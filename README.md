# Sendspin visualiser concept

Proof of concept: the Sendspin logo as a music visualiser, driven by the Sendspin protocol. The
browser connects to Music Assistant as a Sendspin client, plays the audio, and animates the logo
from the server's analysis stream: loudness, beats, onsets, spectrum and artwork colours.

This repo is documentation-first. The intent is to reimplement the concept for other devices and
languages (an ESP32 with a small screen, native apps) from the docs, most likely with Claude doing
the reimplementation. Start with `CLAUDE.md`, then the docs at `/docs/` on the built site or in
`src/pages/docs/`.

It is an [Astro](https://astro.build) static site: the portable core lives in `src/lib/` with no
framework dependency, the UI is Astro components, and the docs are Markdown pages.

## Run it

```
npm install
npm run dev          # http://localhost:4321
```

- `/` — the Sendspin player. Enter your Music Assistant address (`192.168.1.10` is enough; the
  scheme and port `8927` are filled in) and press Connect. A player named "Sendspin Logo" appears in
  Music Assistant; play to it. (From the public GitHub Pages copy the same page asks for your
  Music Assistant Remote ID instead; see "Hosting it for others".)
- `/lab` — the logo lab: every animation control, no server needed, plus a fake 120 BPM clock to
  see the beat lock.
- `/docs/` — the documentation.
- No Music Assistant handy: `tools/testserver.py` streams a synthetic groove with beats
  (`tools/README.md`); connect the player to `127.0.0.1:8928`.

`npm run build` writes the static site to `dist/`; `npm run check` type-checks.

## Hosting it for others

Plain static files. The one thing to decide is how the player reaches Music Assistant's Sendspin
server, and the player picks it by where the page is served from (the `auto` route; the selector
in the control bar or `?route=ws|webrtc` overrides it):

- **Direct (`ws://`)**: the page opens `ws://<ma>:8927/sendspin` itself. Browsers only allow that
  from a page they consider local: served over plain `http://` from a LAN or loopback address
  (`npm run dev`, or `dist/` on a LAN http host). An `https://` page cannot open `ws://` (mixed
  content), and Chrome gates any *public* origin talking to a private address (Local Network
  Access: a prompt, or `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` when it cannot prompt).
- **Remote (WebRTC)**: the page connects the way the Music Assistant app does from outside the
  home, through Music Assistant's own **remote access**: a Remote ID, the Nabu Casa signalling
  server, an `RTCPeerConnection`, and a `sendspin` data channel that Music Assistant bridges onto
  the same Sendspin server. It works from any origin, https included, and from outside your LAN.
  Details in the [Sendspin integration doc](src/pages/docs/sendspin-integration.md).

`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on every push to `main`:
**https://mrdarrengriffin.github.io/sendspin-visualiser-concept-js/** (`site` and `base` in
`astro.config.mjs`). github.io enforces HTTPS, so that copy uses the remote route. Markdown links
in the docs are rewritten onto the base path by a small rehype plugin in the config, so keep them
root-absolute (`/docs/...`).

### Connecting from the hosted page

Once, in Music Assistant (2.7 or newer):

1. Open **Settings → Remote access** (in the core settings) and switch it **on**. No Home Assistant
   Cloud subscription is needed; with one, Music Assistant also gets TURN relays, which only matter
   on networks where a direct WebRTC path cannot be found.
2. Copy the **Remote ID** shown there: 26 letters and digits. It is derived from the server's
   WebRTC certificate, so the page can verify it is talking to your server and nothing else.

Then on the hosted page: the route reads `auto` (remote), paste the Remote ID into the field and
press Connect. The status line walks through `signalling`, `offer`, `answer` and ends at
`connected (remote, host→srflx)` or similar (the ICE candidate types of the path it found); a
"Sendspin Logo" player appears in Music Assistant as usual. The Remote ID is kept in the browser's
`localStorage` only, never in the URL. No Music Assistant user or token is involved: the
`sendspin` channel lands on the Sendspin server itself, which admits unpaired clients by default
exactly as it does on the LAN. Pairing, if the server demands it, shows its PIN in the status line
as before.

If it fails: "Server not found" means remote access is off or the ID is mistyped;
"WebRTC connection failed" means no path between browser and server was found (a restrictive
network; TURN via Home Assistant Cloud fixes that); "certificate does not match" means the peer
that answered is not the server the Remote ID names.

## Layout

| Path | What |
|---|---|
| `src/lib/logo/geometry.ts` | the eight arcs, chains, constants and pure helpers: the part a port copies |
| `src/lib/logo/index.ts` | the logo module: dash queue, per-shape colour, beat lock, `mountLogo()` |
| `src/lib/beat/tempo.ts` | the beat clock: one sticky lock fed by server beats (onset fallback); the last eight beats are classed coherent / half / drift / incoherent and only coherent runs move it; coasting |
| `src/lib/color.ts` | contrast, saturation, the palette policy |
| `src/lib/sendspin/client.ts` | typed surface of the patched Sendspin client and its lazy loader |
| `src/lib/sendspin/ma-webrtc.ts` | the remote route: Music Assistant remote-access signalling, certificate pinning, and a WebSocket-shaped `sendspin` data channel for the client to adopt |
| `src/lib/sendspin/vendor/` | the patched `@sendspin/sendspin-js` bundle (adds visualizer and colour roles) |
| `src/scripts/player.ts`, `src/scripts/lab.ts` | page wiring |
| `src/components/`, `src/layouts/`, `src/pages/` | Astro UI and the docs pages |
| `public/sendspin.svg` | the brand logo, untouched |
| `tools/` | the client-library patch, bundler config, local test server, rebuild notes |

## Player controls

react (loudness → speed), pulse, flash, spectrum (all opt-in), sat (palette saturation), beat
lock, onset tempo (fallback when the server sends no beats), divs (dashes per beat per path,
default `0.5,1,0.5,1,1`: the two long chains carry one dash per two beats), offset (visual beat
offset in ms), debug (palette strip, tempo line, beat lane),
markers (numbered entry/exit rings per path), joined/offset view, guides.

## Status

Working against Music Assistant dev (aiosendspin 9.1.1) as of September 2026. Known limits:

- Beats only exist for tracks Music Assistant's `smart_fades` analysis has processed, and only as far
  as its beat list goes; the client coasts on the measured tempo after that. Details in the beat
  sync doc.
- The beat clock holds one lock and lets the quality of the evidence, not its own confidence,
  decide how fast it moves: it locks provisionally on three consistent beats, is published to the
  logo only once established (about nine agreeing beats), re-phases after one bar of consistently
  shifted beats, relocks after six coherent beats spanning two seconds at another tempo (however
  confident it was), and holds through half-rate sections, gaps and ritardandos, coasting for the
  rest of the track when beats stop. The beat-sync doc has the classes and numbers.
- The onset tempo fallback is heuristic; octave errors are possible on ambiguous material.
- The corner-rounding filter is the main rendering cost; the porting doc has numbers.
