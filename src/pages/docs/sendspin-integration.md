---
layout: ../../layouts/DocsLayout.astro
title: Sendspin integration
description: Roles, frame formats, the client patch, palette policy and hosting constraints.
---

# Sendspin integration

The browser is a Sendspin **client**. Music Assistant (or `tools/testserver.py`) is the server. All
audio analysis happens on the server; the client only renders.

Spec: https://github.com/Sendspin/spec. Relevant parts: `messaging.md` (handshake, `client/hello`,
`client/state`, `stream/*`, binary message ids), `roles/visualizer/v1.md`, `roles/color/v1.md`,
`roles/metadata/v1.md`.

## Connection

- Music Assistant listens at `ws://<ma-ip>:8927/sendspin`. The JS client takes
  `baseUrl: "http://<ma-ip>:8927"` and builds the WebSocket URL itself.
- Transport is encrypted (Noise). Unpaired ("Sentinel PSK") clients are admitted by default; a
  pairing PIN may be shown in the status line if the server requires pairing.
- `connect()` must follow `unlock()` inside a real click handler so the browser allows audio.

## Hosting constraints

- The Sendspin endpoint is `ws://` (no TLS by design). A page served over `https://` cannot open
  it (mixed content). Host over plain `http://`, or from the MA host (same origin), or use MA's
  WebRTC route: the MA frontend obtains ICE servers and signals an `RTCPeerConnection` through the
  authenticated MA API (`sendspin/ice_servers`, `sendspin/connect`, `sendspin/ice`), then hands the
  DataChannel to sendspin-js as a bring-your-own transport. That works from any origin and from
  outside the LAN, at the cost of implementing the MA login.
- Chrome's Private Network Access rules may prompt or block a public page connecting to a private
  address; test on current browsers when hosting publicly.
- The connection needs a user gesture (click) before audio can start.

## Roles used

| Role | Purpose here |
|---|---|
| `player@v1` | the browser outputs the audio (Opus via WebCodecs); optional for a display-only device |
| `controller@v1` | transport buttons, volume |
| `metadata@v1` | title / artist / album / progress; `artwork_url` |
| `visualizer@v1` | loudness, beat, peak, spectrum frames |
| `color@v1` | six-colour palette derived from the artwork |

A display-only device (no audio output) should declare only `visualizer@v1`, `color@v1` and
`metadata@v1`. Music Assistant creates a "visualizer" player type for such clients and groups it
with a real player.

## The client library patch

`@sendspin/sendspin-js` (TypeScript, https://github.com/Sendspin/sendspin-js) only implements
player/controller/metadata. `tools/sendspin-js-visualizer-role.patch` (against commit 7d10307,
2026-08-11) adds:

- `visualizer@v1` and `color@v1` in `supported_roles`; `visualizer@v1_support` in `client/hello`.
- `client/state.visualizer` = the request object `{ types, rate_max, spectrum }`.
- dispatch of binary message ids 16–23 to `onVisualizerFrame`, decoded per spec; `stream/start`
  with a `visualizer` object (and no `player` object) handled; `stream/clear` / `stream/end`
  with the `visualizer` role.
- `server/state.color` stored and delivered through `onStateChange`.
- `SendspinPlayer` options `visualizer`, `onVisualizerFrame`, `onVisualizerStream`,
  `onVisualizerClear`; method `setVisualizerRequest()`.

**Compatibility quirk:** Music Assistant pins aiosendspin 9.1.1, whose `client/hello` parser still
requires `rate_max` and `types` (and optional `spectrum`) *inside* `visualizer@v1_support`; the
current spec moved them to `client/state`. The patch sends both. Unknown keys in `client/state`
are ignored by 9.1.1.

Build: see `tools/README.md`. Output is an ESM bundle in `src/lib/sendspin/vendor/` (Opus fallback decoder
as lazy chunks; Chrome uses WebCodecs and never loads them).

## Visualizer request used

```json
{ "types": ["loudness", "beat", "peak", "spectrum"], "rate_max": 30,
  "spectrum": { "n_disp_bins": 8, "scale": "mel", "f_min": 40, "f_max": 16000 } }
```

## Binary frame formats (ids 16–20)

`[type:1][timestamp:8 big-endian int64 µs][data]`, all uint16 big-endian. Scaled values: 0 = −60 dB,
65535 = 0 dB, A-weighted.

| id | type | data |
|---|---|---|
| 16 | loudness | uint16 |
| 17 | beat | uint8 flags, bit 0 = downbeat |
| 18 | f_peak | uint16 Hz, uint16 amplitude |
| 19 | spectrum | uint16 × n_disp_bins, low → high |
| 20 | peak (onset) | uint8 strength |

Timestamps are server-clock "display at" times. The player queues frames and releases them when
`getCurrentServerTimeUs()` reaches the timestamp (the library's time filter does the mapping);
frames older than 2 s on arrival are dropped. Beats arrive ~3 s early, periodic frames just ahead.

## Mapping to the logo (player.html)

| Input | Effect | Default |
|---|---|---|
| loudness | flow speed `8 + 120 · energy^1.6`, energy = attack 0.45 / release 0.08 smoothing of value/65535 | on |
| beat | tempo clock (see [Beat sync](/docs/beat-sync)); optional pulse | lock on, pulse off |
| peak | optional flash; onset tempo fallback input | flash off, fallback on |
| spectrum | optional per-arc brightness, per-band auto-gain (floor/peak trackers) | off |
| color | shape colours and page background | on |
| metadata | title, artist, album, progress bar, artwork thumbnail | on |
| stream start/end | animation on/off; stop re-forms the logo | |

## Colour role and contrast

Six colours arrive: `background_dark`, `background_light`, `primary`, `accent`, `on_dark`,
`on_light`. Only two pairs carry a contrast guarantee: `on_dark` ≥ 4.5:1 on `background_dark`,
`on_light` ≥ 4.5:1 on `background_light`. `primary` and `accent` are **not** contrast-adjusted.

Player policy (dark UI): surface = `background_dark`; shape colour list = `on_dark` first, then each
of `primary`, `accent`, `background_light`, `on_light` blended into `on_dark` only as far as the
result still clears 3.5:1 against the surface (binary search on the blend), dropping any that would
need to be almost entirely `on_dark`. Near-duplicates (< 1.15:1 apart) are removed. A saturation
multiplier is available. A future palette `timestamp` is honoured (scheduled for the audible track
change). The debug strip shows all six with their measured contrast ratios.

## Test server

`tools/testserver.py` is an aiosendspin server that streams a synthetic 120 BPM groove with beats,
a palette and metadata, port 8928. See `tools/README.md`. It exists so the whole pipeline can be
exercised without Music Assistant.
