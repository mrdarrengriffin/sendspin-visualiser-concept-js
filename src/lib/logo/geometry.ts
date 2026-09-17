/**
 * Geometry of the Sendspin mark, derived from the brand SVG (viewBox 0 0 128 128).
 *
 * Two interleaved single-line S's, each four circular arcs, stroke 8, cut by a 45° slash into an
 * upper-left and a lower-right half that are offset 16 units along the slash and 8 across it.
 * See docs/geometry for the derivation and the numbers.
 *
 * This file is data plus pure functions and has no DOM dependency: it is the part a port copies.
 */

export const BRAND_RED = '#E25C4C';

/** Stroke width, in SVG user units. */
export const STROKE = 8;
/** Distance between any two path ends across the slash. Equals the stroke width. */
export const GAP = 8;
/** Per-half translation that closes the S's: 8 / sqrt(2) along the slash. */
export const SHIFT = 5.657;
/** Unit vector along the slash (bottom-left towards top-right). */
export const U: Vec = [Math.SQRT1_2, -Math.SQRT1_2];
/** Bridges are drawn this much longer at each end, tucked under the arcs, to hide seams. */
export const OVERLAP = 0.3;
/** The two lines every path end lies on in the offset view: x + y = k. */
export const BANK_LINES = [122.497, 133.811] as const;

export type Vec = readonly [number, number];
export type SegmentId = 'A0' | 'A1' | 'A3' | 'A4' | 'B0' | 'B1' | 'B3' | 'B4';
export type SName = 'sA' | 'sB';
export type Half = 'left' | 'right';
export type ViewMode = 'joined' | 'offset';

export interface SegmentDef {
  id: SegmentId;
  /** Which S this arc belongs to. */
  s: SName;
  /** Which side of the slash it sits on (which half moves with which translation). */
  half: Half;
  /** Angular extent in degrees. */
  sweep: 90 | 180;
  /** Centre-line radius. */
  radius: 15 | 31;
  /** Path data exactly as in the brand file. Reversed at load where REVERSED says so. */
  d: string;
}

/** The eight arcs. Order here is the drawing order inside each half. */
export const SEGMENTS: readonly SegmentDef[] = [
  { id: 'A1', s: 'sA', half: 'left', sweep: 180, radius: 31, d: 'M49.766 72.7315C43.9523 66.9179 40.6863 59.0329 40.6863 50.8112C40.6863 42.5895 43.9523 34.7045 49.766 28.8909C55.5796 23.0772 63.4646 19.8112 71.6863 19.8112C79.908 19.8112 87.793 23.0772 93.6066 28.8909' },
  { id: 'B1', s: 'sB', half: 'left', sweep: 180, radius: 15, d: 'M61.0797 61.4178C58.2666 58.6047 56.6863 54.7894 56.6863 50.8112C56.6863 46.8329 58.2666 43.0176 61.0797 40.2046C63.8927 37.3915 67.708 35.8112 71.6863 35.8112C75.6645 35.8112 79.4798 37.3915 82.2929 40.2046' },
  { id: 'B4', s: 'sB', half: 'left', sweep: 90, radius: 31, d: 'M17.2391 105.258C14.3604 102.38 12.077 98.9624 10.5191 95.2013C8.9612 91.4402 8.15936 87.4091 8.15936 83.3381C8.15936 79.2671 8.9612 75.236 10.5191 71.4749C12.077 67.7138 14.3604 64.2964 17.2391 61.4178' },
  { id: 'A4', s: 'sA', half: 'left', sweep: 90, radius: 15, d: 'M28.5528 93.9447C27.1599 92.5518 26.055 90.8982 25.3012 89.0783C24.5473 87.2585 24.1594 85.3079 24.1594 83.3381C24.1594 81.3683 24.5473 79.4177 25.3012 77.5978C26.055 75.778 27.1599 74.1244 28.5528 72.7315' },
  { id: 'B3', s: 'sB', half: 'right', sweep: 180, radius: 31, d: 'M78.0503 55.7609C83.8639 61.5746 87.1299 69.4595 87.1299 77.6812C87.1299 85.903 83.8639 93.7879 78.0503 99.6016C72.2366 105.415 64.3517 108.681 56.1299 108.681C47.9082 108.681 40.0233 105.415 34.2096 99.6016' },
  { id: 'A3', s: 'sA', half: 'right', sweep: 180, radius: 15, d: 'M66.7365 67.0746C69.5496 69.8877 71.1299 73.703 71.1299 77.6812C71.1299 81.6595 69.5496 85.4748 66.7365 88.2878C63.9235 91.1009 60.1082 92.6812 56.1299 92.6812C52.1517 92.6812 48.3364 91.1009 45.5233 88.2878' },
  { id: 'A0', s: 'sA', half: 'right', sweep: 90, radius: 31, d: 'M110.577 23.234C113.456 26.1126 115.739 29.5301 117.297 33.2911C118.855 37.0522 119.657 41.0834 119.657 45.1543C119.657 49.2253 118.855 53.2564 117.297 57.0175C115.739 60.7786 113.456 64.196 110.577 67.0746' },
  { id: 'B0', s: 'sB', half: 'right', sweep: 90, radius: 15, d: 'M99.2635 34.5477C100.656 35.9406 101.761 37.5942 102.515 39.4141C103.269 41.234 103.657 43.1845 103.657 45.1543C103.657 47.1242 103.269 49.0747 102.515 50.8946C101.761 52.7145 100.656 54.3681 99.2635 55.7609' },
];

/**
 * Arcs drawn against the flow direction in the brand file. Flow runs from each S's top-right cap
 * towards its bottom-left cap; these are reversed at load so every arc runs start -> end in flow.
 */
export const REVERSED: Record<SegmentId, boolean> = {
  A0: true, A1: true, A3: false, A4: false,
  B0: true, B1: true, B3: false, B4: false,
};

/**
 * Solid paths ("chains") per view: which arcs join across the 8-unit gaps.
 * Joined view: the faces line up S with S. Offset view (the logo as drawn): only three pairs of
 * faces sit directly opposite each other, each one S against the other; A0 and B4 stand alone.
 */
export const CHAINS: Record<ViewMode, readonly (readonly SegmentId[])[]> = {
  joined: [['A0', 'A1', 'A3', 'A4'], ['B0', 'B1', 'B3', 'B4']],
  offset: [['B0', 'A1'], ['B1', 'A3'], ['B3', 'A4'], ['A0'], ['B4']],
};

/** Each S in flow order (top-right cap first). */
export const FLOW: Record<SName, readonly SegmentId[]> = {
  sA: ['A0', 'A1', 'A3', 'A4'],
  sB: ['B0', 'B1', 'B3', 'B4'],
};

/** Arcs ordered biggest first: the natural bass-to-treble mapping for spectrum bins. */
export const BY_SIZE: readonly SegmentId[] = ['A1', 'B3', 'A0', 'B4', 'A3', 'B1', 'A4', 'B0'];

/** Per-half translation in each view's rest state. */
export const HALF_SHIFT: Record<ViewMode, Record<Half, Vec>> = {
  joined: { left: [SHIFT, -SHIFT], right: [-SHIFT, SHIFT] },
  offset: { left: [0, 0], right: [0, 0] },
};

/** Reverse a path made of one M and a run of cubic C commands. */
export function reversePath(d: string): string {
  const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const pts: Vec[] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  pts.reverse(); // P0 c c P1 c c P2 ... reversed is still M + C triplets
  let out = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 3) {
    out += ` C${pts[i][0]} ${pts[i][1]} ${pts[i + 1][0]} ${pts[i + 1][1]} ${pts[i + 2][0]} ${pts[i + 2][1]}`;
  }
  return out;
}

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
export const smoothstep = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
