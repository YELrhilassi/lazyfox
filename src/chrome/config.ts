// Chrome-side configuration. The chrome helper reads its settings from two
// prefs (lazyfox.chrome.bindings + lazyfox.chrome.config) that the options
// page and the #lfc=cfg channel keep in sync with the extension's
// browser.storage copy. This module owns loading, merging, persisting and the
// hover-reveal side effect so nothing else touches the prefs directly.

import { mergeConfig, mergeHotkeys } from "../shared/config";
import type { ChromeHotkeys, Config } from "../shared/types";

export interface ChromeCfg {
  bindings: ChromeHotkeys;
  config: Config;
}

function getPref(name: string, def: string): string {
  try {
    const v = Services.prefs.getStringPref(name, "");
    return v ? v : def;
  } catch (e) {
    return def;
  }
}

export function loadCfg(): ChromeCfg {
  let bindings: Partial<ChromeHotkeys> = {};
  let config: Partial<Config> = {};
  try {
    const p = JSON.parse(getPref("lazyfox.chrome.bindings", "{}"));
    if (p && typeof p === "object") bindings = p as Partial<ChromeHotkeys>;
  } catch (e) {
    // fall through
  }
  try {
    const p = JSON.parse(getPref("lazyfox.chrome.config", "{}"));
    if (p && typeof p === "object") config = p as Partial<Config>;
  } catch (e) {
    // fall through
  }
  return { bindings: mergeHotkeys(bindings), config: mergeConfig(config) };
}

// Persist both prefs. `config` is optional: some callers only rebind hotkeys.
export function persistCfg(cfg: ChromeCfg, config?: Config): void {
  try {
    Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(cfg.bindings));
  } catch (e) {
    // ignore
  }
  try {
    if (config) {
      Services.prefs.setStringPref("lazyfox.chrome.config", JSON.stringify(config));
    }
  } catch (e) {
    // ignore
  }
}

// userChrome.css reveals the toolbar when the toolbox is hovered and the
// html[data-lf-reveal="1"] gate is set (the -moz-bool-pref media query is
// deprecated in current Firefox, so the helper drives the gate). Keep both
// the pref (about:config visibility) and the attribute in sync whenever the
// config changes.
export function applyHoverRevealPref(cfg: ChromeCfg): void {
  try {
    const on = cfg.config.hoverReveal !== false;
    Services.prefs.setBoolPref("lazyfox.hoverReveal", on);
    const root = document.documentElement;
    if (root) root.setAttribute("data-lf-reveal", on ? "1" : "0");
  } catch (e) {
    // ignore
  }
}

// Immutable update: returns a NEW cfg with `config` merged over the current
// one (callers must not mutate the previous cfg in place).
export function withConfig(cfg: ChromeCfg, patch: Partial<Config>): ChromeCfg {
  return { bindings: cfg.bindings, config: { ...cfg.config, ...patch } };
}
