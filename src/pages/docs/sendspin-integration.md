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

Two routes reach the same Sendspin server; everything above the transport is identical.

**Direct.** Music Assistant listens at `ws://<ma-ip>:8927/sendspin`. The JS client takes
`baseUrl: "http://<ma-ip>:8927"` and builds the WebSocket URL itself. Transport is encrypted
(Noise). Unpaired ("Sentinel PSK") clients are admitted by default; a pairing PIN may be shown in
the status line if the server requires pairing. `connect()` must follow `unlock()` inside a real
click handler so the browser allows audio.

**Remote** (Music Assistant remote access, `src/lib/sendspin/ma-webrtc.ts`). The page borrows the
route Music Assistant's own app uses from outside the home: an `RTCPeerConnection` to the Music
Assistant host, signalled by **Remote ID** through the Nabu Casa signalling server, carrying a
data channel labelled `sendspin` that Music Assistant's gateway pumps onto
`ws://<ma>:8927/sendspin` with text and binary frames preserved. The open channel is wrapped as a
WebSocket-shaped object and handed to the client through its `webSocket` option (sendspin-js
adopts a pre-opened socket instead of dialling `baseUrl`; adopted sockets never auto-reconnect).
Sequence, all signalling messages JSON text over `wss://signaling.music-assistant.io/ws`:

1. `{ type: "connect-request", remoteId }` → `{ type: "connected", sessionId, iceServers }`, or
   `{ type: "error", error }` ("Server not found" when remote access is off or the ID is wrong).
   The ICE servers come from the Music Assistant server: public STUN, plus Home Assistant Cloud
   TURN when the server has a subscription.
2. Create the peer connection with those ICE servers, create the `sendspin` channel
   (`ordered: true`) **before** the offer, then send `{ type: "offer", remoteId, sessionId,
   data: { type, sdp } }`. Local ICE candidates go out as `{ type: "ice-candidate", remoteId,
   sessionId, data }` as they appear; the gateway's arrive the same way (buffer them until the
   remote description is set).
3. `{ type: "answer", sessionId, data: { type, sdp } }`. **Pin it**: the Remote ID is the first 128
   bits of the SHA-256 fingerprint of the server's DTLS certificate, base32 (RFC 4648, no padding,
   with `9` written in place of `2`), 26 characters. Delete every non-SHA-256 `a=fingerprint:` line
   from the SDP and require every remaining SHA-256 fingerprint to start with those 16 bytes,
   otherwise abort. Only then `setRemoteDescription`.
4. The channel opens; the Sendspin handshake proceeds on it unchanged. Keep the signalling socket
   open for the life of the session: the gateway closes the whole peer connection when the
   signalling server reports the client gone. Answer `{ type: "ping" }` with `{ type: "pong" }`.

No Music Assistant login is involved. The Remote ID is the only input; the Sendspin protocol's own
Noise handshake and pairing rules apply on the channel exactly as on a LAN socket. (Music
Assistant also offers WebRTC signalled over its **authenticated API** — commands
`sendspin/ice_servers`, `sendspin/connect {offer}` → `{session_id, answer, ice_candidates}`,
`sendspin/ice {session_id, candidate}`, `sendspin/disconnect` — but that API is a `ws://` socket
on port 8095, blocked from an https page by the same rule as the Sendspin socket, so it is of no
use to a hosted page; the Remote ID route is.)

## Hosting constraints

- A plain `ws://` socket to a LAN address is only allowed from a page the browser treats as local:
  served over `http://` from a LAN or loopback host. Two rules block it elsewhere: mixed content
  (an `https://` page may not open `ws://`), and Chrome's Local Network Access rule for any
  *public* origin talking to a private address (a permission prompt, or
  `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` when it cannot prompt, as in headless Chrome).
  The GitHub Pages copy hits both.
- The remote route above has no such constraints: it works from any origin and from outside the
  LAN. Its costs are a one-off setting in Music Assistant (Settings → Remote access → on, copy the
  Remote ID), a WebRTC path between browser and server (STUN suffices on most home networks; TURN
  via Home Assistant Cloud covers the rest), and a few hundred milliseconds more to connect.
- The player chooses by hostname: a private IP, loopback, `.local`/`.lan`/bare intranet name means
  direct, anything else means remote; the control bar selector or `?route=ws|webrtc` overrides.
  The Remote ID is stored in `localStorage`, never in the URL.
- The connection needs a user gesture (click) before audio can start. On the remote route the
  socket is handed to the client while still connecting, so `unlock()` remains the click's first
  awaited work and signalling runs meanwhile.

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
| loudness | flow speed `8 + 72 · energy^1.4` units/s (8 at silence, 80 at full scale, flattened at the top so loud passages do not race), halved until the beat lock is published, energy = attack 0.45 / release 0.08 smoothing of value/65535 | on |
| beat | tempo clock (see [Beat sync](/docs/beat-sync)), published to the logo only once the lock is established; optional pulse | lock on, pulse off |
| peak | optional flash; onset tempo fallback input | flash off, fallback on |
| spectrum | optional per-arc brightness, per-band auto-gain (floor/peak trackers) | off |
| color | shape colours and page background | on |
| metadata | title, artist, album, progress bar, artwork thumbnail; artwork also as a full-page backdrop (cover, `blur(48px) saturate(1.3)`, opacity 0.35 over the palette background; each new artwork is decoded, then faded in over the old one in 1.2 s; a missing artwork clears it only after 3 s, so a gap between tracks does not flash) | on |
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
