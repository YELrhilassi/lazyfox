// Chrome helper entry (userChrome.uc.js equivalent). This is the composition
// root: it builds the focused modules (config, popup host, split view, status
// bar, debug, channel), wires the chromeOps adapter to them, and glues the
// shared leader/popups to the browser window (key handling, hotkeys, the
// #lfc= progress listener, status-bar polling). No logic lives here beyond
// the wiring — each concern lives in its own module.

import { dbg } from "../shared/dev";
import { LeaderController } from "../shared/leader";
import { toast } from "../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";
import { createChannel, type Channel } from "./channel";
import { applyHoverRevealPref, loadCfg, persistCfg, type ChromeCfg } from "./config";
import { ensureChromeCore, initChromeCore } from "./core";
import { createDebug, type DebugHandlers } from "./debug";
import { createChromeOps } from "./ops";
import { createPopupHost } from "./popup";
import { createSplitView, type SplitView } from "./splitview";
import { createStatusBar, type StatusBarCtl } from "./statusbar";
import { createTypingChannel } from "./typing";

(function () {
  "use strict";

  // Version of the chrome helper (userChrome.uc.js) shipped by the installer.
  // Announced to the extension's background with the alive ping and shown on
  // the options Components panel. Tracks the release; bump with each release.
  const CHROME_HELPER_VERSION = "0.5.6";

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
  let lastMoveDebug: string | null = null;

  const getMode = (): "POPUP" | "LEADER" | "NORMAL" => {
    if (popup.isOpen()) return "POPUP";
    if (leader && leader.active) return "LEADER";
    // The content script owns the leader key on web pages; its arm/disarm is
    // relayed through the background and cached per tab-strip index. Check
    // the SELECTED tab's index (the bar shows the selected tab's mode).
    if (contentLeaderActive()) return "LEADER";
    return "NORMAL";
  };

  status = createStatusBar({
    realTabs: () => split.realTabs(),
    getConfig: () => cfg,
    getMode,
  });

  split = createSplitView({
    ccBaseUrl: () => channel.ccBaseUrl(),
    onSplitChange: () => status.update(),
    onMove: (msg) => { lastMoveDebug = msg; },
  });

  debug = createDebug({
    getState: () => ({
      hasPopup: () => popup.isOpen(),
      leaderActive: () => !!(leader && leader.active),
      leaderPending: () => !!(leader && leader.hasPending()),
      lastAction: () => lastAction,
      lastMoveDebug: () => lastMoveDebug,
      statusMounted: () => status.mounted(),
      statusPosition: () => cfg.config.statusBarPosition || "bottom",
      dlActive: () => status.dlActive(),
      isFullscreen: () => status.isFullscreen(),
      activeSplitView: () => split.activeSplitView(),
      cfg: () => cfg,
      // The persistent relay's helper-side state (found window, ready flag)
      // so the harness can verify the bridge is up.
      relay: () => channel.relayDebug(),
    }),
  });

  /* ===================== chrome ops adapter ===================== */

  // Built with every dependency injected — no post-hoc monkey-patching. The
  // channel is created below and resolved lazily through the getter: the
  // channel needs the popup context that wraps ops, so the two form a
  // construction cycle broken by late binding.
  const chromeOps = createChromeOps({
    split,
    popup,
    status,
    cfg,
    persistCfg,
    applyHoverRevealPref,
    getChannel: () => channel,
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

  // The chrome-level key dispatch (leader/popups/hotkeys/typing guard), set
  // up below but referenced here so the #lfc=keys channel can drive it. The
  // closure resolves at call time (after init), so ordering is safe.
  let chromeKeyDown: (e: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  }) => boolean = () => false;

  channel = createChannel({
    ctx,
    ops: chromeOps as unknown as { openTarget(which: string): boolean; openResize(): void },
    split,
    status,
    cfg,
    debug,
    keys: { dispatch: (e) => chromeKeyDown(e) },
  });

  /* ===================== typing channel ===================== */

  const typing = createTypingChannel();

  /* ===================== leader + shared popups ===================== */

  leader = new LeaderController(
    (k) => {
      lastAction = k;
      runLeaderAction(leaderActions, k);
    },
    () => cfg.config.whichKey !== false,
    // Re-render the status bar the instant the leader arms/disarms so its
    // pulsing chevron appears immediately (the 500ms poll would lag a fast
    // ;<key> press).
    () => status.compute()
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
      lastAction = "+" + k;
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
  // own status bar (the chrome helper owns the single window-level bar). This
  // is a CONFIRMED handshake, not a fire-and-forget: the background replies to
  // the "alive" req with an { ok:true } ack after it has set the storage
  // chromeAlive flag, and only that ack latches the helper out of retrying. A
  // fire-and-forget announce could be accepted-while-queued and then dropped
  // (relay not ready yet), silently leaving chromeAlive=false forever and
  // every restored web page drawing its own bar on top of the window one.
  let announcedAlive = false;
  let aliveAckInFlight = false;
  function announceChromeAlive(): void {
    if (announcedAlive || aliveAckInFlight) return;
    if (!channel.ccBaseUrl()) return; // extension not ready yet; poll retries
    aliveAckInFlight = true;
    void channel.requestReply("alive", CHROME_HELPER_VERSION).then((ack: any) => {
      aliveAckInFlight = false;
      // requestReply resolves null on timeout/error; the ack object on success.
      if (ack && ack.ok) announcedAlive = true;
      // otherwise the next 500ms poll retries
    });
  }
  announceChromeAlive();

  /* ==================== status bar (tmux-style) ==================== */

  status.update();
  status.compute();
  // Poll every 500ms so the bar hides the moment content enters DOM fullscreen
  // (video) — only a poll catches that attribute transition reliably.
  // status.update is idempotent and cheap. startRelay() keeps the relay tab
  // alive: the announce creates it, and if the relay ever dies (tab closed,
  // window rebuilt) this re-creates it within half a second.
  setInterval(() => {
    announceChromeAlive(); // once the extension URL resolves, tell it we're here
    channel.startRelay();
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
  // The observer notifications are the same signals Firefox's own UI
  // listens to: they make the hide/re-show immediate (the 500ms poll is
  // only a backstop) and survive changes to the chrome document's
  // inDOMFullscreen attribute handling.
  try {
    const onFullscreen = () => status.update();
    window.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("willenterfullscreen", onFullscreen);
    window.addEventListener("willexitfullscreen", onFullscreen);
    const fsObs = {
      observe: onFullscreen,
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
    };
    Services.obs.addObserver(fsObs, "MozDOMFullscreen:Entered");
    Services.obs.addObserver(fsObs, "MozDOMFullscreen:Exited");
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
    onLocationChange(browser: any, _webProgress: any, _request: any, location: any) {
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

  // Core chrome-level key dispatch, shared by the window capture listener and
  // the #lfc=keys test channel (which drives the command center because
  // geckodriver's BiDi input is rejected on moz-extension contexts). Returns
  // whether the key was consumed — the capture listener then
  // preventDefaults/stops propagation, and the channel skips dispatching to
  // content.
  chromeKeyDown = (e) => {
    if (e.isComposing) return false;

    // Web pages are the content script's territory (its own leader, popups,
    // hints and typing guard). If Firefox forwards their keys to this chrome
    // window listener (some builds do), never consume them here — the content
    // script already let them through or handled them. The chrome helper only
    // owns keys on its own pages (command center, about:, extension pages).
    if (!chromeOwnsKeys() && !popup.isOpen()) return false;

    // A chrome popup is open: Esc closes it first (before the page/window).
    if (popup.isOpen()) {
      if (e.key === "Escape") {
        if (popup.resizeOnKey(e as KeyboardEvent)) return true;
        // Let the popup consume Esc itself (e.g. the sessions popup cancels a
        // pending copy/move target picker or steps back to the left pane)
        // before closing it.
        if (popup.handleKey(e as KeyboardEvent)) return true;
        popup.close();
        return true;
      }
      if (popup.resizeOnKey(e as KeyboardEvent)) return true;
      return false;
    }

    const typingNow = typing.focusedIsTyping(e as KeyboardEvent);
    const typingValue = typing.focusedTypingValue(e as KeyboardEvent);

    // The leader (or a one-shot capture) is armed: the next key is a binding —
    // but only while the user isn't composing text in a field. A field holding
    // text means typing wins: a stale leader/capture (e.g. `;` pressed on a
    // page, then clicking into a search box) must disarm and the key must type.
    // Exception: the command center empty home input keeps the binding —
    if (leader!.active || leader!.hasPending()) {
      if (typingNow && !(typingValue === "" && isCommandCenterTab())) {
        if (leader!.active) leader!.hide();
        if (leader!.hasPending()) leader!.cancelPending();
        return false;
      }
      if (leader!.hasPending()) {
        leader!.handlePending(e.key);
        return true;
      }
      leader!.handleKey(e as KeyboardEvent);
      return true;
    }

    // Typing in an editable (a page input, the command center's own input, the
    // URL bar): never intercept — the leader key types like any other. The one
    // exception is the command center's EMPTY home input: `;` there arms the
    // leader so commands chain after a command leaves a fresh tab focused,
    // instead of making the user click (or Esc) to blur it first.
    if (typingNow) {
      if (
        e.key === leaderKey() &&
        !e.ctrlKey && !e.altKey && !e.metaKey &&
        typingValue === "" &&
        isCommandCenterTab()
      ) {
        leader!.show();
        return true;
      }
      return false;
    }

    if (leader!.hasPending()) {
      leader!.handlePending(e.key);
      return true;
    }

    if (leader!.active) {
      leader!.handleKey(e as KeyboardEvent);
      return true;
    }

    // The command center is Lazyfox's own page. In command mode (input
    // blurred) the leader key must arm here so the home-screen shortcuts
    // (;n, ;z, ;s, 1-6, ...) work; in insert mode the typing check above
    // already let `;` through so it types into the input like any other key.
    const k = e.key;
    if (
      k === leaderKey() &&
      !e.ctrlKey && !e.altKey && !e.metaKey &&
      isCommandCenterTab()
    ) {
      leader!.show();
      return true;
    }

    // Ctrl+1-9: hot-swap to the session with that marker (tmux-style).
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      chromeOps.switchSessionByMarker(Number(e.key));
      return true;
    }

    if (handleHotkeys(e as KeyboardEvent)) return true;

    // Ctrl/Alt/Meta chords are never the leader key on their own.
    if (e.ctrlKey || e.altKey || e.metaKey) return false;

    if (k === leaderKey()) {
      leader!.show();
      return true;
    }
    return false;
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (chromeKeyDown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
  // and `'`, so it fires even after the leader has consumed the `keydown`.
  // Suppress it outside text fields so `;/` opens the find bar deliberately
  // rather than the native bar stealing the key. Also skip when a popup is
  // open — the popup input must receive these characters.
  window.addEventListener(
    "keypress",
    (e) => {
      if (e.key !== "/" && e.key !== "'") return;
      // Same ownership rule as the keydown handler: never suppress quick-find
      // on web pages (the content script does that there).
      if (!typing.focusedIsTyping(e) && !popup.isOpen() && chromeOwnsKeys()) {
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

  // Is the CONTENT script's leader armed in the selected tab? On web pages
  // the content script owns the leader key (chromeOwnsKeys() is false), so
  // the chrome helper's own leader never arms there — but the window-level
  // status bar must still show the pulsing LEADER chevron. The content
  // script reports every arm/disarm to the background, which relays it as a
  // per-index cache the status bar reads. On chrome-owned pages the content
  // script never runs, so the cache is empty and the chrome helper's own
  // leader is the truth.
  function contentLeaderActive(): boolean {
    try {
      const sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
      return sel >= 0 && status.contentLeaderActive(sel);
    } catch (e) {
      // ignore
    }
    return false;
  }

  // Does the CHROME helper own this tab's keys? True for its own pages
  // (command center, about:, extension URLs) — false for web content, where
  // the content script owns the leader/popups/hints and the chrome helper
  // must stay hands-off even if Firefox forwards content keys up here.
  function chromeOwnsKeys(): boolean {
    try {
      const b = window.gBrowser.selectedBrowser;
      const u = b && b.currentURI;
      if (!u) return true;
      const s = u.spec || "";
      if (/^https?:/i.test(s) || /^file:/i.test(s)) return false;
      return true;
    } catch (e) {
      return true;
    }
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
