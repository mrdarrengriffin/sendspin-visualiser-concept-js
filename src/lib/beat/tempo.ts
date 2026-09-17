/**
 * The beat clock: turns Sendspin's `beat` frames (or, failing those, `peak` onsets) into a tempo
 * and a phase reference for the logo's beat lock. Pure logic, no DOM; times are server-clock
 * microseconds in, local milliseconds (performance.now) out. See docs/beat-sync.
 *
 * The clock is sticky. Once a tempo is locked, each new piece of evidence is tested against the
 * lock: if it agrees it pulls the grid slowly; if it disagrees it is ignored and the grid coasts.
 * The lock is replaced only when the disagreeing evidence has itself been stable for a while.
 */

export interface BeatClockOutput {
  /** Beat period in seconds. */
  period: number;
  /** A coming beat, as a local performance.now() timestamp in ms. */
  nextBeatAt: number;
}

export type TempoSource = 'none' | 'server' | 'onsets';

export interface TempoLogEntry {
  t: number;
  kind: string;
  [k: string]: unknown;
}

export interface BeatClockOptions {
  /** Called whenever the grid is refreshed. */
  onClock: (out: BeatClockOutput) => void;
  /** Called when the clock is dropped (track change, stream end). */
  onClear?: () => void;
  /** Current server-clock time in µs; local = now + (ts - serverNow) / 1000. */
  serverNowUs: () => number;
  now?: () => number;
  /** Use onsets to guess the tempo when the server sends no beats. Default false. */
  onsetFallback?: boolean;
  log?: (entry: TempoLogEntry) => void;
}

interface Lock {
  periodUs: number;
  /** A beat time on the grid, server µs. */
  anchorUs: number;
  source: TempoSource;
  /** Consecutive pieces of evidence that disagreed with the lock. */
  dissent: number;
  /**
   * 0..1, earned by evidence. Agreement raises it, dissent lowers it. A low-confidence lock (a
   * sparse intro, a weak onset guess) adapts fast and is easy to replace; a high-confidence one
   * (many steady beats) moves slowly and rides through fills.
   */
  confidence: number;
}

// Windows and thresholds. All periods in µs unless noted.
const SHORT_WINDOW = 12;
const LONG_WINDOW = 600;
const LONG_MIN = 24;
const PERIOD_MIN = 250_000, PERIOD_MAX = 1_500_000;
const AGREE_PERIOD = 0.04;     // period within 4% of the lock counts as agreeing
const AGREE_PHASE = 0.2;       // beat within 20% of a period from the grid counts as agreeing
// Pull rates and replacement thresholds scale with the lock's confidence c (0..1):
const pullPeriod = (c: number) => 0.1 + 0.3 * (1 - c);   // 0.4 when unsure, 0.1 when sure
const pullPhase = (c: number) => 0.2 + 0.4 * (1 - c);    // 0.6 when unsure, 0.2 when sure
const RELOCK_BEATS = 8;                                   // a replacement needs at least this many steady beats ...
const relockSpanUs = (c: number) => 3_000_000 * (1 + 2 * c);   // ... spanning 3 s (unsure) to 9 s (sure)
const CANDIDATE_MAX = 64;                                 // dissenting beats remembered for that
const CONF_GAIN = 0.06;                                   // per agreeing beat
// Loss per dissenting beat also scales with confidence: a lock built on many steady beats gives
// its trust up slowly (x0.98, ~35 dissents to halve), a fresh one quickly (x0.92, ~8 to halve).
const confLoss = (c: number) => 0.92 + 0.06 * c;
const FLYWHEEL_SHORT_MS = 30000;

export class BeatClock {
  period = 0;            // µs (of the lock)
  bpm = 0;
  source: TempoSource = 'none';
  nextLocal = 0;         // ms, local
  lastBeatLocal = 0;     // ms, local, when evidence last refreshed the clock
  downbeats = 0;
  beatsSeen = 0;
  relocks = 0;
  /** Whether the server's stream currently includes the `beat` type. */
  serverOffersBeats = false;
  /** Use onsets to guess the tempo when the server sends no beats. */
  onsetFallback: boolean;

  private lock: Lock | null = null;
  private ts: number[] = [];
  private all: number[] = [];
  private candidate: number[] = [];
  private onsets: { ts: number; w: number; wr?: number }[] = [];
  private onsetVotes: { P: number; next: number; t: number; score: number }[] = [];
  private lastOnsetEstimate = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BeatClockOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.onsetFallback = opts.onsetFallback ?? false;
  }

  /** True while a lock should be held: a tempo is known and the feed has not been silent too long. */
  get alive(): boolean {
    if (!this.lock) return false;
    const flywheel = this.all.length >= LONG_MIN ? Infinity : FLYWHEEL_SHORT_MS;
    return this.now() - this.lastBeatLocal < flywheel;
  }

  get coastingMs(): number {
    return this.lock ? this.now() - this.lastBeatLocal : 0;
  }

  /** How many recent pieces of evidence disagreed with the lock (0 when in step). */
  get dissent(): number {
    return this.lock?.dissent ?? 0;
  }

  /** 0..1 confidence of the current lock. */
  get confidence(): number {
    return this.lock?.confidence ?? 0;
  }

  /** Drop everything: new track, seek, stream end. */
  reset(reason: string): void {
    this.ts = []; this.all = []; this.candidate = []; this.onsets = []; this.onsetVotes = [];
    this.lock = null; this.period = 0; this.bpm = 0; this.source = 'none';
    this.log('reset', { reason });
    this.opts.onClear?.();
  }

  // ------------------------------------------------------------------ server beats

  /** Feed a server `beat` frame at the moment it is due. */
  trackBeat(timestampUs: number, downbeat: boolean): void {
    this.beatsSeen++;
    if (downbeat) this.downbeats++;
    const prev = this.ts[this.ts.length - 1];
    this.log('beat', { ts: timestampUs, gapMs: prev ? Math.round((timestampUs - prev) / 1000) : null, down: downbeat });
    this.ts.push(timestampUs); if (this.ts.length > SHORT_WINDOW) this.ts.shift();
    this.all.push(timestampUs); if (this.all.length > LONG_WINDOW) this.all.shift();
    this.lastBeatLocal = this.now();

    if (this.lock && this.lock.source === 'server') this.judgeAgainstLock(timestampUs);
    else if (this.lock && this.lock.source === 'onsets') {
      // server beats outrank an onset lock: take the first estimate they can provide
      const est = this.estimateFromBeats();
      if (est) this.adopt(est.periodUs, est.lastBeatUs, 'server', 'server beats replace onset lock');
    } else {
      const est = this.estimateFromBeats();
      if (est) this.adopt(est.periodUs, est.lastBeatUs, 'server', 'first lock');
    }
  }

  /** Test one beat against the locked grid: pull if it agrees, otherwise grow a replacement candidate. */
  private judgeAgainstLock(ts: number): void {
    const lock = this.lock!;
    const k = Math.round((ts - lock.anchorUs) / lock.periodUs);
    const e = ts - (lock.anchorUs + k * lock.periodUs);          // signed phase error, µs
    const est = this.estimateFromBeats();
    const periodOk = !est || Math.abs(est.periodUs / lock.periodUs - 1) < AGREE_PERIOD;
    const phaseOk = Math.abs(e) < AGREE_PHASE * lock.periodUs;

    if (phaseOk) {
      // In step: phase is the evidence that counts, so an on-grid beat agrees even while the short
      // window's period estimate is still polluted by a fill. Re-anchor at this beat's grid slot,
      // pulled toward the actual beat; pull the period only when its estimate agrees too. Both
      // pulls shrink as confidence grows.
      lock.anchorUs = lock.anchorUs + k * lock.periodUs + pullPhase(lock.confidence) * e;
      if (est && periodOk) lock.periodUs += pullPeriod(lock.confidence) * (est.periodUs - lock.periodUs);
      lock.confidence = Math.min(1, lock.confidence + CONF_GAIN);
      lock.dissent = 0; this.candidate = [];
      this.emit();
      return;
    }

    // out of step: keep the lock, coast, and see whether the dissenting beats form a stable tempo
    lock.dissent++;
    lock.confidence *= confLoss(lock.confidence);
    // The candidate keeps the dissenting beats of the last needSpan (plus a little slack), so a
    // rival tempo has to stay steady for the whole span, not just for eight beats.
    const needSpan = relockSpanUs(lock.confidence);
    this.candidate.push(ts);
    while (this.candidate.length > CANDIDATE_MAX || ts - this.candidate[0] > needSpan + 2 * lock.periodUs) this.candidate.shift();
    this.log('dissent', { phaseErrMs: Math.round(e / 1000), estBpm: est ? +(60e6 / est.periodUs).toFixed(1) : null, candidate: this.candidate.length });
    if (this.candidate.length < RELOCK_BEATS) return;
    const gaps = this.candidate.slice(1).map((t, i) => t - this.candidate[i]);
    const med = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
    const steady = gaps.every((g) => Math.abs(g / med - 1) < 0.1) && med >= PERIOD_MIN && med <= PERIOD_MAX;
    const span = this.candidate[this.candidate.length - 1] - this.candidate[0];
    if (steady && span >= needSpan) {
      const P = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      this.relocks++;
      this.adopt(P, this.candidate[this.candidate.length - 1], 'server', `relock after ${this.candidate.length} steady beats`, 0.4);
      this.all = this.candidate.slice(); this.candidate = [];
    }
  }

  /** Tempo and last beat from the beat windows (short least-squares fit, long trimmed mean). */
  private estimateFromBeats(): { periodUs: number; lastBeatUs: number } | null {
    if (this.ts.length < 3) return null;
    const gaps = this.ts.slice(1).map((t, i) => t - this.ts[i]);
    const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
    if (median < PERIOD_MIN || median > PERIOD_MAX) return null;
    // a discontinuity (missed beat, re-anchored schedule) inside the window: use only what follows it
    const gi = gaps.findIndex((g) => Math.abs(g / median - 1) > 0.25);
    const win = gi >= 0 ? this.ts.slice(gi + 1) : this.ts;
    if (win.length < 3) return null;
    const n = win.length, mi = (n - 1) / 2, mt = win.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vari = 0;
    win.forEach((t, i) => { cov += (i - mi) * (t - mt); vari += (i - mi) ** 2; });
    let P = cov / vari;
    const a = mt - P * mi;
    if (this.all.length >= LONG_MIN) {
      // trimmed mean of gaps over the whole track: unbiased by the offset a re-pushed schedule adds
      const g2 = this.all.slice(1).map((t, i) => t - this.all[i]);
      const med2 = [...g2].sort((x, y) => x - y)[g2.length >> 1];
      const good = g2.filter((g) => Math.abs(g / med2 - 1) < 0.15);
      const P2 = good.reduce((x, y) => x + y, 0) / good.length;
      if (good.length >= 20 && Math.abs(P2 / P - 1) < 0.03) P = P2;
    }
    return { periodUs: P, lastBeatUs: a + P * (n - 1) };
  }

  // ------------------------------------------------------------------ onsets (fallback)

  /** Feed a server `peak` (onset) frame at the moment it is due. */
  trackOnset(timestampUs: number, strength: number): void {
    this.onsets.push({ ts: timestampUs, w: 0.3 + strength / 255 });
    if (!this.onsetFallback) return;
    // Server beats always win: if the stream offers `beat`, or a server lock exists, onsets are ignored.
    if (this.serverOffersBeats || this.lock?.source === 'server') return;
    const now = this.now();
    if (now - this.lastOnsetEstimate < 1000) return;
    this.lastOnsetEstimate = now;

    const est = this.estimateFromOnsets();
    this.log('onset-est', est ? { bpm: +(60e6 / est.P).toFixed(1), score: +est.score.toFixed(2) } : { none: true });
    if (!est) return;
    const nowS = this.opts.serverNowUs();

    if (this.lock) {
      const lock = this.lock;
      const k = Math.round((est.next - lock.anchorUs) / lock.periodUs);
      const e = est.next - (lock.anchorUs + k * lock.periodUs);
      const agrees = Math.abs(est.P / lock.periodUs - 1) < AGREE_PERIOD && Math.abs(e) < AGREE_PHASE * lock.periodUs;
      if (agrees) {
        lock.periodUs += pullPeriod(lock.confidence) * (est.P - lock.periodUs);
        lock.anchorUs += pullPhase(lock.confidence) * e;
        // an onset lock's confidence tracks how clear the clustering is: clear drums earn trust fast
        lock.confidence = Math.min(1, lock.confidence + CONF_GAIN * (est.score >= 0.75 ? 2 : 1));
        lock.dissent = 0; this.onsetVotes = [];
        this.lastBeatLocal = now;
        this.emit();
        return;
      }
      lock.dissent++;
      lock.confidence *= confLoss(lock.confidence);
      // a replacement needs consecutive agreeing estimates: two when the lock is unsure, four when
      // it is sure
      this.onsetVotes.push({ P: est.P, next: est.next, t: nowS, score: est.score });
      const need = lock.confidence < 0.5 ? 2 : 4;
      if (this.onsetVotes.length > need) this.onsetVotes.shift();
      const Ps = this.onsetVotes.map((v) => v.P);
      const steady = this.onsetVotes.length === need && Math.max(...Ps) / Math.min(...Ps) < 1.03;
      if (steady) {
        const meanScore = this.onsetVotes.reduce((a, v) => a + v.score, 0) / need;
        this.relocks++;
        this.adopt(Ps.reduce((a, b) => a + b, 0) / need, est.next, 'onsets', 'onset relock', Math.min(0.6, meanScore));
        this.onsetVotes = [];
      }
      return;
    }

    // no lock yet: adopt when two consecutive estimates agree; start with confidence from clarity
    this.onsetVotes.push({ P: est.P, next: est.next, t: nowS, score: est.score });
    if (this.onsetVotes.length > 2) this.onsetVotes.shift();
    const Ps = this.onsetVotes.map((v) => v.P);
    if (this.onsetVotes.length === 2 && Math.max(...Ps) / Math.min(...Ps) < 1.03) {
      this.adopt((Ps[0] + Ps[1]) / 2, est.next, 'onsets', 'first onset lock', Math.min(0.5, est.score - 0.3));
      this.onsetVotes = [];
    }
  }

  /**
   * Tempo from onsets by phase clustering: for each candidate period, how tightly do the recent
   * onsets cluster in phase (|Σ w·e^(2πi t/P)| / Σ w)? Recent onsets weigh more; 80–160 BPM is
   * preferred to disambiguate octaves.
   */
  estimateFromOnsets(): { P: number; next: number; score: number } | null {
    const nowS = this.opts.serverNowUs();
    while (this.onsets.length && this.onsets[0].ts < nowS - 10_000_000) this.onsets.shift();
    if (this.onsets.length < 6) return null;
    for (const o of this.onsets) o.wr = o.w * (0.4 + 0.6 * Math.max(0, 1 - (nowS - o.ts) / 10_000_000));

    const score = (P: number) => {
      let re = 0, im = 0, wsum = 0;
      for (const o of this.onsets) {
        const a = 2 * Math.PI * ((o.ts % P) / P), w = o.wr ?? o.w;
        re += w * Math.cos(a); im += w * Math.sin(a); wsum += w;
      }
      return { s: Math.hypot(re, im) / wsum, phase: Math.atan2(im, re) };
    };
    let best: { P: number; score: number; phase: number } | null = null;
    for (let P = 333_000; P <= 1_000_000; P += 4000) {
      const bpm = 60e6 / P, pref = bpm >= 80 && bpm <= 160 ? 1 : 0.8;
      const { s, phase } = score(P);
      if (!best || pref * s > best.score) best = { P, score: pref * s, phase };
    }
    if (!best || best.score < 0.5) return null;
    for (let P = best.P - 4000; P <= best.P + 4000; P += 250) {
      const { s, phase } = score(P);
      if (s > best.score) best = { P, score: s, phase };
    }
    const phaseUs = ((best.phase / (2 * Math.PI)) * best.P + best.P) % best.P;
    let next = nowS - (nowS % best.P) + phaseUs; while (next <= nowS) next += best.P;
    return { P: best.P, next, score: best.score };
  }

  // ------------------------------------------------------------------ lock management

  private adopt(periodUs: number, anchorUs: number, source: TempoSource, why: string, confidence = 0.3): void {
    this.lock = { periodUs, anchorUs, source, dissent: 0, confidence: Math.max(0.05, Math.min(1, confidence)) };
    this.lastBeatLocal = this.now();
    this.log('lock', { bpm: +(60e6 / periodUs).toFixed(2), source, why, confidence: +this.lock.confidence.toFixed(2) });
    this.emit();
  }

  /** Publish the locked grid: period, and the next grid time converted to local ms. */
  private emit(): void {
    const lock = this.lock!;
    this.period = lock.periodUs; this.bpm = 60e6 / lock.periodUs; this.source = lock.source;
    const nowS = this.opts.serverNowUs();
    const k = Math.ceil((nowS - lock.anchorUs) / lock.periodUs);
    const next = lock.anchorUs + Math.max(k, 0) * lock.periodUs;
    this.nextLocal = this.now() + (next - nowS) / 1000;
    this.log('tempo', { bpm: +this.bpm.toFixed(2), source: lock.source, dissent: lock.dissent, confidence: +lock.confidence.toFixed(2) });
    this.opts.onClock({ period: lock.periodUs / 1e6, nextBeatAt: this.nextLocal });
  }

  private log(kind: string, data: Record<string, unknown>): void {
    this.opts.log?.({ t: +(this.now() / 1000).toFixed(2), kind, ...data });
  }
}
