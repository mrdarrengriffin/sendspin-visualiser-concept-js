# Sendspin visualiser concept

Proof of concept: the Sendspin logo as a music visualiser, driven by the Sendspin protocol. The
browser connects to Music Assistant as a Sendspin client, plays the audio, and animates the logo
from the server's analysis stream: loudness, beats, onsets, spectrum and artwork colours.

This repo is documentation-first. The intent is to reimplement the concept for other devices and
languages (an ESP32 with a small screen, native apps) using the docs, most likely with Claude doing
the reimplementation. Start with `CLAUDE.md`, then `docs/`.

## Run it

```
python -m http.server 8000        # in this folder
```

- http://localhost:8000/player.html — the Sendspin player. Enter `http://<music-assistant-ip>:8927`,
  press Connect. A player named "Sendspin Logo" appears in Music Assistant; play to it.
- http://localhost:8000/ — the logo lab: every animation control, no server needed, plus a fake
  120 BPM clock to see the beat lock.
- No Music Assistant handy: `tools/testserver.py` streams a synthetic groove with beats
  (`tools/README.md`); connect the player to `http://127.0.0.1:8928`.

## Files

| Path | What |
|---|---|
| `sendspin.svg` | the brand logo, untouched |
| `logo.js` | the logo module: geometry, flow queue, colours, beat lock (`mountLogo()`) |
| `index.html` | logo lab |
| `player.html` | Sendspin client + music mapping + debug UI |
| `vendor/sendspin/` | patched `@sendspin/sendspin-js` bundle (adds visualizer and colour roles) |
| `tools/` | the library patch, bundler config, local test server, rebuild notes |
| `docs/GEOMETRY.md` | the mark's geometry, chains, bridges, rendering model |
| `docs/ANIMATION.md` | queue model, easing, colours, public API |
| `docs/BEAT-SYNC.md` | beat lock math, tempo estimation, Music Assistant's beat behaviour |
| `docs/SENDSPIN-INTEGRATION.md` | protocol roles, frame formats, client patch, palette policy |
| `docs/PORTING.md` | what to keep and drop when reimplementing; measured cost |

## Player controls

react (loudness → speed), pulse, flash, spectrum (all opt-in), sat (palette saturation), debug
(palette strip, tempo line, beat lane), beat lock, onset tempo (fallback when the server sends no
beats), markers (numbered entry/exit rings per path), divs (dashes per beat per path, e.g.
`2,1,0.5,1,4`), offset (visual beat offset in ms), joined/offset view, guides.

## Status

Working against Music Assistant dev (aiosendspin 9.1.1) as of September 2026. Known limits:

- Beats only exist for tracks Music Assistant's `smart_fades` analysis has processed, and only as far
  as its beat list goes; the client coasts on the measured tempo after that. Details in
  `docs/BEAT-SYNC.md`.
- The onset tempo fallback is heuristic; octave errors are possible on ambiguous material.
- The corner-rounding filter is the main rendering cost; `docs/PORTING.md` has numbers.
