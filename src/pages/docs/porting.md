---
layout: ../../layouts/DocsLayout.astro
title: Porting guide
description: What to keep, what to drop, and what it costs when reimplementing elsewhere.
---

# Porting guide

For reimplementing this on another platform (native app, ESP32 with a small display, a different
language). Read [Geometry](/docs/geometry), [Animation](/docs/animation), [Beat sync](/docs/beat-sync) first; this file says what to keep,
what to drop, and what it costs.

## Keep verbatim

- The eight arcs (centre, radius, sweep, half) and the `REV` table. On a raster target you do not
  need the Bézier path data at all: an arc is `centre + r·(cos θ, sin θ)` over its sweep. Stroke
  width 8/128 of the canvas, butt caps.
- The chain tables for both views and the bridge geometry (8 units straight across the slash,
  split in two colour halves). Chain lengths `T` follow from the arc lengths.
- The queue model: elements with `(p, len, colour)`, one `phase` per chain, prepend below the entry,
  drop past the exit, static block = the logo. That single mechanism gives you the logo, the flow,
  and the exact re-forming stop.
- The beat lock formulas and the anchor rule. They are a few lines and platform-independent.
- The tempo clock rules if the source is Sendspin beats: one sticky lock, judge each beat against
  it, established at confidence 0.8 (pulls of 0.1; published to the visual only from then), the
  eight-beat evidence window and its classes (coherent within 6%, half at 2× on-grid, drift of three
  same-sign gap steps, incoherent), phase relock after 4 consistently shifted beats, tempo relock
  after 6 coherent beats spanning 2 s at a new period whatever the confidence, hold on half, drift
  and incoherent, coasting. The estimator behind it (regression over 12, trimmed-mean of gaps over
  the track, 25% discontinuity cut) feeds the period pull.

## Drop or simplify freely

- The SVG filter for corner rounding. On a raster target, draw each dash as an arc segment with
  small round-ish end caps, or just butt caps.
- The paper grain. On a raster target, a pre-rendered noise tile multiplied or soft-light
  blended inside the dash shapes gives the same look; keep it fixed in screen space.
- Per-shape colour easing, pulse, flash, spectrum brightness. Nice, not essential.
- The join/offset transition. Static offset view is the logo.
- The onset fallback. Prefer the server's beats; propose tempo in the protocol.

## Rendering a dash without SVG

A dash is the interval `[u0, u1]` along a chain. Walk the chain's pieces (arc, bridge half, arc,
…) with running offsets `s0`; for each piece the dash overlaps, draw the sub-range
`[max(u0, s0) − s0, min(u1, s0 + len) − s0]` of that piece: for an arc, angle range =
`θ_start + range / r`; for a bridge half, a straight segment. Same colour for all pieces of one
dash. Overlap adjacent pieces by a fraction of a unit to hide seams.

## Timing

Frame timing on a microcontroller: the model is time-based (`phase += v · dt`), so any frame rate
works. The beat lock needs `now` in the same clock as the beat anchor, converted from the Sendspin
server clock via the protocol's time filter (already part of any compliant client).

## Measured cost of the browser version (desktop, 165 Hz display, 60 fps cap)

JavaScript in animation callbacks, per second of wall time:

| Configuration | JS ms/s | ≈ % of one core |
|---|---|---|
| debug lane + readouts on | 82 | 8 |
| debug off | 34 | 3 |
| debug off, rounding filter off | 35 | 3 |

The rest is browser style/paint and GPU. The blur filter is the largest single GPU cost; two tabs
with it on pushed the GPU process near 90% on the test machine. For a constrained device: no
filter, 30 fps, no debug, and a display-only role (no audio decoding). Protocol work (WebSocket,
Noise decryption of ~65 small frames/s plus audio) is minor; audio decode is the only heavy
protocol-side item and is avoidable by not taking the player role.

## What must exist server-side

Loudness, spectrum, onsets and beats are computed by the server (aiosendspin's visualizer role).
Beats exist only when Music Assistant's `smart_fades` analysis has run for the track. A port
inherits all of these behaviours; see [Beat sync](/docs/beat-sync) for the consequences.
