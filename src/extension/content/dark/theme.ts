// The theme: two poles, one sheet of CSS.
//
// Pure: samples, analysis, matched corpus and user settings arrive as data; a
// string of CSS leaves. That makes the engine testable — a unit test asserts
// the exact sheet a page-shaped input produces, with no browser — and apply.ts
// keeps only the measurement and the injection.
//
// WHAT THE SHEET CONTAINS, IN CASCADE ORDER (the order IS the design):
//   1. the variables        — our poles + upstream's variable names, so an
//                             imported corpus can read them
//   2. the page guarantee   — html/body painted to the poles, so no white
//                             rectangle survives under a transparent body
//   3. the mapping          — one rule per sampled element, `!important`
//   4. the corpus           — the site's own fixes, expanded, last among the
//                             engine's rules
//   5. the user's CSS       — the last word, by definition
//
// The filter engine gives step 3 a different body (root filter +
// counter-inversions) and shares 1, 4 and 5 exactly.
//
// SCHEME ATTRIBUTE: the sheet defines both `data-lf-scheme` and the rewritten
// `[data-darkreader-scheme=…]` selectors, because apply.ts sets the attribute
// while the theme is live — a corpus rule gated on the scheme keeps working.

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
  /** The colour for an unstyled link. */
  accent: string;
  brightness: number;
  contrast: number;
  sepia: number;
  grayscale: number;
  anchors: Anchors;
  /** The two poles as exact colours: neutral surfaces/text are matched to these EXACTLY (mapInk), which is why `;Y d` on a white page yields this canvas, not a grey that happens to be as bright. */
  poles: { bg: Rgba; fg: Rgba };
  /** The page's OWN two colours — the mapping is role-aware and relative-luminance-measured. `anchors` stays as the HSL view the pure lightness tests use. */
  src: { canvas: Rgba; ink: Rgba };
}

/** One element's mapping: what the sampler saw and what it becomes. */
export interface StyleEntry {
  selector: string;
  bg?: string;
  fg?: string;
  /** `border-color`, every painted side at once — ONLY when all sides share one colour. Where they differ (a coloured left accent) the colour goes into `borders`: one `border-color` would repaint the accent from the top side's sample and turn a red rule grey. */
  border?: string;
  /**
   * Per-side border colours for sides that disagree. Top-only sampling once
   * missed merriam-webster's `border: 4px solid rgba(255,255,255,.5)` hero
   * ring on three sides — a 4px semi-transparent white edge reads exactly as
   * the "gray overlay on some elements" report. A TRANSLUCENT border is
   * mapped with its alpha kept when light; dark ones are scrims and stay.
   */
  borders?: Array<{ side: "top" | "right" | "bottom" | "left"; color: string }>;
  /**
   * A mapped background-image — a gradient whose stops went through the same
   * surface mapping as a flat background. `hasBgImage` used to look only for
   * `url(`, so a pale gradient wash stayed light on a dark page (the most
   * visible artifact this engine had). A gradient carrying `url()` is still a
   * photograph and is left alone.
   */
  image?: string;
}

/** The elements the dynamic engine must not paint: media has its own colours. */
export const MEDIA_TAGS = "img,video,canvas,iframe,object,embed,picture,svg";

/**
 * Our own hosts, which the filter engine counter-inverts: they are children
 * of <html>, so a root filter would turn the which-key overlay, popups,
 * hints, status bar and caret into negatives. Ids are set by the owning
 * module.
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
 * Build the theme for one page. The anchors are the whole mapping: the
 * page's own canvas/text lightness in, the theme's poles out. `lighten` is
 * the same machinery with the poles swapped — a two-pole model never
 * invents a second palette.
 *
 * The anchors are HSL LIGHTNESSES, not relative luminances, and the scales
 * are not interchangeable (#808080 is 0.502 by HSL, 0.216 by luminance): the
 * mapping positions a colour BETWEEN the poles, so it must be measured with
 * the same ruler the mapping uses. Relative luminance still decides whether
 * a page is already dark — a different question.
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
 * A colour with its lightness mirrored — the accent on the light side. The
 * user's accent is chosen to sit on a DARK canvas; on the light side it must
 * move to the other end or it is unreadable.
 */
function swapLightness(c: Rgba): Rgba {
  const hsl = rgbToHsl(c);
  return hslToRgb({ h: hsl.h, s: hsl.s, l: 1 - hsl.l });
}

/** The metadata boxes' output a call site should name: the `bg`/`fg` fields stay from the settings; the mapSurface/mapInk calls are named for the ROLE, so ink cannot be passed where a canvas belongs. */
function dstPoles(theme: Theme) {
  return { canvas: theme.poles.bg, ink: theme.poles.fg };
}

/** The sheet's budget in rules. Raised from 4000 when the walk stopped being capped at the same number — a Wikipedia article has 14 051 elements and the old cap described only the first 4 000 of them. Still a cap: a spreadsheet can have 100 000 elements and a megabyte of CSS is not a theme. */
const MAX_ENTRIES = 9000;

/**
 * The mapping for every sampled element that needs one.
 *
 * ONE RULE PER SELECTOR WHEN THE WEARERS AGREE, ONE PER ELEMENT WHEN THEY
 * DO NOT. A selector on a real site is a NAME shared by many elements, so
 * one rule can only say one thing about them all. Majority vote was the
 * previous answer, and it is what produced the reports measured against
 * here: on merriam-webster.com 556 of 827 text elements were unreadable
 * because a heading's class was shared with a transparent wrapper whose
 * transparent background VETOED the group — white panel unpainted, its text
 * mapped near-white. The rule is "do not claim what you cannot paint":
 *
 *   * every element's surface/ink is decided FROM THAT ELEMENT;
 *   * decisions coalesce only when every member produces the same
 *     declarations (the common case; keeps the sheet small);
 *   * otherwise each member gets its own rule keyed by `PageSample.solo`.
 *     Nothing unpainted, nothing painted with a sibling's colours.
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
      // No address of its own, no rule: painting the shared name hands this
      // element's colours to its siblings; leaving it alone is the smaller
      // wrong (the element keeps the page's own styling).
      if (!s.solo) continue;
      perElement.push({ entry: { ...decision, selector: s.solo }, area: s.area });
    }
  }
  if (shared.length + perElement.length <= MAX_ENTRIES) {
    return shared.concat(perElement.map((p) => p.entry));
  }
  // Over budget: keep the agreed rules (the page's big shared styles) plus
  // the LARGEST per-element ones — the tail is small chrome on a page this
  // large.
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
 * ONLY AN ELEMENT THAT PAINTS ITS OWN COLOUR MAY BE PAINTED. `bg` is what
 * the user SEES behind the element (an ancestor's, if this one is
 * transparent); `ownBg` is what it itself paints. Painting the resolved
 * colour back onto a transparent element is the "gray overlay hiding the
 * grid" report — a layout layer that let a canvas/table show through becomes
 * an opaque sheet. `ownBg === undefined` (the unit tests, or a future
 * sampler) means the resolved colour is treated as the element's own; the
 * live sampler always supplies it.
 */
function entryFor(s: PageSample, theme: Theme): StyleEntry | null {
  const dst = dstPoles(theme);
  const entry: StyleEntry = { selector: "" };
  const own = parseColor(s.ownBg === undefined ? s.bg : s.ownBg);
  // A LIGHT SURFACE UNDER A BACKGROUND IMAGE, when the element carries
  // content. The old rule — "a bg image element is a photograph, leave it" —
  // missed the sortable table header (`#eaecf0 url(<arrow>)`, TEXT ON A LIGHT
  // PANEL) whose ten cells came back light-on-light, and the lazy-load grey
  // `#d7d5d5` placeholder under a covering photo: with `bgCovers`, what is
  // painted under a covering image is invisible and therefore free. The case
  // that stays alone is the `url()` that IS the design (a transparent logo's
  // backdrop).
  if (own && paints(own, theme) && (!s.hasBgImage || s.hasContent || s.bgCovers)) {
    entry.bg = formatColor(mapSurface(own, theme.src, dst, s.share ?? 0));
  }
  // A gradient is painted by the element itself, not by its often-transparent
  // background-colour — gating on the colour once left a pale hero wash.
  // `url()` in the value never reaches here (that is `hasBgImage`).
  if (s.bgImage && !s.hasBgImage) {
    const mapped = mapGradient(s.bgImage, theme);
    if (mapped) entry.image = mapped;
  }
  // A pseudo LAYER is a surface and nothing else: its `color` is the
  // element's and posting one here would repaint the element's own text from
  // a veil's sample.
  if (s.pseudo) return entry.bg || entry.image ? entry : null;
  // The surface the text ACTUALLY sits on — see surfaceFor.
  const surface = surfaceFor(s, entry, own, theme);
  const fg = parseColor(s.fg);
  if (fg && fg.a >= 0.999) {
    entry.fg = formatColor(ensureContrast(mapInk(fg, theme.src, dst), surface, MIN_TEXT_CONTRAST));
  }
  // Every painted side, not just the top (see StyleEntry.borders); a legacy
  // `border` sample is read as the top side.
  const sides: Array<{ side: "top" | "right" | "bottom" | "left"; color: string }> =
    s.borders && s.borders.length
      ? s.borders
      : s.border
        ? [{ side: "top", color: s.border }]
        : [];
  /**
   * THE MAPPED COLOUR OF ONE BORDER. A border is a SURFACE, not ink: mapped
   * as ink, Stack Overflow's `#e3e6e8` hairlines and MW's `rgba(255,255,255,
   * .5)` rings both stayed near-white (mapInk never darkens) and a dark page
   * came back covered in bright 1px grids. What a separator marks is the
   * separation, so it goes through mapSurface — the distance from the canvas
   * it had on the light page, compressed onto the dark side, with a contrast
   * floor against the surface it is drawn on. A dark translucent edge is a
   * scrim and stays (same rule as `paints`).
   */
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
    // One colour across every side = the page's own `border: 1px solid …`
    // shorthand, written back as `border-color`; otherwise each side keeps
    // its own so an accent border stays an accent.
    const one = mapped[0]!.color;
    if (mapped.every((m) => m.color === one)) entry.border = one;
    else entry.borders = mapped;
  }
  if (!entry.bg && !entry.fg && !entry.border && !entry.borders && !entry.image) return null;
  return entry;
}

/**
 * The colour the text will actually sit on AFTER the sheet is applied — the
 * one number that decides readability (light text on a white panel is how
 * dark modes embarrass themselves). Three answers, in order: our own paint,
 * our gradient averaged over its stops, or the mapped colour showing through
 * from behind.
 */
function surfaceFor(s: PageSample, entry: StyleEntry, own: Rgba | null, theme: Theme): Rgba {
  if (entry.bg) return over(parseColor(entry.bg)!, theme.poles.bg);
  if (entry.image) {
    const g = gradientSurface(entry.image);
    if (g) return over(g, theme.poles.bg);
  }
  // A translucent surface we did NOT paint (a scrim, a dark veil) is still on
  // screen in its own colour; text is measured against that.
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
 * Opaque always. TRANSLUCENT only when LIGHT — a frosted white bar would
 * otherwise stay a near-white strip across a dark page; alpha is kept, so it
 * becomes a translucent dark bar. A dark translucent element is a scrim, and
 * painting a scrim dark is no improvement.
 *
 * SIZE IS NOT THE QUESTION, and the counter-example is measured: on
 * nytimes.com/puzzles/sudoku the whole game sits under a translucent WHITE
 * `#modalWrapper-overlay` (z-index:101, opacity .86) — invisible on the
 * site's white page, a grey blanket over the board once dark ("the grid is
 * completely hidden by some sort of gray overlay"). An earlier revision
 * refused to paint large translucent "veils"; that page named the bug, so
 * the rule is the colour, not the size.
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
 * A computed background-image with every colour stop mapped, null when not
 * ours to touch.
 *
 * Computed styles serialise stops as `rgb()/rgba()`, so replacing every
 * colour function keeps the gradient's shape, direction and stop positions
 * while changing only its colours. A `url()` value is a photograph — left
 * exactly as is. Null when nothing changed, so a neutral gradient adds no
 * rule that repeats the page.
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
 * The filter (`invert(1) hue-rotate(180deg)` on <html>) applies to the
 * element's OWN background too, so a canvas painted with the theme's dark
 * colour came out light — the whole of "artifacts in rendering". Handing the
 * inversion its pre-image makes it land exactly on the theme colour. The hue
 * rotation leaves greys alone (matrix rows sum to 1), so the complement is
 * exact for the neutral poles this theme uses.
 */
export function preImage(c: Rgba): Rgba {
  return { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a };
}

function templateVars(theme: Theme): TemplateVars {
  return { foreground: theme.foreground, background: theme.background, accent: theme.accent };
}

/** Declare the theme poles in the shape the inversion expects: the filter engine hands `preImage` of each. */
function canvasColor(theme: Theme): string {
  if (theme.engine !== "filter") return theme.background;
  const bg = parseColor(theme.background);
  return bg ? formatColor(preImage(bg)) : theme.background;
}

/** Text declaration, same reason as canvasColor: inside a filtered root the declared colour is the one the filter will invert. */
function textColor(theme: Theme): string {
  if (theme.engine !== "filter") return theme.foreground;
  const fg = parseColor(theme.foreground);
  return fg ? formatColor(preImage(fg)) : theme.foreground;
}

function varsBlock(theme: Theme, canvas: string, scheme?: "dark" | "light" | null): string {
  return (
    // NO `color-scheme` OF OURS, in either engine — with reasons:
    //   * palette engine: it does NOT invert; it reads the page's computed
    //     colours and writes a mapping for them. Installing
    //     `color-scheme: dark` flips every `light-dark()` value and every
    //     scheme-aware UA style AFTER the measurement ("dark elements are
    //     not rendered properly").
    //   * filter engine: the inversion already darkens the page; forcing the
    //     site's scheme underneath would flip scheme-aware values dark and
    //     then invert them back to light.
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
    "--darkreader-neutral-background:" +
    theme.background +
    ";" +
    "--darkreader-neutral-text:" +
    theme.foreground +
    ";" +
    "--darkreader-selection-background:" +
    theme.accent +
    // `color-scheme` is declared ONLY when the page has no dark theme of its
    // own (the caller decides): on  scheme-aware pages it is the UA furniture
    // — scrollbars, form controls — that reads as white artifacts otherwise.
    // The leading semicolon is not cosmetic: the scheme declaration is glued
    // to the accent's value without one and the whole declaration drops.
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
  /** Scheme to declare on the root, or null to leave the page's own declaration alone. Only a page declaring NO dark support gets one: only there is nothing for `light-dark()` to flip. */
  scheme?: "dark" | "light" | null;
}

/** Decision -> CSS, as a pure string function: no stylesheet parsing, no inline writes, no observer — which is why the engine can be pinned by tests asserting the exact sheet. */
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
    // The canvas is painted explicitly too: a root filter inverts the page's
    // own background, so a white page ends black rather than at the theme's
    // background — different colours. `canvas` is the PRE-IMAGE because this
    // declaration is inside the filtered root; no `color`, or the page's own
    // inverted text colour would be inverted twice.
    chunks.push("html,body{background-color:" + canvas + " !important}");
    // Media counter-inverted so photos/video keep their real colours; "NO
    // INVERT" corpus selectors are excluded (inside a counter-inverted block,
    // leave this one).
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
    // An unstyled link is otherwise invisible on a dark canvas (browser
    // default navy reads on white only). Scoped to links the page has NOT
    // classed or ided, so the site's own link styling wins.
    chunks.push("a:link:not([class]):not([id]){color:" + theme.accent + " !important}");
    for (const e of entries) {
      const decls: string[] = [];
      if (e.bg) decls.push("background-color:" + e.bg + " !important");
      // The gradient after the colour: the colour is the rollback if the
      // gradient is dropped, and the mapped gradient paints over it.
      if (e.image) decls.push("background-image:" + e.image + " !important");
      if (e.fg) decls.push("color:" + e.fg + " !important");
      if (e.border) decls.push("border-color:" + e.border + " !important");
      // Per-side entries name only the sides the page painted.
      if (e.borders) for (const b of e.borders) decls.push("border-" + b.side + "-color:" + b.color + " !important");
      if (decls.length) chunks.push(e.selector + "{" + decls.join(";") + "}");
    }
  }

  // `REMOVE BG`: "this background image is part of the page's light theme" —
  // removing it and painting the poles is what upstream does, the right
  // answer for a CSS-rendered logo or a gradient panel.
  if (removeBgSelectors.length) {
    chunks.push(
      asList(removeBgSelectors) +
        "{background-image:none !important;background-color:" +
        canvas +
        " !important}"
    );
  }

  // IO in dynamic mode: `INVERT` marks an element that vanishes on a dark
  // canvas (a dark logo, a black icon) — the engine inverts IT, where the
  // filter engine counter-inverts everything it would otherwise invert.
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
 * The sheet painted at document_start, before anything is measured.
 *
 * It exists because deciding after the page paints is a white flash on every
 * navigation — the thing users notice most. `prefers-color-scheme` is the
 * ONLY fact available synchronously, so it is used as a hint about who the
 * user is, and removed the moment the real decision lands. It paints only
 * the canvas and text, which cannot be wrong: it is gone before anything
 * else runs. BODY IS PAINTED TOO — a page's own body background covers
 * <html> completely, so a root-only placeholder bought nothing on the pages
 * it existed for.
 */
export function fallbackSheet(theme: Theme): string {
  return (
    "html[data-lf-dark-pending],html[data-lf-dark-pending] body{background-color:" +
    theme.background +
    " !important;color:" +
    theme.foreground +
    " !important}"
  );
}

/** Site rules matching a URL, least specific first: length-ordered so a user can add `docs.example.com` to a list holding `example.com` and get what they meant without thinking about where to put it. Both apply; the more specific wins. */
export function siteRulesFor(sites: SiteRule[], url: string): SiteRule[] {
  const { host, path } = hostAndPath(url);
  return sites
    .filter((r) => r.match && hostMatches(r.match, host, path))
    .sort((a, b) => a.match.length - b.match.length);
}

export { type SiteRule };
