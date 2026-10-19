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

/* ------------------------------------------------------------------------
 * THE MODERN COLOUR SYNTAXES
 *
 * A computed colour is not always `rgb()`. Chrome and Firefox both hand back the
 * function the page wrote for everything outside the legacy set — `oklch()`
 * (Tailwind v4, Radix, and most design systems since 2024), `oklab()`, `hwb()`,
 * `color(srgb …)`, `color-mix()`, `light-dark()` — and an unparsed colour is not
 * a colour this engine can MOVE: `paints()` sees nothing to paint, the surface
 * keeps its light value while everything around it goes dark, and the page ends
 * up with the reported "gray overlay on some elements".
 *
 * These are conversions, not approximations: OKLab/OKLCH is Björn Ottosson's
 * space and the matrices below are his, `color(srgb …)` is already the working
 * space, and `hwb()` is the standard formula. `color-mix()` is resolved in
 * premultiplied sRGB — exact for a mix declared `in srgb`, and a faithful
 * approximation for the others, which is enough for a colour that is about to be
 * re-mapped by luminance anyway.
 *
 * WHAT IS DELIBERATELY NOT HERE: `lab()`/`lch()`, which need a D50→D65
 * chromatic adaptation, and `color(display-p3 …)` is converted through the P3
 * matrix anyway because a page that uses it usually uses it for an image rather
 * than a surface. An unparsed colour still leaves its element alone, which is
 * the same behaviour as before — the difference is how few colours reach it.
 * ---------------------------------------------------------------------- */

/** Split on separators that are not inside a nested function call. */
function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((p) => p.trim());
}

/** The channel numbers of `a b c / alpha`, the modern space-separated form. */
function channels(body: string): { nums: string[]; alphaRaw: string | undefined } {
  const slash = body.indexOf("/");
  const head = slash >= 0 ? body.slice(0, slash) : body;
  return {
    nums: head.trim().split(/[\s,]+/).filter(Boolean),
    alphaRaw: slash >= 0 ? body.slice(slash + 1).trim() : undefined,
  };
}

/** A number that may be written as a percentage. `none` is zero, per CSS. */
function num(raw: string | undefined, scale = 1): number {
  const v = String(raw ?? "").trim();
  if (!v || v === "none") return 0;
  if (v.endsWith("%")) return (parseFloat(v) / 100) * scale;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** A fraction that may be written as a percentage: `0.5` and `50%` are one value. */
function fraction(raw: string | undefined, scale = 1): number {
  const v = String(raw ?? "").trim();
  if (!v || v === "none") return 0;
  if (v.endsWith("%")) return clamp01(parseFloat(v) / 100);
  return clamp01(num(v, scale));
}

/** Linear-light sRGB → the 8-bit sRGB a page is written in. */
function encodeSrgb(v: number): number {
  const c = clamp01(v);
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/** Ottosson's OKLab → linear sRGB. */
function oklabToLinear(L: number, A: number, B: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/**
 * CIE Lab (D50) → linear sRGB: XYZ, then the Bradford adaptation to D65.
 *
 * The constants are the CSS Color 4 sample code's, and the white point matters:
 * `lab()` is defined against D50 while sRGB is D65, so skipping the adaptation
 * shifts every colour by a few percent — invisible on a mapped page, but it is
 * the difference between a colour this engine can move and one it cannot.
 */
function labToLinear(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const xr = fx * fx * fx > eps ? fx * fx * fx : (116 * fx - 16) / kappa;
  const yr = L > kappa * eps ? fy * fy * fy : L / kappa;
  const zr = fz * fz * fz > eps ? fz * fz * fz : (116 * fz - 16) / kappa;
  const x50 = (xr * 0.3457) / 0.3585;
  const y50 = yr;
  const z50 = (zr * (1 - 0.3457 - 0.3585)) / 0.3585;
  const X = 0.9554734 * x50 - 0.0230985 * y50 + 0.0632593 * z50;
  const Y = -0.0283697 * x50 + 1.0099955 * y50 + 0.0210414 * z50;
  const Z = 0.012314 * x50 - 0.0205077 * y50 + 1.3303659 * z50;
  return {
    r: 3.2409699419045226 * X - 1.537383177570094 * Y - 0.4986107602930034 * Z,
    g: -0.9692436362808796 * X + 1.8759675015077202 * Y + 0.04155505740717559 * Z,
    b: 0.05563007969699366 * X - 0.20397695888897652 * Y + 1.0569715142428786 * Z,
  };
}

/** `srgb-linear`/P3 components are linear-light: 8-bit sRGB needs the transfer. */
function linearToRgb(c: { r: number; g: number; b: number }, a: number): Rgba {
  return { r: encodeSrgb(c.r), g: encodeSrgb(c.g), b: encodeSrgb(c.b), a };
}

/** Everything outside the legacy rgb/hsl functions. Null when not understood. */
function parseAdvanced(kind: string, body: string): Rgba | null {
  if (kind === "oklab" || kind === "oklch") {
    const { nums, alphaRaw } = channels(body);
    if (nums.length < 3) return null;
    const L = fraction(nums[0], 1);
    let A: number;
    let B: number;
    if (kind === "oklab") {
      A = num(nums[1], 0.4);
      B = num(nums[2], 0.4);
    } else {
      const C = num(nums[1], 0.4);
      const H = (num(nums[2]) * Math.PI) / 180;
      A = C * Math.cos(H);
      B = C * Math.sin(H);
    }
    return linearToRgb(oklabToLinear(L, A, B), alpha(alphaRaw));
  }
  if (kind === "lab" || kind === "lch") {
    const { nums, alphaRaw } = channels(body);
    if (nums.length < 3) return null;
    // L is 0–100 (or a percentage of it); a and b are ±125, chroma ±150, and a
    // percentage means that full range, per CSS Color 4.
    const L = num(nums[0], 100);
    let A: number;
    let B: number;
    if (kind === "lab") {
      A = num(nums[1], 125);
      B = num(nums[2], 125);
    } else {
      const C = num(nums[1], 150);
      const H = (num(nums[2]) * Math.PI) / 180;
      A = C * Math.cos(H);
      B = C * Math.sin(H);
    }
    return linearToRgb(labToLinear(L, A, B), alpha(alphaRaw));
  }
  if (kind === "hwb") {
    const { nums, alphaRaw } = channels(body);
    if (nums.length < 3) return null;
    const h = ((num(nums[0]) % 360) + 360) % 360;
    let w = fraction(nums[1]);
    let b = fraction(nums[2]);
    const a = alpha(alphaRaw);
    if (w + b >= 1) {
      const g = (w / (w + b)) * 255;
      return { r: g, g, b: g, a };
    }
    const pure = hslToRgb({ h, s: 1, l: 0.5 });
    const mix = (v: number) => (v / 255) * (1 - w - b) * 255 + w * 255;
    return { r: mix(pure.r), g: mix(pure.g), b: mix(pure.b), a };
  }
  if (kind === "color") {
    const { nums, alphaRaw } = channels(body);
    if (nums.length < 4) return null;
    const space = nums[0]!.toLowerCase();
    const a = alpha(alphaRaw);
    const c1 = num(nums[1], 1);
    const c2 = num(nums[2], 1);
    const c3 = num(nums[3], 1);
    if (space === "srgb") return { r: clamp01(c1) * 255, g: clamp01(c2) * 255, b: clamp01(c3) * 255, a };
    if (space === "srgb-linear") return linearToRgb({ r: c1, g: c2, b: c3 }, a);
    if (space === "display-p3") {
      // Display P3 → sRGB, both linear-light. The matrix is the standard one; a
      // colour outside sRGB is clipped by `encodeSrgb`, which is what a browser
      // without a wider output device does with it too.
      const lr = 1.2249401 * c1 - 0.2249404 * c2;
      const lg = -0.0420569 * c1 + 1.0420571 * c2;
      const lb = -0.0196376 * c1 - 0.0786361 * c2 + 1.0982735 * c3;
      return linearToRgb({ r: lr, g: lg, b: lb }, a);
    }
    return null;
  }
  if (kind === "color-mix") {
    const parts = splitTop(body);
    if (parts.length < 3) return null;
    const left = mixOperand(parts[1]!);
    const right = mixOperand(parts[2]!);
    if (!left.color && !right.color) return null;
    // One percentage given means "this much of this one", and the rest to the
    // other; neither given means an even mix.
    let w1 = left.weight;
    let w2 = right.weight;
    if (w1 === undefined && w2 === undefined) {
      w1 = 50;
      w2 = 50;
    } else if (w1 === undefined) {
      w1 = 100 - (w2 ?? 50);
    } else if (w2 === undefined) {
      w2 = 100 - w1;
    }
    const share1 = w1 ?? 50;
    const share2 = w2 ?? 50;
    // The weights are normalised, so 30% + 40% is a 3:4 mix rather than a
    // three-quarter-opaque one.
    const weight = Math.max(1e-6, (share1 + share2) / 100);
    const a1 = (share1 / 100) * (left.color ? left.color.a : 0);
    const a2 = (share2 / 100) * (right.color ? right.color.a : 0);
    const total = a1 + a2;
    if (total <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const c1 = left.color || { r: 0, g: 0, b: 0, a: 0 };
    const c2 = right.color || { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (c1.r * a1 + c2.r * a2) / total,
      g: (c1.g * a1 + c2.g * a2) / total,
      b: (c1.b * a1 + c2.b * a2) / total,
      a: clamp01(total / weight),
    };
  }
  if (kind === "light-dark") {
    // The page is READ in its light scheme (see the scheme notes in theme.ts),
    // so the light alternative is the colour on screen.
    const parts = splitTop(body);
    return parts.length ? parseColor(parts[0]!) : null;
  }
  return null;
}

/** One side of a `color-mix()`: a colour and the share that goes with it. */
function mixOperand(raw: string): { color: Rgba | null; weight: number | undefined } {
  const m = /^(.*?)\s+([\d.]+)%$/.exec(raw.trim());
  if (!m) return { color: parseColor(raw.trim()), weight: undefined };
  return { color: parseColor(m[1]!.trim()), weight: clamp(parseFloat(m[2]!), 0, 100) };
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

  const fn = /^([a-z-]+)\(([\s\S]*)\)$/.exec(s);
  if (!fn) return null;
  const kind = fn[1]!;
  const body = fn[2]!;
  if (kind !== "rgb" && kind !== "rgba" && kind !== "hsl" && kind !== "hsla") {
    return parseAdvanced(kind, body);
  }
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
  const h = ((parseFloat(parts[0]!) % 360) + 360) % 360; // hsl

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

/* ------------------------------------------------------------------------
 * ROLE-AWARE MAPPING
 *
 * The positional mapping above (`mapColor`) is the right answer for a colour
 * whose job on the page is unknown, and it is still what the pure tests pin.
 * It is NOT the right answer for a real page, and the difference is the whole
 * reason dark modes look bad:
 *
 *   a dark navy hero header with white text is a SURFACE that is far from the
 *   canvas. Positional mapping treats "far from the canvas" as "text-like" and
 *   lightens it to near-white — so the header turns pale, its white text stays
 *   white, and the result is a washed-out bar nobody would design.
 *
 * A surface and an ink are different questions:
 *
 *   SURFACE  How far is this from the canvas, in EITHER direction? Keep that
 *            separation, compressed onto the dark side. A white panel becomes
 *            the canvas, a grey panel a slightly lighter panel, a navy header a
 *            visibly distinct navy panel, a red badge a deep red one.
 *
 *   INK      Where does this sit between the text pole and the canvas? Keep
 *            that position on the new side, but NEVER make ink darker than it
 *            already was: white text on a dark header is already correct on a
 *            dark page, and inverting it is how a dark theme produces black
 *            text on a black bar.
 *
 * Both are done in relative LUMINANCE rather than HSL lightness, because
 * luminance is the scale contrast is measured on: preserving an HSL lightness
 * across a canvas change makes a deep red (#c62828, luminance 0.09) come back
 * at a mid lightness with luminance 0.2 — a glowing badge. Targeting the
 * luminance keeps the colour's weight instead of just its position on a wheel.
 * ---------------------------------------------------------------------- */

/** The two colours a page is built from, and the two they become. */
export interface Poles {
  /** The page's canvas (bright on a light page). */
  canvas: Rgba;
  /** The page's text (dark on a light page). */
  ink: Rgba;
}

/**
 * How far a surface is allowed to sit from the canvas, at most.
 *
 * 0.13 luminance is roughly #3f3f3f over #16161e: a panel you can see without
 * a border, which is what the page's own layering looked like on white. Larger
 * and every card competes with the content; smaller and the page flattens to
 * one rectangle.
 */
const SURFACE_OFFSET = 0.13;

/**
 * Contrast to the canvas below which a colour IS the canvas.
 *
 * Tight on purpose. A page's surfaces are often only 5–10% away from its canvas
 * (#f2f4f8 on white is 1.1:1), and those are real panels the page wants the eye
 * to see — snapping them onto the canvas flattens the layout into one rectangle.
 * What this absorbs is the genuine rounding difference (#fefefe, #ffffff), which
 * has to land exactly on the theme's canvas or a white page becomes a wash of
 * near-misses.
 */
const CANVAS_SNAP = 1.045;

/** The least contrast between text and the surface it sits on. WCAG AA body text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** The least contrast that still reads as a border/rule rather than nothing. */
export const MIN_BORDER_CONTRAST = 1.3;

/**
 * The colour with the same hue and saturation whose luminance is `target`.
 *
 * Luminance is monotone in HSL lightness for a fixed hue and saturation, so a
 * bisection lands on the value exactly; the saturation is deliberately left
 * alone because a surface that changes hue is no longer the page's colour.
 * Impossible targets (a saturated blue cannot be pure white) return the closest
 * reachable colour rather than failing.
 */
export function withLuminance(c: Rgba, target: number): Rgba {
  const want = clamp01(target);
  if (want <= 0.0005) return { r: 0, g: 0, b: 0, a: c.a };
  if (want >= 0.9995) return { r: 255, g: 255, b: 255, a: c.a };
  const hsl = rgbToHsl(c);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (relativeLuminance(hslToRgb({ h: hsl.h, s: hsl.s, l: mid })) < want) lo = mid;
    else hi = mid;
  }
  const out = hslToRgb({ h: hsl.h, s: hsl.s, l: (lo + hi) / 2 });
  return { ...out, a: c.a };
}

/**
 * `c` moved away from `bg` until it reaches `min` contrast.
 *
 * The direction is chosen from the surface, not from the colour: on a dark
 * surface readable means lighter, on a light one it means darker. Hue and
 * saturation are kept while it works, and pure white/black is the fallback —
 * the point of this function is that no text is ever left unreadable, so it is
 * allowed to win over the palette when there is no tinted answer.
 */
export function ensureContrast(c: Rgba, bg: Rgba, min: number): Rgba {
  if (contrastRatio(c, bg) >= min) return c;
  const hsl = rgbToHsl(c);
  const towardLight = relativeLuminance(bg) < 0.5;
  let lo = towardLight ? hsl.l : 0;
  let hi = towardLight ? 1 : hsl.l;
  let found: Rgba | null = null;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const cand = hslToRgb({ h: hsl.h, s: hsl.s, l: mid });
    if (contrastRatio(cand, bg) >= min) {
      found = cand;
      if (towardLight) hi = mid;
      else lo = mid;
    } else if (towardLight) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (found) return { ...found, a: c.a };
  return towardLight ? { r: 255, g: 255, b: 255, a: c.a } : { r: 0, g: 0, b: 0, a: c.a };
}

/** `c` composited over an opaque `base`. A translucent surface's real colour. */
export function over(c: Rgba, base: Rgba): Rgba {
  const a = clamp01(c.a);
  return {
    r: c.r * a + base.r * (1 - a),
    g: c.g * a + base.g * (1 - a),
    b: c.b * a + base.b * (1 - a),
    a: 1,
  };
}

/**
 * A background: separation from the canvas, compressed onto the new canvas.
 *
 * See the block comment above. Two properties matter and both are tested: a
 * colour indistinguishable from the page's canvas lands EXACTLY on the theme's
 * canvas (so a white page becomes one clean colour rather than a wash of
 * near-misses), and a surface that was far from the canvas stays visibly
 * distinct — but as a panel, never as a second canvas.
 */
/**
 * How much of a screen a surface may cover before its offset is damped.
 *
 * See `share` below. Half a screen is the point at which a surface stops being
 * a panel and starts being a backdrop.
 */
const BACKDROP_SHARE = 0.5;

/**
 * A background: separation from the canvas, compressed onto the new canvas.
 *
 * See the block comment above. Three properties matter and all three are
 * tested: a colour indistinguishable from the page's canvas lands EXACTLY on
 * the theme's canvas (so a white page becomes one clean colour rather than a
 * wash of near-misses), a surface that was far from the canvas stays visibly
 * distinct — but as a panel, never as a second canvas — and a surface that
 * covers the SCREEN is quieter than a card that covers a corner.
 *
 * `share` is the element's area over the viewport's, and it is the one number
 * that separates "a card" from "the grey backdrop of a sudoku board". MEASURED
 * on nytimes.com/puzzles/sudoku: the board is `background:rgb(151,151,151)` —
 * a mid-grey half a million pixels wide (share 0.5) — and lifting it as far as
 * the model allows put a `rgb(94,94,94)` square on a `#16161e` page. That is
 * the report "bunch of artifacts and harsh colors": a panel's worth of lift is
 * right for a panel and glaring for a backdrop, so the offset is damped by how
 * much of the screen the surface covers.
 */
export function mapSurface(c: Rgba, src: Poles, dst: Poles, share = 0): Rgba {
  if (contrastRatio(c, src.canvas) <= CANVAS_SNAP) return { ...dst.canvas, a: c.a };
  const lc = relativeLuminance(src.canvas);
  const x = Math.min(1, Math.abs(relativeLuminance(c) - lc));
  const ld = relativeLuminance(dst.canvas);
  // A light canvas means the page is going dark, and a panel can only be seen
  // by being LIGHTER than it.
  const sign = ld > 0.5 ? -1 : 1;
  // SATURATED SURFACES GET LESS ROOM. A muted panel needs luminance to be seen
  // at all; a coloured one is already distinct by its hue, and lifting it as far
  // makes a navy header a vivid blue bar and a red badge a glowing one — the
  // "neon dark mode" look. Damping by the colour's own saturation keeps the
  // neutral layering intact and lets the colours keep their weight.
  const sat = rgbToHsl(c).s;
  // A BACKDROP IS NOT A PANEL. At half the screen and beyond the offset falls
  // to 45% of a panel's: still visible layering, no glare.
  const backdrop = 1 - 0.55 * clamp01(share / BACKDROP_SHARE);
  const room = SURFACE_OFFSET * (1 - 0.45 * clamp01(sat)) * backdrop;
  return withLuminance(c, clamp01(ld + sign * room * Math.pow(x, 0.6)));
}

/**
 * Text and other inks: keep the position between the two poles, and never darken.
 *
 * The "never darken" rule is what keeps white text on a dark header white. The
 * neutral path exists because a page's grey text should come back as this
 * theme's ink, not as a neutral grey that happens to have the same brightness —
 * that is what makes a themed page look like one design rather than a filter.
 */
export function mapInk(c: Rgba, src: Poles, dst: Poles): Rgba {
  const hsl = rgbToHsl(c);
  const lc = relativeLuminance(src.canvas);
  const lt = relativeLuminance(src.ink);
  const span = lc - lt;
  const t = Math.abs(span) < 1e-6 ? 1 : clamp01((relativeLuminance(c) - lt) / span);
  const darkening = relativeLuminance(dst.canvas) < 0.5;
  if (hsl.s < NEUTRAL_SATURATION) {
    const blended = blend(dst.ink, dst.canvas, t, c.a);
    return keepWeight(blended, c, darkening);
  }
  const ld = relativeLuminance(dst.canvas);
  const ink = relativeLuminance(dst.ink);
  const target = clamp01(ink + t * (ld - ink));
  return keepWeight(withLuminance(c, target), c, darkening);
}

/** The lighter (or darker) of the two, per the direction the page is moving. */
function keepWeight(mapped: Rgba, source: Rgba, darkening: boolean): Rgba {
  const a = relativeLuminance(mapped);
  const b = relativeLuminance(source);
  if (darkening) return a >= b ? mapped : { ...source };
  return a <= b ? mapped : { ...source };
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
