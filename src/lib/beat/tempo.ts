/**
 * The beat clock: turns Sendspin's `beat` frames (or, failing those, `peak` onsets) into a tempo
 * and a phase reference for the logo's beat lock. Pure logic, no DOM; times are server-clock
 * microseconds in, local milliseconds (performance.now) out. See docs/beat-sync.
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
  /** Called whenever the estimate is refreshed. */
  onClock: (out: BeatClockOutput) => void;
  /** Called when the clock is dropped (track change, stream end, released). */
  onClear?: () => void;
  /** Maps server-clock µs to local ms: `localNow + (ts - serverNow) / 1000`. */
  serverNowUs: () => number;
  now?: () => number;
  /** Use onsets to guess the tempo when the server sends no beats. Default false. */
  onsetFallback?: boolean;
  log?: (entry: TempoLogEntry) => void;
}

const SHORT_WINDOW = 12;
const LONG_WINDOW = 600;
const LONG_MIN = 24;
const OCTAVE_HOLD_MS = 8000;
const FLYWHEEL_SHORT_MS = 30000;

export class BeatClock {
  period = 0;            // µs
  bpm = 0;
  source: TempoSource = 'none';
  nextLocal = 0;         // ms, local
  lastBeatLocal = 0;     // ms, local, when a beat (or onset estimate) last refreshed the clock
  downbeats = 0;
  beatsSeen = 0;
  /** Whether the server's stream currently includes the `beat` type. */
  serverOffersBeats = false;
  /** Use onsets to guess the tempo when the server sends no beats. */
  onsetFallback: boolean;

  private ts: number[] = [];
  private all: number[] = [];
  private octaveSince = 0;
  private onsets: { ts: number; w: number; wr?: number }[] = [];
  private onsetVotes: number[] = [];
  private lastOnsetEstimate = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BeatClockOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.onsetFallback = opts.onsetFallback ?? false;
  }

  /** True while a lock should be held: a tempo is known and the feed has not been silent too long. */
  get alive(): boolean {
    if (!this.period) return false;
    const flywheel = this.all.length >= LONG_MIN ? Infinity : FLYWHEEL_SHORT_MS;
    return this.now() - this.lastBeatLocal < flywheel;
  }

  get coastingMs(): number {
    return this.period ? this.now() - this.lastBeatLocal : 0;
  }

  /** Drop everything: new track, seek, stream end. */
  reset(reason: string): void {
    this.ts = []; this.all = []; this.onsets = []; this.onsetVotes = [];
    this.period = 0; this.bpm = 0; this.source = 'none'; this.octaveSince = 0;
    this.log('reset', { reason });
    this.opts.onClear?.();
  }

  /** Feed a server `beat` frame at the moment it is due. */
  trackBeat(timestampUs: number, downbeat: boolean): void {
    this.beatsSeen++;
    if (downbeat) this.downbeats++;
    const prev = this.ts[this.ts.length - 1];
    this.log('beat', { ts: timestampUs, gapMs: prev ? Math.round((timestampUs - prev) / 1000) : null, down: downbeat });
    this.ts.push(timestampUs); if (this.ts.length > SHORT_WINDOW) this.ts.shift();
    this.all.push(timestampUs); if (this.all.length > LONG_WINDOW) this.all.shift();
    this.lastBeatLocal = this.now();
    if (this.ts.length < 3) return;

    // Beat timestamps sit on the 20 ms audio-chunk grid, so single gaps alternate around the true
    // period; every estimate below averages over a window rather than trusting one gap.
    const gaps = this.ts.slice(1).map((t, i) => t - this.ts[i]);
    const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
    if (median < 250_000 || median > 1_500_000) return;

    // Discontinuity (missed beat, or a schedule re-pushed with a new anchor after a seek): drop
    // everything before it rather than fitting across it.
    const gi = gaps.findIndex((g) => Math.abs(g / median - 1) > 0.25);
    if (gi >= 0) {
      this.log('gap-drop', { droppedBefore: gi + 1, medianMs: Math.round(median / 1000) });
      this.ts = this.ts.slice(gi + 1);
      if (this.ts.length < 3) return;
    }

    // Short estimate: least-squares fit t_i = a + P*i, so phase and period are both averaged.
    const n = this.ts.length, mi = (n - 1) / 2, mt = this.ts.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vari = 0;
    this.ts.forEach((t, i) => { cov += (i - mi) * (t - mt); vari += (i - mi) ** 2; });
    const rawP = cov / vari;
    let P = rawP, a = mt - P * mi;

    // Long estimate: trimmed mean of gaps over the whole track. A line fit would be biased by the
    // offset a re-pushed schedule introduces; a trimmed mean only loses the one odd gap.
    if (this.all.length >= LONG_MIN) {
      const g2 = this.all.slice(1).map((t, i) => t - this.all[i]);
      const med = [...g2].sort((x, y) => x - y)[g2.length >> 1];
      const good = g2.filter((g) => Math.abs(g / med - 1) < 0.15);
      const P2 = good.reduce((x, y) => x + y, 0) / good.length;
      if (good.length >= 20 && Math.abs(P2 / P - 1) < 0.03) { P = P2; a = mt - P * mi; }
      else if (Math.abs(P2 / P - 1) >= 0.03) this.all = this.ts.slice(); // tempo change: restart
    }

    // Octave guard: a sudden 2x or 0.5x is usually missed/doubled beats, not a tempo change.
    if (this.period) {
      const ratio = P / this.period;
      const octave = Math.abs(ratio - 2) < 0.15 || Math.abs(ratio - 0.5) < 0.08;
      if (octave) {
        this.octaveSince ||= this.now();
        if (this.now() - this.octaveSince < OCTAVE_HOLD_MS) { P = this.period; a = mt - P * mi; }
      } else this.octaveSince = 0;
    }

    this.period = P; this.bpm = 60e6 / P; this.source = 'server';
    const nowS = this.opts.serverNowUs();
    let next = a + P * (n - 1); while (next <= nowS) next += P;
    this.nextLocal = this.now() + (next - nowS) / 1000;
    this.log('tempo', { bpm: +this.bpm.toFixed(2), rawBpm: +(60e6 / rawP).toFixed(2), n, guarded: P !== rawP });
    this.opts.onClock({ period: P / 1e6, nextBeatAt: this.nextLocal });
  }

  /** Feed a server `peak` (onset) frame at the moment it is due. */
  trackOnset(timestampUs: number, strength: number): void {
    this.onsets.push({ ts: timestampUs, w: 0.3 + strength / 255 });
    if (!this.onsetFallback) return;
    // Server beats always win: if the stream offers `beat`, or a server tempo is established for
    // this track, onsets are ignored.
    if (this.serverOffersBeats || this.source === 'server') return;
    const now = this.now();
    if (now - this.lastOnsetEstimate < 1000) return;
    this.lastOnsetEstimate = now;

    const est = this.estimateFromOnsets();
    this.log('onset-est', est ? { bpm: +(60e6 / est.P).toFixed(1), score: +est.score.toFixed(2) } : { none: true });
    if (!est) return;

    // Consensus: adopt when two consecutive estimates agree within 3%; once adopted, keep the
    // tempo (refining phase only) unless a different one keeps winning.
    this.onsetVotes.push(est.P); if (this.onsetVotes.length > 2) this.onsetVotes.shift();
    const agree = this.onsetVotes.length === 2 && Math.max(...this.onsetVotes) / Math.min(...this.onsetVotes) < 1.03;
    const current = this.source === 'onsets' ? this.period : 0;
    const same = current > 0 && Math.abs(est.P / current - 1) < 0.06;
    if (!same && !agree) return;

    const P = same ? current : est.P;
    this.period = P; this.bpm = 60e6 / P; this.source = 'onsets'; this.lastBeatLocal = now;
    this.nextLocal = now + (est.next - this.opts.serverNowUs()) / 1000;
    this.opts.onClock({ period: P / 1e6, nextBeatAt: this.nextLocal });
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

  private log(kind: string, data: Record<string, unknown>): void {
    this.opts.log?.({ t: +(this.now() / 1000).toFixed(2), kind, ...data });
  }
}
