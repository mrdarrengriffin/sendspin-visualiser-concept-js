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
  Music Assistant; play to it.
- `/lab` — the logo lab: every animation control, no server needed, plus a fake 120 BPM clock to
  see the beat lock.
- `/docs/` — the documentation.
- No Music Assistant handy: `tools/testserver.py` streams a synthetic groove with beats
  (`tools/README.md`); connect the player to `127.0.0.1:8928`.

`npm run build` writes the static site to `dist/`; `npm run check` type-checks.

## Hosting it for others

Plain static files, with one rule: **serve it over `http://`, not `https://`**. Music Assistant's
Sendspin endpoint is a plain `ws://` WebSocket (the protocol encrypts inside it with Noise), and
browsers block `ws://` connections from an HTTPS page. The player detects an HTTPS load and shows a
link to the http:// copy.

`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on every push to `main`. On a
custom domain, untick "Enforce HTTPS" in the Pages settings so the `http://` address stays
reachable; the default `*.github.io` domain enforces HTTPS and will not work for connecting. If the
site is served from a sub-path, set `base` in `astro.config.mjs`.

Browsers are also tightening rules for public pages talking to private networks. Serving the page
from the Music Assistant host itself, or over WebRTC through the MA API as MA's own frontend does,
avoids both issues; see the Sendspin integration doc.

## Layout

| Path | What |
|---|---|
| `src/lib/logo/geometry.ts` | the eight arcs, chains, constants and pure helpers: the part a port copies |
| `src/lib/logo/index.ts` | the logo module: dash queue, per-shape colour, beat lock, `mountLogo()` |
| `src/lib/beat/tempo.ts` | the beat clock: one sticky lock fed by server beats (onset fallback); the last eight beats are classed coherent / half / drift / incoherent and only coherent runs move it; coasting |
| `src/lib/color.ts` | contrast, saturation, the palette policy |
| `src/lib/sendspin/client.ts` | typed surface of the patched Sendspin client and its lazy loader |
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
