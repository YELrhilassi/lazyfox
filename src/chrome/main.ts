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
import { StatusBar } from "../shared/statusbar";
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
      for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
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

  // userChrome.css reveals the toolbar when the toolbox is hovered and the
  // html[data-lf-reveal="1"] gate is set (the -moz-bool-pref media query is
  // deprecated in current Firefox, so the helper drives the gate). Keep both
  // the pref (about:config visibility) and the attribute in sync whenever the
  // config changes.
  function applyHoverRevealPref(): void {
    try {
      const on = cfg.config.hoverReveal !== false;
      Services.prefs.setBoolPref("lazyfox.hoverReveal", on);
      const root = document.documentElement;
      if (root) root.setAttribute("data-lf-reveal", on ? "1" : "0");
    } catch (e) {
      // ignore
    }
  }

  const cfg: ChromeCfg = loadCfg();
  applyHoverRevealPref();
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
  let lastPopupError: string | null = null;


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
    try {
      return openChromePopupInner(html, build);
    } catch (e) {
      lastPopupError = String(e && (e as Error).message ? (e as Error).message : e);
      if (__DEV__) dbg("openChromePopup threw: " + lastPopupError);
      return { onKey: () => false, refresh: () => {}, close: () => {}, focus: () => {} };
    }
  }

  function openChromePopupInner(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl {
    const root = el("div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace";
    const hdoc = document.implementation.createHTMLDocument("");
    hdoc.body.innerHTML = html;
    while (hdoc.body.firstChild) root.appendChild(hdoc.body.firstChild);
    // Firefox's HTML-fragment parser drops form controls (<input>, <button>,
    // <select>) when it runs in the privileged chrome document — divs and text
    // survive, the input is lost. The popup engine needs its .lf-input, so
    // re-create it from the parsed structure (placeholder from the empty hint).
    if (!root.querySelector(".lf-input")) {
      const panel = root.querySelector(".lf-panel");
      if (panel) {
        const input = el("input");
        input.className = "lf-input";
        input.setAttribute("spellcheck", "false");
        const empty = panel.querySelector(".lf-empty");
        if (empty) input.setAttribute("placeholder", (empty.textContent || "").trim());
        const foot = panel.querySelector(".lf-foot");
        if (foot) panel.insertBefore(input, foot);
        else panel.appendChild(input);
      }
    }
    const st = el("style");
    st.textContent = PANEL_CSS;
    root.appendChild(st);
    document.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closePopup();
    });
    let ctl: PopupCtl;
    try {
      ctl = build(root);
    } catch (e) {
      lastPopupError = String(e && (e as Error).message ? (e as Error).message : e);
      if (__DEV__) dbg("popup build threw: " + lastPopupError);
      ctl = null as unknown as PopupCtl;
    }
    if (!ctl) {
      ctl = { onKey: () => false, refresh: () => {}, close: () => {}, focus: () => {} };
    }
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

  function requestBg(action: string, arg?: string): void {
    const base = ccBaseUrl();
    if (!base) return;
    let frag = "lfc=req." + action;
    if (arg != null && arg !== "") frag += "." + encodeURIComponent(arg);
    try {
      const tab = window.gBrowser.addTab(base + "commandcenter.html#" + frag, {
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
    applyHoverRevealPref();
    toast("toolbar reveal: " + (cfg.config.hoverReveal ? "on" : "off"));
  };
  // Session + split actions relay to the extension background (which owns
  // browser.storage) through the #lfc=req channel.
  const sessionAction = (action: string, arg?: string) => {
    requestBg(action, arg);
    // Refresh the status bar's session list after the action lands.
    setTimeout(requestSessionState, 900);
  };
  chromeOps.saveSession = (name: string) => sessionAction("saveSession", name);
  chromeOps.restoreSession = (name: string) => sessionAction("restoreSession", name);
  chromeOps.deleteSession = (name: string) => sessionAction("deleteSession", name);
  chromeOps.switchSessionByMarker = (marker: number) =>
    sessionAction("switchSessionByMarker", String(marker));
  chromeOps.splitTab = () => sessionAction("splitTab");
  chromeOps.unsplitTab = () => sessionAction("unsplitTab");
  chromeOps.switchSplitPane = () => sessionAction("switchSplitPane");

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
  let lastAction: string | null = null;
  leader = new LeaderController(
    (k) => {
      lastAction = k;
      runLeaderAction(leaderActions, k);
    },
    () => cfg.config.whichKey !== false
  );
  // ;' = quick switch: capture the next digit and jump to the marked session.
  leaderActions["'"] = () =>
    leader.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        chromeOps.switchSessionByMarker(Number(k));
        return true;
      }
      return false;
    }, 3000);

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

  /* ==================== status bar (tmux-style) ==================== */

  const chromeStatusBar = new StatusBar();
  let chromeStatusInfo = {
    name: "default",
    marker: 0,
    inSplit: false,
    sessions: [] as { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[],
  };

  // The content script owns the status bar on web pages; the chrome helper only
  // shows its own on chrome-only pages (about:, moz-extension:, ...) where the
  // content script never runs.
  function chromePageNeedsStatus(): boolean {
    try {
      const b = window.gBrowser.selectedBrowser;
      const uri = b && b.currentURI;
      if (!uri) return true;
      const s = uri.scheme || "";
      return s !== "http" && s !== "https" && s !== "file" && s !== "ftp";
    } catch (e) {
      return false;
    }
  }

  function computeChromeStatus(): void {
    const tabs = window.gBrowser.tabs;
    const sel = tabs.indexOf(window.gBrowser.selectedTab);
    const mode = currentPopup ? "POPUP" : leader.active ? "LEADER" : "NORMAL";
    chromeStatusBar.setData({
      name: chromeStatusInfo.name,
      marker: chromeStatusInfo.marker,
      tabIndex: (sel < 0 ? 0 : sel) + 1,
      tabCount: tabs.length,
      inSplit: chromeStatusInfo.inSplit,
      mode: mode,
      sessions: chromeStatusInfo.sessions,
    });
  }

  function updateChromeStatus(): void {
    if (cfg.config.statusBar === false) {
      chromeStatusBar.hide();
      return;
    }
    chromeStatusBar.setPosition(cfg.config.statusBarPosition || "bottom");
    if (chromePageNeedsStatus()) chromeStatusBar.show();
    else chromeStatusBar.hide();
  }

  function requestSessionState(): void {
    const base = ccBaseUrl();
    if (!base) return;
    const nonce = "ss" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    try {
      const tab = window.gBrowser.addTab(
        base + "commandcenter.html#lfc=req.sessionState." + nonce,
        {
          inBackground: true,
          skipAnimation: true,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        }
      );
      // Safety net: if the reply never arrives, drop the request tab.
      setTimeout(() => {
        try {
          if (tab && !tab.closing) window.gBrowser.removeTab(tab);
        } catch (e) {
          // ignore
        }
      }, 5000);
    } catch (e) {
      // ignore
    }
  }

  updateChromeStatus();
  computeChromeStatus();
  setInterval(computeChromeStatus, 500);
  // Fetch the session name + list once at startup and after chrome-triggered
  // session actions. Deliberately NOT polled on a timer or on TabSelect: the
  // round-trip creates a transient background tab, and doing that on a timer
  // would churn tab counts under automation.
  setTimeout(requestSessionState, 2000);
  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      updateChromeStatus();
      computeChromeStatus();
    });
  } catch (e) {
    // ignore
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
    const which = target.split(".")[0]!;
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
    if (cmd === "reveal") {
      // Dev/verification: force the toolbar visible so tests can hover real
      // chrome buttons.
      try {
        const tb = document.getElementById("navigator-toolbox");
        if (tb) {
          if (tb.hasAttribute("lf-debug-reveal")) tb.removeAttribute("lf-debug-reveal");
          else tb.setAttribute("lf-debug-reveal", "1");
        }
        setHash(browser, "#lfc=reveal." + rest);
      } catch (e) {
        // ignore
      }
      return;
    }
    if (cmd === "console") {
      // Debug/verification: dump recent internal-console messages so
      // content-script exceptions are visible instead of silent.
      const dot = rest.indexOf(".");
      const nonce = dot < 0 ? rest : rest.slice(0, dot);
      let json = "{}";
      try {
        const msgs: Array<{ t: string; m: string }> = [];
        const c = (globalThis as any).Services.console;
        if (c && typeof c.getMessageCount === "function") {
          const n = c.getMessageCount();
          for (let i = Math.max(0, n - 60); i < n; i++) {
            try {
              const m = c.getMessageAt(i);
              const text = m && (m.message || m.errorMessage || "");
              const flag = m && m.flags;
              if (text) {
                const s = String(text);
                if (/lazyfox|content\.js|moz-extension|error|exception|referenceerror|typeerror|cannot|undefined/i.test(s)) {
                  msgs.push({ t: String(flag || ""), m: s.slice(0, 400) });
                }
              }
            } catch (e) {
              // skip
            }
          }
        }
        json = btoa(JSON.stringify({ count: msgs.length, msgs: msgs.slice(0, 25) }));
      } catch (e) {
        json = btoa(JSON.stringify({ error: String(e) }));
      }
      setHash(browser, "#lfc=console." + json + "." + nonce);
      return;
    }
    if (cmd === "diag") {
      // Debug/verification: report the extension's live state inside the
      // browser — loaded policy, background context, content-script
      // registration — so install problems are visible instead of silent.
      const dot = rest.indexOf(".");
      const nonce = dot < 0 ? rest : rest.slice(0, dot);
      let json = "{}";
      try {
        const p = (globalThis as any).WebExtensionPolicy.getByID(EXT_ID);
        let cs = null;
        try {
          if (p && p.contentScripts) {
            const arr = Array.from(p.contentScripts as Iterable<any>);
            cs = {
              count: arr.length,
              matches: arr.map((c: any) => (c.matches ? Array.from(c.matches) : [])),
              js: arr.map((c: any) => (c.jsPaths ? Array.from(c.jsPaths) : [])),
              props: arr.map((c: any) => Object.getOwnPropertyNames(c).slice(0, 30)),
              matchesType: arr.map((c: any) => (c.matches ? typeof c.matches + "/" + String(c.matches && c.matches.constructor && c.matches.constructor.name) : "none")),
              // Does the registered MatchPatternSet actually match web pages?
              matchesHttp: arr.map((c: any) => {
                try {
                  if (!c.matches) return "no-matches";
                  const urls = [
                    "http://127.0.0.1/x",
                    "http://example.com/x",
                    "https://example.com/x",
                    "file:///C:/x.html",
                  ];
                  const r: Record<string, unknown> = {};
                  for (const u of urls) {
                    if (typeof c.matches.matches === "function") r[u] = c.matches.matches(u);
                    else r[u] = "no-matches-fn";
                  }
                  return r;
                } catch (e) {
                  return { error: String(e) };
                }
              }),
              manifest: (p.extension && p.extension.manifest && p.extension.manifest.content_scripts) || null,
            };
          }
        } catch (e) {
          cs = { error: String(e) };
        }
        let bg = null;
        try {
          bg = p && p.backgroundContext ? true : false;
        } catch (e) {
          bg = String(e);
        }
        let e10s = null;
        try {
          e10s = (globalThis as any).Services.appinfo.browserTabsRemoteAutostart;
        } catch (e) {
          e10s = String(e);
        }
        let perTab = null;
        try {
          const tab = (window as any).gBrowser && (window as any).gBrowser.selectedTab;
          const lb = tab && tab.linkedBrowser;
          perTab = lb ? { remote: lb.isRemoteBrowser, currentURI: lb.currentURI && lb.currentURI.spec } : null;
        } catch (e) {
          perTab = String(e);
        }
        json = btoa(JSON.stringify({
          exists: !!p,
          active: p ? p.active : false,
          bg: bg,
          e10s: e10s,
          perTab: perTab,
          contentScripts: cs,
          extUrl: p ? p.getURL("") : null,
        }));
      } catch (e) {
        json = btoa(JSON.stringify({ error: String(e) }));
      }
      setHash(browser, "#lfc=diag." + json + "." + nonce);
      return;
    }
    if (cmd === "state") {
      // Debug/verification: report the actual chrome UI state. The URL
      // toolbar and tab strip are display:none unless the hover-reveal strip
      // shows them, so tests can assert the vanilla UI is really gone.
      const dot = rest.indexOf(".");
      const nonce = dot < 0 ? rest : rest.slice(0, dot);
      // onLocationChange fires again for our own location.replace: don't
      // re-answer an already-answered query. The reply is
      // state.<base64>.<nonce> (two dots); the request state.<nonce> (one).
      try {
        const cur = browser.currentURI ? browser.currentURI.spec : "";
        const after = cur.indexOf("#lfc=state.") !== -1 ? cur.split("#lfc=state.")[1] : "";
        if (after && after.split(".").length >= 2) return;
      } catch (e) {
        // ignore
      }
      let json = "{}";
      try {
        const nav = document.getElementById("nav-bar");
        const tabs = document.getElementById("TabsToolbar");
        const toolbox = document.getElementById("navigator-toolbox");
        const st = (el: HTMLElement | null) =>
          el ? getComputedStyle(el).display : "missing";
        let hover = false;
        try {
          hover = toolbox ? toolbox.matches(":hover") : false;
        } catch (e) {
          // ignore
        }
        const br = toolbox ? toolbox.getBoundingClientRect() : null;
        let popupInfo = null;
        try {
          const panels = Array.from(document.querySelectorAll(".lf-panel"));
          popupInfo = {
            current: !!currentPopup,
            wkOn: document.querySelectorAll(".wk.on").length,
            rootInputs: document.querySelectorAll(".lf-popup .lf-input").length,
            panels: panels.map((p) => ({
              title: (p.querySelector(".lf-title") || {}).textContent || "",
              hasInput: !!p.querySelector(".lf-input"),
            })),
          };
        } catch (e) {
          popupInfo = { error: String(e) };
        }
        let mutedCount = 0;
        try {
          for (const t of Array.from(window.gBrowser.tabs) as Array<{ muted?: boolean }>) {
            if (t.muted) mutedCount++;
          }
        } catch (e) {
          // ignore
        }
        const state = {
          popup: popupInfo,
          navDisplay: st(nav),
          tabsDisplay: st(tabs),
          toolboxDisplay: st(toolbox),
          toolboxHeight: br ? Math.round(br.height) : -1,
          hoverReveal: Services.prefs.getBoolPref("lazyfox.hoverReveal", false),
          toolboxHover: hover,
          leaderActive: leader ? leader.active : false,
          mutedCount: mutedCount,
          lastAction: lastAction,
          statusMounted: chromeStatusBar ? chromeStatusBar.mounted : false,
          statusPosition: (cfg.config.statusBarPosition || "bottom"),
          leaderPending: leader ? leader.hasPending() : false,
        };
        json = btoa(JSON.stringify(state));
      } catch (e) {
        json = btoa(JSON.stringify({ error: String(e) }));
      }
      setHash(browser, "#lfc=state." + json + "." + nonce);
      return;
    }
    if (cmd === "sessionState") {
      // Status-bar reply from the background: sessionState.<b64>.<nonce>.
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const state = JSON.parse(new TextDecoder().decode(bytes));
        chromeStatusInfo = {
          name: state && state.name ? String(state.name) : "default",
          marker: state && state.marker ? Number(state.marker) : 0,
          inSplit: !!(state && state.inSplit),
          sessions: (state && state.sessions) || [],
        };
        computeChromeStatus();
      } catch (e) {
        // ignore
      }
      try {
        const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
        if (tab) window.gBrowser.removeTab(tab);
      } catch (e) {
        // ignore
      }
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
            applyHoverRevealPref();
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

      if (leader.hasPending()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        leader.handlePending(e.key);
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
    // A blur fires on every tab switch (tabbrowser's _adjustFocusAfterTabSwitch
    // moves focus through the window), so close only on a real deactivation of
    // the OS window — checked on the next tick, after the switch settles.
    typing.reset();
    setTimeout(() => {
      try {
        if (Services.focus.activeWindow === window) return;
      } catch (e) {
        // fall through and close
      }
      if (currentPopup) closePopup();
      if (leader.active) leader.hide();
    }, 0);
  });

  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      typing.reset();
    });
  } catch (e) {
    // ignore
  }
})();
