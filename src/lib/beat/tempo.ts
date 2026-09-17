/**
 * The beat clock: turns Sendspin's `beat` frames (or, failing those, `peak` onsets) into a tempo
 * and a phase reference for the logo's beat lock. Pure logic, no DOM; times are server-clock
 * microseconds in, local milliseconds (performance.now) out. See docs/beat-sync.
 *
 * The clock is sticky. Once a tempo is locked, each new piece of evidence is tested against the
 * lock. While the lock is young it adapts fast. Once it is established (confidence >= 0.8) it
 * only eases, ignores isolated off-grid beats entirely, and is only moved by a run of beats that
 * agree with each other: same period with one offset -> re-phase at once; a different period ->
 * lose confidence and, once the run has lasted long enough, relock to it.
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
   * 0..1, earned by evidence. Agreement raises it; only coherent disagreement (a rival run)
   * lowers it once the lock is established. A young lock (a sparse intro, a weak onset guess)
   * adapts fast and is easy to replace; an established one moves slowly and rides through fills.
   */
  confidence: number;
}

/** One beat as remembered in the steady run: its time and how it sat against the lock. */
interface RunBeat {
  ts: number;
  /** Signed phase error against the lock at the time, µs, wrapped to ±period/2. */
  e: number;
  /** Off-grid (|e| >= AGREE_PHASE·period). */
  off: boolean;
}

// Windows and thresholds. All periods in µs unless noted.
const SHORT_WINDOW = 12;
const LONG_WINDOW = 600;
const LONG_MIN = 24;
const PERIOD_MIN = 250_000, PERIOD_MAX = 1_500_000;
const AGREE_PERIOD = 0.04;     // period within 4% of the lock counts as agreeing
const AGREE_PHASE = 0.2;       // beat within 20% of a period from the grid counts as agreeing
const ESTABLISHED = 0.8;       // confidence from which the lock is established (~9 agreeing beats after a first lock)
const CONF_GAIN = 0.06;        // per agreeing beat (not while a rival run is present)
const CONF_LOSS_LOOSE = 0.92;  // per off-grid beat while not established (~8 to halve)
const CONF_LOSS_RIVAL = 0.85;  // per off-grid beat that belongs to a rival run (~4 to halve)
// The steady run: the most recent consecutive beats whose gaps agree within 10% of their median.
const RUN_MAX = 16;
const RUN_STEADY = 0.1;
// K: a steady run of at least this many beats, at least half of them off-grid, is a rival.
const RIVAL_MIN = 4;
// Phase relock: K consecutive off-grid beats at the locked period (mean gap within AGREE_PERIOD)
// whose offsets agree within 10% of a period are the same tempo with a new phase.
const PHASE_SPREAD = 0.1;
// Tempo relock: a rival run of at least 8 beats spanning 3 s (unsure) to 9 s (sure).
const RELOCK_BEATS = 8;
const relockSpanUs = (c: number) => 3_000_000 * (1 + 2 * c);
// Pull rates. Established: small and constant. Below that they scale with confidence c.
const PULL_PHASE_FIRM = 0.1, PULL_PERIOD_FIRM = 0.1;
const pullPeriodLoose = (c: number) => 0.1 + 0.3 * (1 - c);   // 0.4 when unsure
const pullPhaseLoose = (c: number) => 0.2 + 0.4 * (1 - c);    // 0.6 when unsure
const FLYWHEEL_SHORT_MS = 30000;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const gapsOf = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]);

export class BeatClock {
  period = 0;            // µs (of the lock)
  bpm = 0;
  source: TempoSource = 'none';
  nextLocal = 0;         // ms, local
  lastBeatLocal = 0;     // ms, local, when evidence last refreshed the clock
  downbeats = 0;
  beatsSeen = 0;
  /** Tempo relocks: the lock was replaced by a rival run at a different period. */
  relocks = 0;
  /** Phase relocks: same period, re-anchored onto a consistently shifted run. */
  rephases = 0;
  /** Whether the server's stream currently includes the `beat` type. */
  serverOffersBeats = false;
  /** Use onsets to guess the tempo when the server sends no beats. */
  onsetFallback: boolean;

  private lock: Lock | null = null;
  private ts: number[] = [];
  private all: number[] = [];
  private run: RunBeat[] = [];
  private onsets: { ts: number; w: number; wr?: number }[] = [];
  private onsetVotes: { P: number; next: number; t: number; score: number }[] = [];
  private lastOnsetEstimate = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BeatClockOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.onsetFallback = opts.onsetFallback ?? false;
  }

  /**
   * True while a lock should be held. An established lock (or one with a whole-track history)
   * runs until the track ends: silence is not evidence against it. A young lock coasts 30 s.
   */
  get alive(): boolean {
    if (!this.lock) return false;
    const forever = this.lock.confidence >= ESTABLISHED || this.all.length >= LONG_MIN;
    return forever || this.now() - this.lastBeatLocal < FLYWHEEL_SHORT_MS;
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

  /** Established: confidence >= 0.8. Ignores isolated off-grid beats and only eases. */
  get established(): boolean {
    return (this.lock?.confidence ?? 0) >= ESTABLISHED;
  }

  /** Drop everything: new track, seek, stream end. */
  reset(reason: string): void {
    this.ts = []; this.all = []; this.run = []; this.onsets = []; this.onsetVotes = [];
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

  /**
   * Test one beat against the locked grid. On-grid: pull. Off-grid: coast. Either way, keep the
   * steady run up to date and see whether it has become a rival (a new phase or a new tempo).
   */
  private judgeAgainstLock(ts: number): void {
    const lock = this.lock!;
    const k = Math.round((ts - lock.anchorUs) / lock.periodUs);
    const slot = lock.anchorUs + k * lock.periodUs;
    const e = ts - slot;                                          // signed phase error, µs
    const off = Math.abs(e) >= AGREE_PHASE * lock.periodUs;
    const firm = lock.confidence >= ESTABLISHED;

    // The steady run: broken by a gap that disagrees with the run's gaps by more than 10%.
    if (this.run.length >= 2) {
      const last = this.run[this.run.length - 1].ts;
      const med = median(gapsOf(this.run.map((b) => b.ts)));
      if (Math.abs((ts - last) / med - 1) > RUN_STEADY) this.run = [];
    }
    this.run.push({ ts, e, off }); if (this.run.length > RUN_MAX) this.run.shift();
    const runOff = this.run.filter((b) => b.off).length;
    const rival = this.run.length >= RIVAL_MIN && runOff * 2 >= this.run.length;

    if (!off) {
      // In step. Re-anchor at this beat's grid slot, pulled a little toward the beat. Steer the
      // period from the whole-track estimate only once established; a young lock follows the
      // 12-beat window so a sparse-intro lock yields quickly to real drums.
      lock.anchorUs = slot + (firm ? PULL_PHASE_FIRM : pullPhaseLoose(lock.confidence)) * e;
      if (firm) {
        const P2 = this.longEstimate();
        if (P2 && Math.abs(P2 / lock.periodUs - 1) < AGREE_PERIOD) lock.periodUs += PULL_PERIOD_FIRM * (P2 - lock.periodUs);
      } else {
        const est = this.estimateFromBeats();
        if (est && Math.abs(est.periodUs / lock.periodUs - 1) < AGREE_PERIOD) lock.periodUs += pullPeriodLoose(lock.confidence) * (est.periodUs - lock.periodUs);
      }
      if (!rival) lock.confidence = Math.min(1, lock.confidence + CONF_GAIN);
      lock.dissent = 0;
      this.emit();
    } else {
      lock.dissent++;
      const runP = this.run.length >= 2 ? mean(gapsOf(this.run.map((b) => b.ts))) : null;
      this.log('dissent', {
        offMs: Math.round(e / 1000), run: this.run.length, runOff, rival,
        runBpm: runP ? +(60e6 / runP).toFixed(1) : null, confidence: +lock.confidence.toFixed(2),
      });
      // Same tempo, new phase (a re-pushed beat list): re-anchor at once, keep period and trust.
      if (this.tryPhaseRelock(slot)) return;
      // Otherwise coast. Incoherent dissent costs nothing once established; a rival run costs.
      if (rival) lock.confidence *= CONF_LOSS_RIVAL;
      else if (!firm) lock.confidence *= CONF_LOSS_LOOSE;
    }
    if (rival) this.tryTempoRelock(runOff);
  }

  /**
   * K consecutive off-grid beats whose mean gap is the locked period (within 4%) and whose
   * offsets agree within 10% of a period: the grid has moved, not the tempo. Re-anchor onto them.
   */
  private tryPhaseRelock(slot: number): boolean {
    const lock = this.lock!;
    if (lock.dissent < RIVAL_MIN || this.run.length < RIVAL_MIN) return false;
    const tail = this.run.slice(-RIVAL_MIN);
    if (!tail.every((b) => b.off)) return false;
    const P = mean(gapsOf(tail.map((b) => b.ts)));
    if (Math.abs(P / lock.periodUs - 1) >= AGREE_PERIOD) return false;
    const es = tail.map((b) => b.e);
    if (Math.max(...es) - Math.min(...es) >= PHASE_SPREAD * lock.periodUs) return false;
    const shift = mean(es);
    lock.anchorUs = slot + shift;
    lock.dissent = 0; this.run = [];
    this.rephases++;
    this.log('lock', {
      bpm: +(60e6 / lock.periodUs).toFixed(2), source: lock.source, why: `phase relock after ${RIVAL_MIN} beats`,
      shiftMs: Math.round(shift / 1000), confidence: +lock.confidence.toFixed(2),
    });
    this.emit();
    return true;
  }

  /** A rival run of at least 8 steady beats spanning the confidence-scaled minimum replaces the lock. */
  private tryTempoRelock(runOff: number): void {
    const lock = this.lock!;
    if (this.run.length < RELOCK_BEATS) return;
    const ts = this.run.map((b) => b.ts);
    const span = ts[ts.length - 1] - ts[0];
    if (span < relockSpanUs(lock.confidence)) return;
    const P = mean(gapsOf(ts));
    if (P < PERIOD_MIN || P > PERIOD_MAX) return;
    this.relocks++;
    this.adopt(P, ts[ts.length - 1], 'server', `relock after ${ts.length} steady beats (${runOff} off-grid)`, 0.4);
    this.all = ts.slice(); this.run = [];
  }

  /** Tempo and last beat from the beat windows (short least-squares fit, long trimmed mean). */
  private estimateFromBeats(): { periodUs: number; lastBeatUs: number } | null {
    if (this.ts.length < 3) return null;
    const gaps = gapsOf(this.ts);
    const med = median(gaps);
    if (med < PERIOD_MIN || med > PERIOD_MAX) return null;
    // a discontinuity (missed beat, re-anchored schedule) inside the window: use only what follows it
    const gi = gaps.findIndex((g) => Math.abs(g / med - 1) > 0.25);
    const win = gi >= 0 ? this.ts.slice(gi + 1) : this.ts;
    if (win.length < 3) return null;
    const n = win.length, mi = (n - 1) / 2, mt = mean(win);
    let cov = 0, vari = 0;
    win.forEach((t, i) => { cov += (i - mi) * (t - mt); vari += (i - mi) ** 2; });
    let P = cov / vari;
    const a = mt - P * mi;
    const P2 = this.longEstimate();
    if (P2 && Math.abs(P2 / P - 1) < 0.03) P = P2;
    return { periodUs: P, lastBeatUs: a + P * (n - 1) };
  }

  /**
   * Whole-track period: trimmed mean of the gaps (within 15% of their median) once >= 24 beats
   * are known. Never a line fit: a re-pushed schedule adds an offset that would bias it.
   */
  private longEstimate(): number | null {
    if (this.all.length < LONG_MIN) return null;
    const g = gapsOf(this.all);
    const med = median(g);
    const good = g.filter((x) => Math.abs(x / med - 1) < 0.15);
    return good.length >= 20 ? mean(good) : null;
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
      const firm = lock.confidence >= ESTABLISHED;
      const k = Math.round((est.next - lock.anchorUs) / lock.periodUs);
      const e = est.next - (lock.anchorUs + k * lock.periodUs);
      const agrees = Math.abs(est.P / lock.periodUs - 1) < AGREE_PERIOD && Math.abs(e) < AGREE_PHASE * lock.periodUs;
      if (agrees) {
        lock.periodUs += (firm ? PULL_PERIOD_FIRM : pullPeriodLoose(lock.confidence)) * (est.P - lock.periodUs);
        lock.anchorUs += (firm ? PULL_PHASE_FIRM : pullPhaseLoose(lock.confidence)) * e;
        // an onset lock's confidence tracks how clear the clustering is: clear drums earn trust fast
        lock.confidence = Math.min(1, lock.confidence + CONF_GAIN * (est.score >= 0.75 ? 2 : 1));
        lock.dissent = 0; this.onsetVotes = [];
        this.lastBeatLocal = now;
        this.emit();
        return;
      }
      // Dissent. Same rule as for beats: an established lock ignores it unless it is coherent,
      // and coherent dissent must persist for 4 estimates (2 while unsure) to replace the lock.
      lock.dissent++;
      if (!firm) lock.confidence *= CONF_LOSS_LOOSE;
      this.onsetVotes.push({ P: est.P, next: est.next, t: nowS, score: est.score });
      const need = firm ? RIVAL_MIN : 2;
      if (this.onsetVotes.length > need) this.onsetVotes.shift();
      const Ps = this.onsetVotes.map((v) => v.P);
      const steady = this.onsetVotes.length === need && Math.max(...Ps) / Math.min(...Ps) < 1.03;
      this.log('dissent', { offMs: Math.round(e / 1000), estBpm: +(60e6 / est.P).toFixed(1), votes: this.onsetVotes.length, coherent: steady, confidence: +lock.confidence.toFixed(2) });
      if (steady) {
        const meanScore = this.onsetVotes.reduce((a, v) => a + v.score, 0) / need;
        this.relocks++;
        this.adopt(mean(Ps), est.next, 'onsets', `onset relock after ${need} estimates`, Math.min(0.6, meanScore));
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
    this.run = [];
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
    this.log('tempo', { bpm: +this.bpm.toFixed(2), source: lock.source, dissent: lock.dissent, confidence: +lock.confidence.toFixed(2), established: lock.confidence >= ESTABLISHED });
    this.opts.onClock({ period: lock.periodUs / 1e6, nextBeatAt: this.nextLocal });
  }

  private log(kind: string, data: Record<string, unknown>): void {
    this.opts.log?.({ t: +(this.now() / 1000).toFixed(2), kind, ...data });
  }
}
