// The theme: two poles, one sheet of CSS.
//
// Pure. Everything the engine needs to paint a page arrives here as data —
// samples, the analysis, the matched corpus, the user's settings — and leaves as
// a string of CSS. That is deliberate and it is what makes the engine testable:
// a unit test can assert the exact sheet a page-shaped input produces, without a
// browser, and the DOM shell (apply.ts) keeps only the measurement and the
// injection.
//
// WHAT THE SHEET CONTAINS, in cascade order, because the order IS the design:
//
//   1. the variables        — our own poles, plus upstream's variable names so
//                             an imported corpus can read them
//   2. the page guarantee   — html/body painted to the poles, so no white
//                             rectangle can survive under a transparent body
//   3. the mapping          — one rule per sampled element, keyed by a computed
//                             selector, `!important` so a page's own non-important
//                             rule cannot win
//   4. the corpus           — the site's own fixes, expanded (`${…}`), last among
//                             the engine's rules so they beat the generic ones
//   5. the user's CSS       — the last word, by definition
//
// The filter engine produces a different body for step 3 (one root filter plus
// counter-inversions) and shares 1, 4 and 5 unchanged.
//
// SCHEME ATTRIBUTE. The sheet defines both `data-lf-scheme` and the rewritten
// `[data-darkreader-scheme=…]` selectors from an imported corpus, because
// apply.ts sets the attribute on <html> when the theme is live. A corpus rule
// gated on the scheme therefore keeps working, which is the entire reason the
// rewrite exists rather than being a nicety.

import {
  asIs,
  asList,
  expandTemplates,
  hostAndPath,
  hostMatches,
  type DarkRule,
  type TemplateVars,
} from "../../../shared/dark-rules";
import type { SiteRule } from "../../../shared/types";
import {
  ensureContrast,
  formatColor,
  hslToRgb,
  MIN_BORDER_CONTRAST,
  MIN_TEXT_CONTRAST,
  mapInk,
  mapSurface,
  over,
  parseColor,
  relativeLuminance,
  rgbToHsl,
  type Anchors,
  type Rgba,
} from "./color";
import type { Analysis, PageSample, ThemeDirection } from "./detect";

export interface Theme {
  direction: ThemeDirection;
  engine: "dynamic" | "filter";
  /** The colour the page's canvas becomes. */
  background: string;
  /** The colour its text becomes. */
  foreground: string;
  /** The colour for a link that carries no styling of its own. */
  accent: string;
  brightness: number;
  contrast: number;
  sepia: number;
  grayscale: number;
  anchors: Anchors;
  /**
   * The two poles as colours, not just as lightnesses.
   *
   * A neutral surface or text colour is matched to these EXACTLY (see mapInk),
   * which is why `;Y d` on a white page produces this product's canvas rather
   * than a grey that happens to be as bright as it.
   */
  poles: { bg: Rgba; fg: Rgba };
  /**
   * The page's OWN two colours, kept because the mapping is now role-aware and
   * relative luminance (not HSL lightness) is what it is measured in.
   *
   * `anchors` above stays: it is the HSL view of the same two colours, it is
   * what the pure lightness tests are written against, and it is what lets the
   * sheet's poles be reasoned about without a document.
   */
  src: { canvas: Rgba; ink: Rgba };
}

/** One element's mapping: what the sampler saw and what it becomes. */
export interface StyleEntry {
  selector: string;
  bg?: string;
  fg?: string;
  /**
   * A border colour, written as `border-color` — every side at once.
   *
   * Only used when ALL of the element's painted sides share one colour, which
   * is the usual `border: 1px solid #e5e7eb`. When they differ (a card with a
   * coloured left accent) the colour goes into `borders` instead: one
   * `border-color` would repaint the accent from the top side's sample, which
   * is how a red rule turns grey.
   */
  border?: string;
  /**
   * Per-side border colours, for an element whose painted sides disagree.
   *
   * Measured on merriam-webster.com: a hero card is ringed by
   * `border: 4px solid rgba(255,255,255,.5)` on three sides. Computed only from
   * the TOP side (and only when that side has a width) it was invisible to the
   * engine, so the ring stayed a half-white hairline around a dark card — the
   * report "some gray overlay on some elements", as a 4px semi-transparent
   * white edge reads exactly as a grey one. Every painted side is sampled now,
   * and a TRANSLUCENT border is treated like a translucent surface: light ones
   * are mapped with their alpha kept, dark ones are scrims and stay.
   */
  borders?: Array<{ side: "top" | "right" | "bottom" | "left"; color: string }>;
  /**
   * A mapped `background-image` — a gradient whose colour stops went through
   * the same surface mapping as a flat background.
   *
   * Gradients used to be missed entirely (`hasBgImage` only looked for `url(`),
   * so a page's pale gradient washed over the mapped colour and left a light
   * panel on a dark page: the single most visible artifact this engine had. A
   * gradient that carries a `url()` is still a photograph and is left alone.
   */
  image?: string;
}

/** The elements the dynamic engine must not paint: media has its own colours. */
export const MEDIA_TAGS = "img,video,canvas,iframe,object,embed,picture,svg";

/**
 * Our own hosts, which the filter engine has to counter-invert: they are
 * children of <html>, so a root filter would turn the which-key overlay, the
 * popups, the hint layer, the status bar and the caret into negatives of
 * themselves. Every id here is set by the module that owns that surface.
 */
export const OUR_HOSTS = [
  "#lazyfox-leader",
  "#lazyfox-popups",
  "#lazyfox-popup",
  "#lazyfox-hints",
  "#lazyfox-status",
  "#lazyfox-status-reserve",
  "#lazyfox-caret",
  "#lazyfox-scroll-target",
  "#lazyfox-reader",
];

const DEFAULT_BG = "#16161e";
const DEFAULT_FG = "#c0caf5";
const DEFAULT_ACCENT = "#7aa2f7";

function color(value: string, fallback: string): Rgba {
  return parseColor(value) || parseColor(fallback)!;
}

/**
 * Build the theme for one page.
 *
 * The anchors are the whole mapping: the page's own canvas and text lightness
 * on the way in, the theme's two poles on the way out. `lighten` is the same
 * machinery with the poles swapped — a user who configured a dark theme and asks
 * for light on a dark page gets the two colours exchanged, which is exactly what
 * a two-pole model can say without inventing a second palette.
 */
export function buildTheme(
  settings: {
    background: string;
    foreground: string;
    accent: string;
    brightness: number;
    contrast: number;
    sepia: number;
    grayscale: number;
  },
  direction: ThemeDirection,
  engine: "dynamic" | "filter",
  analysis: Analysis
): Theme {
  const darkBg = color(settings.background, DEFAULT_BG);
  const lightFg = color(settings.foreground, DEFAULT_FG);
  const accentIn = color(settings.accent, DEFAULT_ACCENT);
  const bg = direction === "darken" ? darkBg : lightFg;
  const fg = direction === "darken" ? lightFg : darkBg;
  const accent = direction === "darken" ? accentIn : swapLightness(accentIn);
  // The anchors are HSL LIGHTNESSES, not relative luminances, and the two scales
  // are not interchangeable: #808080 is 0.502 by HSL lightness and 0.216 by
  // luminance. The mapping positions a colour BETWEEN the two poles, and the
  // position has to be measured with the same ruler the mapping uses — otherwise
  // every mid-tone lands somewhere the page never asked for, and the poles
  // themselves stop being exact. (Perceptual luminance still decides whether a
  // page is already dark; that is a different question and uses the other one.)
  return {
    direction,
    engine,
    background: formatColor(bg),
    foreground: formatColor(fg),
    accent: formatColor(accent),
    brightness: settings.brightness,
    contrast: settings.contrast,
    sepia: settings.sepia,
    grayscale: settings.grayscale,
    anchors: {
      srcBg: rgbToHsl(analysis.canvas).l,
      srcFg: rgbToHsl(analysis.text).l,
      dstBg: rgbToHsl(bg).l,
      dstFg: rgbToHsl(fg).l,
    },
    poles: { bg, fg },
    src: { canvas: analysis.canvas, ink: analysis.text },
  };
}

/**
 * A colour with its lightness mirrored — the accent, in light mode.
 *
 * One line of arithmetic, and it is a real decision rather than a detail: the
 * accent the user configured is chosen to sit on a DARK canvas, so on the light
 * side it has to move to the other end or it is unreadable.
 */
function swapLightness(c: Rgba): Rgba {
  const hsl = rgbToHsl(c);
  return hslToRgb({ h: hsl.h, s: hsl.s, l: 1 - hsl.l });
}

/**
 * The mapping for every sampled element that needs one.
 *
 * Three filters, and each of them is a rule rather than a taste call:
 *
 *  * media and elements painting a background image are left alone (the engine
 *    cannot recolour a photograph, and pretending to is how a dark theme gets
 *    its reputation);
 *  * an element whose colours are already the theme's poles is skipped, which is
 *    what keeps the sheet small on a page that is mostly transparent divs;
 *  * identical (selector-less) colour pairs collapse to one rule per colour pair
 *    per selector, because two elements with the same selector and the same
 *    colours are the same rule.
 */
/**
 * The theme's two poles in the shape the mapping speaks: canvas and ink.
 *
 * `poles` keeps the `bg`/`fg` names because they are what the settings and the
 * variables block use; `mapSurface`/`mapInk` take a pair named for the ROLE, so
 * that a call site cannot pass the ink where the canvas belongs.
 */
function dstPoles(theme: Theme) {
  return { canvas: theme.poles.bg, ink: theme.poles.fg };
}

/**
 * The sheet's budget, in rules.
 *
 * Raised from 4000 when the walk stopped being capped at the same number: a
 * Wikipedia article has 14 051 elements and 2 338 rules only ever described the
 * first 4 000 of them (see MAX_SCAN in apply.ts). The cap is still a cap — a
 * spreadsheet or a long feed can have a hundred thousand elements, and a
 * megabyte of CSS is not a theme — but it now sits above the documents a person
 * actually reads rather than below them.
 */
const MAX_ENTRIES = 9000;

/**
 * The mapping for every sampled element that needs one.
 *
 * ONE RULE PER SELECTOR WHEN THE ELEMENTS THAT WEAR IT AGREE, ONE RULE PER
 * ELEMENT WHEN THEY DO NOT.
 *
 * A selector on a real site is a NAME shared by many elements — `.card`,
 * `.dropdown-item`, `.btn` — so a rule keyed by it can only say one thing about
 * all of them. Grouping with a majority vote was the previous answer, and it is
 * what produced the reports this file is now written against: measured on
 * merriam-webster.com, 556 of 827 text elements were unreadable because a
 * heading's class was shared with a transparent wrapper, the transparent member
 * vetoed the group's background, and the white panel was never painted while
 * the text on it was mapped to near-white. The rule is not "take a vote", it is
 * "do not claim what you cannot paint":
 *
 *   * every element's own surface and ink are decided FROM THAT ELEMENT;
 *   * the decisions are coalesced into one rule ONLY when every member of the
 *     group produces the same declarations — the common case, and it keeps the
 *     sheet small;
 *   * otherwise each member gets its own rule, keyed by the selector that
 *     reaches it alone (`PageSample.solo`). No element is left unpainted, and
 *     no element is painted with a sibling's colours.
 */
export function entriesFor(samples: PageSample[], theme: Theme, ignored?: (s: PageSample) => boolean): StyleEntry[] {
  const groups = new Map<string, PageSample[]>();
  for (const s of samples) {
    if (s.media || s.area <= 0) continue;
    if (ignored && ignored(s)) continue;
    const list = groups.get(s.selector);
    if (list) list.push(s);
    else groups.set(s.selector, [s]);
  }
  const shared: StyleEntry[] = [];
  const perElement: Array<{ entry: StyleEntry; area: number }> = [];
  for (const [selector, group] of groups) {
    const decisions = group.map((s) => entryFor(s, theme));
    let agree = true;
    for (let i = 1; i < decisions.length; i++) {
      if (!sameEntry(decisions[0] ?? null, decisions[i] ?? null)) {
        agree = false;
        break;
      }
    }
    if (agree) {
      const first = decisions[0];
      if (first) shared.push({ ...first, selector });
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      const decision = decisions[i];
      if (!decision) continue;
      const s = group[i]!;
      // NO ADDRESS OF ITS OWN, NO RULE. Painting the shared name here would give
      // this element's colours to its siblings, which is the artifact the split
      // exists to avoid; leaving it alone is the smaller wrong (it keeps the
      // page's own styling).
      if (!s.solo) continue;
      perElement.push({ entry: { ...decision, selector: s.solo }, area: s.area });
    }
  }
  if (shared.length + perElement.length <= MAX_ENTRIES) {
    return shared.concat(perElement.map((p) => p.entry));
  }
  // OVER BUDGET: keep every agreed rule (they are the page's big shared styles)
  // and the largest per-element ones, since the biggest surfaces are the ones
  // the user sees. A page this large is a spreadsheet or a feed and the tail is
  // small chrome.
  perElement.sort((a, b) => b.area - a.area);
  const room = Math.max(0, MAX_ENTRIES - shared.length);
  return shared.concat(perElement.slice(0, room).map((p) => p.entry));
}

/** Whether two selector-less decisions are the same declarations. */
function sameEntry(a: StyleEntry | null, b: StyleEntry | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.bg === b.bg &&
    a.fg === b.fg &&
    a.border === b.border &&
    a.image === b.image &&
    JSON.stringify(a.borders || null) === JSON.stringify(b.borders || null)
  );
}

/**
 * The rule for ONE element, decided from that element alone.
 *
 * ONLY AN ELEMENT THAT PAINTS ITS OWN COLOUR MAY BE PAINTED.
 *
 * `bg` is the colour the user SEES behind the element (an ancestor's, when the
 * element is transparent); `ownBg` is what the element itself paints. Painting
 * the resolved colour back onto a transparent element is the reported "gray
 * overlay hiding the grid": a layout layer that let a canvas or a table show
 * through becomes an opaque sheet of the canvas colour and covers exactly what
 * it used to reveal.
 *
 * `s.ownBg === undefined` means the caller only knows the resolved colour (the
 * unit tests, and any future sampler), so it is treated as the element's own.
 * The live sampler always supplies it.
 */
function entryFor(s: PageSample, theme: Theme): StyleEntry | null {
  const dst = dstPoles(theme);
  const entry: StyleEntry = { selector: "" };
  const own = parseColor(s.ownBg === undefined ? s.bg : s.ownBg);
  // A LIGHT SURFACE UNDER A BACKGROUND IMAGE, WHEN THE ELEMENT CARRIES CONTENT.
  //
  // The rule used to be "an element with a background image is a photograph, so
  // leave it alone", and it was wrong in the way that is hardest to see: measured
  // on en.wikipedia.org/wiki/Firefox, a sortable table header is
  // `background: #eaecf0 url(<sort arrow>)` — a LIGHT SURFACE with a 16px icon on
  // it. The colour was skipped (there is a `url(` in the value) while the text on
  // it WAS mapped, so ten header cells came back as light ink on a light panel.
  // The same shape is a lazy-load container (measured on merriam-webster.com):
  // `#d7d5d5` plus an `image-set()` photo, i.e. a light grey placeholder box in a
  // dark page. The image paints ABOVE the colour, so what we paint under a
  // covering photo is invisible — and the case where it is not invisible is a box
  // with nothing in it at all, where the `url()` IS the design and darkening
  // under it could erase a transparent logo's backdrop.
  //
  // `bgCovers` is the third and cheapest answer: `background-size: cover` means
  // the image hides the colour completely, so painting under it costs nothing and
  // is invisible — which is the lazy-load placeholder, a light grey box waiting
  // for a photo that will cover it.
  if (own && paints(own, theme) && (!s.hasBgImage || s.hasContent || s.bgCovers)) {
    entry.bg = formatColor(mapSurface(own, theme.src, dst, s.share ?? 0));
  }
  // A GRADIENT IS PAINTED BY THE ELEMENT ITSELF, not by its background-colour:
  // a hero almost always has `background-color: transparent` under its
  // gradient, and gating the gradient on the colour left the pale wash in place
  // — a white hero on a dark page. `url()` in the value is a photograph and
  // never reaches here (that is `hasBgImage`).
  if (s.bgImage && !s.hasBgImage) {
    const mapped = mapGradient(s.bgImage, theme);
    if (mapped) entry.image = mapped;
  }
  // A LAYER IS A SURFACE AND NOTHING ELSE.
  //
  // `::before`/`::after` paints a veil over content it does not own: its `color`
  // is the element's (already decided by the element's own rule) and it has no
  // border of its own worth a rule. Emitting `color` here would repaint the
  // element's text from a layer's sample — the same class of artifact as a
  // selector that reaches the wrong element.
  if (s.pseudo) return entry.bg || entry.image ? entry : null;
  // THE SURFACE THE TEXT ACTUALLY SITS ON — see `surfaceFor`.
  const surface = surfaceFor(s, entry, own, theme);
  const fg = parseColor(s.fg);
  if (fg && fg.a >= 0.999) {
    entry.fg = formatColor(ensureContrast(mapInk(fg, theme.src, dst), surface, MIN_TEXT_CONTRAST));
  }
  // EVERY PAINTED SIDE, not just the top one (see `StyleEntry.borders`). The
  // samples come side-by-side with their side names; a sample that predates them
  // (or a unit test) still carries `border`, and it is read as the top side.
  const sides: Array<{ side: "top" | "right" | "bottom" | "left"; color: string }> =
    s.borders && s.borders.length
      ? s.borders
      : s.border
        ? [{ side: "top", color: s.border }]
        : [];
  // THE MAPPED COLOUR OF ONE BORDER.
  //
  // A BORDER IS A SURFACE, NOT INK, and that is a correction rather than a
  // preference: mapped as ink, a `#e3e6e8` hairline (Stack Overflow's row
  // separators) and a `rgba(255,255,255,.5)` ring (Merriam-Webster's hero cards)
  // both stayed near-white — `mapInk` never darkens — so a dark page came back
  // covered in bright 1px grids and grey rings. What a separator is FOR is the
  // separation, so it goes through `mapSurface`: the distance from the canvas it
  // had on the light page, compressed onto the dark side, and then the contrast
  // floor against the surface it is drawn on.
  //
  // A TRANSLUCENT border keeps its alpha and is only ours when it is LIGHT: a
  // dark translucent edge is a scrim, exactly as in `paints`.
  const mapBorder = (raw: string): string | null => {
    const c = parseColor(raw);
    if (!c || c.a <= 0.001) return null;
    if (c.a < 0.999 && !paints(c, theme)) return null;
    return formatColor(ensureContrast(mapSurface(c, theme.src, dst, s.share ?? 0), surface, MIN_BORDER_CONTRAST));
  };
  const mapped = sides
    .map((one) => ({ side: one.side, color: mapBorder(one.color) }))
    .filter((one): one is { side: "top" | "right" | "bottom" | "left"; color: string } => !!one.color);
  if (mapped.length) {
    // ONE COLOUR ACROSS EVERY PAINTED SIDE is the shorthand — the page wrote
    // `border: 1px solid …` and we write its `border-color` back. Otherwise each
    // side keeps its own, so an accent border stays an accent.
    const one = mapped[0]!.color;
    if (mapped.every((m) => m.color === one)) entry.border = one;
    else entry.borders = mapped;
  }
  if (!entry.bg && !entry.fg && !entry.border && !entry.borders && !entry.image) return null;
  return entry;
}

/**
 * The colour the text will actually sit on, AFTER this sheet is applied.
 *
 * This is the one number that decides whether text is readable, and getting it
 * wrong is how a dark mode produces light text on a white panel: the mapped
 * surface of an ancestor is only the real surface if that ancestor is really
 * painted, which — with one rule per element and per element always emitting
 * its own surface — is now what happens. Three answers, in order:
 *
 *   * our own paint, when the element paints a background;
 *   * our own gradient, averaged over its stops, when it paints a gradient;
 *   * the colour that shows through (an ancestor's, mapped), when it paints
 *     nothing itself.
 */
function surfaceFor(s: PageSample, entry: StyleEntry, own: Rgba | null, theme: Theme): Rgba {
  if (entry.bg) return over(parseColor(entry.bg)!, theme.poles.bg);
  if (entry.image) {
    const g = gradientSurface(entry.image);
    if (g) return over(g, theme.poles.bg);
  }
  // A translucent surface we did NOT paint (a scrim, a dark veil) is still on
  // screen in its own colour; text on it is measured against that colour.
  if (own && own.a > 0.001 && own.a < 0.999) return over(own, theme.poles.bg);
  return surfaceBehind(s.bg, theme);
}

/** The average colour of a mapped gradient's stops — what its text sits on. */
function gradientSurface(css: string): Rgba | null {
  const re = /(rgba?|hsla?)\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  const sum = { r: 0, g: 0, b: 0 };
  while ((m = re.exec(css))) {
    const c = parseColor(m[1]!.toLowerCase() + "(" + m[2] + ")");
    if (!c) continue;
    sum.r += c.r;
    sum.g += c.g;
    sum.b += c.b;
    n++;
  }
  return n ? { r: sum.r / n, g: sum.g / n, b: sum.b / n, a: 1 } : null;
}

/**
 * Whether a background colour is one the engine paints.
 *
 * Opaque colours always are. A TRANSLUCENT one is painted only when it is
 * LIGHT — that is a frosted bar (`rgba(255,255,255,.85)`) which would otherwise
 * stay a near-white strip across a dark page; the alpha is kept, so it becomes
 * a translucent dark bar. A dark translucent element is a scrim, and painting a
 * scrim dark over a dark page is not an improvement.
 *
 * SIZE IS NOT THE QUESTION, and this is measured rather than argued: on
 * nytimes.com/puzzles/sudoku the whole game sits under
 * `#modalWrapper-overlay` — `position:absolute;z-index:101;background:
 * rgba(255,255,255,.376);opacity:.86`, i.e. a translucent WHITE sheet over a
 * million square pixels. It is invisible on the site's own white page and a
 * grey blanket over the board once the page is dark, which is the report "the
 * grid is completely hidden by some sort of gray overlay". An earlier revision
 * refused to paint translucent surfaces above a size threshold as "veils"; the
 * page that named the bug is the counter-example, so the rule is the colour and
 * not the size — a light translucent layer is darkened wherever it is.
 */
function paints(own: Rgba, theme: Theme): boolean {
  if (own.a >= 0.999) return true;
  if (own.a <= 0.001) return false;
  return relativeLuminance(over(own, theme.src.canvas)) >= 0.6;
}

/** The surface colour behind an element that paints nothing itself. */
function surfaceBehind(resolved: string, theme: Theme): Rgba {
  const c = parseColor(resolved);
  if (!c || c.a < 0.5) return theme.poles.bg;
  return over(mapSurface(c, theme.src, dstPoles(theme)), theme.poles.bg);
}

/**
 * A computed `background-image` with every colour stop mapped, or null when it
 * is not ours to touch.
 *
 * Computed styles serialise a gradient's stops as `rgb()`/`rgba()` (Firefox and
 * Chrome both), so replacing every colour function in the string keeps the
 * gradient's shape, direction and stop positions while changing only its
 * colours. A value carrying a `url()` is a photograph: left exactly as it is.
 * Returns null when nothing changed, so an unmappable or neutral gradient does
 * not add a rule that says the same thing as the page.
 */
export function mapGradient(image: string, theme: Theme): string | null {
  const css = String(image || "");
  if (!css || css === "none" || css.indexOf("url(") >= 0) return null;
  let changed = false;
  const mapped = css.replace(/(rgba?|hsla?)\(([^)]*)\)/gi, (whole, fn: string, body: string) => {
    const c = parseColor(fn.toLowerCase() + "(" + body + ")");
    if (!c) return whole;
    const out = mapSurface(c, theme.src, dstPoles(theme));
    if (Math.abs(out.r - c.r) < 0.5 && Math.abs(out.g - c.g) < 0.5 && Math.abs(out.b - c.b) < 0.5) return whole;
    changed = true;
    return formatColor(out);
  });
  return changed ? mapped : null;
}

/**
 * The colour that RENDERS as `c` once the filter engine has inverted it.
 *
 * The filter engine puts `filter: invert(1) hue-rotate(180deg)` on <html>, and a
 * filter applies to the element's own background as well as its content — so a
 * canvas painted with the theme's dark colour came out LIGHT. That was the whole
 * of "artifacts in rendering": the engine painted the page's background upside
 * down. Painting the pre-image (channel complement) of the theme colour makes the
 * inversion land exactly on it. The hue rotation leaves greys alone (every row of
 * its matrix sums to 1), so the complement is exact for the neutral canvas and
 * text poles this theme uses.
 */
export function preImage(c: Rgba): Rgba {
  return { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a };
}

function templateVars(theme: Theme): TemplateVars {
  return { foreground: theme.foreground, background: theme.background, accent: theme.accent };
}

/**
 * The canvas declaration for this engine.
 *
 * The palette engine paints the theme's colour directly; the filter engine has to
 * hand the inversion its complement (see `preImage`).
 */
function canvasColor(theme: Theme): string {
  if (theme.engine !== "filter") return theme.background;
  const bg = parseColor(theme.background);
  return bg ? formatColor(preImage(bg)) : theme.background;
}

/**
 * The text declaration for this engine, for the same reason as `canvasColor`:
 * inside a filtered root, the colour we DECLARE is a colour the filter inverts,
 * so it has to be handed over as its own complement.
 */
function textColor(theme: Theme): string {
  if (theme.engine !== "filter") return theme.foreground;
  const fg = parseColor(theme.foreground);
  return fg ? formatColor(preImage(fg)) : theme.foreground;
}

function varsBlock(theme: Theme, canvas: string, scheme?: "dark" | "light" | null): string {
  return (
    // NO `color-scheme` OF OURS, IN EITHER ENGINE.
    //
    // The palette engine does not invert the page: it reads the page's own
    // computed colours and writes a mapping for them. Installing `color-scheme:
    // dark` alongside that mapping changes the colours it was computed from —
    // every `light-dark()` value and every scheme-aware UA style on the page
    // flips to the site's dark variant AFTER the measurement — so the mapping
    // repaints values it never saw. On a site that ships both schemes that is
    // exactly the report: "dark elements are not rendered properly" / artifacts
    // in half the page. The scheme the page is measured in is the scheme it must
    // keep while our sheet is installed.
    //
    // The filter engine reaches the same conclusion for a stronger reason: the
    // inversion already turns the page dark, and forcing the site's dark scheme
    // underneath it would turn every scheme-aware value dark and then invert it
    // back to light — bright widgets inside a dark page.
    ":root{" +
    "--lf-scheme-bg:" +
    theme.background +
    ";" +
    "--lf-scheme-fg:" +
    theme.foreground +
    ";" +
    "--lf-scheme-accent:" +
    theme.accent +
    ";" +
    // Upstream's variable names, defined so an imported corpus rule that reads
    // them does not silently resolve to nothing.
    "--darkreader-neutral-background:" +
    theme.background +
    ";" +
    "--darkreader-neutral-text:" +
    theme.foreground +
    ";" +
    "--darkreader-selection-background:" +
    theme.accent +
    // `color-scheme` IS WRITTEN HERE ONLY WHEN THE PAGE HAS NO DARK THEME OF ITS
    // OWN (see the caller). It is what makes the UA's own furniture — scrollbars,
    // form controls, the select dropdown, spinners — dark instead of the white
    // strips and white inputs that read as artifacts on an otherwise dark page.
    // It is NOT written on a page that declares both schemes: there it would flip
    // every `light-dark()` value to its dark variant AFTER the mapping was
    // measured from the light ones, which is the corruption this file's notes
    // call out.
    // The leading semicolon is not cosmetic: the variable above it is the LAST
    // declaration of the block, so without one the scheme declaration is glued to
    // the accent's value and the whole declaration is dropped.
    (scheme ? ";color-scheme:" + scheme + " !important" : "") +
    "}" +
    "html[data-lf-scheme]{background-color:" +
    canvas +
    " !important;color:" +
    textColor(theme) +
    " !important}"
  );
}

function filterValue(theme: Theme): string {
  const parts = ["invert(1)", "hue-rotate(180deg)"];
  if (theme.brightness !== 100) parts.push("brightness(" + theme.brightness / 100 + ")");
  if (theme.contrast !== 100) parts.push("contrast(" + theme.contrast / 100 + ")");
  if (theme.sepia !== 0) parts.push("sepia(" + theme.sepia / 100 + ")");
  if (theme.grayscale !== 0) parts.push("grayscale(" + theme.grayscale / 100 + ")");
  return parts.join(" ");
}

export interface SheetInput {
  theme: Theme;
  entries: StyleEntry[];
  /** The corpus blocks that matched this page, generic first. */
  rules: DarkRule[];
  /** The user's own CSS: the last word. */
  userCss: string;
  /**
   * The scheme to declare on the root, or null/undefined to leave the page's
   * own declaration alone. The caller decides (see `apply` in index.ts): only a
   * page that declares NO dark support gets one, because only there is nothing
   * for `light-dark()` to flip.
   */
  scheme?: "dark" | "light" | null;
}

/**
 * The one function that turns a decision into CSS.
 *
 * Note what is NOT here: no stylesheet parsing, no per-element inline writes, no
 * observer. This is a pure string function, which is why the engine's behaviour
 * can be pinned by tests that assert on the exact sheet for a page-shaped input.
 */
export function composeSheet(input: SheetInput): string {
  const { theme, entries, rules, userCss } = input;
  const vars = templateVars(theme);
  const canvas = canvasColor(theme);
  const chunks: string[] = [varsBlock(theme, canvas, input.scheme)];

  const invertSelectors = rules.flatMap((r) => r.invert);
  const noInvertSelectors = rules.flatMap((r) => r.noInvert);
  const removeBgSelectors = rules.flatMap((r) => r.removeBg);

  if (theme.engine === "filter") {
    chunks.push("html{" + "filter:" + filterValue(theme) + " !important;" + "}");
    // The canvas has to be painted explicitly too: a root filter inverts the
    // page's own background, so a page that painted white ends up at black rather
    // than at the theme's background, and the two are not the same colour. The
    // value is the PRE-IMAGE — `canvas` — because this declaration is inside the
    // filtered root as well. No `color`: the page's own text colour inverted is
    // the text colour this theme wants, and declaring one would be inverted twice.
    chunks.push("html,body{background-color:" + canvas + " !important}");
    // Media is counter-inverted so photographs and video keep their real
    // colours. `NO INVERT` selectors are excluded from the counter-inversion
    // (upstream's meaning: inside a counter-inverted block, leave this one).
    const media = MEDIA_TAGS + ",*[style*=\"background-image\"]";
    const mediaRule = noInvertSelectors.length
      ? media
          .split(",")
          .map((sel) => sel + ":not(" + asIs(noInvertSelectors) + ")")
          .join(",")
      : media;
    chunks.push(mediaRule + "{filter:" + filterValue(theme) + " !important}");
    if (OUR_HOSTS.length) chunks.push(asList(OUR_HOSTS) + "{filter:" + filterValue(theme) + " !important}");
  } else {
    chunks.push("html,body{background-color:" + theme.background + " !important;color:" + theme.foreground + " !important}");
    // A link with no styling of its own is invisible on a dark canvas otherwise:
    // the browser default is a navy that only reads on white. Scoped to links
    // the page has NOT classed or ided, so a site's own link styling wins.
    chunks.push("a:link:not([class]):not([id]){color:" + theme.accent + " !important}");
    for (const e of entries) {
      const decls: string[] = [];
      if (e.bg) decls.push("background-color:" + e.bg + " !important");
      // A gradient comes AFTER its background-color: the colour is what shows if
      // the gradient is ever dropped, and the mapped gradient paints over it.
      if (e.image) decls.push("background-image:" + e.image + " !important");
      if (e.fg) decls.push("color:" + e.fg + " !important");
      if (e.border) decls.push("border-color:" + e.border + " !important");
      // A per-side entry only names the sides the page actually painted, so a
      // zero-width side is never given a colour it did not have.
      if (e.borders) for (const b of e.borders) decls.push("border-" + b.side + "-color:" + b.color + " !important");
      if (decls.length) chunks.push(e.selector + "{" + decls.join(";") + "}");
    }
  }

  // `REMOVE BG` means "this background image is part of the page's light theme";
  // removing it and painting the poles is what upstream does, and it is the
  // right answer for a CSS-rendered logo or a gradient panel.
  if (removeBgSelectors.length) {
    chunks.push(
      asList(removeBgSelectors) +
        "{background-image:none !important;background-color:" +
        canvas +
        " !important}"
    );
  }

  // IO in dynamic mode: `INVERT` marks an element that disappears on a dark
  // canvas (a dark logo, a black icon) — the engine inverts IT, where the filter
  // engine counter-inverts everything it would otherwise have inverted.
  if (theme.engine === "dynamic" && invertSelectors.length) {
    chunks.push(asList(invertSelectors) + "{filter:" + filterValue(theme) + " !important}");
  }

  for (const rule of rules) {
    if (!rule.css.trim()) continue;
    chunks.push(expandTemplates(rule.css, vars));
  }
  if (userCss.trim()) chunks.push(userCss);

  return chunks.join("\n");
}

/**
 * The sheet painted at document_start, before anything has been measured.
 *
 * This exists for one reason: a dark-mode extension that decides after the page
 * has painted shows a white flash on every navigation, and the flash is the
 * thing users notice most. The `prefers-color-scheme` media query is the ONLY
 * fact available synchronously at that moment, so it is used as a hint about
 * who the user is (a light-preferring user's pages stay light for the
 * milliseconds until the config arrives) — and the moment the real decision
 * lands this sheet is removed. It deliberately paints only the canvas and the
 * text: nothing here can be wrong on a page that turns out to be dark, because
 * it is removed before anything else runs.
 */
export function fallbackSheet(theme: Theme): string {
  // BODY IS PAINTED TOO. A page almost always paints its own `body` background,
  // which covers <html> completely, so a placeholder that only painted the root
  // bought nothing on the pages it existed for: the white body showed through
  // until the real sheet arrived. Both elements, one declaration.
  return (
    "html[data-lf-dark-pending],html[data-lf-dark-pending] body{background-color:" +
    theme.background +
    " !important;color:" +
    theme.foreground +
    " !important}"
  );
}

/**
 * The site rules that apply to a URL, least specific first.
 *
 * Specificity is pattern LENGTH rather than file order, so a user can add
 * `docs.example.com` to a list that already has `example.com` and get what they
 * meant without learning where to put it. Both are applied; the more specific
 * rule is the one that wins.
 */
export function siteRulesFor(sites: SiteRule[], url: string): SiteRule[] {
  const { host, path } = hostAndPath(url);
  return sites
    .filter((r) => r.match && hostMatches(r.match, host, path))
    .sort((a, b) => a.match.length - b.match.length);
}

export { type SiteRule };
