/**
 * The beat clock: turns Sendspin's `beat` frames (or, failing those, `peak` onsets) into a tempo
 * and a phase reference for the logo's beat lock. Pure logic, no DOM; times are server-clock
 * microseconds in, local milliseconds (performance.now) out. See docs/beat-sync.
 *
 * The clock is sticky, and the quality of the evidence, not the confidence of the lock, decides
 * how fast it moves. Each server beat is judged against the lock, and the last eight beats are
 * classified: `coherent` (steady gaps at a plausible tempo), `half` (steady at twice the locked
 * period, on the grid), `drift` (gaps growing or shrinking beat after beat: a ritardando or
 * accelerando) or `incoherent` (fills, syncopation, missing beats). Coherent beats on the grid
 * track; coherent beats at the same period with a new phase re-phase after one bar; coherent beats
 * at a different period relock after six beats spanning two seconds, however confident the lock;
 * half, drift and incoherent evidence hold the lock. Confidence only scales how hard one on-grid
 * beat pulls and how long a young lock coasts.
 */

export interface BeatClockOutput {
  /** Beat period in seconds. */
  period: number;
  /** A coming beat, as a local performance.now() timestamp in ms. */
  nextBeatAt: number;
}

export type TempoSource = 'none' | 'server' | 'onsets';

/**
 * What the last eight server beats look like as a body of evidence.
 * - `coherent`: gaps agree within EV_COHERENT of their median at a plausible tempo
 * - `half`: coherent at twice the locked period, every beat on the grid (a breakdown, a half-time feel)
 * - `drift`: gaps growing or shrinking beat after beat (a ritardando or accelerando)
 * - `incoherent`: anything else (fills, syncopation, dropped beats, too few beats yet)
 */
export type EvidenceClass = 'none' | 'coherent' | 'half' | 'drift' | 'incoherent';

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
   * 0..1, earned by agreeing beats. It scales how hard one on-grid beat pulls (a young lock from
   * a sparse intro or a weak onset guess adapts fast; an established one only eases) and how long
   * a lock coasts without beats. It is never a wall: coherent evidence moves any lock.
   */
  confidence: number;
}

/** One beat as remembered in the coherent run: its time and how it sat against the lock. */
interface RunBeat {
  ts: number;
  /** Signed phase error against the lock at the time, µs, wrapped to ±period/2. */
  e: number;
  /** Off-grid (|e| >= AGREE_PHASE·period). */
  off: boolean;
}

// Windows and thresholds. All periods in µs unless noted. One line of justification each.
const SHORT_WINDOW = 12;       // beats in the least-squares tempo fit for first locks and young steering
const LONG_WINDOW = 600;       // whole-track history for the trimmed-mean period (10 min at 60 BPM)
const LONG_MIN = 24;           // beats before the whole-track estimate is trusted
const PERIOD_MIN = 300_000, PERIOD_MAX = 1_050_000;   // plausible tempos, 200 down to ~57 BPM
const AGREE_PERIOD = 0.04;     // a period within 4% of the lock is the same tempo (the pull closes the rest)
const AGREE_PHASE = 0.2;       // a beat within 20% of a period of its slot is on-grid (a 16th note is 25%)
const ESTABLISHED = 0.8;       // confidence from which the lock is established (~9 agreeing beats after a first lock)
const CONF_GAIN = 0.06;        // per agreeing beat
const CONF_LOSS_LOOSE = 0.92;  // per incoherent off-grid beat while not established (~8 to halve)
// Evidence window: the last eight beats, two bars of 4/4, long enough to hold a fill and its
// recovery yet short enough that a section change fills it within a few seconds.
const EV_WINDOW = 8;
// Coherent: consecutive gaps within 6% of their median (or one 20 ms chunk, whichever is larger:
// Music Assistant quantises beat times to its 20 ms audio chunks, so a 450 ms beat arrives as
// 440/460). The run is the longest coherent tail of the window; RUN_MIN beats make it evidence.
const EV_COHERENT = 0.06;
const EV_QUANT_US = 24_000;
const RUN_MIN = 4;
// Drift: at least three consecutive gap changes in the same direction with no step back, each
// bigger than 0.5% of the median (so one quantisation step counts and jitter does not). A single
// jump followed by flat gaps is a tempo change, not a drift. A 2%-per-beat threshold was tried
// and missed 1.5%-per-beat ritardandos, which then relocked every six beats.
const DRIFT_STEPS = 3;
const DRIFT_STEP = 0.005;
// Half: a coherent run whose period is twice the lock's, within 6%, all beats on-grid: the server
// is skipping every other slot, the grid still fits. Octaves are the divisions' job.
const HALF_TOL = 0.06;
// Phase relock: RUN_MIN consecutive off-grid beats at the locked period (mean gap within
// AGREE_PERIOD) whose offsets agree within 10% of a period are the same tempo with a new phase.
const PHASE_SPREAD = 0.1;
// Tempo relock: a coherent run of at least 6 beats (a bar and a half) spanning at least 2 s (so a
// single 4/4 fill bar cannot flip it) at a period outside AGREE_PERIOD that is not half the tempo.
// Independent of confidence; the new lock starts at 0.5 because the evidence was coherent.
const RELOCK_BEATS = 6;
const RELOCK_SPAN_US = 2_000_000;
const RELOCK_CONFIDENCE = 0.5;
// Period steering: the whole-track estimate is used when it agrees with the recent run within 1%
// (a steady track, where its precision wins); otherwise the run's mean gap (the tempo moved a little).
const STEER_LONG_TOL = 0.01;
// Pull rates per on-grid beat. Established: small and constant. Below that they scale with c.
const PULL_PHASE_FIRM = 0.1, PULL_PERIOD_FIRM = 0.1;
const pullPeriodLoose = (c: number) => 0.1 + 0.3 * (1 - c);   // 0.4 when unsure
const pullPhaseLoose = (c: number) => 0.2 + 0.4 * (1 - c);    // 0.6 when unsure
const FLYWHEEL_SHORT_MS = 30000;  // a young lock coasts this long without beats; an established one for the track
// First lock: three beats whose two gaps agree within 10% at a plausible tempo. Provisional
// (confidence 0.3), refined by every beat after; the player publishes it only once established.
const FIRST_LOCK_BEATS = 3;
const FIRST_LOCK_TOL = 0.1;
const SEARCH_LOG_MS = 1000;       // `searching` log entries at most this often while nothing is locked
const ONSET_VOTES_FIRM = 4, ONSET_VOTES_LOOSE = 2;  // agreeing onset estimates that replace a lock

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const gapsOf = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]);

/**
 * Drift: the most recent gaps change in one direction, step after step. Walk back from the last
 * gap while the steps keep the sign (steps within DRIFT_STEP of flat are allowed either way, so a
 * quantised ramp still counts); drift if DRIFT_STEPS of them are significant. One jump followed by
 * flat gaps (a tempo change) has one significant step and is not drift.
 */
const isDrifting = (gaps: number[]): boolean => {
  if (gaps.length < DRIFT_STEPS + 1) return false;
  const tol = DRIFT_STEP * median(gaps);
  for (const sign of [1, -1]) {
    let significant = 0;
    for (let i = gaps.length - 1; i > 0; i--) {
      const step = (gaps[i] - gaps[i - 1]) * sign;
      if (step < -tol) break;
      if (step > tol) significant++;
    }
    if (significant >= DRIFT_STEPS) return true;
  }
  return false;
};

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
  /** Evidence class of the last eight server beats, refreshed as each one arrives. */
  evidence: EvidenceClass = 'none';
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
  private lastSearchLog = 0;
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

  /** Established: confidence >= 0.8. Only eases on agreeing beats and coasts for the rest of the track. */
  get established(): boolean {
    return (this.lock?.confidence ?? 0) >= ESTABLISHED;
  }

  /** Drop everything: new track, seek, stream end. */
  reset(reason: string): void {
    this.ts = []; this.all = []; this.run = []; this.onsets = []; this.onsetVotes = [];
    this.lock = null; this.period = 0; this.bpm = 0; this.source = 'none'; this.evidence = 'none';
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
    else {
      // No lock, or an onset lock (server beats outrank it): lock provisionally on the first
      // three consistent beats and refine from there.
      const est = this.firstEstimate();
      if (est) this.adopt(est.periodUs, est.lastBeatUs, 'server', this.lock ? 'server beats replace onset lock' : 'first lock');
      else this.searching('beats');
    }
  }

  /**
   * Call once a frame. Keeps the search running while nothing is locked: the onset estimate
   * every second when the server sends no beats, and a `searching` log line otherwise.
   */
  poll(): void {
    if (this.lock || (this.ts.length === 0 && this.onsets.length === 0)) return;
    if (this.onsetFallback && !this.serverOffersBeats) {
      if (this.now() - this.lastOnsetEstimate >= 1000) this.onsetStep();
    } else if (this.serverOffersBeats) this.searching('beats');
  }

  /** Detection is running but nothing is locked yet; logged at most once a second. */
  private searching(via: string): void {
    const now = this.now();
    if (now - this.lastSearchLog < SEARCH_LOG_MS) return;
    this.lastSearchLog = now;
    this.log('searching', { via, beats: this.ts.length, onsets: this.onsets.length });
  }

  /**
   * A provisional first lock: the last three beats' gaps agree within 10% at a plausible tempo.
   * The period comes from the 12-beat fit when it has enough beats, else from those two gaps.
   */
  private firstEstimate(): { periodUs: number; lastBeatUs: number } | null {
    const last = this.ts.slice(-FIRST_LOCK_BEATS);
    if (last.length < FIRST_LOCK_BEATS) return null;
    const [g1, g2] = gapsOf(last);
    const P = (g1 + g2) / 2;
    if (Math.abs(g1 - g2) > FIRST_LOCK_TOL * P || P < PERIOD_MIN || P > PERIOD_MAX) return null;
    return this.estimateFromBeats() ?? { periodUs: P, lastBeatUs: last[last.length - 1] };
  }

  /**
   * Test one beat against the locked grid, classify the recent evidence, and act on the class:
   * coherent on-grid tracks, coherent with a new phase re-phases, coherent at a new period relocks,
   * half is agreement, drift and incoherent hold (an incoherent on-grid beat still pulls).
   */
  private judgeAgainstLock(ts: number): void {
    const lock = this.lock!;
    const k = Math.round((ts - lock.anchorUs) / lock.periodUs);
    const slot = lock.anchorUs + k * lock.periodUs;
    const e = ts - slot;                                          // signed phase error, µs
    const off = Math.abs(e) >= AGREE_PHASE * lock.periodUs;
    const firm = lock.confidence >= ESTABLISHED;

    // The coherent run: broken by a gap that disagrees with the run's median gap.
    if (this.run.length >= 2) {
      const last = this.run[this.run.length - 1].ts;
      const med = median(gapsOf(this.run.map((b) => b.ts)));
      if (Math.abs(ts - last - med) > Math.max(EV_COHERENT * med, EV_QUANT_US)) this.run = [];
    }
    this.run.push({ ts, e, off }); if (this.run.length > EV_WINDOW) this.run.shift();
    const runP = this.run.length >= 2 ? mean(gapsOf(this.run.map((b) => b.ts))) : null;
    const runOff = this.run.filter((b) => b.off).length;

    const ev = this.classify(lock, runP, runOff);
    this.evidence = ev;
    const samePeriod = ev === 'coherent' && runP !== null && Math.abs(runP / lock.periodUs - 1) < AGREE_PERIOD;
    const newPeriod = ev === 'coherent' && !samePeriod;
    const detail = {
      ev, offMs: Math.round(e / 1000), run: this.run.length, runOff,
      runBpm: runP ? +(60e6 / runP).toFixed(1) : null, confidence: +lock.confidence.toFixed(2),
    };

    if (ev === 'drift') {
      // A ritardando or accelerando: the track is between tempos. Hold everything.
      if (off) lock.dissent++;
      this.log('drift', { ...detail, gapsMs: gapsOf(this.ts.slice(-EV_WINDOW)).map((g) => Math.round(g / 1000)) });
      return;
    }
    if (newPeriod) {
      // Coherent beats at another tempo: hold the lock, and relock once the run is long enough.
      lock.dissent++;
      this.log('dissent', detail);
      this.tryTempoRelock(runOff);
      return;
    }
    if (!off || ev === 'half') {
      // In step (or every other slot). Re-anchor at this beat's grid slot, pulled a little toward
      // the beat; steer the period (never from half-rate gaps); earn confidence.
      lock.anchorUs = slot + (firm ? PULL_PHASE_FIRM : pullPhaseLoose(lock.confidence)) * e;
      if (ev !== 'half') this.steerPeriod(lock, firm, samePeriod ? runP : null);
      lock.confidence = Math.min(1, lock.confidence + CONF_GAIN);
      lock.dissent = 0;
      this.emit();
      return;
    }
    // Off-grid. Same tempo, new phase (a re-pushed beat list, a section on the offbeat): re-anchor
    // at once, keep the period and the trust. Otherwise coast; incoherent dissent costs an
    // established lock nothing, a young one a little.
    lock.dissent++;
    this.log('dissent', detail);
    if (samePeriod && this.tryPhaseRelock(slot)) return;
    if (!firm && ev === 'incoherent') lock.confidence *= CONF_LOSS_LOOSE;
  }

  /** Classify the last EV_WINDOW beats. Drift is tested on the whole window, coherence on the run. */
  private classify(lock: Lock, runP: number | null, runOff: number): EvidenceClass {
    const win = this.ts.slice(-EV_WINDOW);
    if (win.length >= 2 && isDrifting(gapsOf(win))) return 'drift';
    if (this.run.length < RUN_MIN || runP === null) return 'incoherent';
    if (Math.abs(runP / (2 * lock.periodUs) - 1) < HALF_TOL) return runOff === 0 ? 'half' : 'incoherent';
    if (runP < PERIOD_MIN || runP > PERIOD_MAX) return 'incoherent';
    return 'coherent';
  }

  /**
   * Pull the period toward the best estimate within AGREE_PERIOD. Established: the whole-track
   * trimmed mean when it agrees with the recent coherent run within 1%, else the run's mean gap.
   * Young: the 12-beat fit, so a sparse-intro lock follows real drums quickly.
   */
  private steerPeriod(lock: Lock, firm: boolean, runP: number | null): void {
    let target: number | null;
    if (firm) {
      const P2 = this.longEstimate();
      target = P2 !== null && (runP === null || Math.abs(P2 / runP - 1) < STEER_LONG_TOL) ? P2 : runP ?? P2;
    } else {
      target = this.estimateFromBeats()?.periodUs ?? null;
    }
    if (target === null || Math.abs(target / lock.periodUs - 1) >= AGREE_PERIOD) return;
    lock.periodUs += (firm ? PULL_PERIOD_FIRM : pullPeriodLoose(lock.confidence)) * (target - lock.periodUs);
  }

  /**
   * RUN_MIN consecutive off-grid beats whose mean gap is the locked period (within 4%) and whose
   * offsets agree within 10% of a period: the grid has moved, not the tempo. Re-anchor onto them.
   */
  private tryPhaseRelock(slot: number): boolean {
    const lock = this.lock!;
    if (lock.dissent < RUN_MIN || this.run.length < RUN_MIN) return false;
    const tail = this.run.slice(-RUN_MIN);
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
      bpm: +(60e6 / lock.periodUs).toFixed(2), source: lock.source, why: `phase relock after ${RUN_MIN} beats`,
      shiftMs: Math.round(shift / 1000), confidence: +lock.confidence.toFixed(2),
    });
    this.emit();
    return true;
  }

  /**
   * A coherent run of RELOCK_BEATS spanning RELOCK_SPAN at another period replaces the lock,
   * whatever its confidence. Never onto half the tempo (the caller classified that as `half` or
   * `incoherent`); double is allowed: beats between our slots mean the grid is missing them.
   */
  private tryTempoRelock(runOff: number): void {
    const lock = this.lock!;
    if (this.run.length < RELOCK_BEATS) return;
    const ts = this.run.map((b) => b.ts);
    const span = ts[ts.length - 1] - ts[0];
    if (span < RELOCK_SPAN_US) return;
    const P = mean(gapsOf(ts));
    if (P < PERIOD_MIN || P > PERIOD_MAX) return;
    if (Math.abs(P / (2 * lock.periodUs) - 1) < HALF_TOL) return;
    this.relocks++;
    this.adopt(P, ts[ts.length - 1], 'server', `relock after ${ts.length} coherent beats over ${(span / 1e6).toFixed(1)} s (${runOff} off-grid)`, RELOCK_CONFIDENCE);
    this.ts = ts.slice(); this.all = ts.slice(); this.run = [];   // history restarts at the new tempo
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
    while (this.onsets.length && this.onsets[0].ts < timestampUs - 10_000_000) this.onsets.shift();
    if (!this.onsetFallback) return;
    // Server beats always win: if the stream offers `beat`, or a server lock exists, onsets are ignored.
    if (this.serverOffersBeats || this.lock?.source === 'server') return;
    if (this.now() - this.lastOnsetEstimate < 1000) return;
    this.onsetStep();
  }

  /** One onset estimate, judged against the lock or voted toward a first one. At most once a second. */
  private onsetStep(): void {
    const now = this.now();
    this.lastOnsetEstimate = now;
    const est = this.estimateFromOnsets();
    this.log('onset-est', est ? { bpm: +(60e6 / est.P).toFixed(1), score: +est.score.toFixed(2) } : { none: true });
    if (!est) { if (!this.lock) this.searching('onsets'); return; }
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
      // Dissent. Same idea as for beats: only coherent dissent moves the lock, and it must
      // persist for 4 estimates (2 while unsure) to replace it.
      lock.dissent++;
      if (!firm) lock.confidence *= CONF_LOSS_LOOSE;
      this.onsetVotes.push({ P: est.P, next: est.next, t: nowS, score: est.score });
      const need = firm ? ONSET_VOTES_FIRM : ONSET_VOTES_LOOSE;
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
    if (this.onsetVotes.length > ONSET_VOTES_LOOSE) this.onsetVotes.shift();
    const Ps = this.onsetVotes.map((v) => v.P);
    if (this.onsetVotes.length === ONSET_VOTES_LOOSE && Math.max(...Ps) / Math.min(...Ps) < 1.03) {
      this.adopt(mean(Ps), est.next, 'onsets', 'first onset lock', Math.min(0.5, est.score - 0.3));
      this.onsetVotes = [];
    } else this.searching('onsets');
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
    this.log('tempo', { bpm: +this.bpm.toFixed(2), source: lock.source, ev: this.evidence, dissent: lock.dissent, confidence: +lock.confidence.toFixed(2), established: lock.confidence >= ESTABLISHED });
    this.opts.onClock({ period: lock.periodUs / 1e6, nextBeatAt: this.nextLocal });
  }

  private log(kind: string, data: Record<string, unknown>): void {
    this.opts.log?.({ t: +(this.now() / 1000).toFixed(2), kind, ...data });
  }
}
