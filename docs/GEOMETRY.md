# Logo geometry

Everything here is derived from `sendspin.svg` (viewBox `0 0 128 128`). All numbers are SVG user
units. The derivation was verified numerically: every residual below is under 0.001 units, i.e. the
rounding of the source file.

## The mark in one paragraph

The logo is **two interleaved single-line S's**, each drawn as a stroke of width 8, sliced by a
45° slash. Each S is four circular arcs. The two S's share two circle centres per loop (an outer
radius and an inner radius), so together they look like one double-line S plus two detached caps.
The slash cuts the whole figure into an upper-left half and a lower-right half, and the two halves
are **offset from each other by 16 units along the slash and 8 units across it**. The 8 across is
the visible dark gap; the 16 along is why the mark reads as "offset".

## Constants

| Name | Value | Meaning |
|---|---|---|
| `SW` | 8 | stroke width |
| `GAP` | 8 | distance between any two path ends across the slash (equals `SW`) |
| radii | 15, 31 | inner and outer line of every loop; pitch between lines is 16 = stroke + gap |
| slash direction `U` | (1, −1)/√2 | direction of the cut, from bottom-left to top-right |
| across direction | (1, 1)/√2 | perpendicular to the slash |
| half offset | 16 along `U`, 8 across | how the lower-right half is displaced from the upper-left half |
| `SHIFT` | 5.657 = 8/√2 | per-half translation that joins the S's: left half +(5.657, −5.657), right half −(5.657, −5.657) |
| loop centre spacing (joined) | 46 = 31 + 15 | outer line of one loop is tangent to inner line of the other |
| bank lines (offset view) | x + y = 122.497 and x + y = 133.811 | the two lines all 16 path ends sit on; 8 units apart |

## The eight arcs

Ids: letter = which S (`A` or `B`), digit = position. Sweep is the angular extent. Radius is of the
stroke centre-line. "Half" is which side of the slash the arc lives on. Centre coordinates are of
the circle the arc lies on, in the offset (as-drawn) view.

| Id | S | Half | Radius | Sweep | Centre (x, y) | Role in its S |
|---|---|---|---|---|---|---|
| A0 | A | right | 31 | 90° | (88.657, 45.154) | top cap, outer |
| A1 | A | left | 31 | 180° | (71.686, 50.811) | top loop, outer |
| A3 | A | right | 15 | 180° | (56.130, 77.681) | bottom loop, inner |
| A4 | A | left | 15 | 90° | (39.159, 83.338) | bottom cap, inner |
| B0 | B | right | 15 | 90° | (88.657, 45.154) | top cap, inner |
| B1 | B | left | 15 | 180° | (71.686, 50.811) | top loop, inner |
| B3 | B | right | 31 | 180° | (56.130, 77.681) | bottom loop, outer |
| B4 | B | left | 31 | 90° | (39.159, 83.338) | bottom cap, outer |

Arc lengths: 180° at r31 = 97.39, 180° at r15 = 47.12, 90° at r31 = 48.69, 90° at r15 = 23.56.

S-A runs outer on the top loop and inner on the bottom loop; S-B is the mirror (inner top, outer
bottom). Each S is the other rotated 180° about the canvas centre (63.908, 64.246).

The exact path data for each arc is in `SEGMENTS` in `logo.js` and is a verbatim copy of the
brand file. Regenerating from a new `sendspin.svg`: fit a circle to each path's on-curve points
(first point, then every third), read off centre and radius, and classify by radius and half.

## Flow direction

Every S is animated from its **top-right cap towards its bottom-left cap**. Four of the eight paths
are drawn against that direction in the source file and are reversed at load:

```
REV = { A0: true, A1: true, A3: false, A4: false, B0: true, B1: true, B3: false, B4: false }
```

Reversing a chain of cubic Béziers is reversing the point list (`M P0 C c1 c2 P1 C ...` becomes
`M Pn C ... c2 c1 P0`).

## Solid paths ("chains") in each view

A **chain** is a run of arcs that form one continuous line once the 8-unit gaps across the slash
are bridged. Which arcs join depends on the view, because the two halves slide relative to each
other.

**Joined view** (halves translated by ±`SHIFT` so the S's close): the faces line up S with S.

```
chains.joined = [ [A0, A1, A3, A4], [B0, B1, B3, B4] ]
```

**Offset view** (the logo as drawn): only three pairs of faces sit directly opposite each other
across the slash, and each pair is one S against the other:

```
chains.offset = [ [B0, A1], [B1, A3], [B3, A4], [A0], [B4] ]
```

`A0` (outer top cap) and `B4` (outer bottom cap) face empty slash and stand alone.

Chain lengths `T` (sum of arc lengths plus 8 per internal bridge): joined 232.8 each; offset
129.0, 102.2, 129.0, 48.7, 48.7. These drive the beat lock (see `BEAT-SYNC.md`).

Face positions along the slash (projection onto `U`), offset view, for reference:
upper-left bank: B4 −62.24, A4 −46.24, A1 −16.24 and 45.76, B1 −0.24 and 29.76;
lower-right bank: B3 −46.24 and 15.76, A3 −0.24 and −30.24, B0 45.76, A0 61.76.
Equal values on opposite banks are the joined pairs.

## Bridges

Each junction inside a chain is bridged by a straight 8-unit connector between the two faces, in
the coordinates of the view it belongs to. It is split into two 4-unit halves so each half can carry
the colour of the arc it touches. Every half is drawn `OVERLAP = 0.3` units longer at both ends,
tucked under the arcs, so abutting shapes never show an anti-aliasing seam.

During the join/offset transition the halves are translated by CSS, so a bridge's two faces are
displaced relative to each other along `U`. The bridge is drawn under a **shear** that keeps both
ends on the faces: with `m` the sideways displacement of face B relative to face A and `N` the unit
vector from A to B, the matrix is `I + (m / len) · U · Nᵀ`, applied about A. In a view's own rest
state the shear is the identity.

## Rendering model

The arcs and bridge halves are **geometry only**. Every visible shape is a dash in the flow queue
(see `ANIMATION.md`), rendered as one or more clones of the underlying piece paths showing only the
dash's range via `stroke-dasharray = "0 a b 100000"` (a = start along the piece, b = length). A dash
that straddles two pieces is two clones in the same colour, so a shape never changes colour
mid-way. Butt line caps throughout.

Corner rounding is a whole-drawing SVG filter: Gaussian blur (`stdDeviation` 0.8 by default) then a
steep alpha ramp (`feComponentTransfer` linear, slope 12, intercept −5.5). Straight edges stay put,
convex corners round by roughly the blur radius. It must be applied to the union of arcs and
bridges, never per element, or joins show. It is the most expensive part of rendering; see
`PORTING.md`.

Debug overlays (corner guides, beat markers) live in a separate `overlay` group outside the filter
and are translated with the halves via two matching guide groups.
