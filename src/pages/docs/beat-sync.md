---
layout: ../../layouts/DocsLayout.astro
title: Beat sync
description: The beat lock, the tempo clock, and how Music Assistant produces beats.
---

# Beat sync

Goal: every dash enters its solid path exactly on a beat (or a chosen subdivision) and, because
each path is traversed in a whole number of beats, exits on a beat too. Guitar Hero, per path.

Two layers: the **beat clock** (a tempo and a phase reference, produced by the player from Sendspin
data) and the **lock** (how the logo places dashes on that clock). They are independent; the logo
only ever sees `setBeatClock({ period, nextBeatAt })`.

## The lock (in `logo.js`)

One master grid per stream: `period` (s) and `anchor` (a local timestamp on a beat). All paths use
this grid. Nothing is detected per path.

For a chain of length `T` with division `div` (dashes per beat; fractions allowed, 0.5 = one dash
spanning two beats):

- `n` = beats to traverse the path = `round(T / (v_wanted · period))`, at least 1, and a multiple of
  `1/div` when `div < 1` so a two-beat dash still exits on a beat. `v_wanted` is the energy-driven
  speed; `n` is only re-chosen when the current speed is more than 40% away from it (hysteresis).
- pitch `L = T / (n · div)`; speed `v = T / (n · period)`. Note `L` is independent of tempo.
- beat block = `[dash L − 8, gap 8]` (or two halves of `L` if `L ≤ 16`).

**Deterministic placement**, every frame, for the next not-yet-entered dash (leading edge at
pattern position `q = p + len`):

```
Pd     = period / div                          # grid spacing for this path
tau    = (anchor + offset − now) mod Pd        # seconds until the next grid time
target = −q − v · tau                          # phase that puts that edge at u = 0 exactly then
err    = wrap(target − phase, ±L/2)            # grid is periodic in L
```

`|err| ≤ 0.4` units: snap. Otherwise ease `phase += err · min(1, dt / 1.0)`, i.e. the flow speeds
up or slows down a little for about a second. Never slide dashes (that opened holes). Because
`target` is computed, not integrated, there is no steady-state lag and paths with different
divisions are mutually aligned by construction.

The queue is kept one pitch ahead of the entry line so a dash is always available to place.

**Anchor stability.** `setBeatClock` refines the anchor onto the latest estimate while keeping the
same beat count: `anchor = nextBeatAt − round((nextBeatAt − anchor) / period) · period`. It only
re-anchors from scratch when the period changes by more than 5%. This is what keeps multi-beat
divisions from flipping parity.

`setBeatOffset(ms)` shifts the visual grid later (+) or earlier (−) to compensate output latency the
browser cannot see (Bluetooth, TV). Persisted in the player.

Changing a division affects only dashes not yet on screen; visible ones finish their traversal at
the old spacing (one traversal of settle). This is deliberate; re-timing visible dashes would jump.

## The beat clock (`src/lib/beat/tempo.ts`, class `BeatClock`)

The clock is **sticky**. It holds one lock, `{ period, anchor, source, confidence }`, and treats
every new piece of evidence as a claim to be tested against that lock rather than as a new answer.
The governing idea: a lock is only ever moved by evidence that **agrees with itself**. One odd beat
proves nothing; a run of beats that form their own steady grid does.

**Confidence** (0..1) is earned, +0.06 per on-grid beat. A first lock starts at 0.3, so about nine
agreeing beats make it **established** (`confidence ≥ 0.8`, the `established` getter, `est` in the
player's debug line). Established is the mode the clock should spend a whole track in:

| | young (c < 0.8) | established (c ≥ 0.8) |
|---|---|---|
| phase pull per on-grid beat | 0.2 + 0.4·(1 − c) of the error (0.6 → 0.28) | 0.1 |
| period steering | 12-beat estimate, pull 0.1 + 0.3·(1 − c) | whole-track estimate only, pull 0.1 |
| isolated off-grid beat | confidence ×0.92, coast | **ignored**, coast |
| off-grid beat inside a rival run | ×0.85 | ×0.85 |
| on-grid beat while a rival run exists | no gain | no gain |
| coasting when beats stop | 30 s, then the lock is dropped | for the rest of the track |

Silence is never evidence: an established lock is only lowered by contradicting beats, never by
their absence.

**The steady run.** The clock remembers the most recent consecutive beats (up to 16) whose gaps all
agree within 10% of their median; a gap outside that restarts the run. Each beat in it is tagged
on-grid or off-grid (`|e| < 0.2·period` against the lock). The run is a **rival** when it holds at
least **K = 4** beats and at least half of them are off-grid. K = 4 is one bar: three agreeing
gaps is the shortest sequence that cannot be produced by a pushed pair of beats in a fill, and a
whole bar on another grid is the shortest thing that sounds like a new tempo rather than
syncopation. The half rule (not "all off-grid") is because a genuinely different tempo still lands
on the old grid now and then (6:5, 4:3, 2:1 ratios), while a half-tempo run (every beat on-grid)
is never a rival: octaves are handled by the divisions, not the lock.

Two things can then happen, in this order:

1. **Phase relock.** If the last K beats are all off-grid, their mean gap is the locked period
   within 4%, and their offsets agree within 10% of a period, the grid has moved but the tempo has
   not (a beat list re-pushed after a pause or re-anchor, quantised to the 20 ms chunk). Re-anchor
   at once onto their mean offset; keep the period and the confidence; `rephases++`; the logo eases
   the shift over its usual one second. Logged as `lock` with `why: "phase relock …"` and `shiftMs`.
2. **Tempo relock.** A rival run of at least **8** beats spanning at least **3 s · (1 + 2c)** (3 s
   when unsure, 9 s when sure) replaces the lock with its mean gap and last beat, at confidence 0.4;
   `relocks++`. The span shrinks as the rival costs confidence (×0.85 per off-grid beat), so an
   established lock yields to a steady new tempo in about 6–7 s and to nothing shorter. The
   whole-track window restarts from the run.

Every `dissent` log entry carries `offMs`, the run length, how many of its beats are off-grid,
whether it is a rival and its BPM, so a `dumpLog()` shows which case a real track produced.

### From Sendspin beats (preferred)

Music Assistant sends `beat` frames with server-clock timestamps, about 3 s ahead, quantised to the
20 ms audio chunk grid (so consecutive gaps alternate, e.g. 440/460 for a 450 ms beat). The player
releases each frame when the server clock reaches its timestamp, then:

1. **Estimate.** Keep the last 12 timestamps and, for the track, all of them (max 600). If a gap in
   the short window deviates > 25% from its median, use only what follows it (missed beat, or a
   schedule re-anchored after a seek). Short estimate: least-squares fit `t_i = a + P·i`. Long
   estimate once ≥ 24 beats: trimmed mean of gaps (within ±15% of median). Never line-fit the long
   window: a re-pushed schedule adds an offset that biases it.
2. **First lock** from the first short estimate (three beats), confidence 0.3.
3. **Judge each beat against the lock.** Phase error `e` = distance from the nearest grid time.
   Update the steady run. If `|e| < 0.2·period` the beat is on-grid: re-anchor at that grid slot
   pulled toward the beat by the table's rate, steer the period (young: toward the short estimate
   if within 4%; established: toward the long estimate if within 4%), earn confidence unless a
   rival run exists, clear `dissent`. Otherwise `dissent++`, try the phase relock, else coast and
   apply the table's cost.
4. **Replace** only by the tempo relock rule above.
5. Publish: next grid time ≥ now from the anchor, converted server→local
   (`local = now + (ts − serverNow)/1000`), to `setBeatClock`.

**Coasting.** An established lock, or one with ≥ 24 beats of history, runs for the rest of the
track when beats stop; a younger one coasts 30 s. Track change, seek (`stream/clear`) and stream end
drop the lock.

Measured on the test server (`tools/testserver.py`, 120 BPM, options in its docstring):

- *Fill* (two bars in every sixteen pushed off the grid, one beat dropped): confidence 1.00 before,
  during and after; `dissent` counted 1→5 and back to 0; relocks 0; all paths 0 ms throughout.
- *Phase shift* (`--shift-ms 200 --shift-at 30`): phase relock on the 4th shifted beat, 1.5 s after
  the shift, `shiftMs: 200`; confidence stayed 1.00, relocks 0, paths back to 0 ms within ~2 s.
- *Tempo change* (`--bpm2 100 --switch-at 40 --no-fill`): rival from the 4th beat, confidence
  1.00 → 0.44 over the next seven, relock to 100.0 BPM after 11 steady beats, 6.6 s after the switch;
  established again 8 s later; 0 ms errors from then on.
- *Sparse intro* (`--sparse 10 --no-fill`, every other beat for 10 s): first lock at 60 BPM; when
  the drums arrive every other beat is off-grid, the run is a rival, and the clock relocks to
  120 BPM once the run spans the confidence-scaled minimum: 5.0 s after the drums start (12 steady
  beats, 6 off-grid), and 5.5 s when the intro was long enough to establish the 60 BPM lock at
  1.00 first.

### From onsets (fallback, when the server has no beats)

Every `peak` frame is an onset with a strength. Every second, score candidate periods from 60 to
180 BPM (4 ms steps, refined to 0.25 ms) by phase clustering of the last 10 s of onsets:
`|Σ w·e^(2πi·t/P)| / Σ w`, weights `w = (0.3 + strength/255) · recency`. Prefer 80–160 BPM (×0.8
outside); ignore scores below 0.5. First lock when two consecutive estimates agree within 3%, with
confidence from the clustering score. Afterwards each estimate is judged against the lock like a
beat (period within 4%, phase within 0.2·period): agreement pulls and earns confidence (double for
scores ≥ 0.75). Dissent follows the beat rule: a young lock loses ×0.92 per dissenting estimate and
is replaced by 2 consecutive estimates that agree with each other (periods within 3%); an
established one ignores dissent unless 4 consecutive estimates agree, which replaces it. Server beats always take precedence: if the stream offers `beat`, or a server
lock exists, onsets are ignored.

Measured: on a clear-pulse track it locked at the correct 123 BPM with scores 0.73–0.93. Start-up
needs 6 onsets and two agreeing estimates, about 4 s of clear beat. Octave errors are possible on
ambiguous material; there is no downbeat information.

## What Music Assistant actually does (as of its dev branch, Sept 2026)

- Beats come **only** from the `smart_fades` audio-analysis provider (offline neural beat tracker,
  5–10 s per track). No provider → `beat` never offered.
- On track start (and after a seek) it pushes the analysis' beat list from the current position
  onward, all at once. If analysis isn't ready it polls every 3 s for up to 90 s, then withdraws
  `beat` from the stream (`stream/start` re-sent without it). So beats can appear seconds into a
  track, or after a rewind, or not at all.
- Beats stop where the analysis' list ends; the stream continues without them. That is why the
  client coasts.
- `tracks_downbeats` is false; downbeat flags are always 0.
- The spec has no tempo field. A BPM plus reference beat in the visualizer role would remove all
  of the estimation above; worth proposing.

## Server-side gotcha for anyone writing a Sendspin server

aiosendspin's visualizer role drops any beat whose timestamp is at or behind its "wire cursor",
the timestamp of the last frame it already sent (periodic frames run up to 3 s ahead of the
playhead while beats are pending). Beats must be fed **before** the audio they belong to is
committed. `tools/testserver.py` does this one chunk ahead.
