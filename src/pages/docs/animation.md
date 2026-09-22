---
layout: ../../layouts/DocsLayout.astro
title: Animation model
description: The dash queue, easing, colours and the public API of the logo module.
---

# Animation model

Implemented in `logo.js`. This document is the specification of what the animation does, so it can
be reimplemented without SVG.

## The queue

Each chain (solid path, see [Geometry](/docs/geometry)) carries an explicit **queue of elements**, each
`{ p, len, dash, color }`, contiguous and sorted by pattern position `p`. A chain has a scalar
`phase`. An element occupies path distance `u = p + phase` … `p + len + phase`, where `u = 0` is
the chain's entry (top-right end) and `u = T` its exit. Raising `phase` carries everything toward
the exit. Elements are **prepended** below the window (`p < −phase`) and enter at `u = 0`; elements
whose start passes `u = T` are dropped.

The queue is kept topped up so its lowest element starts at or below `−phase` (or one beat-pitch
further while beat-locked, so a dash is always on approach).

Blocks that can be prepended:

- **static** — the logo's own segments: `[L0, GAP, L1, GAP, …]` for the chain's arcs (`GAP = 8`).
  With the queue holding exactly one static block and `phase` set so it sits at `u ∈ [0, T + GAP]`,
  the rendering is the logo pixel-for-pixel.
- **anim** — each arc split into `n = max(1, round((L + GAP) / (dash + GAP)))` equal dashes with
  8-unit gaps, preserving the arc's total length. `dash` is a user setting (default 24).
- **random** — one dash of length `dash × U(0.5, 1.5)` plus an 8-unit gap.
- **beat** — one dash + gap per beat subdivision; see [Beat sync](/docs/beat-sync).

## Start, stop, and easing

- Animation **on**: queued-but-not-entered elements are discarded so the new kind is next, and the
  chain runs. Speed ramps from 0 with a smoothstep over `RAMP_IN = 1.0 s`.
- Animation **off**: one static block is queued next and a stop target is set at the phase where
  that block is home. The chain keeps flowing, decelerates with a quadratic ease-out over the
  distance it would cover in `DECEL_T = 1.4 s`, and lands exactly on target. Dashes already in
  flight simply exit ahead of it. Result: the logo re-forms exactly, never snaps.
- Speed (units/s) is low-pass filtered (`v += (target − v) · min(1, 4·dt)`) so nudging a slider
  never jolts.
- Leaving the beat lock (`clearBeatClock()`, e.g. on a track change) never jolts either: each path
  keeps the speed it had under the lock and the difference to the free flow decays,
  `dv ← dv · exp(−dt / 0.5)`, speed `= max(0, v + dv)`.
- Frame rate is capped (default 60 fps) regardless of display refresh.

## Colour

Every dash gets **one solid colour** when it is created, taken round-robin from a list
(`setDashColors([...])`). `recolor()` reassigns the shapes already on screen. Each shape's displayed
colour eases toward its target with time constant 0.45 s, so palette changes fade rather than snap;
the background reference eases the same way.

Per frame, a shape's colour = `mix(mix(bg, base, 0.5 + 0.5·level), white, 0.6·flash)`:

- `level` (0..1) is a per-arc brightness (spectrum hook), never dimming below half strength.
- `flash` (0..1) is an onset envelope decaying with `exp(−dt / 0.12)`.
- `pulse` (0..1) scales the whole mark by `1 + 0.1·pulse` about its centre, decaying with
  `exp(−dt / 0.22)`.

In the player, all three are opt-in and off by default; loudness drives speed instead (see
[Sendspin integration](/docs/sendspin-integration)).

## View switching

`setMode('joined' | 'offset')` toggles a class; CSS translates each half (and its guide group) by
±`SHIFT` over 1.2 s. On a mode change the chains of the new view are reset to the static block
(logo as drawn) and, if animating, start flowing again. Bridges are re-placed with the shear each
frame while the transition runs, then left alone.

## Public API of `mountLogo(container, opts)`

`opts`: `speed`, `dash`, `colorA`, `background`, `radius`, `maxFps`, `joinMs`.

Returns:

| Method | Effect |
|---|---|
| `setMode(m)`, `toggleMode()` | joined / offset view |
| `setAnimating(bool)` | start flowing / re-form the logo |
| `setSpeed(v)`, `setDash(len)`, `setRandom(bool)` | flow parameters |
| `setRadius(r)` | corner rounding blur; 0 disables the filter |
| `setDashColors(list)`, `setColors(a, b)`, `recolor()` | per-shape colours |
| `setBackground(hex)`, `setColorEase(s)` | colour mixing reference and fade time |
| `flash(x)`, `pulse(x)`, `setLevels([8])`, `clearLevels()` | music hooks (levels indexed by `BY_SIZE`) |
| `showGuides(bool)` | corner guides overlay |
| `setBeatClock({period, nextBeatAt})`, `clearBeatClock()` | beat lock input (see [Beat sync](/docs/beat-sync)) |
| `setBeatDiv(d)`, `setPathBeatDivs([...])`, `setBeatOffset(ms)` | subdivisions and visual offset |
| `showBeatMarkers(bool)`, `beatDebug()` | entry/exit rings with path numbers; per-path telemetry |
| `reset()`, `destroy()` | |

`BY_SIZE = [A1, B3, A0, B4, A3, B1, A4, B0]` orders arcs biggest first (bass → treble mapping).
`FLOW = { sA: [A0, A1, A3, A4], sB: [B0, B1, B3, B4] }` is each S in flow order.
