/** Colour helpers: hex/rgb conversion, mixing, WCAG contrast, saturation, and the palette policy. */

export type RGB = [number, number, number];

export const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const rgbToHex = (c: RGB): string =>
  '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

export const rgbToCss = (c: RGB): string => `rgb(${c.map(Math.round).join(',')})`;

/** Linear mix of two colours, t in 0..1. */
export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const mixHex = (a: string, b: string, t: number): string => rgbToHex(mixRgb(hexToRgb(a), hexToRgb(b), t));

/** Sendspin sends colours as [R, G, B]; null/undefined stays null. */
export const rgbArrayToHex = (c: number[] | null | undefined): string | null =>
  Array.isArray(c) && c.length === 3 ? rgbToHex([c[0], c[1], c[2]]) : null;

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio (>= 1). */
export function contrast(a: string, b: string): number {
  const la = luminance(a) + 0.05, lb = luminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

/** Scale HSL saturation by k, keeping hue and lightness. */
export function saturate(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as RGB;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return hex;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  const s2 = Math.min(1, s * k);
  const q = l < 0.5 ? l * (1 + s2) : l + s2 - l * s2, p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return rgbToHex([f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]);
}

/** The six colours of the Sendspin colour role, as hex strings (null where absent). */
export interface Palette {
  background_dark: string | null;
  background_light: string | null;
  primary: string | null;
  accent: string | null;
  on_dark: string | null;
  on_light: string | null;
}

export const PALETTE_KEYS = ['background_dark', 'background_light', 'primary', 'accent', 'on_dark', 'on_light'] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

export interface ShapeColours {
  /** Page / logo background. */
  background: string;
  /** Readable text colour on it. */
  foreground: string;
  /** Colours handed to shapes, in order. */
  shapes: string[];
  /** Which palette keys contributed. */
  used: PaletteKey[];
}

/**
 * Palette policy for a dark surface. Follows the spec's own pairing: background_dark is the surface
 * and on_dark is guaranteed readable on it (>= 4.5:1). primary, accent, background_light and
 * on_light carry the artwork's character but are not contrast-adjusted, so each is blended into
 * on_dark only as far as the result still clears `minContrast`. Colours that would need to be
 * almost entirely on_dark are dropped, as are near-duplicates.
 */
export function shapeColoursFor(p: Palette, opts: { minContrast?: number; saturation?: number; fallback?: string } = {}): ShapeColours {
  const minContrast = opts.minContrast ?? 3.5, k = opts.saturation ?? 1;
  const background = p.background_dark ?? '#111111';
  const onDark = p.on_dark ?? opts.fallback ?? '#f0f0f0';

  const safest = (col: string): string | null => {
    if (contrast(col, background) >= minContrast) return col;
    let lo = 0, hi = 1; // largest blend of col into onDark that stays readable
    for (let i = 0; i < 12; i++) {
      const t = (lo + hi) / 2;
      if (contrast(mixHex(onDark, col, t), background) >= minContrast) lo = t; else hi = t;
    }
    return lo < 0.2 ? null : mixHex(onDark, col, lo);
  };

  const picked: { key: PaletteKey; col: string }[] = [{ key: 'on_dark', col: onDark }];
  for (const key of ['primary', 'accent', 'background_light', 'on_light'] as const) {
    const raw = p[key];
    if (!raw) continue;
    const col = safest(raw);
    if (col && !picked.some((u) => contrast(u.col, col) < 1.15)) picked.push({ key, col });
  }
  return {
    background,
    foreground: onDark,
    shapes: picked.map((u) => saturate(u.col, k)),
    used: picked.map((u) => u.key),
  };
}
