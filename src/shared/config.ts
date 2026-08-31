import type { ChromeHotkeys, Config, QuickApp } from "./types";

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
};


export const CHROME_HOTKEY_DEFAULTS: ChromeHotkeys = {
  preferences: "Ctrl+Alt+O",
  addons: "Ctrl+Alt+A",
  history: "Ctrl+Alt+H",
  downloads: "Ctrl+Alt+D",
};

export function mergeConfig(partial: Partial<Config> | undefined): Config {
  return Object.assign({}, CONFIG_DEFAULTS, partial || {});
}

export function mergeHotkeys(
  partial: Partial<ChromeHotkeys> | undefined
): ChromeHotkeys {
  return Object.assign({}, CHROME_HOTKEY_DEFAULTS, partial || {});
}
