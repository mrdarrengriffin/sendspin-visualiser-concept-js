# Notes for Claude

This is a proof of concept of the Sendspin logo as a music visualiser, driven by the Sendspin
protocol. It exists to be **reimplemented** elsewhere (other devices, languages, apps). Treat the
docs as the specification and the code as a reference implementation.

## Read in this order

The docs are Markdown pages in `src/pages/docs/` (rendered at `/docs/` on the site):

1. `geometry.md` — what the mark is. The eight arcs, two S's, the slash, chains per view, bridges.
   Every number needed to redraw it, without the SVG.
2. `animation.md` — the dash queue. One mechanism gives the static logo, the flow, and the exact
   re-forming stop.
3. `beat-sync.md` — the beat lock and tempo clock. Formulas, not prose.
4. `sendspin-integration.md` — protocol roles, binary frame formats, the client-library patch,
   palette rules, hosting constraints.
5. `porting.md` — what to keep, drop, and what it costs.

## Code map

- `src/lib/` is the portable core and has no framework dependency. `logo/geometry.ts` is data and
  pure functions; `logo/index.ts` is the queue, renderer and beat lock behind `mountLogo()`;
  `beat/tempo.ts` is the `BeatClock`; `color.ts` the palette policy; `sendspin/client.ts` the typed
  surface of the patched client plus its loader.
- `src/scripts/player.ts` and `lab.ts` wire the lib to the DOM; UI elements are addressed by
  `data-control`, `data-track`, `data-beat`, `data-palette`, `data-logo` attributes, never ids.
- `src/components/` and `src/layouts/` are Astro; `src/pages/` has the player (`/`), the lab
  (`/lab`) and the docs.

## Invariants to preserve in any port

- The logo at rest is exactly the brand file: eight arcs, stroke 8, gap 8, halves offset 16 along
  and 8 across the 45° slash.
- Every visible shape is one solid colour, even when it spans two arcs across a bridge.
- All paths lock to **one** master beat grid; subdivisions divide that grid. Paths never detect
  anything individually. Placement is computed from the grid each frame, not steered.
- A stop always re-forms the logo exactly; corrections ease, they never open holes.
- Server beats take precedence over any client-side tempo guess.

## Running and testing here

- `npm install`, `npm run dev` (http://localhost:4321), `npm run check`, `npm run build`.
- Local server without Music Assistant: `tools/testserver.py` (needs `pip install "aiosendspin[server]"`),
  then connect the player to `127.0.0.1:8928`.
- Music Assistant address used during development: `192.168.3.2` (port 8927).
- Rebuilding the patched client: `tools/README.md`.
- Debug on the player page: `window.logo`, `window.player`, `window.clock`, and `window.dumpLog()`
  prints every beat frame, tempo decision and stream event of the session.

## Conventions

- Keep `src/lib/logo/` free of DOM assumptions beyond SVG itself, and free of imports outside
  `src/lib/`.
- Units: SVG user units for geometry, seconds for time in the logo module, microseconds on the
  Sendspin server clock, `performance.now()` ms locally.
- Path indices 0–4 in the offset view are `[B0,A1]`, `[B1,A3]`, `[B3,A4]`, `[A0]`, `[B4]`; the
  markers overlay shows these numbers on the mark.
- Update the docs when behaviour changes; they are the product here.
