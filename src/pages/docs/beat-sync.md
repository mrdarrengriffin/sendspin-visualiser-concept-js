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

## The beat clock (in `player.html`)

### From Sendspin beats (preferred)

Music Assistant sends `beat` frames with server-clock timestamps, about 3 s ahead, quantised to the
20 ms audio chunk grid (so consecutive gaps alternate, e.g. 440/460 for a 450 ms beat). The player
releases each frame when the server clock reaches its timestamp, then:

1. Keep the last 12 beat timestamps (`ts`) and, for the track, all of them (`all`, max 600).
2. Discontinuity: if any gap in `ts` deviates more than 25% from the median, drop everything before
   it (missed beat, or a re-anchored schedule after a seek).
3. Short estimate: least-squares fit `t_i = a + P·i` over `ts` (phase and period, both averaged).
4. Long estimate, once `all` has ≥ 24 beats: **trimmed mean of gaps** (gaps within ±15% of the
   median). Use it if within 3% of the short one; otherwise restart `all` (tempo change). Do not use
   a line fit over `all`: a re-pushed schedule shifts later timestamps by an offset and biases it.
5. Octave guard: a new estimate at 2× or 0.5× the established period is held to the old period for
   8 s before being believed.
6. Predict the next beat from the fit, convert server→local (`local = now + (ts − serverNow)/1000`),
   call `setBeatClock`.

**Coasting.** With a long estimate in hand the grid runs for the rest of the track when beats stop
(accuracy ~0.03%, well under a beat over minutes); with only a short estimate it coasts 30 s. A
track change, seek (`stream/clear`) or stream end drops the grid immediately.

### From onsets (fallback, when the server has no beats)

Every `peak` frame is an onset with a strength. Every second, score candidate periods from 60 to
180 BPM (4 ms steps, refined to 0.25 ms) by phase clustering of the last 10 s of onsets:
`|Σ w·e^(2πi·t/P)| / Σ w`, weights `w = (0.3 + strength/255) · recency`. Prefer 80–160 BPM (×0.8
outside). Adopt when two consecutive estimates agree within 3% and score ≥ 0.5; once adopted, keep
it unless a different tempo keeps winning. Server beats always take precedence: if the stream
includes `beat`, or a server tempo is established for the track, onsets are ignored.

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
