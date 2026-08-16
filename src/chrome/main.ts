// Chrome helper entry (userChrome.uc.js equivalent): wires the shared leader,
// popup engine and actions to chrome-only plumbing (Services, gBrowser, the
// #lfc= URL channel, hotkeys). All popups/actions live in ../shared/popups
// behind the ActionOps adapter (chrome/ops.ts); this file only glues them to
// the browser window.

import { mergeConfig, mergeHotkeys } from "../shared/config";
import { core } from "../shared/core";
import { ensureChromeCore, initChromeCore } from "./core";
import { chromeOps } from "./ops";
import { activeDownloads, updateDownloads } from "./downloads";
import { createTypingChannel } from "./typing";
import { dbg } from "../shared/dev";
import { LeaderController } from "../shared/leader";
import { PANEL_CSS, toast, type PopupCtl } from "../shared/overlay";
import { makeLeaderActions, openBookmarksPopup, openDownloadsPopup, openHistoryPopup, openSearchPopup, openTabsPopup, openUrlPopup, runLeaderAction, type PopupCtx } from "../shared/popups";
import { StatusBar } from "../shared/statusbar";
import type { ChromeHotkeys, Config, PopupItem } from "../shared/types";

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
  chromeOps.stealthOpen = () => requestBg("stealthOpen");
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
  chromeOps.newSession = (name: string) => sessionAction("newSession", name);
  chromeOps.restoreSession = (name: string) => sessionAction("restoreSession", name);
  chromeOps.deleteSession = (name: string) => sessionAction("deleteSession", name);
  chromeOps.switchSessionByMarker = (marker: number) =>
    sessionAction("switchSessionByMarker", String(marker));
  chromeOps.assignSessionMarker = (name: string, marker: number) =>
    sessionAction("assignSessionMarker", name + "\u0001" + marker);
  /* ============ native split view (Firefox 149+) ============ */

  // Firefox 149+ ships a native split view (two real tabs side-by-side). It has
  // no extension API yet (bug 2016928 — only a WECG proposal), but this chrome
  // helper runs privileged and can drive it through gBrowser.addTabSplitView.
  // When available it is strictly better than the iframe split: each pane is a
  // real top-level tab, so no site can block embedding and both panes keep full
  // focus/history/zoom state. The iframe split remains a side-by-side
  // fallback for older Firefox.
  function nativeSplitAvailable(): boolean {
    try {
      if (typeof window.gBrowser.addTabSplitView !== "function") return false;
      let on = false;
      try {
        on = Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false);
      } catch (e) {
        on = false;
      }
      if (!on) {
        // The feature flag is not set in this profile (only the test profile
        // sets it via user.js). The chrome helper is privileged: enable it so
        // the split view works everywhere Firefox ships it.
        try {
          Services.prefs.setBoolPref("browser.tabs.splitView.enabled", true);
          on = true;
        } catch (e) {
          return false;
        }
      }
      return on;
    } catch (e) {
      return false;
    }
  }

  // The split-panel companion pane (search/URL + move-a-tab list) is pure UI:
  // it must never accumulate as stray tabs or be offered as a move target.
  // Tabs we created as panels are tracked by reference because the panel's
  // currentURI is still about:blank for a moment after creation (the
  // splitpanel.html document has not committed yet).
  const createdPanelTabs = new Set<any>();
  function isSplitPanelTab(tab: any): boolean {
    if (tab && createdPanelTabs.has(tab)) return true;
    try {
      const spec =
        tab && tab.linkedBrowser && tab.linkedBrowser.currentURI
          ? tab.linkedBrowser.currentURI.spec
          : "";
      return spec.indexOf("splitpanel.html") !== -1;
    } catch (e) {
      return false;
    }
  }

  // Transient tabs (the split panel + the #lfc= request channel) are not
  // user tabs: they are hidden from numbering so a tab's 1-9 identity never
  // changes just because a split/unsplit added or removed a companion pane.
  function isTransientTab(tab: any): boolean {
    try {
      if (isSplitPanelTab(tab)) return true;
      const spec =
        tab && tab.linkedBrowser && tab.linkedBrowser.currentURI
          ? tab.linkedBrowser.currentURI.spec
          : "";
      return spec.indexOf("#lfc=") !== -1;
    } catch (e) {
      return false;
    }
  }

  // Real (user) tabs in strip order — the stable 1-9 identity space.
  function realTabs(): any[] {
    const out: any[] = [];
    for (const t of window.gBrowser.tabs) {
      if (t && !isTransientTab(t)) out.push(t);
    }
    return out;
  }

  // The split view wrapper the user last interacted with, so `;+` (move the
  // selected tab into the split) works even while the selected tab itself is
  // outside the split. gBrowser.activeSplitView covers the same case on newer
  // Firefox; this fallback guards older 149/150 builds where it was not yet
  // exposed. The wrapper is a DOM element, so isConnected detects unsplits.
  let lastNativeSplit: any = null;

  function rememberSplit(): void {
    try {
      const sv = activeSplitView();
      if (sv) lastNativeSplit = sv;
      else if (lastNativeSplit && lastNativeSplit.isConnected === false) lastNativeSplit = null;
    } catch (e) {
      // ignore
    }
    // A split appearing or dissolving flips whether the window-level status
    // bar owns the bottom of the window, so re-evaluate it right away instead
    // of waiting for the next TabSelect / location change.
    updateChromeStatus();
  }

  function activeSplitView(): any {
    try {
      const tab = window.gBrowser.selectedTab;
      if (tab && tab.splitview) return tab.splitview;
      try {
        if (window.gBrowser.activeSplitView) return window.gBrowser.activeSplitView;
      } catch (e) {
        // not exposed on this build
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function nativeSplitCurrentTab(
    orientation: "horizontal" | "vertical"
  ): boolean {
    if (orientation !== "horizontal") return false; // native is side-by-side only
    try {
      if (!nativeSplitAvailable()) return false;
      const active = window.gBrowser.selectedTab;
      if (!active || active.pinned) return false;
      // A stale .splitview reference can linger after an unsplit on some
      // builds; dissolve it first so ;| on the very same tab works again
      // instead of failing with a spurious "needs Firefox 149+" toast.
      if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
        try {
          active.splitview.unsplitTabs();
        } catch (e) {
          // ignore
        }
      }
      const base = ccBaseUrl();
      const splitPanelUrl = base ? base + "splitpanel.html" : "about:blank";
      const activePos = window.gBrowser.tabs.indexOf(active);
      // Reuse a leftover split-panel tab (not in a split) instead of always
      // creating a new pane: it keeps the strip from accumulating panels.
      let blank: any = null;
      for (const t of window.gBrowser.tabs) {
        if (t && !t.pinned && !t.splitview && isSplitPanelTab(t)) {
          blank = t;
          break;
        }
      }
      if (!blank) {
        blank = window.gBrowser.addTab(splitPanelUrl, {
          // Keep the original tab selected: the pane the user was looking at
          // stays the active pane of the new split view. The new pane lands on
          // the split panel (search/URL + move-a-tab list) instead of a blank
          // page.
          inBackground: true,
          skipAnimation: true,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        createdPanelTabs.add(blank);
      } else {
        createdPanelTabs.add(blank);
      }
      // Park the panel immediately after the active tab so the pair is already
      // adjacent: gBrowser.addTabSplitView otherwise regroups the two tabs
      // (moving the pair to the end) and reshuffles every tab between them.
      try {
        const want = window.gBrowser.tabs.indexOf(active) + 1;
        const at = window.gBrowser.tabs.indexOf(blank);
        if (at !== want) window.gBrowser.moveTabTo(blank, { tabIndex: want });
      } catch (e) {
        // ignore
      }
      try {
        window.gBrowser.addTabSplitView([active, blank]);
      } catch (e) {
        // First attempt can fail with stale internal split state; dissolve the
        // active tab's split group and retry once.
        try {
          if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
            active.splitview.unsplitTabs();
          }
        } catch (e2) {
          // ignore
        }
        window.gBrowser.addTabSplitView([active, blank]);
      }
      // addTabSplitView may still regroup the pair (moving it to the end); pin
      // the active tab — and its partner, which travels with it — back to its
      // original slot so the strip order stays stable.
      try {
        const now = window.gBrowser.tabs.indexOf(active);
        if (now !== activePos && activePos >= 0) {
          window.gBrowser.moveTabTo(active, { tabIndex: activePos });
        }
      } catch (e) {
        // ignore
      }
      rememberSplit();
      return true;
    } catch (e) {
      if (__DEV__) dbg("native split failed: " + String(e));
      return false;
    }
  }

  function nativeAddTabToSplit(): boolean {
    try {
      if (!nativeSplitAvailable()) return false;
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      if (!sv) return false;
      const tab = window.gBrowser.selectedTab;
      if (!tab || tab.pinned) return false;
      if (tab.splitview === sv) return true; // already in this split
      if (typeof sv.addTabs !== "function") return false;
      sv.addTabs([tab]);
      rememberSplit();
      return true;
    } catch (e) {
      if (__DEV__) dbg("native add-to-split failed: " + String(e));
      return false;
    }
  }

  // Drop the split-panel companion pane(s) from a split view — they are pure
  // UI ("move a tab into this split") and must not pile up as panes once a
  // real tab has been moved in or the split is dissolved.
  function removePanelPanes(sv: any): void {
    const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
    for (const p of panes) {
      try {
        if (!p || p.closing) continue;
        if (isSplitPanelTab(p)) {
          createdPanelTabs.delete(p);
          window.gBrowser.removeTab(p);
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // Move tab number `n` (1-based position among REAL tabs, ;+1-9) into the
  // active split view. Numbering skips the split-panel companion, so a tab's
  // number is stable: splitting/unsplitting never shifts it.
  //
  // When no split exists yet, the active tab is split DIRECTLY with tab n —
  // no companion panel pane, so auto-splitting never leaves an empty pane
  // behind. When a split exists with a panel companion, the moved tab
  // REPLACES the panel instead of stacking a third pane (the panel is added
  // first, so the split never drops below two panes and auto-unsplits).
  function nativeAddTabToSplitByIndex(n: number): boolean {
    try {
      if (!nativeSplitAvailable()) return false;
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      const tab = realTabs()[n - 1];
      if (!tab || tab.pinned) return false;
      if (!sv) {
        // Auto-split: pair the active tab with tab N directly.
        const active = window.gBrowser.selectedTab;
        if (!active || active.pinned || active === tab) return false;
        // A stale .splitview reference can linger after an unsplit; dissolve
        // it first so the auto-split succeeds instead of failing.
        if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
          try {
            active.splitview.unsplitTabs();
          } catch (e) {
            // ignore
          }
        }
        window.gBrowser.addTabSplitView([active, tab]);
        rememberSplit();
        return true;
      }
      if (tab.splitview === sv) return true; // already in this split
      // A dissolved split can leave a stale .splitview reference on the tab
      // (a known Firefox quirk after unsplit); Firefox's addTabs then refuses
      // the tab and the move silently fails. Dissolve any leftover reference
      // first — it is a different (disconnected) view, so this only clears
      // the stale state.
      if (tab.splitview && tab.splitview !== sv) {
        try {
          const stale = tab.splitview;
          if (typeof stale.unsplitTabs === "function") stale.unsplitTabs();
          else if (stale.isConnected === false) stale.unsplitTabs?.();
        } catch (e) {
          // ignore — the view is already gone
        }
      }
      if (typeof sv.addTabs !== "function") return false;
      sv.addTabs([tab]);
      removePanelPanes(sv);
      rememberSplit();
      return true;
    } catch (e) {
      if (__DEV__) dbg("native add-to-split-by-index failed: " + String(e));
      return false;
    }
  }

  function nativeUnsplit(): boolean {
    try {
      const sv = activeSplitView();
      if (!sv || typeof sv.unsplitTabs !== "function") return false;
      const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      sv.unsplitTabs();
      // The companion split-panel pane is pure UI: close it once the split
      // dissolves so it never piles up as a stray tab. A pane the user
      // navigated to real content is kept.
      for (const p of panes) {
        try {
          if (!p || p.closing) continue;
          if (isSplitPanelTab(p)) {
            createdPanelTabs.delete(p);
            window.gBrowser.removeTab(p);
          }
        } catch (e) {
          // ignore
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function nativeSwitchPane(dir: number): boolean {
    try {
      const sv = activeSplitView();
      if (sv && Array.isArray(sv.tabs) && sv.tabs.length > 1) {
        const active = window.gBrowser.selectedTab;
        const idx = sv.tabs.indexOf(active);
        const next =
          sv.tabs[(idx + (dir > 0 ? 1 : -1) + sv.tabs.length) % sv.tabs.length];
        if (next) {
          window.gBrowser.selectedTab = next;
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Swap the split panes around (tmux swap-pane): ;{ moves the active pane
  // left, ;} moves it right. Firefox's native split view ships reverseTabs,
  // but on splits formed via addTabs (the panel path) it leaves the tabs API
  // in a bad state (splitViewId queries start resolving undefined), and
  // moveTabTo keeps split pairs glued together — so the swap dissolves the
  // pair and re-splits it with the pane order flipped. The pane layout
  // follows the array passed to addTabSplitView, so no tab moves are needed.
  function nativeSwapPane(dir: number): boolean {
    try {
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      if (!sv || !Array.isArray(sv.tabs) || sv.tabs.length < 2) return false;
      const active = window.gBrowser.selectedTab;
      const idx = sv.tabs.indexOf(active);
      if (idx < 0) return false;
      const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      if (panes.length === 2) {
        // Two panes: swapping either direction reverses them.
        panes.reverse();
      } else {
        panes.splice(idx, 1);
        const ni = (idx + (dir > 0 ? 1 : -1) + panes.length) % panes.length;
        panes.splice(ni, 0, active);
      }
      if (typeof sv.unsplitTabs !== "function") return false;
      sv.unsplitTabs();
      if (typeof window.gBrowser.addTabSplitView === "function") {
        window.gBrowser.addTabSplitView(panes);
      }
      window.gBrowser.selectedTab = active;
      rememberSplit();
      return true;
    } catch (e) {
      if (__DEV__) dbg("native swap failed: " + String(e));
      return false;
    }
  }

  chromeOps.splitTab = (orientation: "horizontal" | "vertical") => {
    if (!nativeSplitCurrentTab(orientation)) {
      const api = typeof window.gBrowser.addTabSplitView === "function";
      toast(api ? "could not split (pinned tab or stale split state)" : "native split needs Firefox 149+");
    }
  };
  chromeOps.unsplitTab = () => {
    if (!nativeUnsplit()) toast("not in a split view");
  };
  chromeOps.switchSplitPane = (dir: number) => {
    if (!nativeSwitchPane(dir)) toast("not in a split view");
  };
  chromeOps.swapSplitPane = (dir: number) => {
    if (!nativeSwapPane(dir)) toast("not in a split view");
  };
  chromeOps.splitAddTabByIndex = (n: number) => {
    if (!nativeAddTabToSplitByIndex(n)) toast("no split view to move into");
  };
  chromeOps.toggleWhichKey = () => {
    cfg.config.whichKey = cfg.config.whichKey === false;
    try {
      Services.prefs.setStringPref("lazyfox.chrome.config", JSON.stringify(cfg.config));
    } catch (e) {
      // ignore
    }
    // Keep the background's stored config in step (the chrome helper only
    // caches a copy).
    requestBg("toggleWhichKey");
    toast("which-key: " + (cfg.config.whichKey !== false ? "on" : "off"));
  };
  // The tab switcher popup on chrome pages: real tabs only (skip the
  // split-panel companion and the #lfc= request channel), with each row's
  // true Firefox id shown in the list. The ids come from a fresh
  // sessionState round-trip (chromeStatusTabIds), which also keeps the status
  // bar current while the popup is open.
  chromeOps.listTabs = async (q: string) => {
    await requestSessionState();
    const ql = (q || "").trim().toLowerCase();
    const out: PopupItem[] = [];
    const tabs = window.gBrowser.tabs;
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      try {
        const spec =
          t.linkedBrowser && t.linkedBrowser.currentURI
            ? t.linkedBrowser.currentURI.spec
            : "";
        if (spec.indexOf("splitpanel.html") !== -1 || spec.indexOf("#lfc=") !== -1) continue;
      } catch (e) {
        // ignore
      }
      let uri = "";
      try {
        uri = (t.linkedBrowser && t.linkedBrowser.currentURI && t.linkedBrowser.currentURI.spec) || "";
      } catch (e) {
        // ignore
      }
      const item: PopupItem = {
        id: i, // strip index — what the chrome ops address
        realId: chromeStatusTabIds[i], // true Firefox tab id, for display
        title: t.label || uri || "",
        url: uri,
        active: !!t.selected,
        pinned: !!t.pinned,
        muted: !!t.muted,
        stealth: !!chromeStatusStealthFlags[i],
        favIconUrl: (t.getAttribute && t.getAttribute("image")) || "",
      };
      if (!ql || ((item.title || "") + " " + (item.url || "")).toLowerCase().indexOf(ql) !== -1) {
        out.push(item);
      }
    }
    return out;
  };

  // The sessions popup needs the session list on chrome-only pages too. Answer
  // from the cached status-bar summary (which requestSessionState refreshes)
  // and kick a background refresh so the next open is current.
  chromeOps.listSessions = async (q: string) => {
    // Await a fresh status-bar refresh so the list reflects a just-completed
    // save/delete instead of the stale cache (the sessions popup reads this
    // list right after a mutation).
    await requestSessionState();
    const ql = (q || "").trim().toLowerCase();
    let items: PopupItem[] = chromeStatusInfo.sessions.map((s) => ({
      kind: "session",
      title: s.name,
      marker: s.marker || 0,
      subtitle:
        (s.marker ? "marker " + s.marker + " \u00b7 " : "") +
        (s.tabCount || 0) +
        " tabs" +
        (s.splitCount ? " \u00b7 " + s.splitCount + " split" : ""),
    }));
    if (ql) items = items.filter((s) => (s.title || "").toLowerCase().indexOf(ql) !== -1);
    return items;
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
  // ;+1-9 = move tab N into the current split view.
  leaderActions["+"] = () =>
    leader.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        chromeOps.splitAddTabByIndex(Number(k));
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
  // content scripts can hand leader-key handling over to chrome and hide their
  // own status bar (the chrome helper owns the single window-level bar). The
  // announce is fire-and-forget and needs the extension's moz-extension URL,
  // so it can miss when the window opened before the add-on finished loading
  // (fresh test profiles, slow first run). announceChromeAlive() retries from
  // the 500ms poll until the extension URL is resolvable, then stops.
  let announcedAlive = false;
  function announceChromeAlive(): void {
    if (announcedAlive) return;
    if (!ccBaseUrl()) return; // extension not ready yet; poll retries
    announcedAlive = true;
    try {
      requestBg("alive");
    } catch (e) {
      announcedAlive = false; // allow one more try
    }
  }
  announceChromeAlive();

  /* ==================== status bar (tmux-style) ==================== */

  // The chrome helper draws the window-level bar into the browser XUL
  // document and reserves space by shrinking the #browser content area
  // (margin on #browser), so the fixed bar sits in reserved space instead of
  // overlapping the page — for a single tab and for split panes alike.
  const chromeStatusBar = new StatusBar(true, "#browser");
  // Clicking a download notification on the bar dismisses just that one (the
  // popup list keeps it).
  chromeStatusBar.setDownloadDismiss((key) => {
    chromeOps.dismissDownload(key);
    void refreshDownloadStatus();
  });
  let chromeStatusInfo = {
    name: "default",
    marker: 0,
    inSplit: false,
    splitOrientation: undefined as "horizontal" | "vertical" | undefined,
    splitActive: 0,
    splitPanes: 0,
    activeStealth: false,
    sessions: [] as { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[],
  };
  // Real tab ids in strip order from the last sessionState reply, so the tab
  // switcher popup can show each tab's true Firefox id.
  let chromeStatusTabIds: number[] = [];
  // Stealth flags parallel to chromeStatusTabIds (strip order), so the tab
  // switcher can badge stealth tabs without re-querying the containers.
  let chromeStatusStealthFlags: boolean[] = [];
  // Active (un-dismissed) downloads for the status bar's progress segment.
  let chromeStatusDownloads: { key: string; filename: string; state: string; percent: number; speed: string }[] = [];

  // Is the selected tab the extension's command center page?
  function isCommandCenterTab(): boolean {
    try {
      const b = window.gBrowser.selectedBrowser;
      const uri = b && b.currentURI;
      if (!uri) return false;
      const s = uri.spec || "";
      return s.indexOf("commandcenter.html") !== -1;
    } catch (e) {
      return false;
    }
  }

  // ONE window-level bar owns the bottom of the window for EVERY tab — plain
  // web pages, chrome-only pages, and split panes alike. The bar lives in the
  // chrome document (outside the web content) and reserves its 18px by
  // shrinking the #browser content area, so the page reflows above it instead
  // of rendering underneath it — the fix for the old per-page fixed bar, which
  // always overlapped the bottom of the viewport while scrolling. The content
  // script hides its own bar whenever the chrome helper is alive (see
  // content/main.ts) so there is exactly one bar, single tab or split.
  function chromePageNeedsStatus(): boolean {
    return true;
  }

  // True while a page element is in DOM fullscreen (an HTML5 video, a gallery
  // lightbox, ...) — Firefox sets the `inDOMFullscreen` attribute on the
  // chrome document root. Only then does the bar hide: browser-level
  // fullscreen (zen mode, F11) keeps the bar visible, because there the bar
  // still owns the bottom of the window and the page fills the rest.
  function isFullscreen(): boolean {
    try {
      return document.documentElement.hasAttribute("inDOMFullscreen");
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
      splitOrientation: chromeStatusInfo.splitOrientation,
      splitActive: chromeStatusInfo.splitActive,
      splitPanes: chromeStatusInfo.splitPanes,
      activeStealth: chromeStatusInfo.activeStealth,
      mode: mode,
      sessions: chromeStatusInfo.sessions,
      downloads: chromeStatusDownloads,
    });
  }

  function updateChromeStatus(): void {
    if (cfg.config.statusBar === false || isFullscreen()) {
      chromeStatusBar.hide();
      return;
    }
    chromeStatusBar.setPosition(cfg.config.statusBarPosition || "bottom");
    if (chromePageNeedsStatus()) chromeStatusBar.show();
    else chromeStatusBar.hide();
  }

  // Recompute the status bar's download segment from the manager cache (the
  // Go activeDownloads/formatSpeed/progress helpers do the work) and re-render.
  async function refreshDownloadStatus(): Promise<void> {
    const active = await activeDownloads();
    const out: { key: string; filename: string; state: string; percent: number; speed: string }[] = [];
    for (const d of active) {
      const percent = await core.downloadProgress(d.received, d.total);
      const speed = await core.formatSpeed(d.speed);
      out.push({ key: d.id, filename: d.filename, state: d.state, percent: percent, speed: speed });
    }
    chromeStatusDownloads = out;
    computeChromeStatus();
  }

  async function pollDownloads(): Promise<void> {
    try {
      await updateDownloads();
      await refreshDownloadStatus();
    } catch (e) {
      // downloads are best-effort; never let a poll break the bar
    }
  }

  // One-shot waiters for requestSessionState, keyed by nonce, resolved by the
  // handleLfc "sessionState" reply. Lets the sessions popup await a FRESH
  // list after a delete/save instead of reading the stale cache (which made a
  // deleted session keep showing until the next Firefox restart).
  let sessionStateWaiters: Record<string, () => void> = {};

  function requestSessionState(): Promise<void> {
    const base = ccBaseUrl();
    if (!base) return Promise.resolve();
    const nonce = "ss" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    return new Promise((resolve) => {
      sessionStateWaiters[nonce] = resolve;
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
          if (sessionStateWaiters[nonce]) {
            delete sessionStateWaiters[nonce];
            resolve();
          }
        }, 5000);
      } catch (e) {
        if (sessionStateWaiters[nonce]) {
          delete sessionStateWaiters[nonce];
          resolve();
        }
      }
    });
  }

  updateChromeStatus();
  computeChromeStatus();
  // Poll every 500ms so the bar hides the moment content enters DOM fullscreen
  // (video) — only a poll catches that attribute transition reliably.
  // updateChromeStatus is idempotent and cheap.
  setInterval(() => {
    announceChromeAlive(); // once the extension URL resolves, tell it we're here
    updateChromeStatus();
    computeChromeStatus();
  }, 500);
  // Download progress on the bar: poll Downloads.sys.mjs once a second and
  // refresh the ⭳ segment. The popup reads the same manager cache, so the two
  // always agree.
  setInterval(() => {
    void pollDownloads();
  }, 1000);
  setTimeout(() => {
    void pollDownloads();
  }, 1500);
  // When a page element goes fullscreen (a video), the window-level bar would
  // sit over the full-screen content — hide it and re-show when it exits.
  try {
    const onFullscreen = () => {
      if (isFullscreen()) chromeStatusBar.hide();
      else updateChromeStatus();
    };
    window.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("willenterfullscreen", onFullscreen);
    window.addEventListener("willexitfullscreen", onFullscreen);
  } catch (e) {
    // ignore
  }
  // Fetch the session name + list once at startup and after chrome-triggered
  // session actions. Deliberately NOT polled on a timer or on TabSelect: the
  // round-trip creates a transient background tab, and doing that on a timer
  // would churn tab counts under automation.
  setTimeout(requestSessionState, 2000);
  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      rememberSplit();
      // The stealth badge must track the tab you switched to immediately;
      // sessionState round-trips are not polled on TabSelect, so derive the
      // flag locally from the per-tab stealthFlags the last reply carried.
      try {
        const sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
        chromeStatusInfo.activeStealth = !!(chromeStatusStealthFlags[sel] || false);
      } catch (e) {
        // ignore
      }
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

  // Drop the transient #lfc request tab after the chrome helper handles it.
  function removeReqTab(browser: any): void {
    try {
      const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
      if (tab) window.gBrowser.removeTab(tab);
    } catch (e) {
      // ignore
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
            items: panels
              .map((p) =>
                Array.from(p.querySelectorAll(".lf-item"))
                  .map((it) => (it.textContent || "").trim())
                  .slice(0, 40)
              )
              .reduce((a, b) => a.concat(b), []),
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
          dlCount: chromeStatusDownloads.length,
          dlActive: chromeStatusDownloads.map(
            (d) => d.filename + "|" + d.state + (d.percent >= 0 ? "|" + d.percent : "")
          ),
          // The window bar's rendered strip, as the StatusBar mirrors it onto
          // the chrome document root (name|marker|tabIdx/tabCount|split|mode|pos).
          statusAttr: (() => {
            try {
              return document.documentElement.getAttribute("data-lf-status");
            } catch (e) {
              return null;
            }
          })(),
          fullscreen: isFullscreen(),
          inDOMFullscreen: (() => {
            try {
              return document.documentElement.hasAttribute("inDOMFullscreen");
            } catch (e) {
              return false;
            }
          })(),
          browserReserve: (() => {
            try {
              const el = document.getElementById("browser");
              if (!el) return null;
              const cs = getComputedStyle(el);
              return { mb: cs.marginBottom, mt: cs.marginTop, h: Math.round(el.getBoundingClientRect().height) };
            } catch (e) {
              return null;
            }
          })(),

          leaderPending: leader ? leader.hasPending() : false,
          strip: (() => {
            try {
              return Array.from(window.gBrowser.tabs).map((t: any, i: number) => {
                let spec = "";
                try {
                  spec = t.linkedBrowser && t.linkedBrowser.currentURI
                    ? t.linkedBrowser.currentURI.spec : "";
                } catch (e) {}
                return {
                  i: i,
                  u: (spec.split("?")[0] || "").replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(-40),
                  sv: t.splitview ? t.splitview.splitViewId : (t.splitViewId ?? -1),
                  panel: spec.indexOf("splitpanel.html") !== -1,
                  req: spec.indexOf("#lfc=") !== -1,
                };
              });
            } catch (e) {
              return { error: String(e) };
            }
          })(),
          nativeSplit: (() => {
            try {
              const sv = activeSplitView();
              const sel = window.gBrowser.selectedTab;
              return {
                fn: typeof window.gBrowser.addTabSplitView,
                pref: Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false),
                selSplitview: sv
                  ? {
                      id: sv.splitViewId,
                      tabs: Array.isArray(sv.tabs) ? sv.tabs.length : -1,
                    }
                  : null,
                selHasSplitview: sel ? !!sel.splitview : false,
                selUrl: sel && sel.linkedBrowser && sel.linkedBrowser.currentURI
                  ? sel.linkedBrowser.currentURI.spec
                  : null,
              };
            } catch (e) {
              return { error: String(e) };
            }
          })(),
        };
        json = btoa(JSON.stringify(state));
      } catch (e) {
        json = btoa(JSON.stringify({ error: String(e) }));
      }
      setHash(browser, "#lfc=state." + json + "." + nonce);
      return;
    }
    if (cmd === "moveToSplit") {
      // ;+1-9 relayed from the background (or the split panel): move tab N
      // into the active split view, then remove the request tab.
      try {
        nativeAddTabToSplitByIndex(parseInt(rest, 10) || 0);
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "splitTab") {
      // ;| relayed from the background (content-script context).
      try {
        nativeSplitCurrentTab("horizontal");
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "unsplit") {
      // ;\ relayed from the background.
      try {
        nativeUnsplit();
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "switchPane") {
      // ;[ / ;] relayed from the background.
      try {
        nativeSwitchPane(parseInt(rest, 10) || 1);
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "restoreSplits") {
      // Session restore finished opening tabs; re-create the native split
      // groupings. `rest` is JSON of [[index, ...], ...] with 1-based
      // positions over the SAVED tab list — which restore recreates exactly
      // as the window's real (non-transient) tabs in order. Positions must be
      // resolved against realTabs() (which skips the splitpanel companion and
      // the #lfc= request channel): indexing window.gBrowser.tabs directly
      // would be shifted by those transient tabs (and any pinned tabs the
      // restore left in front), pairing the wrong tabs or none at all.
      try {
        const json = decodeURIComponent(rest);
        const groups = JSON.parse(json) as number[][];
        // Resolve the 1-based saved positions against non-pinned real tabs.
        // A restore re-opens saved tabs in order as unpinned tabs AFTER any
        // pinned tabs left in front, so pinned tabs must not offset the
        // positions (split view never involves pinned tabs).
        const real = realTabs().filter((t: any) => !t.pinned);
        for (const g of groups) {
          const tabs = (g || []).map((i) => real[i - 1]).filter((t: any) => !!t);
          if (tabs.length > 1 && typeof window.gBrowser.addTabSplitView === "function") {
            window.gBrowser.addTabSplitView(tabs);
          }
        }
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "swapSplitPanes") {
      // ;{ / ;} relayed from the background (content-script context): swap
      // the active pane with its left/right neighbour.
      try {
        nativeSwapPane(parseInt(rest, 10) || 1);
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "sessionState") {
      // Status-bar reply from the background: sessionState.<b64>.<nonce>.
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      const nonce = dot < 0 ? "" : rest.slice(dot + 1);
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const state = JSON.parse(new TextDecoder().decode(bytes));
        chromeStatusInfo = {
          name: state && state.name ? String(state.name) : "default",
          marker: state && state.marker ? Number(state.marker) : 0,
          inSplit: !!(state && state.inSplit),
          splitOrientation:
            state && state.splitOrientation === "vertical" ? "vertical" : "horizontal",
          splitActive: state && typeof state.splitActive === "number" ? state.splitActive : 0,
          splitPanes: state && typeof state.splitPanes === "number" ? state.splitPanes : 0,
          activeStealth: !!(state && state.activeStealth),
          sessions: (state && state.sessions) || [],
        };
        chromeStatusTabIds = Array.isArray(state && state.tabIds) ? state.tabIds : [];
        chromeStatusStealthFlags = Array.isArray(state && state.stealthFlags)
          ? state.stealthFlags
          : [];
        computeChromeStatus();
      } catch (e) {
        // ignore
      }
      const w = sessionStateWaiters[nonce];
      if (w) {
        delete sessionStateWaiters[nonce];
        w();
      }
      try {
        const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
        if (tab) window.gBrowser.removeTab(tab);
      } catch (e) {
        // ignore
      }
      return;
    }
    if (cmd === "reqResult") {
      // Async reply to a chrome-helper request (e.g. stealthOpen): toast the
      // outcome so a failure is never silent, then drop the reply tab.
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const r = JSON.parse(new TextDecoder().decode(bytes));
        if (r && r.ok === true) toast("stealth tab opened");
        else toast("stealth tab failed: " + ((r && r.error) || "unknown"));
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
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
      // The selected tab may have crossed the web/chrome boundary (e.g. a web
      // page navigated to about:preferences): remount the chrome status bar
      // accordingly. updateChromeStatus is cheap and idempotent, and
      // chromePageNeedsStatus() reads the *selected* browser, so location
      // changes in background tabs are harmless here.
      updateChromeStatus();
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

      // The command center is Lazyfox's own page: its input is focused by
      // default (so h/j/k/l etc. type normally), but the leader key must
      // still arm there — otherwise the home-screen command shortcuts
      // (;n, ;z, ;s, 1-6, ...) stop working the moment the input is focused.
      let k = e.key;
      if (
        k === leaderKey() &&
        !e.ctrlKey && !e.altKey && !e.metaKey &&
        isCommandCenterTab()
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        leader.show();
        return;
      }

      // Typing in a page input (or the URL bar): let the key through.
      if (typing.focusedIsTyping(e)) return;

      // Ctrl+1-9: hot-swap to the session with that marker (tmux-style).
      if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        chromeOps.switchSessionByMarker(Number(e.key));
        return;
      }

      if (handleHotkeys(e)) return;

      // Ctrl/Alt/Meta chords are never the leader key on their own.
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (k === leaderKey()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        leader.show();
        return;
      }
    },
    true
  );

  // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
  // and `'`, so it fires even after the leader has consumed the `keydown`.
  // Suppress it outside text fields so `;/` opens the find bar deliberately
  // rather than the native bar stealing the key.
  window.addEventListener(
    "keypress",
    (e) => {
      if (e.key !== "/" && e.key !== "'") return;
      if (!typing.focusedIsTyping(e)) {
        e.preventDefault();
        e.stopPropagation();
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
