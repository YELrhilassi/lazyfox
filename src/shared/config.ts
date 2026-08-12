import type { ChromeHotkeys, Config } from "./types";

// Config defaults are plain data (not logic), so they live here as the single
// TS source that the chrome helper, content script, background and options
// page all import. Everything that IS logic (URL parsing, ranking, hint
// generation, which-key pagination, the #lfc= grammar, the binding tables)
// lives in the Go core and is reached through ./core.
export const CONFIG_DEFAULTS: Config = {
  leader: ";",
  hintChars: "asdfjkl;gh",
  scrollKeys: true,
  openInNewTab: true,
  hoverReveal: true,
  whichKey: true,
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
