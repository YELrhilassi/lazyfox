// Chrome helper entry (userChrome.uc.js equivalent). This is the composition
// root: it builds the focused modules (config, popup host, split view, status
// bar, debug, channel), wires the chromeOps adapter to them, and glues the
// shared leader/popups to the browser window (key handling, hotkeys, the
// #lfc= progress listener, status-bar polling). No logic lives here beyond
// the wiring — each concern lives in its own module.

import { core } from "../shared/core";
import { dbg } from "../shared/dev";
import { LeaderController } from "../shared/leader";
import { toast } from "../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";
import type { PopupItem } from "../shared/types";
import { createChannel, type Channel } from "./channel";
import { applyHoverRevealPref, loadCfg, persistCfg, withConfig, type ChromeCfg } from "./config";
import { ensureChromeCore, initChromeCore } from "./core";
import { createDebug, type DebugHandlers } from "./debug";
import { chromeOps } from "./ops";
import { createPopupHost } from "./popup";
import { createSplitView, type SplitView } from "./splitview";
import { createStatusBar, type StatusBarCtl } from "./statusbar";
import { createTypingChannel } from "./typing";

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

  /* ===================== config (prefs) ===================== */

  const cfg: ChromeCfg = loadCfg();
  applyHoverRevealPref(cfg);
  const leaderKey = () => cfg.config.leader || ";";

  /* ===================== modules ===================== */

  const popup = createPopupHost();

  // Late-bound references: the modules below are mutually dependent (split
  // needs the channel's base URL, the channel needs split/status), so each is
  // created with getters that resolve the others at call time.
  let split!: SplitView;
  let status!: StatusBarCtl;
  let channel!: Channel;
  let debug!: DebugHandlers;
  let leader: LeaderController | null = null;
  let lastAction: string | null = null;

  const getMode = (): "POPUP" | "LEADER" | "NORMAL" =>
    popup.isOpen() ? "POPUP" : leader && leader.active ? "LEADER" : "NORMAL";

  status = createStatusBar({
    realTabs: () => split.realTabs(),
    getConfig: () => cfg,
    getMode,
    dismissDownload: (key) => chromeOps.dismissDownload(key),
  });

  split = createSplitView({
    ccBaseUrl: () => channel.ccBaseUrl(),
    onSplitChange: () => status.update(),
  });

  debug = createDebug({
    getState: () => ({
      hasPopup: () => popup.isOpen(),
      leaderActive: () => !!(leader && leader.active),
      leaderPending: () => !!(leader && leader.hasPending()),
      lastAction: () => lastAction,
      statusMounted: () => status.mounted(),
      statusPosition: () => cfg.config.statusBarPosition || "bottom",
      dlActive: () => status.dlActive(),
      isFullscreen: () => status.isFullscreen(),
      activeSplitView: () => split.activeSplitView(),
      cfg: () => cfg,
    }),
  });

  /* ===================== popup context + leader ===================== */

  let leaderActions: Record<string, () => void> = {};
  const ctx: PopupCtx = {
    ops: chromeOps,
    open: popup.open,
    close: popup.close,
    toast: toast,
    runAction: (k) => runLeaderAction(leaderActions, k),
    bindings: () => (leader ? leader.bindings() : Promise.resolve([])),
    manualText: false,
  };
  leaderActions = makeLeaderActions(ctx);

  channel = createChannel({
    ctx,
    ops: chromeOps as unknown as { openTarget(which: string): boolean; openResize(): void },
    split,
    status,
    cfg,
    debug,
  });

  /* ===================== wire chromeOps to chrome ===================== */

  chromeOps.startHints = () => channel.requestBg("startHints");
  chromeOps.focusFirstInput = () => channel.requestBg("focusFirstInput");
  chromeOps.stealthOpen = () => channel.requestBg("stealthOpen");
  chromeOps.openResize = () => popup.openResizePopup();
  chromeOps.toggleReveal = () => {
    const next = withConfig(cfg, { hoverReveal: !cfg.config.hoverReveal });
    cfg.config = next.config;
    persistCfg(cfg, cfg.config);
    applyHoverRevealPref(cfg);
    toast("toolbar reveal: " + (cfg.config.hoverReveal ? "on" : "off"));
  };
  // Session + split actions relay to the extension background (which owns
  // browser.storage) through the #lfc=req channel.
  const sessionAction = (action: string, arg?: string) => {
    channel.requestBg(action, arg);
    // Refresh the status bar's session list after the action lands.
    setTimeout(channel.requestSessionState, 900);
  };
  chromeOps.saveSession = (name: string) => sessionAction("saveSession", name);
  chromeOps.newSession = (name: string) => sessionAction("newSession", name);
  chromeOps.restoreSession = (name: string) => sessionAction("restoreSession", name);
  chromeOps.deleteSession = (name: string) => sessionAction("deleteSession", name);
  chromeOps.switchSessionByMarker = (marker: number) =>
    sessionAction("switchSessionByMarker", String(marker));
  chromeOps.assignSessionMarker = (name: string, marker: number) =>
    sessionAction("assignSessionMarker", name + "\u0001" + marker);
  chromeOps.quit = () => channel.requestBg("quit");

  chromeOps.splitTab = (orientation: "horizontal" | "vertical") => {
    if (!split.splitCurrentTab(orientation)) {
      const api = typeof window.gBrowser.addTabSplitView === "function";
      toast(api ? "could not split (pinned tab or stale split state)" : "native split needs Firefox 149+");
    }
  };
  chromeOps.unsplitTab = () => {
    if (!split.unsplit()) toast("not in a split view");
  };
  chromeOps.switchSplitPane = (dir: number) => {
    if (!split.switchPane(dir)) toast("not in a split view");
  };
  chromeOps.swapSplitPane = (dir: number) => {
    if (!split.swapPane(dir)) toast("not in a split view");
  };
  chromeOps.splitAddTabByIndex = (n: number) => {
    if (!split.addTabToSplitByIndex(n)) toast("no split view to move into");
  };
  chromeOps.toggleWhichKey = () => {
    const next = withConfig(cfg, { whichKey: cfg.config.whichKey === false });
    cfg.config = next.config;
    persistCfg(cfg, cfg.config);
    // Keep the background's stored config in step (the chrome helper only
    // caches a copy).
    channel.requestBg("toggleWhichKey");
    toast("which-key: " + (cfg.config.whichKey !== false ? "on" : "off"));
  };
  // The tab switcher popup on chrome pages: real tabs only (skip the
  // split-panel companion and the #lfc= request channel), with each row's
  // true Firefox id shown in the list. The ids come from a fresh
  // sessionState round-trip (status.getTabIds), which also keeps the status
  // bar current while the popup is open.
  chromeOps.listTabs = async (q: string) => {
    await channel.requestSessionState();
    const ql = (q || "").trim().toLowerCase();
    const out: PopupItem[] = [];
    const tabIds = status.getTabIds();
    const stealthFlags = status.getStealthFlags();
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
        realId: tabIds[i], // true Firefox tab id, for display
        title: t.label || uri || "",
        url: uri,
        active: !!t.selected,
        pinned: !!t.pinned,
        muted: !!t.muted,
        stealth: !!stealthFlags[i],
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
    await channel.requestSessionState();
    const ql = (q || "").trim().toLowerCase();
    let items: PopupItem[] = status.getInfo().sessions.map((s) => ({
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

  leader = new LeaderController(
    (k) => {
      lastAction = k;
      runLeaderAction(leaderActions, k);
    },
    () => cfg.config.whichKey !== false
  );
  // ;' = quick switch: capture the next digit and jump to the marked session.
  leaderActions["'"] = () =>
    leader!.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        chromeOps.switchSessionByMarker(Number(k));
        return true;
      }
      return false;
    }, 3000);
  // ;+1-9 = move tab N into the current split view.
  leaderActions["+"] = () =>
    leader!.armPending((k) => {
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
      const out = await leader!.devSelfTest();
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
    if (!channel.ccBaseUrl()) return; // extension not ready yet; poll retries
    announcedAlive = true;
    try {
      channel.requestBg("alive");
    } catch (e) {
      announcedAlive = false; // allow one more try
    }
  }
  announceChromeAlive();

  /* ==================== status bar (tmux-style) ==================== */

  status.update();
  status.compute();
  // Poll every 500ms so the bar hides the moment content enters DOM fullscreen
  // (video) — only a poll catches that attribute transition reliably.
  // status.update is idempotent and cheap.
  setInterval(() => {
    announceChromeAlive(); // once the extension URL resolves, tell it we're here
    status.update();
    status.compute();
  }, 500);
  // Download progress on the bar: poll Downloads.sys.mjs once a second and
  // refresh the ⭳ segment. The popup reads the same manager cache, so the two
  // always agree.
  setInterval(() => {
    void status.pollDownloads();
  }, 1000);
  setTimeout(() => {
    void status.pollDownloads();
  }, 1500);
  // When a page element goes fullscreen (a video), the window-level bar would
  // sit over the full-screen content — hide it and re-show when it exits.
  // status.update() reads isFullscreen() itself, so it handles both edges.
  try {
    const onFullscreen = () => status.update();
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
  setTimeout(channel.requestSessionState, 2000);
  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      split.rememberSplit();
      // The stealth badge must track the tab you switched to immediately;
      // sessionState round-trips are not polled on TabSelect, so derive the
      // flag locally from the per-tab stealthFlags the last reply carried.
      try {
        const sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
        status.setActiveStealth(!!(status.getStealthFlags()[sel] || false));
      } catch (e) {
        // ignore
      }
      status.update();
      status.compute();
    });
  } catch (e) {
    // ignore
  }

  /* ==================== lfc progress listener ==================== */

  window.gBrowser.addTabsProgressListener({
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener"]),
    onLocationChange(browser: any, webProgress: any, request: any, location: any) {
      if (!location) return;
      // The selected tab may have crossed the web/chrome boundary (e.g. a web
      // page navigated to about:preferences): remount the chrome status bar
      // accordingly. update is cheap and idempotent, and the status module
      // reads the *selected* browser, so location changes in background tabs
      // are harmless here.
      status.update();
      if (location.scheme !== "moz-extension") return;
      const spec = location.spec;
      const h = spec.indexOf("#");
      if (h < 0) return;
      const frag = spec.slice(h + 1);
      if (frag.indexOf("lfc=") !== 0) return;
      channel.handleLfc(browser, frag.slice(4));
    },
  });

  /* ==================== hotkeys ===================== */

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
        if (cfg.bindings[t as keyof typeof cfg.bindings] === combo) {
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
      if (popup.isOpen()) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (popup.resizeOnKey(e)) return;
          popup.close();
        } else if (popup.resizeOnKey(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }

      if (leader!.hasPending()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        leader!.handlePending(e.key);
        return;
      }

      if (leader!.active) {
        e.preventDefault();
        e.stopImmediatePropagation();
        leader!.handleKey(e);
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
        leader!.show();
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
        leader!.show();
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
      if (popup.isOpen()) popup.close();
      if (leader!.active) leader!.hide();
    }, 0);
  });

  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      typing.reset();
    });
  } catch (e) {
    // ignore
  }

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
})();
