// Colour maths for the dark engine: parse, convert, measure, and re-map.
//
// Pure by construction — no DOM, no globals — for two reasons that are the house
// rule here: a module worth testing may not name the DOM in its signature (the
// Node-side test runner carries no DOM lib at all), and the interesting part of
// a dark mode is exactly this arithmetic. The sampling and the stylesheet are
// plumbing; the mapping is the feature.
//
// THE MAPPING, in one paragraph, because it is the answer to "why does this look
// better than an inversion". A blanket `filter: invert()` complements every
// colour, which turns a photograph into a negative and a brand blue into orange.
// What a dark theme actually wants is a change of LIGHTNESS that preserves hue
// and saturation, anchored on the two colours the page itself is built from:
// its canvas and its text. So the engine measures those two (see detect.ts),
// treats them as the source poles `srcBg`/`srcFg`, pairs them with the theme's
// own two poles `dstBg`/`dstFg`, and maps every other colour by linear
// interpolation through those anchors in HSL — clamping outside them, because
// extrapolation past pure white or black is not a colour.
//
// The clamp is worth stating plainly: a page using three near-white greys for
// three surfaces will collapse them onto one. That is the price of a two-anchor
// mapping and it is the right trade (they differ by 3% on a light page and will
// differ by ~3% on a dark one), but it is a real property of the model rather
// than a rounding detail, so it is written down and pinned by a test.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Hsl {
  /** Degrees, 0..360. */
  h: number;
  /** 0..1. */
  s: number;
  /** 0..1. */
  l: number;
}

/** The two anchors a lightness mapping is built from (0..1 lightness). */
export interface Anchors {
  srcBg: number;
  srcFg: number;
  dstBg: number;
  dstFg: number;
}

// Computed styles are always normalised to rgb()/rgba() by the browser, so this
// table exists for the tests and for hand-written values, not for the hot path.
const NAMED: Record<string, string> = {
  transparent: "rgba(0, 0, 0, 0)",
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  orange: "#ffa500",
  yellow: "#ffff00",
};

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);
export const clamp01 = (n: number): number => clamp(n, 0, 1);

function channel(raw: string, scale: number): number {
  const v = raw.trim();
  if (v.endsWith("%")) return clamp01(parseFloat(v) / 100) * 255;
  return clamp(parseFloat(v) * scale, 0, 255);
}

function alpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const v = raw.trim();
  if (v.endsWith("%")) return clamp01(parseFloat(v) / 100);
  const n = parseFloat(v);
  return Number.isFinite(n) ? clamp01(n) : 1;
}

/**
 * Parse a CSS colour. Returns null for anything not understood — and note that
 * "not understood" is a supported outcome: a caller that cannot parse a value
 * leaves that element alone rather than guessing a colour for it.
 */
export function parseColor(input: string): Rgba | null {
  let s = (input || "").trim().toLowerCase();
  if (!s) return null;
  const named = NAMED[s];
  if (named) s = named;

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const ok = /^[0-9a-f]+$/;
    if (!ok.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const kind = fn[1]!;
  const body = fn[2]!;
  // Comma form and the modern space form (`rgb(1 2 3 / 50%)`) both occur.
  const parts = body.indexOf(",") >= 0 ? body.split(",") : body.split(/[\s/]+/).filter(Boolean);
  // Three channels and at most one alpha. A longer list is not a colour, and
  // accepting it would mean every malformed value silently became an opaque one
  // — which is exactly the kind of guess this module refuses to make.
  if (kind.startsWith("rgb")) {
    if (parts.length < 3 || parts.length > 4) return null;
    return {
      r: channel(parts[0]!, 1),
      g: channel(parts[1]!, 1),
      b: channel(parts[2]!, 1),
      a: alpha(parts[3]),
    };
  }
  if (parts.length < 3 || parts.length > 4) return null;
  const h = ((parseFloat(parts[0]!) % 360) + 360) % 360;
  const sat = parts[1]!.endsWith("%") ? clamp01(parseFloat(parts[1]!) / 100) : clamp01(parseFloat(parts[1]!));
  const light = parts[2]!.endsWith("%") ? clamp01(parseFloat(parts[2]!) / 100) : clamp01(parseFloat(parts[2]!));
  const rgb = hslToRgb({ h, s: sat, l: light });
  return { ...rgb, a: alpha(parts[3]) };
}

/** The CSS text for a colour. Alpha is dropped only when it is exactly opaque. */
export function formatColor(c: Rgba): string {
  const r = Math.round(clamp(c.r, 0, 255));
  const g = Math.round(clamp(c.g, 0, 255));
  const b = Math.round(clamp(c.b, 0, 255));
  const a = clamp01(c.a);
  if (a >= 1) return "rgb(" + r + ", " + g + ", " + b + ")";
  return "rgba(" + r + ", " + g + ", " + b + ", " + Math.round(a * 1000) / 1000 + ")";
}

export function rgbToHsl(c: Rgba): Hsl {
  const r = clamp01(c.r / 255);
  const g = clamp01(c.g / 255);
  const b = clamp01(c.b / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return { h, s: clamp01(s), l };
}

export function hslToRgb(hsl: Hsl): Rgba {
  const h = ((hsl.h % 360) + 360) % 360;
  const s = clamp01(hsl.s);
  const l = clamp01(hsl.l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}

/**
 * WCAG relative luminance. Used for two decisions and nothing else: whether the
 * page's canvas is already dark, and whether two colours are far enough apart to
 * be a readable pair (which is how the text pole is chosen).
 */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = clamp01(v / 255);
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Map one lightness through the anchors.
 *
 * `t` is where the colour sits between the text pole and the canvas pole; the
 * result is the same position between the theme's poles. Both ends are clamped,
 * which is what makes a near-white surface land exactly on the theme's
 * background instead of a fraction of a shade away from it.
 */
export function mapLightness(l: number, a: Anchors): number {
  const span = a.srcBg - a.srcFg;
  if (Math.abs(span) < 1e-6) return clamp01(a.dstBg);
  const t = (clamp01(l) - a.srcFg) / span;
  return clamp01(a.dstFg + t * (a.dstBg - a.dstFg));
}

/**
 * Below this saturation a colour is a GREY: a neutral surface or text, rather
 * than a colour the page chose.
 *
 * The distinction earns its keep. A neutral that is re-mapped through the
 * theme's own two colours lands exactly ON them (the page's white becomes the
 * theme's canvas, not a grey with the same brightness) — which is what makes a
themed page look like it belongs to this product instead of merely being dark.
 * A saturated colour keeps the hue it was given, because a brand colour that
 * comes back as a different brand is a bug. 0.12 is the threshold: greys and
 * near-greys are in, anything a designer would call "a colour" is out.
 */
export const NEUTRAL_SATURATION = 0.12;

/** Linear blend in RGB: 0 → `from`, 1 → `to`. Alpha comes from the source. */
export function blend(from: Rgba, to: Rgba, t: number, alpha = 1): Rgba {
  const k = clamp01(t);
  return {
    r: from.r + (to.r - from.r) * k,
    g: from.g + (to.g - from.g) * k,
    b: from.b + (to.b - from.b) * k,
    a: alpha,
  };
}

/**
 * Re-map a colour: hue and saturation are kept, lightness moves.
 *
 * Saturation is deliberately NOT adjusted. Boosting it on dark backgrounds is
 * what some engines do and it makes muted colours loud; keeping it means the
 * mapped page reads like the original at a different exposure.
 *
 * `poles` are the theme's own two colours, and passing them changes the answer
 * for neutrals only (see NEUTRAL_SATURATION). Omitting them — which the tests of
 * the pure mapping do — takes the HSL path for everything, which is the same
 * answer for a saturated colour and a slightly different one for a grey.
 */
export function mapColor(c: Rgba, a: Anchors, poles?: { bg: Rgba; fg: Rgba }): Rgba {
  const hsl = rgbToHsl(c);
  const span = a.srcBg - a.srcFg;
  const t = Math.abs(span) < 1e-6 ? 1 : clamp01((clamp01(hsl.l) - a.srcFg) / span);
  if (poles && hsl.s < NEUTRAL_SATURATION) {
    return blend(poles.fg, poles.bg, t, c.a);
  }
  const mapped = hslToRgb({ h: hsl.h, s: hsl.s, l: mapLightness(hsl.l, a) });
  return { ...mapped, a: c.a };
}

/** A bucket key for counting how much of the page uses a given colour. */
export function colorKey(c: Rgba, levels = 16): string {
  const q = (v: number) => Math.round((clamp(v, 0, 255) / 255) * (levels - 1));
  return q(c.r) + "," + q(c.g) + "," + q(c.b);
}

/** Whether two colours are close enough to be treated as the same surface. */
export function nearColor(a: Rgba, b: Rgba, tol = 10): boolean {
  return (
    Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol
  );
}

/** Alpha below this is not a surface — it is a hint about one. */
export const OPAQUE_ENOUGH = 0.5;

/** The luminance below which a canvas counts as dark. */
export const DARK_CANVAS_LUMINANCE = 0.4;
