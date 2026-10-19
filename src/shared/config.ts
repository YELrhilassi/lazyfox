import type { ChromeHotkeys, Config, DarkConfig, QuickApp, ReaderConfig } from "./types";
// THE EXTENSION IS LOAD-BEARING, and it is the same reason the e2e fixtures
// import THEIR src files with one: `scripts/e2e/fixture/config.ts` loads this
// module with plain `node` (no bundler, no resolve hook) because the harness
// compares the stored config against the product's own merge, and a runtime
// import that resolves only under esbuild makes `npm run e2e` die at startup.
import { SHIPPED_FIXES } from "./dark-fixes.ts";

// Factory for the default quick-launch apps. The full desktop set (Spotify,
// YouTube, X, GitHub, Reddit, Gmail, Netflix) is enabled by default so the
// home grid feels useful on first run; each can be toggled or have its name /
// URL edited (or a new one added) on the options page.
export function defaultApps(): QuickApp[] {
  return [
    { id: "spotify", name: "Spotify", url: "https://open.spotify.com", enabled: true },
    { id: "youtube", name: "YouTube", url: "https://youtube.com", enabled: true },
    { id: "x", name: "X", url: "https://x.com", enabled: true },
    { id: "github", name: "GitHub", url: "https://github.com", enabled: true },
    { id: "reddit", name: "Reddit", url: "https://reddit.com", enabled: true },
    { id: "gmail", name: "Gmail", url: "https://mail.google.com", enabled: true },
    { id: "netflix", name: "Netflix", url: "https://netflix.com", enabled: false },
  ];
}

// Config defaults are plain data (not logic), so they live here as the single
// TS source that the chrome helper, content script, background and options
// page all import. Everything that IS logic (URL parsing, ranking, hint
// generation, which-key pagination, the #lfc= grammar, the binding tables)
// lives in the Go core and is reached through ./core.
// The dark theme's three poles. Tokyo Night's, because that is this product's
// own palette — the status bar, the overlays and the panels are all drawn from
// it, so a page themed onto the same colours stops looking like a different
// application bolted onto the browser.
const DARK_DEFAULTS: DarkConfig = {
  mode: "auto",
  engine: "auto",
  background: "#16161e",
  foreground: "#c0caf5",
  accent: "#7aa2f7",
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  // The SHIPPED corpus is the default value, not a hidden constant: it shows up
  // in the settings textarea as the starting point a user edits, which is the
  // whole reason the field is text and not a compiled table.
  fixes: SHIPPED_FIXES,
  userCss: "",
  sites: [],
};

const READER_DEFAULTS: ReaderConfig = {
  width: 68,
  fontSize: 19,
  lineHeight: 1.62,
  theme: "auto",
  images: true,
  font: "",
};

export const CONFIG_DEFAULTS: Config = {
  leader: ";",
  hintChars: "asdfjklgh",
  scrollKeys: true,
  openInNewTab: true,
  hoverReveal: true,
  whichKey: true,
  statusBar: true,
  statusBarPosition: "bottom",
  autoRestore: true,
  apps: defaultApps(),
  dark: DARK_DEFAULTS,
  reader: READER_DEFAULTS,
};


export const CHROME_HOTKEY_DEFAULTS: ChromeHotkeys = {
  preferences: "Ctrl+Alt+O",
  addons: "Ctrl+Alt+A",
  history: "Ctrl+Alt+H",
  downloads: "Ctrl+Alt+D",
};

export function mergeConfig(partial: Partial<Config> | undefined): Config {
  const merged = Object.assign({}, CONFIG_DEFAULTS, partial || {});
  // The two nested objects are merged FIELD BY FIELD rather than replaced.
  // A shallow assign would make the whole dark config vanish the moment any one
  // of its fields was stored, which is the classic way a nested setting becomes
  // un-settable: the stored partial (say, `{mode:"off"}`) would wipe the corpus
  // and the palette along with it.
  merged.dark = Object.assign({}, DARK_DEFAULTS, partial?.dark || {});
  merged.reader = Object.assign({}, READER_DEFAULTS, partial?.reader || {});
  return merged;
}

export { DARK_DEFAULTS, READER_DEFAULTS };

export function mergeHotkeys(
  partial: Partial<ChromeHotkeys> | undefined
): ChromeHotkeys {
  return Object.assign({}, CHROME_HOTKEY_DEFAULTS, partial || {});
}
