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
  formatColor,
  hslToRgb,
  mapColor,
  parseColor,
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
   * A neutral surface or text colour is matched to these EXACTLY (see mapColor),
   * which is why `;Y d` on a white page produces this product's canvas rather
   * than a grey that happens to be as bright as it.
   */
  poles: { bg: Rgba; fg: Rgba };
}

/** One element's mapping: what the sampler saw and what it becomes. */
export interface StyleEntry {
  selector: string;
  bg?: string;
  fg?: string;
  border?: string;
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
export function entriesFor(samples: PageSample[], theme: Theme, ignored?: (s: PageSample) => boolean): StyleEntry[] {
  const out: StyleEntry[] = [];
  const seen = new Set<string>();
  for (const s of samples) {
    if (s.media || s.area <= 0) continue;
    if (ignored && ignored(s)) continue;
    const entry: StyleEntry = { selector: s.selector };
    if (!s.hasBgImage) {
      const bg = parseColor(s.bg);
      // A transparent background is not a colour, and painting one would put a
      // dark rectangle under content the page deliberately left see-through.
      if (bg && bg.a >= 0.999) entry.bg = formatColor(mapColor(bg, theme.anchors, theme.poles));
    }
    const fg = parseColor(s.fg);
    if (fg && fg.a >= 0.999) entry.fg = formatColor(mapColor(fg, theme.anchors, theme.poles));
    if (s.border) {
      const border = parseColor(s.border);
      if (border && border.a >= 0.999) entry.border = formatColor(mapColor(border, theme.anchors, theme.poles));
    }
    if (!entry.bg && !entry.fg && !entry.border) continue;
    const key = entry.selector + "|" + (entry.bg || "") + "|" + (entry.fg || "") + "|" + (entry.border || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function templateVars(theme: Theme): TemplateVars {
  return { foreground: theme.foreground, background: theme.background, accent: theme.accent };
}

function varsBlock(theme: Theme): string {
  return (
    ":root{" +
    "color-scheme:" +
    (theme.direction === "darken" ? "dark" : "light") +
    " !important;" +
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
    "}" +
    "html[data-lf-scheme]{background-color:" +
    theme.background +
    " !important;color:" +
    theme.foreground +
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
  const chunks: string[] = [varsBlock(theme)];

  const invertSelectors = rules.flatMap((r) => r.invert);
  const noInvertSelectors = rules.flatMap((r) => r.noInvert);
  const removeBgSelectors = rules.flatMap((r) => r.removeBg);

  if (theme.engine === "filter") {
    chunks.push("html{" + "filter:" + filterValue(theme) + " !important;" + "}");
    // The canvas has to be painted explicitly too: a root filter inverts the
    // page's own background, so a page that painted white ends up at #000 rather
    // than at the theme's background, and the two are not the same colour.
    chunks.push("html,body{background-color:" + theme.background + " !important}");
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
      if (e.fg) decls.push("color:" + e.fg + " !important");
      if (e.border) decls.push("border-color:" + e.border + " !important");
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
        theme.background +
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
  return (
    "html[data-lf-dark-pending]{background-color:" +
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
