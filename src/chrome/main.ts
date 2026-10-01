// Chrome helper entry (userChrome.uc.js equivalent).
//
// This is the composition root: it builds the focused modules and wires them
// together. The behaviors live in their own modules —
//
//   alive.ts              the confirmed chrome-alive announce/ack handshake
//   keysdispatch.ts       the chrome keydown dispatcher (leader/popups/hotkeys)
//   keystate.ts           which surface owns the keys
//   commandcenterfocus.ts command-center focus + key forwarding
//   pagehints.ts          link hints on pages without a content script
//   scrollkeys.ts         vim scroll keys on chrome-owned pages
//   channel.ts            the persistent relay channel (helper side)
//   ops.ts                the chrome implementation of ActionOps
//   popup.ts / splitview.ts / statusbar.ts / cache.ts / debug.ts / config.ts
//
// No feature logic lives here beyond the wiring.

import { dbg } from "../shared/dev";
import { KeyGuard } from "../shared/keyguard";
import { LeaderController } from "../shared/leader";
import { toast } from "../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";
import { leaderSequences } from "../shared/leader";
import { openNavPopup } from "../shared/popups/nav";
import { createAliveAnnounce, detectProfile } from "./alive";
import { createCacheCtl } from "./cache";
import { createChannel, type Channel } from "./channel";
import { applyHoverRevealPref, loadCfg, persistCfg, type ChromeCfg } from "./config";
import { focusCommandCenterContent } from "./commandcenterfocus";
import { ensureChromeCore, initChromeCore } from "./core";
import { createDebug, type DebugHandlers } from "./debug";
import { createChromeKeyDown } from "./keysdispatch";
import { chromeOwnsKeys, isCommandCenterTab } from "./keystate";
import { createChromeOps } from "./ops";
import { createPopupHost } from "./popup";
import { createScrollKeys } from "./scrollkeys";
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
  // Tracks the keys the chrome helper has consumed so their keypress/keyup
  // tails are swallowed too (see shared/keyguard.ts): a page or browser
  // surface behind an overlay must never observe a keystroke aimed at Lazyfox.
  const keyGuard = new KeyGuard();

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

  status = createStatusBar({
    realTabs: () => split.realTabs(),
    getConfig: () => cfg,
    getUi: () => ({ popup: popup.isOpen(), leader: !!(leader && leader.active) }),
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

  /* ===================== leader + shared popups ===================== */

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

  // The chrome-level key dispatch (leader/popups/hotkeys/typing guard).
  // Referenced here so the #lfc=keys channel can drive it; the closure
  // resolves at call time (after init), so ordering is safe.
  let chromeKeyDown: (
    e: {
      key: string;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      metaKey: boolean;
      isComposing: boolean;
    },
    fromActor?: boolean
  ) => boolean = () => false;

  const typing = createTypingChannel();
  const handleScrollKeys = createScrollKeys(() => cfg.config);

  /* ===================== key dispatch ===================== */

  const dispatch = createChromeKeyDown({
    win: window,
    leader: () => leader,
    popup,
    typing,
    keyGuard,
    leaderKey,
    switchSessionByMarker: (m) => chromeOps.switchSessionByMarker(m),
    handleScrollKeys,
    handleHotkeyCombo: (combo) => {
      for (const t of Object.keys(cfg.bindings)) {
        if (cfg.bindings[t as keyof typeof cfg.bindings] === combo) {
          chromeOps.openTarget(t);
          return true;
        }
      }
      return false;
    },
    runWebHints: () => {
      const startHints = leaderActions["f"];
      if (startHints) startHints();
    },
  });
  chromeKeyDown = dispatch.chromeKeyDown;

  // ;f is link-hints, and who handles it depends on the page: the command
  // center arms hint-PICK and chrome-owned pages (about:, error pages) draw
  // their own hints — both live in the dispatcher — while web pages run the
  // shared popup engine's hint action (makeLeaderActions put it there). The
  // leader table keeps ONE entry that routes by page type.
  const startHintsAction = leaderActions["f"];
  leaderActions["f"] = () => {
    if (isCommandCenterTab(window) || chromeOwnsKeys(window)) {
      dispatch.runHintsAction();
      return;
    }
    if (startHintsAction) startHintsAction();
  };
  // The dispatcher's web-page path (a key forwarded to chrome on a page it
  // does not own) routes back to the shared engine's action.
  dispatch.setWebHints(() => { if (startHintsAction) startHintsAction(); });

  /* ===================== leader pending actions ===================== */

  function buildLeader(): void {
    leader = new LeaderController(
      (k) => {
        lastAction = k;
        runLeaderAction(leaderActions, k);
      },
      () => cfg.config.whichKey !== false,
      // Re-render the status bar the instant the leader arms/disarms so its
      // far-right indicator appears immediately (the 500ms poll would lag a
      // fast ;<key> press). The indicator works even when the which-key
      // overlay is disabled — it is then the only visible leader sign.
      () => {
        if (leader) {
          status.setLeaderSignal(leader.active || leader.hasPending());
        }
        status.compute();
      }
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
    // The nav-stack popup gets its OWN keys, never shared with a plain
    // binding: ;G / ;L (shift) — ;g and ;l stay back/forward unshadowed.
    Object.assign(leaderSequences, {
      G: { final: { k: () => openNavPopup(ctx) } }, // ;Gk = history stack
      L: { final: { k: () => openNavPopup(ctx) } }, // ;Lk = forward stack
    });
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
    // ;F / ;B (cycle scroll region) are implemented by the content script,
    // which owns page scrolling on web content. They appear in the shared
    // which-key table, so answer them here with a clear note instead of a
    // silent no-op.
    leaderActions["F"] = () => toast("scroll regions: web pages only");
    leaderActions["B"] = () => toast("scroll regions: web pages only");
  }
  buildLeader();

  // Warm the wasm core AND the which-key bindings so the first leader press
  // is already synchronous (the overlay renders from the preloaded table;
  // loading it lazily on the first `;` was the visible activation delay).
  ensureChromeCore()
    .then((a) => {
      if (__DEV__) dbg("core ready, version=" + a.version());
      void leader!.bindings().catch(() => {});
    })
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

  // Dev-only end-to-end check of the which-key render path. The bindings
  // preload above (after the core warms) feeds this same cache.
  void leader!
    .bindings()
    .then(async (all: unknown[]) => {
      if (!__DEV__) return;
      dbg("bindings loaded, count=" + all.length);
      const out = await leader!.devSelfTest();
      dbg("wk self-test: " + out);
    })
    .catch((e: unknown) => { if (__DEV__) dbg("loadBindings FAILED: " + String(e)); });

  /* ===================== alive announce ===================== */

  const profile = detectProfile(window);
  const alive = createAliveAnnounce(window, () => channel, profile);

  /* ===================== cache control ===================== */

  // Per-tab / per-session page-cache enforcement. The pool of bypassable tabs
  // is keyed off the status bar's live tab-id snapshot (strip order).
  const cache = createCacheCtl({ getTabIds: () => status.getTabIds() });

  channel = createChannel({
    ctx,
    ops: chromeOps as unknown as { openTarget(which: string): boolean; openUrlNative(url: string): boolean; openResize(): void },
    split,
    status,
    cfg,
    debug,
    cache,
    keys: { dispatch: (e) => chromeKeyDown(e) },
  });

  /* ===================== window listeners ===================== */

  window.addEventListener(
    "keydown",
    (e) => {
      if (chromeKeyDown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      // Record every key the chrome helper consumed so its keypress/keyup
      // tail is swallowed too — keydown's preventDefault does not cancel them.
      if (e.defaultPrevented) keyGuard.consume(e);
    },
    true
  );

  // keypress/keyup do NOT obey the keydown's preventDefault, so a key the
  // helper consumed would still surface as a browser shortcut behind the
  // overlay. Swallow the tail of every consumed key, and anything aimed
  // outside an open popup while it owns the keyboard.
  function onKeyTail(e: KeyboardEvent): void {
    // Always reconcile the guard (never short-circuit): a key we consumed once
    // must have its record cleared by the tail that follows, or a later,
    // legitimate press of the same key while typing would be swallowed too.
    const escapePopup = popup.isOpen() && !popup.containsTarget(e.target);
    const tail = keyGuard.ownsTail(e);
    if (escapePopup || tail) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  window.addEventListener("keypress", onKeyTail, true);
  window.addEventListener("keyup", onKeyTail, true);

  // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
  // and `'`, so it fires even after the leader has consumed the `keydown`.
  // Suppress it outside text fields so `;/` opens the find bar deliberately.
  // Also skip when a popup is open — the popup input must receive these
  // characters. Never suppress on web pages (the content script does that).
  window.addEventListener(
    "keypress",
    (e) => {
      if (e.key !== "/" && e.key !== "'") return;
      if (!typing.focusedIsTyping(e) && !popup.isOpen() && chromeOwnsKeys(window)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  window.addEventListener("blur", () => {
    // A blur fires on every tab switch, so close only on a real deactivation
    // of the OS window — checked on the next tick, after the switch settles.
    typing.reset();
    keyGuard.clear();
    setTimeout(() => {
      try {
        if (Services.focus.activeWindow === window) return;
      } catch {
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
  } catch {
    // ignore
  }

  /* ===================== content-process actor bridge ============== */

  // Keys forwarded by the "Lazyfox" JS window actor (see actor-parent.ts /
  // actor-child.ts) arrive here. They run through the very same dispatcher as
  // keys typed into the browser window, so the leader, its popups, find and
  // Esc behave identically on pages the extension's content script cannot
  // reach. When the dispatcher declines the key and it is a vim scroll key,
  // the return value tells the content process to scroll itself — the browser
  // process cannot reach into a remote page's DOM, so the child has to do it.
  let actorLastG = 0;
  window.__lazyfoxActorKey = (data) => {
    if (!data || typeof data.key !== "string") return null;
    const key = data.key;
    const handled = chromeKeyDown(
      {
        key,
        ctrlKey: false,
        altKey: false,
        shiftKey: !!data.shift,
        metaKey: false,
        isComposing: false,
      },
      true
    );
    if (handled) return null;
    if (cfg.config.scrollKeys === false) return null;
    const page = Math.max(120, Math.round((data.vh || 600) * 0.5));
    if (key === "j") return { scrollY: 60 };
    if (key === "k") return { scrollY: -60 };
    if (key === "d") return { scrollY: page };
    if (key === "u") return { scrollY: -page };
    if (key === "G") return { goto: "bottom" };
    if (key === "g") {
      const now = Date.now();
      if (now - actorLastG < 600) {
        actorLastG = 0;
        return { goto: "top" };
      }
      actorLastG = now;
      return null;
    }
    return null;
  };

  /* ===================== tab lifecycle ===================== */

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
      } catch {
        // ignore
      }
      // A fresh command-center tab starts with Firefox's URL-bar focus, which
      // would swallow every key — pull focus into the page.
      if (isCommandCenterTab(window)) focusCommandCenterContent(window);
      status.update();
      status.compute();
    });
  } catch {
    // ignore
  }

  /* ===================== lfc progress listener ===================== */

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

  /* ===================== polling + observers ===================== */

  // Poll every 500ms so the bar hides the moment content enters DOM fullscreen
  // (video) — only a poll catches that attribute transition reliably.
  // status.update is idempotent and cheap. startRelay() keeps the relay tab
  // alive: the announce creates it, and if the relay ever dies (tab closed,
  // window rebuilt) this re-creates it within half a second.
  setInterval(() => {
    alive.announce(); // once the extension URL resolves, tell it we're here
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
  // The observer notifications are the same signals Firefox's own UI listens
  // to: they make the hide/re-show immediate (the 500ms poll is only a
  // backstop) and survive changes to the chrome document's inDOMFullscreen
  // attribute handling.
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
  } catch {
    // ignore
  }
})();
