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
  tag: string;
  /** Computed background-color. Alpha is resolved against ancestors by the
   *  sampler, so this is opaque unless the chain behind it was too. */
  bg: string;
  /** Computed color. */
  fg: string;
  /** Computed border-top-color, when the element actually has a border. */
  border?: string;
  /** On-screen area in CSS px². Zero-area samples are dropped by the sampler. */
  area: number;
  /** The element paints a background image, so its background is not ours to move. */
  hasBgImage: boolean;
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
export function chooseEngine(engine: "auto" | "dynamic" | "filter", analysis: Analysis): "dynamic" | "filter" {
  if (engine !== "auto") return engine;
  // A page with no usable samples cannot be remapped at all.
  if (!analysis.sampled) return "filter";
  return analysis.coverage >= 0.5 ? "dynamic" : "filter";
}

