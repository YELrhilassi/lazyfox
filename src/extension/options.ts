// Options page: saves config + chrome hotkeys to storage and pushes them to
// the chrome helper over the #lfc=cfg URL channel (fragment built by the Go
// core). Also owns the quick-launch web-app editor (config.apps). The keyboard
// handling for this page lives in optionskeys.ts.

import {
  CHROME_HOTKEY_DEFAULTS,
  CONFIG_DEFAULTS,
  DARK_DEFAULTS,
  READER_DEFAULTS,
  defaultApps,
  mergeConfig,
  mergeHotkeys,
} from "../shared/config";
import { corpusStats, parseFixList } from "../shared/dark-rules";
import { readKey, writeKey, vConfig, vStringMap } from "./store";
import { core } from "../shared/core";
import { favicon } from "../shared/dom";
import { send } from "../shared/protocol";
import type {
  ChromeHotkeys,
  Config,
  DarkConfig,
  DarkEngine,
  DarkMode,
  QuickApp,
  ReaderConfig,
  ReaderTheme,
  SiteRule,
} from "../shared/types";

(function () {
  "use strict";

  const leader = document.getElementById("leader") as HTMLInputElement;
  const hintChars = document.getElementById("hintChars") as HTMLInputElement;
  const scrollKeys = document.getElementById("scrollKeys") as HTMLInputElement;
  const openInNewTab = document.getElementById("openInNewTab") as HTMLInputElement;
  const hoverReveal = document.getElementById("hoverReveal") as HTMLInputElement;
  const whichKey = document.getElementById("whichKey") as HTMLInputElement;
  const statusBar = document.getElementById("statusBar") as HTMLInputElement;
  const statusBarPosition = document.getElementById("statusBarPosition") as HTMLSelectElement;
  const autoRestore = document.getElementById("autoRestore") as HTMLInputElement;
  const saveBtn = document.getElementById("save") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLSpanElement;

  /* --------------------------- dark + reader ---------------------------- */

  const darkMode = document.getElementById("darkMode") as HTMLSelectElement;
  const darkEngine = document.getElementById("darkEngine") as HTMLSelectElement;
  const darkBackground = document.getElementById("darkBackground") as HTMLInputElement;
  const darkForeground = document.getElementById("darkForeground") as HTMLInputElement;
  const darkAccent = document.getElementById("darkAccent") as HTMLInputElement;
  const darkBrightness = document.getElementById("darkBrightness") as HTMLInputElement;
  const darkContrast = document.getElementById("darkContrast") as HTMLInputElement;
  const darkSepia = document.getElementById("darkSepia") as HTMLInputElement;
  const darkGrayscale = document.getElementById("darkGrayscale") as HTMLInputElement;
  const darkSites = document.getElementById("darkSites") as HTMLDivElement;
  const darkAddSite = document.getElementById("darkAddSite") as HTMLButtonElement;
  const darkFixes = document.getElementById("darkFixes") as HTMLTextAreaElement;
  const darkFixesStatus = document.getElementById("darkFixesStatus") as HTMLDivElement;
  const darkUserCss = document.getElementById("darkUserCss") as HTMLTextAreaElement;
  const darkExchange = document.getElementById("darkExchange") as HTMLTextAreaElement;
  const darkExport = document.getElementById("darkExport") as HTMLButtonElement;
  const darkImport = document.getElementById("darkImport") as HTMLButtonElement;
  const darkExchangeStatus = document.getElementById("darkExchangeStatus") as HTMLDivElement;
  const readerTheme = document.getElementById("readerTheme") as HTMLSelectElement;
  const readerWidth = document.getElementById("readerWidth") as HTMLInputElement;
  const readerFontSize = document.getElementById("readerFontSize") as HTMLInputElement;
  const readerLineHeight = document.getElementById("readerLineHeight") as HTMLInputElement;
  const readerFont = document.getElementById("readerFont") as HTMLInputElement;
  const readerImages = document.getElementById("readerImages") as HTMLInputElement;

  const MODES: DarkMode[] = ["auto", "dark", "light", "off"];
  const ENGINES: DarkEngine[] = ["auto", "dynamic", "filter"];
  const READER_THEMES: Array<ReaderTheme | "auto"> = ["auto", "dark", "light", "sepia"];

  /**
   * One site-rule row. Two selects and an input, and both selects carry an
   * explicit "inherit" choice rather than relying on an empty string: a user who
   * wants this site to follow the default has to be able to SAY so, and a rule
   * whose only content is "inherit" is dropped on save (see sitesFromForm).
   */
  function renderSiteRow(rule: SiteRule): void {
    const row = document.createElement("div");
    row.className = "site-row";

    const match = document.createElement("input");
    match.type = "text";
    match.className = "match";
    match.placeholder = "example.com";
    match.value = rule.match;

    const mode = document.createElement("select");
    mode.className = "mode";
    for (const value of ["inherit", ...MODES]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value === "inherit" ? "mode: inherit" : "mode: " + value;
      if ((rule.mode || "inherit") === value) opt.selected = true;
      mode.appendChild(opt);
    }

    const engine = document.createElement("select");
    engine.className = "engine";
    for (const value of ["inherit", ...ENGINES]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value === "inherit" ? "engine: inherit" : "engine: " + value;
      if ((rule.engine || "inherit") === value) opt.selected = true;
      engine.appendChild(opt);
    }

    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "\u00d7";
    rm.title = "Remove";
    rm.addEventListener("click", () => row.remove());

    row.appendChild(match);
    row.appendChild(mode);
    row.appendChild(engine);
    row.appendChild(rm);
    darkSites.appendChild(row);
  }

  function sitesFromForm(): SiteRule[] {
    const out: SiteRule[] = [];
    for (const row of Array.from(darkSites.querySelectorAll<HTMLElement>(".site-row"))) {
      const match = (row.querySelector(".match") as HTMLInputElement).value.trim();
      if (!match) continue;
      const mode = (row.querySelector(".mode") as HTMLSelectElement).value;
      const engine = (row.querySelector(".engine") as HTMLSelectElement).value;
      const rule: SiteRule = { match };
      if (mode !== "inherit") rule.mode = mode as DarkMode;
      if (engine !== "inherit") rule.engine = engine as DarkEngine;
      // A row that inherited everything is dropped, which is the same rule the
      // keyboard toggle uses: an empty rule reads like a setting and behaves
      // like nothing.
      if (rule.mode || rule.engine) out.push(rule);
    }
    return out;
  }

  function num(el: HTMLInputElement, fallback: number, lo: number, hi: number): number {
    const n = Number((el.value || "").trim());
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function darkFromForm(): DarkConfig {
    return {
      mode: MODES.indexOf(darkMode.value as DarkMode) >= 0 ? (darkMode.value as DarkMode) : DARK_DEFAULTS.mode,
      engine: ENGINES.indexOf(darkEngine.value as DarkEngine) >= 0 ? (darkEngine.value as DarkEngine) : DARK_DEFAULTS.engine,
      background: darkBackground.value || DARK_DEFAULTS.background,
      foreground: darkForeground.value || DARK_DEFAULTS.foreground,
      accent: darkAccent.value || DARK_DEFAULTS.accent,
      brightness: num(darkBrightness, DARK_DEFAULTS.brightness, 30, 220),
      contrast: num(darkContrast, DARK_DEFAULTS.contrast, 30, 220),
      sepia: num(darkSepia, DARK_DEFAULTS.sepia, 0, 100),
      grayscale: num(darkGrayscale, DARK_DEFAULTS.grayscale, 0, 100),
      fixes: darkFixes.value,
      userCss: darkUserCss.value,
      sites: sitesFromForm(),
    };
  }

  function readerFromForm(): ReaderConfig {
    return {
      theme: READER_THEMES.indexOf(readerTheme.value as ReaderTheme) >= 0 ? (readerTheme.value as ReaderTheme | "auto") : READER_DEFAULTS.theme,
      width: num(readerWidth, READER_DEFAULTS.width, 30, 120),
      fontSize: num(readerFontSize, READER_DEFAULTS.fontSize, 12, 32),
      lineHeight: num(readerLineHeight, READER_DEFAULTS.lineHeight, 1, 2.4),
      font: readerFont.value.trim(),
      images: readerImages.checked,
    };
  }

  /**
   * The corpus status line.
   *
   * This exists because the fix list is free text a user edits by hand, and the
   * failure mode of a hand-edited list is silence: a mistyped directive does
   * nothing, a block with no host does nothing, and nothing on screen says so.
   * Reporting the block count and every parse problem, next to the field, is
   * the whole difference between a setting and a guessing game.
   */
  function refreshFixStatus(): void {
    const text = darkFixes.value;
    if (!text.trim()) {
      darkFixesStatus.textContent = "empty — no per-site fixes will be applied";
      return;
    }
    const parsed = parseFixList(text);
    const stats = corpusStats(parsed.rules);
    const parts = [stats.blocks + " blocks", stats.sites + " site-specific", stats.selectors + " selectors", text.split("\n").length + " lines"];
    const problems = parsed.errors.length ? " · " + parsed.errors.slice(0, 3).join("; ") : "";
    darkFixesStatus.textContent = parts.join(" · ") + problems;
    darkFixesStatus.style.color = parsed.errors.length ? "var(--red)" : "var(--muted)";
  }

  function loadDarkForm(dark: DarkConfig, reader: ReaderConfig): void {
    darkMode.value = dark.mode;
    darkEngine.value = dark.engine;
    darkBackground.value = dark.background;
    darkForeground.value = dark.foreground;
    darkAccent.value = dark.accent;
    darkBrightness.value = String(dark.brightness);
    darkContrast.value = String(dark.contrast);
    darkSepia.value = String(dark.sepia);
    darkGrayscale.value = String(dark.grayscale);
    darkFixes.value = dark.fixes;
    darkUserCss.value = dark.userCss;
    darkSites.textContent = "";
    dark.sites.forEach((r) => renderSiteRow(r));
    refreshFixStatus();
    readerTheme.value = reader.theme;
    readerWidth.value = String(reader.width);
    readerFontSize.value = String(reader.fontSize);
    readerLineHeight.value = String(reader.lineHeight);
    readerFont.value = reader.font;
    readerImages.checked = reader.images !== false;
  }

  darkAddSite.addEventListener("click", () => {
    renderSiteRow({ match: "" });
    const last = darkSites.lastElementChild?.querySelector(".match") as HTMLInputElement | null;
    if (last) last.focus();
  });
  darkFixes.addEventListener("input", refreshFixStatus);

  darkExport.addEventListener("click", () => {
    darkExchange.value = JSON.stringify({ dark: darkFromForm(), reader: readerFromForm() }, null, 2);
    darkExchangeStatus.textContent = "exported — copy the JSON out of the box to keep it";
    darkExchangeStatus.style.color = "var(--muted)";
  });

  darkImport.addEventListener("click", () => {
    let raw: unknown;
    try {
      raw = JSON.parse(darkExchange.value || "{}");
    } catch (e) {
      darkExchangeStatus.textContent = "that is not valid JSON";
      darkExchangeStatus.style.color = "var(--red)";
      return;
    }
    const obj = (raw || {}) as { dark?: Partial<DarkConfig>; reader?: Partial<ReaderConfig> };
    // mergeConfig rather than a bare spread, for the same reason the load path
    // uses it: the defaults live in one file, and a partial pasted JSON must
    // arrive with every missing field filled in rather than undefined.
    const merged = mergeConfig({ dark: obj.dark, reader: obj.reader } as Partial<Config>);
    loadDarkForm(merged.dark, merged.reader);
    darkExchangeStatus.textContent = "applied to the form — press Save to store it";
    darkExchangeStatus.style.color = "var(--muted)";
  });

  // Cast, not a lie: CHROME_HOTKEY_DEFAULTS is typed, and the cast recovers
  // the literal key union Object.keys() widens to string. Without it the whole
  // bindings table is indexed by plain string and a typo in a key name is
  // invisible — which is exactly what the typed store was supposed to stop.
  const CH_KEYS = Object.keys(CHROME_HOTKEY_DEFAULTS) as (keyof ChromeHotkeys)[];
  const chEls: { [k: string]: HTMLInputElement } = {};
  for (const k of CH_KEYS) {
    chEls[k] = document.getElementById("ch" + k[0]!.toUpperCase() + k.slice(1)) as HTMLInputElement;
  }
  const chStatusEl = document.getElementById("chStatus") as HTMLSpanElement;
  let chTimer: ReturnType<typeof setTimeout> | null = null;

  /* ------------------------- quick-launch apps editor ------------------------- */

  const appsList = document.getElementById("appsList") as HTMLDivElement;
  const addAppBtn = document.getElementById("addApp") as HTMLButtonElement;

  // Live favicon preview uses the shared helper (same source as the
  // command-center tiles), so each row shows the site's real icon.
  function renderAppRow(app: QuickApp): void {
    const row = document.createElement("div");
    row.className = "app-row";

    const en = document.createElement("input");
    en.type = "checkbox";
    en.className = "en";
    en.checked = app.enabled;
    en.addEventListener("change", () => updatePreview(row));

    const ic = document.createElement("div");
    ic.className = "ic";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "name";
    name.placeholder = "Name";
    name.value = app.name;

    const url = document.createElement("input");
    url.type = "text";
    url.className = "url";
    url.placeholder = "https://…";
    url.value = app.url;
    url.addEventListener("input", () => updatePreview(row));

    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "\u00d7";
    rm.title = "Remove";
    rm.addEventListener("click", () => row.remove());

    row.appendChild(en);
    row.appendChild(ic);
    row.appendChild(name);
    row.appendChild(url);
    row.appendChild(rm);
    row.dataset.appId = app.id;

    appsList.appendChild(row);
    updatePreview(row);
  }

  function updatePreview(row: HTMLElement): void {
    const url = (row.querySelector(".url") as HTMLInputElement).value;
    const ic = row.querySelector(".ic") as HTMLDivElement;
    ic.textContent = "";
    const icUrl = favicon(url);
    if (icUrl) {
      const img = document.createElement("img");
      img.src = icUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      ic.appendChild(img);
    } else {
      ic.textContent = "\u2026";
    }
  }

  function addAppRow(app: QuickApp): void {
    renderAppRow(app);
  }

  function appsFromForm(): QuickApp[] {
    const out: QuickApp[] = [];
    let n = 0;
    for (const row of Array.from(appsList.querySelectorAll<HTMLElement>(".app-row"))) {
      const name = ((row.querySelector(".name") as HTMLInputElement).value || "").trim();
      const url = ((row.querySelector(".url") as HTMLInputElement).value || "").trim();
      const enabled = (row.querySelector(".en") as HTMLInputElement).checked;
      const id = row.dataset.appId || "app" + n;
      if (name || url) {
        out.push({ id, name: name || url.split("/")[2] || url, url, enabled });
      }
      n++;
    }
    return out;
  }

  addAppBtn.addEventListener("click", () => {
    addAppRow({ id: "app" + Date.now().toString(36), name: "", url: "https://", enabled: true });
    (appsList.lastElementChild!.querySelector(".name") as HTMLInputElement).focus();
  });

  function chBindingsFromForm(): Record<string, string> {
    const bindings: Record<string, string> = {};
    for (const k of CH_KEYS) {
      bindings[k] = (chEls[k]!.value || "").trim() || CHROME_HOTKEY_DEFAULTS[k];
    }
    return bindings;
  }

  // The return type is the point of this annotation. Without it the ternary
  // below widens statusBarPosition to string, writeKey then refuses the whole
  // object, and the options page becomes the one page that cannot save — which
  // is where a silently-corrupt preference is most expensive.
  function formConfig(): Partial<Config> {
    return {
      leader: leader.value || CONFIG_DEFAULTS.leader,
      hintChars: hintChars.value || CONFIG_DEFAULTS.hintChars,
      scrollKeys: scrollKeys.checked,
      openInNewTab: openInNewTab.checked,
      hoverReveal: hoverReveal.checked,
      whichKey: whichKey.checked,
      statusBar: statusBar.checked,
      statusBarPosition: statusBarPosition.value === "top" ? "top" : "bottom",
      autoRestore: autoRestore.checked,
      apps: appsFromForm(),
      dark: darkFromForm(),
      reader: readerFromForm()
    };
  }

  function pushChromeBindings() {
    const payload = { bindings: chBindingsFromForm(), config: formConfig() };
    const nonce =
      Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    chStatusEl.textContent = "pushing\u2026";
    void core.lfcCfg(nonce, encodeURIComponent(JSON.stringify(payload))).then((hash) => {
      const base = location.href.split("#")[0];
      location.replace(base + "#" + hash);
    });
    if (chTimer) clearTimeout(chTimer);
    chTimer = setTimeout(() => {
      chStatusEl.textContent =
        "no response from the chrome script \u2014 is chrome/userChrome.uc.js installed?";
    }, 3000);
  }

  window.addEventListener("hashchange", () => {
    const h = location.hash;
    if (h.indexOf("#lfc=ok.") === 0) {
      if (chTimer) clearTimeout(chTimer);
      chStatusEl.textContent = "chrome script updated";
      setTimeout(() => (chStatusEl.textContent = ""), 2000);
    } else if (h.indexOf("#lfc=err.") === 0) {
      if (chTimer) clearTimeout(chTimer);
      chStatusEl.textContent = "chrome script rejected the config";
    }
  });

  // Component versions (the Components panel).
  void send("components").then((c) => {
    if (!c) return;
    const set = (id: string, v: string | null | undefined) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v || "n/a";
    };
    set("cExt", c.extension);
    set("cWasm", c.wasm);
    set("cHost", c.nativeHost ? c.nativeHost + (c.nativeProtocol ? " (proto " + c.nativeProtocol + ")" : "") : null);
    set("cChrome", c.chromeHelper);
  });

  Promise.all([
    readKey("config", vConfig, {}),
    readKey("chromeBindings", vStringMap, {}),
  ]).then(([storedConfig, storedBindings]) => {
    // mergeConfig rather than a hand-rolled Object.assign: the defaults then
    // live in exactly one file, and this page cannot drift from it.
    const c = mergeConfig(storedConfig);
    leader.value = c.leader;
    hintChars.value = c.hintChars;
    scrollKeys.checked = c.scrollKeys !== false;
    openInNewTab.checked = c.openInNewTab !== false;
    hoverReveal.checked = c.hoverReveal !== false;
    whichKey.checked = c.whichKey !== false;
    statusBar.checked = c.statusBar !== false;
    statusBarPosition.value = c.statusBarPosition === "top" ? "top" : "bottom";
    autoRestore.checked = c.autoRestore !== false;
    // Apps: fall back to defaults when absent (linked by reference via spread).
    // An explicitly emptied app list is a valid user choice, so "empty"
    // cannot mean "corrupt" — but vConfig has already guaranteed the array, so
    // the only remaining question is whether there is anything in it.
    const apps: QuickApp[] = c.apps.length ? c.apps : defaultApps();
    appsList.textContent = "";
    apps.forEach((a) => addAppRow(a));
    const cb = mergeHotkeys(storedBindings);
    for (const k of CH_KEYS) {
      chEls[k]!.value = cb[k];
    }
    loadDarkForm(c.dark, c.reader);
  });

  // Horizontal logo (icon + wordmark) in the settings header.
  try {
    const img = document.getElementById("logoImg") as HTMLImageElement;
    img.src = browser.runtime.getURL("lazyfox-logo.svg");
  } catch (e) {
    // ignore
  }

  saveBtn.addEventListener("click", () => {
    // Two keys, so Promise.all rather than two awaits in series: the save
    // button waits on both anyway and the round trips are independent. The
    // store writers are best-effort, so the "saved" confirmation below is
    // shown either way — same as the old .set() would have been swallowed, but
    // now the swallow has one documented home.
    void Promise.all([
      writeKey("config", formConfig()),
      writeKey("chromeBindings", chBindingsFromForm()),
    ]).then(() => {
      statusEl.textContent = "saved";
      setTimeout(() => (statusEl.textContent = ""), 1500);
    });
    pushChromeBindings();
  });
})();