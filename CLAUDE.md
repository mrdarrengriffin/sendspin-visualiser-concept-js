# Notes for Claude

This is a proof of concept of the Sendspin logo as a music visualiser, driven by the Sendspin
protocol. It exists to be **reimplemented** elsewhere (other devices, languages, apps). Treat the
docs as the specification and the code as a reference implementation.

## Read in this order

1. `docs/GEOMETRY.md` — what the mark is. The eight arcs, two S's, the slash, chains per view,
   bridges. Every number needed to redraw it, without the SVG.
2. `docs/ANIMATION.md` — the dash queue. One mechanism gives the static logo, the flow, and the
   exact re-forming stop.
3. `docs/BEAT-SYNC.md` — the beat lock and tempo clock. Formulas, not prose.
4. `docs/SENDSPIN-INTEGRATION.md` — protocol roles, binary frame formats, the client-library patch,
   palette rules.
5. `docs/PORTING.md` — what to keep, drop, and what it costs.

## Invariants to preserve in any port

- The logo at rest is exactly the brand file: eight arcs, stroke 8, gap 8, halves offset 16 along
  and 8 across the 45° slash.
- Every visible shape is one solid colour, even when it spans two arcs across a bridge.
- All paths lock to **one** master beat grid; subdivisions divide that grid. Paths never detect
  anything individually. Placement is computed from the grid each frame, not steered.
- A stop always re-forms the logo exactly; corrections ease, they never open holes.
- Server beats take precedence over any client-side tempo guess.

## Running and testing here

- `python -m http.server 8000` in the repo root; `player.html` and `index.html`.
- Local server without Music Assistant: `tools/testserver.py` (needs `pip install "aiosendspin[server]"`).
- Music Assistant address used during development: `http://192.168.3.2:8927`.
- Rebuilding the patched client: `tools/README.md`.
- Debug: `window.logo` and `window.player` on the player page; `window.dumpLog()` prints every beat
  frame, tempo decision and stream event of the session.

## Conventions

- `logo.js` is a single ES module with no dependencies; keep it that way.
- Units: SVG user units for geometry, seconds for time in the logo module, microseconds on the
  Sendspin server clock, `performance.now()` ms locally.
- Path indices 0–4 in the offset view are `[B0,A1]`, `[B1,A3]`, `[B3,A4]`, `[A0]`, `[B4]`; the
  markers overlay shows these numbers on the mark.
