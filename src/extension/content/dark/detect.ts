// Detecting what the page ALREADY looks like, from its rendered colours.
//
// Pure: it takes samples and returns a judgement. The sampling — reading
// computed styles, measuring rectangles, resolving transparent backgrounds
// against ancestors — is the DOM shell in apply.ts; this module is the decision,
// and it is the decision that decides whether the feature feels smart or
// broken.
//
// WHY NOT `color-scheme`, A META TAG, OR THE MEDIA QUERY. All three are about
// what a page SAYS, not what it is showing: `color-scheme: light dark` means the
// site supports both, `prefers-color-scheme: dark` is a fact about the USER's
// operating system, and a `<meta name="color-scheme">` is a declaration the page
// is free to ignore. Darkening a site that is already rendering dark is the most
// common way a dark-mode extension looks broken, so the verdict comes from the
// pixels the user is looking at (as reported by the style system) and nothing
// else. `prefers-color-scheme` is used for exactly one thing, in the boot path:
// choosing which colour to paint BEFORE this analysis can run (see index.ts).
//
// The classic false positives are handled explicitly:
//   * a dark header or a video hero does not make a page dark — every surface is
//     weighted by its on-screen AREA, and the most-covered surface wins;
//   * a transparent body is not black (or white) — the sampler resolves alpha
//     against the ancestors and hands over an opaque colour, or nothing at all;
//   * a page whose content is inside an image or a canvas is out of reach — the
//     sample carries `media`, and a media-dominated page reads as low coverage,
//     which is the engine's signal to stop remapping and invert instead.

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
  /** A CSS selector that reaches this element (see selectorFor in apply.ts). */
  selector: string;
  /**
   * A selector that reaches THIS element and nothing else, or "" when there is
   * none.
   *
   * `selector` is a NAME — a class the element shares with its siblings — and a
   * name can only carry one decision. When the elements that share it disagree
   * (one white card, one transparent one) the honest answer is one rule per
   * element, and this is the selector that rule is written against. It is also
   * how a page stops being half-painted: the previous answer was to drop the
   * disagreeing group, which left light text on a still-white panel.
   */
  solo?: string;
  /**
   * The element's share of the viewport (area / viewport area), 0..1+.
   *
   * One question needs it: whether this surface is a PANEL or a BACKDROP. A
   * card the size of a corner may be lifted to a visible panel; a mid-grey
   * square covering half the screen may not — that is the sudoku board, and
   * lifting it as far as a panel goes is the report "harsh colors". See
   * `mapSurface` in color.ts, which is the only consumer.
   */
  share?: number;
  tag: string;
  /** Computed background-color. Alpha is resolved against ancestors by the
   *  sampler, so this is opaque unless the chain behind it was too. */
  bg: string;
  /**
   * The element's OWN `background-color`, alpha and all — the resolved `bg`
   * above is for reading the PAGE, this one is for painting it.
   *
   * The difference is the reported "gray overlay hiding the grid": a wrapper
   * with `background-color: transparent` resolves to the canvas behind it, and
   * painting that resolved colour back onto the wrapper turns a transparent
   * layer into an opaque one. On a normal page that is invisible (same colour);
   * over a grid, a photograph or a canvas drawn by a SIBLING it covers the
   * content completely. Only an element that paints its own colour may be
   * painted.
   */
  ownBg?: string;
  /** Computed color. */
  fg: string;
  /** Computed border-top-color, when the element actually has a border. */
  border?: string;
  /** On-screen area in CSS px². Zero-area samples are dropped by the sampler. */
  area: number;
  /** The element paints a background image, so its background is not ours to move. */
  hasBgImage: boolean;
  /**
   * The computed `background-image` when it is a GRADIENT rather than a picture.
   *
   * A gradient is a surface: its colour stops are mapped like any other
   * background colour, which is what stops a page's pale hero wash from staying
   * pale on a dark page. A value carrying `url()` never reaches here — that is
   * `hasBgImage`, and it is left alone.
   */
  bgImage?: string;
  /** img/video/canvas/iframe/object/embed/picture/svg — never recoloured. */
  media: boolean;
}

export interface Analysis {
  canvas: Rgba;
  text: Rgba;
  canvasKey: string;
  textKey: string;
  /** The canvas is dark enough that darkening it again would be a mistake. */
  pageDark: boolean;
  /**
   * How much of the sampled area the three most-used surface colours explain.
   *
   * This is the engine's confidence signal, and it is a MEASUREMENT rather than a
   * heuristic about the site: a page built from a handful of flat surfaces reads
   * high (the mapping will reach nearly everything the user can see), while a
   * page that is mostly photographs, gradients or canvas reads low (the mapping
   * will leave holes, and a uniform inversion will not).
   */
  coverage: number;
  /** Whether any sample had a usable surface at all. */
  sampled: boolean;
  distinct: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

// There is deliberately no tolerance constant here. "The same surface" is
// decided by `colorKey`, which quantises each channel to 16 levels — so #ffffff
// and #fefefe are already one surface, and a #f5f5f5 card is a separate one, at
// the same granularity the stylesheet keys its rules by. A second, differently
// sized tolerance for one of the two uses would make the ranking and the sheet
// disagree about what a surface is.

function opaque(c: Rgba | null): c is Rgba {
  return !!c && c.a >= OPAQUE_ENOUGH;
}

/**
 * Analyse the samples. Never throws, never returns null: a page with nothing
 * usable in it is decided as "light page" (which is what the overwhelming
 * majority of pages are) rather than left undecided.
 */
export function analyze(samples: PageSample[]): Analysis {
  const usable = samples.filter((s) => s.area > 0 && !s.media);
  const surfaces = new Map<string, { color: Rgba; area: number }>();
  let totalArea = 0;
  for (const s of usable) {
    // Every visible element counts towards the area we are judged on…
    totalArea += s.area;
    // …but an element painting a background IMAGE is not a surface whose colour
    // we can map: the engine will leave it alone, so counting it as "explained"
    // would report confidence we do not have. This is what makes a page built
    // out of photographs and gradient panels read as low coverage and get the
    // filter engine instead of a half-finished remap.
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

  // The text pole: the colour with the most AREA among elements that actually
  // sit on the canvas and are far enough from it to be readable. Requiring the
  // contrast is what stops a large pale panel's own border colour from being
  // mistaken for the page's text.
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
  /** Why, in a phrase fit for a toast or the trace. Never empty. */
  reason: string;
}

/**
 * Whether to apply at all. The whole point of this function is the
 * already-dark-page case, so it is a named rule rather than an `if` in the boot
 * path: darken a dark page and the site's own carefully-built theme is destroyed,
 * which is the single most common complaint about dark-mode extensions.
 */
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
 * Which engine to run.
 *
 * `auto` is where the "smart" lives, and it is one measured rule: remap the
 * page's own palette when the palette explains most of what is on screen, and
 * invert the whole page when it does not. Both are correct engines; they fail in
 * opposite directions (the remap leaves holes where it cannot see a colour, the
 * inversion gets every pixel but turns photographs into negatives), so the
 * choice belongs to the page rather than to a guess about the site.
 */
/**
 * Does the page SAY it can render dark, even though it is showing light right
 * now?
 *
 * This is the half of "use the site's own theme" that the pixel measurement
 * cannot see. A page whose canvas is white because the OS is light may still
 * ship a complete dark theme behind `color-scheme: light dark` (`light-dark()`,
 * `@media (prefers-color-scheme: dark)`, `:root[data-theme]`). Asking the site
 * for THAT theme is strictly better than recolouring its light one: the site's
 * dark theme is what its authors designed, down to every accent and border.
 *
 * The signals are the ones that are FACTS about the page rather than guesses:
 * the computed `color-scheme` (the declaration that makes UA widgets and
 * `light-dark()` follow the scheme) and a `<meta name="color-scheme">` that names
 * dark. `prefers-color-scheme` is deliberately NOT consulted — that is a fact
 * about the user's OS, not about the site, and treating the two as the same thing
 * is how a dark-mode extension darkens pages that were already fine.
 */
export function declaresDarkSupport(colorScheme: string | null | undefined, metaColorScheme?: string | null): boolean {
  const value = String(colorScheme || "").toLowerCase();
  if (/\bdark\b/.test(value)) {
    // `only dark` is dark support with no light variant: the page is dark already
    // or will be once it paints, and remapping it would fight the site.
    return true;
  }
  const meta = String(metaColorScheme || "").toLowerCase();
  return /\bdark\b/.test(meta);
}

/**
 * The verdict on a page that MIGHT have its own dark theme.
 *
 * `awaiting` is the only non-obvious state: the page declared support, the
 * caller asked it for dark, and the re-measure has not happened yet. The caller
 * sets `color-scheme: dark`, re-samples, and asks again with the new analysis —
 * so this function is called twice and the second answer is the real one.
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

export function chooseEngine(
  engine: "auto" | "dynamic" | "filter",
  analysis: Analysis,
  previous?: "dynamic" | "filter" | "native" | "auto" | null
): "dynamic" | "filter" {
  if (engine !== "auto") return engine;
  // A page with no usable samples cannot be remapped at all.
  if (!analysis.sampled) return "filter";
  // HYSTERESIS, because the coverage figure is re-measured on every pass and the
  // two engines paint the page in opposite ways. A page whose coverage drifts
  // across a single threshold would be remapped on one pass and inverted on the
  // next — a whole-page flash each time, on any page with an ad slot or a lazy
  // panel that changes size. The band is wide on purpose: switching is a rare,
  // decisive event (a page that turned out to be mostly photographs, or one that
  // turned out to be flat after all), not a per-pass vote.
  if (previous === "dynamic") return analysis.coverage >= 0.35 ? "dynamic" : "filter";
  if (previous === "filter") return analysis.coverage >= 0.6 ? "dynamic" : "filter";
  return analysis.coverage >= 0.5 ? "dynamic" : "filter";
}

