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

The clock is **sticky**, and the **quality of the evidence, not the confidence of the lock, decides
how fast it moves**. It holds one lock, `{ period, anchor, source, confidence }`, and tests every
server beat against it. One odd beat proves nothing; a run of beats that agree with each other
moves any lock, however confident. A run that agrees with the lock, or contradicts nothing (half
rate, a gap, a ritardando), holds it.

**First lock, at once.** Detection starts with the first beat and never idles. Three beats whose two
gaps agree within 10% at a plausible tempo (57–200 BPM) give a provisional lock at confidence 0.3,
refined by every beat after. While nothing is locked the log carries `searching` at most once a
second (`via: beats | onsets`); the onset fallback, when it applies, is scored every second
whether or not new onsets arrive (`poll()`).

**Confidence** (0..1) is earned, +0.06 per agreeing beat. A first lock starts at 0.3, so about nine
agreeing beats make it **established** (`confidence ≥ 0.8`, the `established` getter, `est` in the
debug line). Confidence is not a wall against evidence. It does four things:

| | young (c < 0.8) | established (c ≥ 0.8) |
|---|---|---|
| phase pull per agreeing beat | 0.2 + 0.4·(1 − c) of the error (0.6 → 0.28) | 0.1 |
| period steering | toward the 12-beat fit, pull 0.1 + 0.3·(1 − c) | toward the whole-track estimate when it agrees with the recent run within 1%, else the run's mean gap; pull 0.1 |
| incoherent off-grid beat | confidence ×0.92 | ignored |
| coasting when beats stop | 30 s, then the lock is dropped | for the rest of the track |
| published to the logo | **no**: the flow stays loudness-driven | **yes**, and it stays published until the clock is reset |

**The clock is published to the logo only once established.** The player calls `setBeatClock` for
the first time when `established` turns true (about 4.5 s into a steady 120 BPM track) and keeps
calling it for every later update, relocks included, even if confidence dips below 0.8 again; a
reset (track change, seek, stream end) unpublishes. The debug line reads `searching`,
`provisional 120.0 bpm` or `locked 120.0 bpm`. Silence is never evidence: a lock is only lowered by
contradicting beats, never by their absence.

### Evidence classes

Each arriving beat is tagged on-grid or off-grid (`|e| < 0.2·period` against the lock, `e` the
distance to the nearest grid time), and the last **eight** beats (two bars of 4/4: long enough to
hold a fill and its recovery, short enough that a section change fills it in a few seconds) are
classified. The class is `evidence` on the clock, `ev` in the debug line and on every `tempo`,
`dissent` and `drift` log entry.

- The **run** is the longest tail of the window whose consecutive gaps agree with their median
  within **6%** (or 24 ms if that is larger: Music Assistant quantises beat times to its 20 ms audio
  chunks, so a 450 ms beat arrives as 440/460). Four beats make it evidence.
- `drift` — the window's most recent gaps change in one direction step after step: at least
  **three** consecutive gap changes with the same sign, each more than 0.5% of the median (one 20 ms
  chunk step counts, jitter does not), with no step back. A ritardando or accelerando. Tested on the
  whole window before anything else. A single jump followed by flat gaps has one significant step:
  that is a tempo change, not a drift. (A 2%-per-beat threshold was tried and missed 1.5%-per-beat
  slowdowns, which then relocked every six beats.)
- `half` — the run's mean gap is **2× the locked period within 6%** and every beat in it is on the
  grid: the server is skipping every other slot; the grid still fits.
- `coherent` — a run of at least four beats at a plausible tempo. Either at the **same period**
  (mean gap within 4% of the lock) or at a **new period**.
- `incoherent` — anything else: fills, syncopation, dropped beats, or fewer than four coherent
  beats yet.

### Rules

| evidence | action |
|---|---|
| coherent, same period, beat on-grid | **track**: re-anchor at the beat's slot pulled toward it by the table's rate, steer the period, +0.06 confidence, `dissent = 0` |
| coherent, same period, beat off-grid | **phase relock** once the last 4 beats are all off-grid with offsets agreeing within 10% of a period: re-anchor onto their mean offset at once, keep period and confidence, `rephases++` (logged `lock`, `why: "phase relock …"`, `shiftMs`). Otherwise hold. |
| coherent, new period | **hold**, then **tempo relock** once the run has **6 beats spanning ≥ 2 s** (a bar and a half; one 4/4 fill bar cannot do it): adopt its mean gap and last beat at confidence **0.5**, `relocks++`, the short and whole-track histories restart from the run. Independent of confidence. Never onto half the tempo. Double is allowed: beats between our slots mean the grid is missing them (a sparse intro). |
| half | **agreement**: pull the phase, earn confidence, never steer the period from those gaps. Octaves are the divisions' job. |
| drift | **hold everything**: no pulls, no confidence change, no candidate; logged as `drift` with the window's gaps |
| incoherent, beat on-grid | pull and earn as an agreeing beat (a fill's beats that happen to land on the grid) |
| incoherent, beat off-grid | hold; a young lock loses ×0.92 |
| no beats | coast at the locked period; young 30 s, established for the rest of the track |

### From Sendspin beats (preferred)

Music Assistant sends `beat` frames with server-clock timestamps, about 3 s ahead, quantised to the
20 ms audio chunk grid. The player releases each frame when the server clock reaches its timestamp,
then:

1. **Remember.** Keep the last 12 timestamps and, for the track, all of them (max 600). Short
   estimate: least-squares fit `t_i = a + P·i` over the 12, using only what follows any gap that
   deviates > 25% from the window's median (missed beat, schedule re-anchored after a seek). Long
   estimate once ≥ 24 beats: trimmed mean of gaps (within ±15% of median). Never line-fit the long
   window: a re-pushed schedule adds an offset that biases it.
2. **First lock** from three beats whose gaps agree within 10% (period from the short fit when it
   has enough beats), confidence 0.3.
3. **Judge each beat against the lock**: update the run, classify the window, apply the rules
   table. Every `dissent` entry carries `ev`, `offMs`, the run length, how many of its beats are
   off-grid and its BPM, so a `dumpLog()` shows which case a real track produced.
4. Publish: next grid time ≥ now from the anchor, converted server→local
   (`local = now + (ts − serverNow)/1000`), to `setBeatClock`, once established.

**Coasting.** An established lock, or one with ≥ 24 beats of history, runs for the rest of the
track when beats stop; a younger one coasts 30 s. Track change, seek (`stream/clear`) and stream end
drop the lock.

Measured on the test server (`tools/testserver.py`, 120 BPM, options in its docstring; times are
from the scenario event):

- *Fill* (two bars in every sixteen pushed off the grid, one beat dropped): `ev incoherent` during
  the fill, confidence 1.00 before, during and after; `dissent` counted 1→5 and back to 0; relocks
  0; all paths 0 ms throughout.
- *Tempo change* (`--bpm2 100 --switch-at 40 --no-fill`): coherent dissent from the 4th new beat,
  relock to 100.0 BPM on the 6th, **3.6 s** after the switch (was 6.6 s); confidence 0.5,
  established 3.4 s later; 0 ms errors within 4 s of the relock.
- *Phase shift* (`--shift-ms 200 --shift-at 30`): phase relock on the 4th shifted beat, 1.5 s after
  the shift, `shiftMs: 200`; confidence stayed 1.00, relocks 0, paths eased back to 0 ms within 3 s.
- *Halving* (`--half 30 45`, every other beat for 15 s): `ev half` from the 4th half-rate beat;
  120 BPM throughout, relocks 0, rephases 0, confidence 1.00, 0 ms errors before, during and after.
- *Gap* (`--gap 30 45`, no beats for 15 s): coasted 15 s at 120 BPM; on resume the beats were on
  the grid at once, relocks 0, 0 ms errors.
- *Ritardando* (`--rit-at 50 --rit-rate 0.03 --rit-beats 12`, then no more beats): `ev drift` from
  the third slowed beat (gaps 515/530/546 ms) to the last (713 ms); 120 BPM, confidence 1.00,
  relocks 0, 0 ms errors, then coasting for the rest of the track.
- *Sparse intro* (`--sparse 10 --no-fill`, every other beat for 10 s): first lock at 60 BPM after
  three sparse beats (not published: never established); when the drums arrive the run is coherent
  at twice the rate and the clock relocks to 120 BPM on the 6th drum beat, 1.5 s after they start,
  whatever the 60 BPM lock's confidence was; established and published 3 s later.

### From onsets (fallback, when the server has no beats)

Every `peak` frame is an onset with a strength. Every second, score candidate periods from 60 to
180 BPM (4 ms steps, refined to 0.25 ms) by phase clustering of the last 10 s of onsets:
`|Σ w·e^(2πi·t/P)| / Σ w`, weights `w = (0.3 + strength/255) · recency`. Prefer 80–160 BPM (×0.8
outside); ignore scores below 0.5. First lock when two consecutive estimates agree within 3%, with
confidence from the clustering score. Afterwards each estimate is judged against the lock like a
beat (period within 4%, phase within 0.2·period): agreement pulls and earns confidence (double for
scores ≥ 0.75). Dissent follows the beat idea (only coherent dissent moves the lock): a young lock loses ×0.92
per dissenting estimate and is replaced by 2 consecutive estimates that agree with each other
(periods within 3%); an established one ignores dissent unless 4 consecutive estimates agree, which
replaces it. Server beats always take precedence: if the stream offers `beat`, or a server lock
exists, onsets are ignored. Like a server lock, an onset lock reaches the logo only once established.

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
