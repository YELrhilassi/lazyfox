// The product's own palette: one set of tokens every Lazyfox surface draws from.
//
// WHY THIS FILE EXISTS AT ALL. The chrome, the status bar, the which-key panel,
// every popup, the find bar, the hint badges, the settings page and the command
// center were each authored with their own copy of Tokyo Night's hexes. That
// looked consistent by luck, not by rule: changing the accent meant editing
// fourteen stylesheets, and a light UI was impossible without touching every one
// of them. So the colours are named once, here, and the surfaces read `--lf-*`
// (see uiVars). The presets below are the shipped choices; a user can override
// the accent and the background from Settings → Appearance.
//
// THEMING IS NOT DARK MODE. This module is about Lazyfox's own UI. Dark mode
// (shared/dark/*) recolours WEB PAGES and has its own palettes, its own config
// and its own settings card. A user can run a light Lazyfox UI over dark pages or
// the reverse; nothing here reads or writes `config.dark`.

// Single source of truth for the app-wide UI font, shared by every embedded
// stylesheet (status bar, which-key overlay, popups, find widget, toasts).
// One stack everywhere keeps the UI visually consistent; the native system
// sans reads cleanly at every size the overlays use. Monospace is reserved
// for key caps / hint badges / commands (see the individual stylesheets).
export const UI_FONT =
  'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

/**
 * The status bar's own cut.
 *
 * A 15px strip of dense, low-contrast text is the one place where the platform
 * default is not the best available: `Segoe UI Variable Text` (Windows 11) and
 * `SF Pro Text` are the text-optimised optical sizes of their families, drawn
 * with a wider aperture and looser fit than the display cuts, which is exactly
 * what 15px needs. Everything older in the stack is the same fallback chain the
 * rest of the UI uses, so a machine without those fonts degrades to what it
 * showed before rather than to a default serif.
 *
 * Emitted as `--lf-bar-font` so the settings preview draws the bar in the same
 * face as the bar itself instead of duplicating the stack in a second file.
 */
export const BAR_FONT =
  '"Segoe UI Variable Text","SF Pro Text",-apple-system,system-ui,"Segoe UI","Inter","Noto Sans",Roboto,"Helvetica Neue",Arial,sans-serif';

/**
 * The corner-radius scale, as numbers because the settings page shows it and
 * the token block emits it. Deliberately tighter than the first pass (12/8/5):
 * a 12px corner on a 640px panel is a bubble, and every control inheriting its
 * own hand-picked radius is how a UI ends up looking assembled rather than
 * designed.
 */
export const RADIUS = { lg: "6px", md: "4px", sm: "2px" } as const;

/** Every colour a Lazyfox surface may use, by role rather than by hue. */
export interface UiPalette {
  // The window/page ground the UI sits on.
  bg: string;
  // A deeper ground: inputs, title bars, the bar's far edge.
  bg2: string;
  // Raised surfaces: panels, popups, cards.
  panel: string;
  // Primary ink.
  fg: string;
  // Secondary ink (labels that explain).
  sub: string;
  // Tertiary ink (placeholders, counts, hints).
  dim: string;
  border: string;
  border2: string;
  // Hover fill: one neutral step off the surface.
  raise: string;
  // The ACTIVE row's fill — the selected item in a list, the chosen tile, the
  // current nav entry. A COLOURED step toward the accent, never `raise`: hover
  // and selection used to share one tone, so a pointer resting on an unrelated
  // row looked exactly like the selected one and the active item was the
  // hardest thing in the list to find. Measured in resolvePalette.
  sel: string;
  // The session chip's fill. `raise` wherever that genuinely separates from the
  // bar's ground, and a measured step toward the body ink where it does not —
  // see resolvePalette.
  chip: string;
  accent: string;
  // Semantic tones. Presets carry their own so a light UI gets readable reds
  // and greens instead of the dark palette's pastels.
  green: string;
  red: string;
  yellow: string;
  purple: string;
  cyan: string;
  // Ink for text drawn ON an accent fill (a session pill, a save button).
  onAccent: string;
  // The same, per semantic fill. A badge painted in cyan cannot borrow the
  // accent's ink: on a light preset the cyan is dark enough to need white while
  // the accent still needs black. Emitting one ink per fill keeps every badge
  // readable without the stylesheet having to guess.
  onGreen: string;
  onRed: string;
  onYellow: string;
  onPurple: string;
  onCyan: string;
  // A faint wash for a selected row: black on a light UI, white on a dark one.
  tint: string;
  // The modal backdrop and the shadow under a floating panel.
  backdrop: string;
  shadow: string;
  // True for a light-ground preset. Surfaces use it for the few decisions the
  // roles above cannot express (icon fills, scrollbar colours).
  light: boolean;
}

export interface UiPreset {
  id: string;
  name: string;
  /** One line, shown under the name in Settings → Appearance. */
  blurb: string;
  /** The palette's canonical source, credited in the settings UI. */
  credit: string;
  // A preset names the colours it chooses; the ink that sits ON each fill and
  // the derived washes are computed per palette (see resolvePalette), never
  // written by hand — that is how every preset stays readable on its own ground.
  palette: Omit<
    UiPalette,
    "onAccent" | "onGreen" | "onRed" | "onYellow" | "onPurple" | "onCyan" |
      "chip" | "sel" | "tint" | "backdrop" | "shadow"
  >;
}

// Five presets, each taken from its project's published palette. Tokyo Night is
// first because it is the look Lazyfox already shipped — switching to any other
// preset is a deliberate change, never an accidental one.
export const UI_PRESETS: UiPreset[] = [
  {
    id: "tokyonight",
    name: "Tokyo Night",
    blurb: "Cool navy and a soft blue. The Lazyfox default.",
    credit: "folke/tokyonight.nvim",
    palette: {
      bg: "#1a1b26",
      bg2: "#16161e",
      panel: "#1e1e2e",
      fg: "#c0caf5",
      sub: "#9aa5ce",
      dim: "#565f89",
      border: "#2a2f45",
      border2: "#414868",
      raise: "#292e42",
      accent: "#7aa2f7",
      green: "#9ece6a",
      red: "#f7768e",
      yellow: "#e0af68",
      purple: "#bb9af7",
      cyan: "#2ac3de",
      light: false,
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin Mocha",
    blurb: "Warm pastels on a soft mauve ground. Easiest on the eyes at night.",
    credit: "catppuccin/catppuccin",
    palette: {
      bg: "#1e1e2e",
      bg2: "#181825",
      panel: "#313244",
      fg: "#cdd6f4",
      sub: "#a6adc8",
      dim: "#6c7086",
      border: "#45475a",
      border2: "#585b70",
      raise: "#45475a",
      accent: "#89b4fa",
      green: "#a6e3a1",
      red: "#f38ba8",
      yellow: "#f9e2af",
      purple: "#cba6f7",
      cyan: "#89dceb",
      light: false,
    },
  },
  {
    id: "rosepine",
    name: "Rosé Pine",
    blurb: "Deep velvet with iris and rose. Quiet, low-contrast, deliberate.",
    credit: "rose-pine/rose-pine",
    palette: {
      bg: "#191724",
      bg2: "#1f1d2e",
      panel: "#1f1d2e",
      fg: "#e0def4",
      sub: "#908caa",
      dim: "#6e6a86",
      border: "#26233a",
      border2: "#403d52",
      raise: "#26233a",
      accent: "#c4a7e7",
      green: "#9ccfd8",
      red: "#eb6f92",
      yellow: "#f6c177",
      purple: "#c4a7e7",
      cyan: "#ebbcba",
      light: false,
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox Dark",
    blurb: "Retro earth tones with a warm yellow accent. High personality.",
    credit: "morhetz/gruvbox",
    palette: {
      bg: "#282828",
      bg2: "#1d2021",
      panel: "#32302f",
      fg: "#ebdbb2",
      sub: "#d5c4a1",
      dim: "#928374",
      border: "#3c3836",
      border2: "#504945",
      raise: "#3c3836",
      accent: "#83a598",
      green: "#b8bb26",
      red: "#fb4934",
      yellow: "#fabd2f",
      purple: "#d3869b",
      cyan: "#8ec07c",
      light: false,
    },
  },
  {
    id: "solarized",
    name: "Solarized Light",
    blurb: "Paper-warm daylight palette. For a bright room, not a dark one.",
    credit: "ethanschoonover.com/solarized",
    palette: {
      bg: "#fdf6e3",
      bg2: "#eee8d5",
      panel: "#eee8d5",
      // base01 for body text and base00 for secondary: the palette's own
      // "emphasized content" pair. base00 on base3 is 4.1:1 — fine for Solarized's
      // own typography, too thin for a 13px UI, so the roles are the other way
      // round from the raw palette listing.
      fg: "#586e75",
      sub: "#657b83",
      dim: "#93a1a1",
      border: "#e0d9c4",
      border2: "#d3cbb4",
      raise: "#e6dfcb",
      accent: "#268bd2",
      green: "#859900",
      red: "#dc322f",
      yellow: "#b58900",
      purple: "#6c71c4",
      cyan: "#2aa198",
      light: true,
    },
  },
];

export const DEFAULT_UI_PRESET = "tokyonight";

/** What the settings page stores under `config.theme`. */
export interface UiThemeConfig {
  /** A preset id. An unknown id falls back to the default rather than to no theme. */
  preset: string;
  /** "" means the preset's own accent. */
  accent: string;
  /** "" means the preset's own background. */
  background: string;
}

export const UI_THEME_DEFAULTS: UiThemeConfig = {
  preset: DEFAULT_UI_PRESET,
  accent: "",
  background: "",
};

/* ------------------------------ colour maths ------------------------------ */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && (HEX3.test(v) || HEX6.test(v));
}

function parseHex(hex: string): Rgb | null {
  const m3 = HEX3.exec(hex);
  if (m3) {
    return {
      r: parseInt(m3[1]! + m3[1]!, 16),
      g: parseInt(m3[2]! + m3[2]!, 16),
      b: parseInt(m3[3]! + m3[3]!, 16),
    };
  }
  const m6 = HEX6.exec(hex);
  if (!m6) return null;
  return { r: parseInt(m6[1]!, 16), g: parseInt(m6[2]!, 16), b: parseInt(m6[3]!, 16) };
}

function toHex(c: Rgb): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

/** Linear blend of two hex colours; t=0 is `a`, t=1 is `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  });
}

/** WCAG relative luminance, used only to decide light-vs-dark ink. */
export function luminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrast(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG contrast between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  return contrast(luminance(a), luminance(b));
}

/**
 * `ink`, moved toward black or white until it clears `min` against EVERY ground.
 *
 * A preset is a starting point, not a promise. Solarized's base01 is 5:1 on its
 * own paper — fine for prose, thin for an 11px status bar — and a user who
 * replaces the background with a light colour leaves a dark preset's pale ink
 * with nothing to read against. Measuring here means every surface inherits a
 * readable palette instead of each stylesheet inventing one.
 *
 * The direction is decided by the grounds, not per colour: text on a dark UI
 * gets lighter until it clears, text on a light one gets darker. That keeps the
 * hue recognisably the preset's while the value does the work.
 */
export function fitReadable(ink: string, grounds: string[], min: number): string {
  if (!isHexColor(ink)) return ink;
  const ok = (c: string) => grounds.every((g) => contrastRatio(c, g) >= min);
  if (ok(ink)) return ink;
  const towards = grounds.every((g) => luminance(g) < 0.5) ? "#ffffff" : "#000000";
  if (!ok(towards)) return towards;
  // Bisect the mix: the smallest move that clears the bar, so a near-miss is a
  // nudge rather than a jump to white.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mix(ink, towards, mid))) hi = mid;
    else lo = mid;
  }
  return mix(ink, towards, hi);
}

/** `#rrggbb` plus an alpha, as CSS rgba. Falls back to the input unchanged. */
function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
}

/** Near-black or near-white: whichever reads better on `fill`. */
export function inkOn(fill: string): string {
  const l = luminance(fill);
  return contrast(l, luminance("#101014")) >= contrast(l, 1) ? "#101014" : "#ffffff";
}

/* ------------------------------- resolution ------------------------------- */

export function presetById(id: string | undefined): UiPreset {
  const found = UI_PRESETS.find((p) => p.id === id);
  return found || UI_PRESETS[0]!;
}

/**
 * The palette a document should draw with: the chosen preset, then the user's
 * accent and background on top. A background override re-derives the surfaces
 * around it (they describe a relationship to the ground, not absolute colours),
 * while ink and semantic tones stay the preset's — a user who picks a custom
 * ground has not asked for unreadable reds.
 */
export function resolvePalette(theme?: Partial<UiThemeConfig> | null): UiPalette {
  const preset = presetById(theme ? theme.preset : undefined);
  const base = preset.palette;
  let bg = base.bg;
  let bg2 = base.bg2;
  let panel = base.panel;
  let raise = base.raise;
  let border = base.border;
  let border2 = base.border2;
  let accent = base.accent;
  if (theme && isHexColor(theme.accent)) accent = theme.accent;

  if (theme && isHexColor(theme.background)) {
    bg = theme.background;
    // The ground moved, so the light/dark answer is re-read from it rather than
    // from the preset: a user can put Tokyo Night's ink on paper if they want,
    // and the surfaces have to describe the ground they are actually on.
    const onLight = luminance(bg) > 0.45;
    bg2 = onLight ? mix(bg, "#000000", 0.06) : mix(bg, "#000000", 0.22);
    panel = onLight ? mix(bg, "#000000", 0.02) : mix(bg, base.fg, 0.04);
    raise = mix(bg, base.fg, onLight ? 0.12 : 0.1);
    border = mix(bg, base.fg, onLight ? 0.18 : 0.14);
    border2 = mix(bg, base.fg, onLight ? 0.3 : 0.24);
  }

  const light = luminance(bg) > 0.45;
  // The grounds every ink is read against. Borders and hover fills are not
  // grounds; panels and the deeper ground are, because popup rows and the
  // status bar draw text on them.
  const grounds = [bg, bg2, panel];
  // Three tiers, and the gaps between the targets are what keep the hierarchy
  // visible after fitting: body ink clears 8:1 on the WORST ground it sits on
  // (a raised panel, not just the page), secondary ink 5.5:1, tertiary 4.2:1.
  // Without the split, fitting every role to one number flattens fg and dim into
  // the same grey — readable, but with nothing left to say what is primary.
  const fg = fitReadable(base.fg, grounds, 8.5);
  const sub = fitReadable(base.sub, grounds, 6.5);
  // Deliberately NOT fitted against `raise`: dim is the quietest tier, and the
  // bar it would need to clear on a hover fill is higher than `sub`'s, which
  // would leave tertiary text brighter than secondary.
  const dim = fitReadable(base.dim, grounds, 4.8);
  // The accent does two jobs — a fill (with onAccent on it) and a colour for
  // links/keys/labels. Fitting it against the grounds is what keeps the second
  // job readable; inkOn then decides the first.
  accent = fitReadable(accent, grounds, 4.6);
  const green = fitReadable(base.green, grounds, 4.6);
  const red = fitReadable(base.red, grounds, 4.6);
  const yellow = fitReadable(base.yellow, grounds, 4.6);
  const purple = fitReadable(base.purple, grounds, 4.6);
  const cyan = fitReadable(base.cyan, grounds, 4.6);

  // THE ACTIVE ROW is the brightest thing in a list, and it is reachable from
  // every preset: the panel is stepped toward the palette's own accent, so a
  // selection belongs to the palette instead of being one more neutral surface.
  // Two measurements constrain the step. It must stay VISIBLY apart from the
  // hover tone (`raise`) — the bug this fixes is a hovered row and a selected
  // row painting the same colour — and body ink must still read on it, because
  // a selected row is a ground like any other. The step is reduced until the
  // ink clears, so a palette whose accent is close to its panel still gets a
  // usable row rather than an unreadable one.
  const selStep = light ? 0.34 : 0.42;
  let sel = mix(raise, accent, selStep);
  for (let t = selStep; t > 0.04; t -= 0.02) {
    sel = mix(raise, accent, t);
    if (contrastRatio(fg, sel) >= 5.2) break;
  }

  // A chip has to read as a chip against the bar it sits on. Three presets pass
  // on their own raised tone (Tokyo 1.34:1, Catppuccin 1.92, Gruvbox 1.41); two
  // do not — Solarized's cream-on-cream and Rosé Pine's velvet-on-velvet are both
  // 1.09:1, which is not a selected chip but a smudge. There the fill is stepped
  // from the bar's ground toward the palette's body ink and stops at the first
  // step that clears 1.30:1, so the chip stays the palette's colour and the
  // secondary ink drawn on it keeps more than 4.6:1.
  let chip = raise;
  if (contrastRatio(raise, bg2) < 1.3) {
    for (let t = 0.08; t <= 0.3; t += 0.02) {
      const c = mix(bg2, fg, t);
      if (contrastRatio(c, bg2) >= 1.3) {
        chip = c;
        break;
      }
    }
  }

  return {
    bg,
    bg2,
    panel,
    fg,
    sub,
    dim,
    border,
    border2,
    raise,
    sel,
    chip,
    accent,
    green,
    red,
    yellow,
    purple,
    cyan,
    onAccent: inkOn(accent),
    onGreen: inkOn(green),
    onRed: inkOn(red),
    onYellow: inkOn(yellow),
    onPurple: inkOn(purple),
    onCyan: inkOn(cyan),
    tint: light ? "rgba(0,0,0,.055)" : "rgba(255,255,255,.05)",
    // Derived from the ground rather than fixed: a paper palette wants a light
    // veil behind a popup, a dark one wants a darker one.
    backdrop: withAlpha(light ? bg2 : mix(bg, "#000000", 0.6), 0.55),
    shadow: light ? "0 18px 46px rgba(0,0,0,.18)" : "0 18px 46px rgba(0,0,0,.5)",
    light,
  };
}

/** The logo lockup for a palette: a dark wordmark for a light UI, and the
 *  light one otherwise. Two files, because the lockup is served as an <img> and
 *  `currentColor` cannot cross an image boundary. */
export const LOGO_ON_DARK = "lazyfox-logo.svg";
export const LOGO_ON_LIGHT = "lazyfox-logo-light.svg";

export function logoFile(p: UiPalette): string {
  return p.light ? LOGO_ON_LIGHT : LOGO_ON_DARK;
}

/* -------------------------------- emission -------------------------------- */

/** The token block, as CSS declarations. Every surface speaks these names. */
export function uiVars(p: UiPalette): string {
  return (
    "--lf-bg:" + p.bg +
    ";--lf-bg2:" + p.bg2 +
    ";--lf-panel:" + p.panel +
    ";--lf-fg:" + p.fg +
    ";--lf-sub:" + p.sub +
    ";--lf-dim:" + p.dim +
    ";--lf-border:" + p.border +
    ";--lf-border2:" + p.border2 +
    ";--lf-raise:" + p.raise +
    ";--lf-sel:" + p.sel +
    ";--lf-chip:" + p.chip +
    ";--lf-accent:" + p.accent +
    ";--lf-green:" + p.green +
    ";--lf-red:" + p.red +
    ";--lf-yellow:" + p.yellow +
    ";--lf-purple:" + p.purple +
    ";--lf-cyan:" + p.cyan +
    ";--lf-on-accent:" + p.onAccent +
    ";--lf-on-green:" + p.onGreen +
    ";--lf-on-red:" + p.onRed +
    ";--lf-on-yellow:" + p.onYellow +
    ";--lf-on-purple:" + p.onPurple +
    ";--lf-on-cyan:" + p.onCyan +
    ";--lf-tint:" + p.tint +
    ";--lf-backdrop:" + p.backdrop +
    ";--lf-shadow:" + p.shadow +
    // A type token next to the colour tokens: the bar (shadow DOM, chrome) and
    // the settings preview (plain DOM) must pick the same face, and this is the
    // one emission point both already read.
    ";--lf-bar-font:" + BAR_FONT +
    // Shape, next to the colour. The corner radius is the one design decision a
    // user may want to change wholesale, and it used to be a literal in nine
    // stylesheets (12px panel, 8px toast, 5px key cap, 4px badge...) so "less
    // rounded" meant editing every one of them. Three steps, not five: big
    // surfaces, controls, chips.
    ";--lf-r-lg:" + RADIUS.lg +
    ";--lf-r-md:" + RADIUS.md +
    ";--lf-r-sm:" + RADIUS.sm
  );
}

// The palette a DOCUMENT is drawing with. One document, one palette: the content
// script sets it once from the config the background pushes, the chrome helper
// from its pref copy, and every extension page from storage at startup. The
// overlay modules are shared by both hosts and are mounted lazily, so a
// module-level value means the stylesheets they build do not each have to thread
// a palette through their constructors.
let currentPalette: UiPalette = resolvePalette();

export function setUiPalette(p: UiPalette): void {
  currentPalette = p;
}

export function uiPalette(): UiPalette {
  return currentPalette;
}

/**
 * A stylesheet body prefixed with the document's tokens. Both selectors are
 * emitted as separate rules on purpose: `:host` is what matches inside a closed
 * shadow root, `:root` is what matches in the chrome helper's plain-DOM popups,
 * and a list mixing the two is dropped wholesale in the document context.
 */
export function uiCss(css: string, p: UiPalette = currentPalette): string {
  const v = uiVars(p);
  return ":root{" + v + "}\n:host{" + v + "}\n" + css;
}

/** Apply the tokens to a document (the settings page's live preview and the
 *  chrome helper both use this). */
export function applyUiTheme(
  theme: Partial<UiThemeConfig> | null | undefined,
  doc?: any
): UiPalette {
  const p = resolvePalette(theme);
  // Surfaces are created lazily (a popup per open, the which-key panel on first
  // use), so the module-level palette is what they read when they build their
  // stylesheet. Keep it in step with the document.
  setUiPalette(p);
  // Read the ambient document through `globalThis`: this module is also
  // typechecked by the Node-side project, which has no DOM lib.
  const d = doc || (globalThis as any).document || null;
  if (d && d.documentElement) {
    const root = d.documentElement;
    for (const pair of uiVars(p).split(";")) {
      const i = pair.indexOf(":");
      if (i > 0) root.style.setProperty(pair.slice(0, i), pair.slice(i + 1));
    }
    root.setAttribute("data-lf-ui", p.light ? "light" : "dark");
  }
  return p;
}
