// Detecting what the page ALREADY looks like, from its rendered colours.
//
// Pure: it takes samples and returns a judgement. The sampling (computed
// styles, rectangles, alpha resolution against ancestors) is apply.ts's DOM
// shell; this is the decision — and the decision that decides whether the
// feature feels smart or broken.
//
// WHY NOT `color-scheme`, A META TAG, OR THE MEDIA QUERY: all three are about
// what a page SAYS, not what it shows. `prefers-color-scheme` is a fact about
// the user's OS. Darkening an already-dark site is the most common way a
// dark-mode extension looks broken, so the verdict comes from the pixels the
// user is looking at and nothing else (prefers-color-scheme is used only in
// the boot path to pick the first frame's colour — index.ts). Classics:
//   * a dark header or video hero decides nothing — surfaces are weighted by
//     on-screen AREA;
//   * a transparent body is neither black nor white — the sampler resolves
//     alpha against ancestors or yields nothing;
//   * a page of images/canvas is out of reach — `media`-dominated pages read
//     low coverage, the engine's signal to invert instead of remap.

import {
  colorKey,
  contrastRatio,
  DARK_CANVAS_LUMINANCE,
  OPAQUE_ENOUGH,
  parseColor,
  relativeLuminance,
  type Rgba,
} from "./color";

/** One visible element, as the sampler measured it. */
export interface PageSample {
  selector: string;
  /**
   * A selector reaching THIS element and nothing else ("": none). `selector`
   * is a name shared with siblings, and a name carries one decision — where
   * the sharers disagree (one white card, one transparent), the honest answer
   * is a rule per element. Also how a page stops being half-painted: the old
   * answer dropped the whole disagreeing group, leaving light text on a
   * still-white panel.
   */
  solo?: string;
  /**
   * Share of the viewport (0..1+): whether this surface is a PANEL or a
   * BACKDROP. A corner-sized card may lift; a mid-grey half-screen square
   * may not (the sudoku board — the "harsh colors" report). mapSurface in
   * color.ts is the only consumer.
   */
  share?: number;
  tag: string;
  /** Computed background-color; alpha resolved against ancestors (opaque unless the chain behind is too). */
  bg: string;
  /** The element's OWN background-color, alpha and all. `bg` is for reading the page; this is for PAINTING it: painting a resolved alpha adds an opaque layer over a grid or a sibling-drawn canvas ("gray overlay hiding the grid"). */
  ownBg?: string;
  /** Computed color. */
  fg: string;
  /** Legacy single-colour border (the top side) for hand-built samples. */
  border?: string;
  /** Every painted border SIDE, each with its own colour. Reading only the top used to miss a bottom-only hairline entirely and repainted a coloured left accent from the top side's colour (merriam-webster hero kept all three light sides of `border: 4px solid rgba(255,255,255,.5)`). */
  borders?: Array<{ side: "top" | "right" | "bottom" | "left"; color: string }>;
  area: number;
  /** Paints a background image, so its background is not ours to move. */
  hasBgImage: boolean;
  /** Does anything but the image live inside (text/children)? Only asked of bg-image elements: a sort header is `#eaecf0 url(arrow)` WITH a label; a lazy-load placeholder holds the photo and its overlay. */
  hasContent?: boolean;
  /** Whether the background image is sized to COVER the element — settles the two shapes content cannot: a cover placeholder hides behind the photo completely (painting under it is free); a small transparent logo is artwork ON its backdrop (darkening erases the mark). Only `cover` and `100% 100%` count. */
  bgCovers?: boolean;
  /** Computed background-image when it is a GRADIENT: a surface whose stops are mapped like any other background colour (otherwise a pale hero wash stays pale). A `url()` value never lands here. */
  bgImage?: string;
  /** img/video/canvas/iframe/object/embed/picture/svg — never recoloured. */
  media: boolean;
  /** A PSEUDO-ELEMENT LAYER (::before/::after) of the element the selectors reach: no text of its own, so only its background is ours to move — the white veil a card paints over itself keeps a page half-light if only elements are sampled. */
  pseudo?: "::before" | "::after";
}

export interface Analysis {
  canvas: Rgba;
  text: Rgba;
  canvasKey: string;
  textKey: string;
  /** Dark enough that darkening again would be a mistake. */
  pageDark: boolean;
  /** How much of the sampled area the top-3 surface colours explain — the engine's confidence, as a measurement: flat pages read high (remap reaches everything); photograph/canvas pages read low (remap leaves holes; inversion does not). */
  coverage: number;
  sampled: boolean;
  distinct: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

// Deliberately no tolerance constant: "the same surface" is colorKey's
// qántisation to 16 levels — #ffffff and #fefefe are already one surface, at
// the same granularity the rule sheet keys by, so ranking and sheet cannot
// disagree about what a surface is.

function opaque(c: Rgba | null): c is Rgba {
  return !!c && c.a >= OPAQUE_ENOUGH;
}

/** Analyse the samples. Never throws, never null: an unusable page is decided "light" (what most pages are). */
export function analyze(samples: PageSample[]): Analysis {
  // A pseudo layer is not a surface text sits on; its area is its element's,
  // and letting it vote would hand the canvas to a full-page veil's colour.
  const usable = samples.filter((s) => s.area > 0 && !s.media && !s.pseudo);
  const surfaces = new Map<string, { color: Rgba; area: number }>();
  let totalArea = 0;
  for (const s of usable) {
    // Everything visible counts towards the area we are judged on...
    totalArea += s.area;
    // ...but a bg-IMAGE element is not a mappable surface; counting it as
    // explained would report confidence we do not have (this is what makes a
    // page of photographs read low and get the filter engine).
    if (s.hasBgImage) continue;
    const c = parseColor(s.bg);
    if (!opaque(c)) continue;
    const key = colorKey(c);
    const hit = surfaces.get(key);
    if (hit) hit.area += s.area;
    else surfaces.set(key, { color: c, area: s.area });
  }
  const ranked = Array.from(surfaces.entries()).sort((a, b) => b[1].area - a[1].area);
  if (!ranked.length || totalArea <= 0) {
    return {
      canvas: WHITE,
      text: BLACK,
      canvasKey: colorKey(WHITE),
      textKey: colorKey(BLACK),
      pageDark: false,
      coverage: 0,
      sampled: false,
      distinct: 0,
    };
  }
  const [canvasKey, canvasEntry] = ranked[0]!;
  const canvas = canvasEntry.color;

  // Text pole: the colour with the most AREA among elements actually ON the
  // canvas (contrast > 1.25 to it) and readable against it (> 1.8) — the
  // contrast gate is what stops a pale panel's own border from becoming "the
  // page's text".
  const textArea = new Map<string, { color: Rgba; area: number }>();
  for (const s of usable) {
    const bg = parseColor(s.bg);
    const fg = parseColor(s.fg);
    if (!opaque(bg) || !fg || fg.a < OPAQUE_ENOUGH) continue;
    if (contrastRatio(canvas, bg) > 1.25) continue; // not on the canvas
    if (contrastRatio(canvas, fg) < 1.8) continue; // not readable text
    const key = colorKey(fg);
    const hit = textArea.get(key);
    if (hit) hit.area += s.area;
    else textArea.set(key, { color: fg, area: s.area });
  }
  const textRanked = Array.from(textArea.entries()).sort((a, b) => b[1].area - a[1].area);
  const canvasLum = relativeLuminance(canvas);
  const fallbackText = canvasLum < DARK_CANVAS_LUMINANCE ? WHITE : BLACK;
  const text = textRanked.length ? textRanked[0]![1].color : fallbackText;

  const top3 = ranked.slice(0, 3).reduce((n, [, v]) => n + v.area, 0);
  return {
    canvas,
    text,
    canvasKey,
    textKey: textRanked.length ? textRanked[0]![0] : colorKey(fallbackText),
    pageDark: canvasLum < DARK_CANVAS_LUMINANCE,
    coverage: totalArea > 0 ? top3 / totalArea : 0,
    sampled: true,
    distinct: ranked.length,
  };
}

export type ThemeDirection = "darken" | "lighten";

export interface ApplyDecision {
  on: boolean;
  /** Why, fit for a toast or the trace. Never empty. */
  reason: string;
}

/** Whether to apply at all: the already-dark-page case as a named rule, not an `if` in the boot path — darkening a dark page destroys its theme, the most-complained-about dark-mode failure. */
export function shouldApply(
  direction: ThemeDirection,
  analysis: Analysis,
  skipAlreadyInScheme: boolean
): ApplyDecision {
  const dark = analysis.pageDark;
  if (direction === "darken") {
    if (!skipAlreadyInScheme) return { on: true, reason: "forced on (already-dark pages included)" };
    if (dark) return { on: false, reason: "the page is already dark" };
    return { on: true, reason: "light page → dark" };
  }
  if (!skipAlreadyInScheme) return { on: true, reason: "forced on (already-light pages included)" };
  if (!dark) return { on: false, reason: "the page is already light" };
  return { on: true, reason: "dark page → light" };
}

/**
 * Does the page SAY it can render dark, though showing light right now?
 *
 * The half of "use the site's own theme" pixels cannot see: a white canvas
 * because the OS is light may still ship a full dark theme behind
 * `color-scheme: light dark`. Signals are FACTS about the page — the computed
 * `color-scheme` (drives UA widgets and `light-dark()`) and a `<meta
 * name="color-scheme">` naming dark. `prefers-color-scheme` is deliberately
 * NOT consulted: an OS fact, and conflating the two is how dark-mode
 * extensions darken pages that were fine.
 */
export function declaresDarkSupport(colorScheme: string | null | undefined, metaColorScheme?: string | null): boolean {
  const value = String(colorScheme || "").toLowerCase();
  if (/\bdark\b/.test(value)) return true;
  const meta = String(metaColorScheme || "").toLowerCase();
  return /\bdark\b/.test(meta);
}

/**
 * The verdict on a page that MIGHT have its own dark theme. `awaiting` is the
 * only non-obvious state: support declared, caller asked for dark, re-measure
 * pending — the caller sets `color-scheme: dark`, re-samples, asks again, and
 * the second answer is the real one.
 */
export interface NativeDarkDecision {
  /** Take the page's own theme: no sheet, no remap, nothing to undo. */
  native: boolean;
  reason: string;
}

export function nativeDarkVerdict(
  declared: boolean,
  asked: boolean,
  analysis: Analysis
): NativeDarkDecision {
  if (!declared) return { native: false, reason: "the page declares no dark theme" };
  if (asked) {
    return analysis.pageDark
      ? { native: true, reason: "the site's own dark theme (color-scheme)" }
      : { native: false, reason: "the page declares dark but still renders light" };
  }
  return { native: false, reason: "the page declares a dark theme; asking for it" };
}

/**
 * Which engine to run.
 *
 * `auto` is one measured rule: remap when the palette explains most of the
 * screen, invert when it does not. Both engines are correct and fail in
 * opposite directions (remap leaves holes; inversion gets every pixel but
 * turns photographs negative), so the choice belongs to the page.
 *
 * HYSTERESIS because coverage is re-measured per pass and the engines paint
 * in opposite ways — a drifting page would remap one pass and invert the
 * next, a whole-page flash on any page with a lazy panel. The band is wide
 * on purpose: switching is a rare, decisive event, not a per-pass vote.
 */
export function chooseEngine(
  engine: "auto" | "dynamic" | "filter",
  analysis: Analysis,
  previous?: "dynamic" | "filter" | "native" | "auto" | null
): "dynamic" | "filter" {
  if (engine !== "auto") return engine;
  if (!analysis.sampled) return "filter";
  if (previous === "dynamic") return analysis.coverage >= 0.35 ? "dynamic" : "filter";
  if (previous === "filter") return analysis.coverage >= 0.6 ? "dynamic" : "filter";
  return analysis.coverage >= 0.5 ? "dynamic" : "filter";
}
