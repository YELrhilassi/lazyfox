// Chrome helper entry (userChrome.uc.js equivalent): wires the shared leader,
// popup engine and actions to chrome-only plumbing (Services, gBrowser, the
// #lfc= URL channel, hotkeys). All popups/actions live in ../shared/popups
// behind the ActionOps adapter (chrome/ops.ts); this file only glues them to
// the browser window.

import { mergeConfig, mergeHotkeys } from "../shared/config";
import { ensureChromeCore, initChromeCore } from "./core";
import { chromeOps } from "./ops";
import { createTypingChannel } from "./typing";
import { dbg } from "../shared/dev";
import { LeaderController } from "../shared/leader";
import { PANEL_CSS, toast, type PopupCtl } from "../shared/overlay";
import { makeLeaderActions, openBookmarksPopup, openDownloadsPopup, openHistoryPopup, openSearchPopup, openTabsPopup, openUrlPopup, runLeaderAction, type PopupCtx } from "../shared/popups";
import type { ChromeHotkeys, Config } from "../shared/types";

(function () {
  "use strict";

  if (window.top !== window) return;
  if (!window.gBrowser) return;

  if (__DEV__) {
    dbg("chrome bundle loaded", "ff=" + Services.appinfo.version,
      "evalSys=" + Services.prefs.getBoolPref("security.allow_eval_with_system_principal", false),
      "evalParent=" + Services.prefs.getBoolPref("security.allow_eval_in_parent_process", false));
  }

  initChromeCore();

  const EXT_ID = "lazyfox@lazyfox.dev";
  const XHTML = "http://www.w3.org/1999/xhtml";

  function el(tag: string, attrs?: Record<string, string> | null, text?: string | null): HTMLElement {
    const e = document.createElementNS(XHTML, tag) as HTMLElement;
    if (attrs) {
      for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    }
    if (text != null) e.textContent = text;
    return e;
  }

  /* ===================== config (prefs) ===================== */

  interface ChromeCfg {
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

  function loadCfg(): ChromeCfg {
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

  const cfg: ChromeCfg = loadCfg();
  const leaderKey = () => cfg.config.leader || ";";

  /* ===================== popup shell ===================== */

  interface PopupState {
    root: HTMLElement;
    onKey?: (e: KeyboardEvent) => boolean;
    focus?: () => void;
    refresh?: () => void;
    close?: () => void;
  }
  let currentPopup: PopupState | null = null;

  function closePopup(): void {
    if (currentPopup) {
      try {
        currentPopup.root.remove();
      } catch (e) {
        // ignore
      }
      currentPopup = null;
    }
    try {
      window.gBrowser.selectedBrowser.focus();
    } catch (e) {
      // ignore
    }
  }

  function openChromePopup(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl {
    closePopup();
    const root = el("div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace";
    const hdoc = document.implementation.createHTMLDocument("");
    hdoc.body.innerHTML = html;
    while (hdoc.body.firstChild) root.appendChild(hdoc.body.firstChild);
    const st = el("style");
    st.textContent = PANEL_CSS;
    root.appendChild(st);
    document.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closePopup();
    });
    const ctl = build(root) || { onKey: () => false, refresh: () => {}, close: () => {}, focus: () => {} };
    // Keys typed into the popup input drive the selector directly.
    const input = root.querySelector(".lf-input") as HTMLInputElement | null;
    if (input && ctl.onKey) {
      input.addEventListener("keydown", (e) => {
        if (ctl.onKey(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      });
    }
    currentPopup = { root: root, onKey: ctl.onKey, refresh: ctl.refresh, focus: ctl.focus, close: ctl.close };
    setTimeout(() => {
      if (currentPopup && currentPopup.focus) currentPopup.focus();
      if (currentPopup && currentPopup.refresh) currentPopup.refresh();
    }, 0);
    return ctl;
  }

  /* ===================== resize (chrome-native) ===================== */

  let resizeHost: HTMLElement | null = null;

  function openResizePopup(): void {
    closePopup();
    const root = el("div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:ui-monospace,Menlo,Consolas,monospace";
    const panel = el("div");
    panel.style.cssText =
      "width:520px;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
      "box-shadow:0 24px 70px rgba(0,0,0,.6);padding:20px 22px;text-align:center";
    panel.innerHTML =
      "<div style='font-size:13px;color:#c0caf5'>Resize / move window</div>" +
      "<div style='margin-top:12px;font-size:12px;color:#7aa2f7'>" +
      "arrows resize \u00b7 shift+arrows move \u00b7 Esc close</div>";
    root.appendChild(panel);
    document.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closeResize();
    });
    resizeHost = root;
    currentPopup = { root: root };
    window.focus();
  }

  function closeResize(): void {
    if (resizeHost) {
      try {
        resizeHost.remove();
      } catch (e) {
        // ignore
      }
      resizeHost = null;
    }
    closePopup();
  }

  function resizeOnKey(e: KeyboardEvent): boolean {
    const step = e.shiftKey ? 40 : 20;
    switch (e.key) {
      case "ArrowLeft":
        if (e.shiftKey) window.moveBy(-step, 0);
        else window.resizeBy(-step, 0);
        return true;
      case "ArrowRight":
        if (e.shiftKey) window.moveBy(step, 0);
        else window.resizeBy(step, 0);
        return true;
      case "ArrowUp":
        if (e.shiftKey) window.moveBy(0, -step);
        else window.resizeBy(0, -step);
        return true;
      case "ArrowDown":
        if (e.shiftKey) window.moveBy(0, step);
        else window.resizeBy(0, step);
        return true;
      case "Escape":
        closeResize();
        return true;
    }
    return false;
  }

  /* ===================== request channel (chrome -> bg) ===================== */

  function ccBaseUrl(): string | null {
    try {
      const p = WebExtensionPolicy.getByID(EXT_ID);
      if (p) return p.getURL("");
    } catch (e) {
      // fall through to tab scan
    }
    for (const t of window.gBrowser.tabs) {
      try {
        const s = t.linkedBrowser.currentURI.spec;
        const i = s.indexOf("commandcenter.html");
        if (s.indexOf("moz-extension://") === 0 && i !== -1) {
          return s.slice(0, i);
        }
      } catch (e) {
        // skip tab
      }
    }
    return null;
  }

  function requestBg(action: string): void {
    const base = ccBaseUrl();
    if (!base) return;
    try {
      const tab = window.gBrowser.addTab(base + "commandcenter.html#lfc=req." + action, {
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      // Background removes the request tab after handling; give it a safety timeout.
      setTimeout(() => {
        try {
          if (tab && !tab.closing) window.gBrowser.removeTab(tab);
        } catch (e) {
          // ignore
        }
      }, 3000);
    } catch (e) {
      // ignore
    }
  }

  chromeOps.startHints = () => requestBg("startHints");
  chromeOps.focusFirstInput = () => requestBg("focusFirstInput");
  chromeOps.openResize = openResizePopup;
  chromeOps.toggleReveal = () => {
    cfg.config.hoverReveal = !cfg.config.hoverReveal;
    try {
      Services.prefs.setStringPref("lazyfox.chrome.config", JSON.stringify(cfg.config));
    } catch (e) {
      // ignore
    }
    toast("toolbar reveal: " + (cfg.config.hoverReveal ? "on" : "off"));
  };

  /* ===================== typing channel ===================== */

  const typing = createTypingChannel();

  /* ===================== leader + shared popups ===================== */

  let leader: LeaderController;
  const ctx: PopupCtx = {
    ops: chromeOps,
    open: openChromePopup,
    close: closePopup,
    toast: toast,
    runAction: (k) => runLeaderAction(leaderActions, k),
    bindings: () => leader.bindings(),
    manualText: false,
  };
  const leaderActions = makeLeaderActions(ctx);
  leader = new LeaderController(
    (k) => runLeaderAction(leaderActions, k),
    () => cfg.config.whichKey !== false
  );

  // Warm the wasm core so the first leader press is already synchronous.
  ensureChromeCore()
    .then((a) => { if (__DEV__) dbg("core ready, version=" + a.version()); })
    .catch((e) => {
      if (__DEV__) {
        dbg(
          "CORE INIT FAILED: name=" + (e && e.name) +
          " msg=" + JSON.stringify(e && e.message) +
          " str=" + String(e) +
          " stack=" + (e && e.stack)
        );
      }
    });

  // Dev-only end-to-end check of the which-key render path.
  void leader
    .bindings()
    .then(async (all) => {
      if (!__DEV__) return;
      dbg("bindings loaded, count=" + all.length);
      const out = await leader.devSelfTest();
      dbg("wk self-test: " + out);
    })
    .catch((e) => { if (__DEV__) dbg("loadBindings FAILED: " + String(e)); });

  // Announce to the extension background that the chrome helper is alive, so
  // content scripts can hand leader-key handling over to chrome.
  try {
    if (__DEV__) dbg("announcing alive");
    requestBg("alive");
    if (__DEV__) dbg("alive announced");
  } catch (e) {
    if (__DEV__) dbg("alive announce failed: " + e);
  }

  /* ==================== open / cfg hash handling ==================== */

  function setHash(browser: any, hash: string): void {
    try {
      const cw = browser.contentWindow;
      if (cw && cw.location) {
        cw.location.replace(cw.location.href.split("#")[0] + hash);
        return;
      }
    } catch (e) {
      // ignore
    }
  }

  function handleOpen(target: string, browser: any): void {
    const closeCc = target.indexOf("c") !== -1;
    const which = target.split(".")[0];
    const POPUP_ACTIONS: Record<string, () => void> = {
      search: () => openSearchPopup(ctx),
      url: () => openUrlPopup(ctx),
      tabs: () => openTabsPopup(ctx),
      history: () => openHistoryPopup(ctx),
      bookmarks: () => openBookmarksPopup(ctx),
      downloads: () => openDownloadsPopup(ctx),
      resize: () => chromeOps.openResize(),
    };
    const fn = POPUP_ACTIONS[which];
    if (fn) {
      fn();
    } else {
      chromeOps.openTarget(which);
    }
    if (closeCc && browser) {
      try {
        const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
        if (tab) window.gBrowser.removeTab(tab);
      } catch (e) {
        // ignore
      }
    }
  }

  function handleLfc(browser: any, payload: string): void {
    const idx = payload.indexOf(".");
    const cmd = idx < 0 ? payload : payload.slice(0, idx);
    const rest = idx < 0 ? "" : payload.slice(idx + 1);
    if (cmd === "open") {
      handleOpen(rest, browser);
      return;
    }
    if (cmd === "cfg") {
      const dot = rest.indexOf(".");
      const nonce = dot < 0 ? rest : rest.slice(0, dot);
      const json = dot < 0 ? "" : decodeURIComponent(rest.slice(dot + 1));
      let reply = "ok";
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          if (parsed.bindings && typeof parsed.bindings === "object") {
            cfg.bindings = mergeHotkeys(parsed.bindings as Partial<ChromeHotkeys>);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(cfg.bindings));
          } else {
            cfg.bindings = mergeHotkeys(parsed as Partial<ChromeHotkeys>);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(cfg.bindings));
          }
          if (parsed.config && typeof parsed.config === "object") {
            cfg.config = mergeConfig(parsed.config as Partial<Config>);
            Services.prefs.setStringPref("lazyfox.chrome.config", JSON.stringify(cfg.config));
          }
        }
      } catch (e) {
        reply = "err";
      }
      setHash(browser, "#lfc=" + reply + "." + nonce);
    }
  }

  window.gBrowser.addTabsProgressListener({
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener"]),
    onLocationChange(browser: any, webProgress: any, request: any, location: any) {
      if (!location) return;
      if (location.scheme !== "moz-extension") return;
      const spec = location.spec;
      const h = spec.indexOf("#");
      if (h < 0) return;
      const frag = spec.slice(h + 1);
      if (frag.indexOf("lfc=") !== 0) return;
      handleLfc(browser, frag.slice(4));
    },
  });

  /* ==================== hotkeys ==================== */

  function keyCombo(e: KeyboardEvent): string {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    let key = e.key;
    if (key === " ") key = "Space";
    return mods.join("+") + (mods.length ? "+" : "") + key;
  }

  function handleHotkeys(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      const combo = keyCombo(e);
      for (const t of Object.keys(cfg.bindings)) {
        if (cfg.bindings[t as keyof ChromeHotkeys] === combo) {
          e.preventDefault();
          e.stopPropagation();
          chromeOps.openTarget(t);
          return true;
        }
      }
    }
    return false;
  }

  /* ==================== key handling ==================== */

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;

      // A chrome popup is open: Esc closes it first (before the page/window).
      if (currentPopup) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (resizeHost) closeResize();
          else closePopup();
        } else if (resizeHost && resizeOnKey(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }

      if (leader.active) {
        e.preventDefault();
        e.stopImmediatePropagation();
        leader.handleKey(e);
        return;
      }

      // Typing in a page input (or the URL bar): let the key through.
      if (typing.focusedIsTyping(e)) return;

      if (handleHotkeys(e)) return;

      // Ctrl/Alt/Meta chords are never the leader key on their own.
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const k = e.key;
      if (k === leaderKey()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        leader.show();
        return;
      }
    },
    true
  );

  window.addEventListener("blur", () => {
    if (currentPopup) closePopup();
    if (leader.active) leader.hide();
    typing.reset();
  });

  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      typing.reset();
    });
  } catch (e) {
    // ignore
  }
})();
