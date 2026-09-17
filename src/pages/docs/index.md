---
layout: ../../layouts/DocsLayout.astro
title: Documentation
description: How the Sendspin visualiser concept works, written so it can be reimplemented elsewhere.
---

# Documentation

These pages are the specification of the concept; the code in this repository is one
implementation of it. They are written for a reader (human or Claude) who will rebuild it on
another platform, so they carry exact numbers, tables and formulas rather than descriptions of
the source.

Read in this order:

1. [Geometry](/docs/geometry): what the mark is. The eight arcs, the two S's, the slash, the chains
   per view, the bridges. Every number needed to redraw it without the SVG.
2. [Animation](/docs/animation): the dash queue. One mechanism gives the static logo, the flow and
   the exact re-forming stop.
3. [Beat sync](/docs/beat-sync): the beat lock and the tempo clock, as formulas.
4. [Sendspin integration](/docs/sendspin-integration): protocol roles, binary frame formats, the
   client-library patch, palette rules, hosting constraints.
5. [Porting](/docs/porting): what to keep, what to drop, and what it costs.

## Where things live in this repository

| Path | What |
|---|---|
| `src/lib/logo/geometry.ts` | the arcs, chains, constants and pure helpers: the part a port copies |
| `src/lib/logo/index.ts` | the logo module: queue, rendering, beat lock (`mountLogo()`) |
| `src/lib/beat/tempo.ts` | the beat clock: server beats, coasting, onset fallback |
| `src/lib/color.ts` | contrast, saturation, the palette policy |
| `src/lib/sendspin/client.ts` | typed surface of the patched Sendspin client and its loader |
| `src/scripts/player.ts`, `src/scripts/lab.ts` | page wiring |
| `src/components/`, `src/pages/` | Astro UI |
| `src/lib/sendspin/vendor/` | the patched `@sendspin/sendspin-js` bundle |
| `tools/` | the library patch, bundler config, local test server |
