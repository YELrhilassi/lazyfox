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
import { LeaderController, leaderSequences } from "../shared/leader";
// The two hold-release rules live in shared/holdrelease.ts so BOTH hosts use
// one implementation and a unit test can pin the implementation, not a
// restatement of it. See that file for why that distinction mattered.
import {
  releaseHoldOnKeyup,
  releaseLostHold as releaseLostHoldOnBlur,
} from "../shared/holdrelease";
import { toast } from "../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";

import { openNavPopup } from "../shared/popups/nav";
import { CATEGORY_TIMEOUT_MS, leaderCategories } from "../shared/popups/categories";
import { createAliveAnnounce, detectProfile } from "./alive";
import { createCacheCtl } from "./cache";
import { createChannel, type Channel } from "./channel";
import { applyHoverRevealPref, loadCfg, persistCfg, type ChromeCfg } from "./config";
import { focusCommandCenterContent } from "./commandcenterfocus";
import { ensureChromeCore, initChromeCore } from "./core";
import { createDebug, type DebugHandlers } from "./debug";
import { createChromeKeyDown } from "./keysdispatch";
import {
  chromeOwnsKeys,
  chromeOwnsSurfaces,
  isCommandCenterTab,
  noteContentPresent,
  forgetContentFrom,
} from "./keystate";
import { createChromeOps } from "./ops";
import { setRelayTabTest } from "./ops/primitives";
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
  // The whole trail of the last split MOVE, not just its final line. A single
  // "addTabs returned ok" cannot distinguish "it worked" from "it worked and
  // something undid it a moment later", which is exactly the ambiguity that
  // made the restore-by-position failure unreadable.
  let moveLog: string[] = [];

  status = createStatusBar({
    realTabs: () => split.realTabs(),
    getConfig: () => cfg,
    getUi: () => ({ popup: popup.isOpen(), leader: !!(leader && leader.active) }),
  });

  split = createSplitView({
    ccBaseUrl: () => channel.ccBaseUrl(),
    onSplitChange: () => status.update(),
    // Resolved at call time: `channel` is built after `split` (it needs the
    // popup context that wraps ops), and the relay's identity is only known
    // once it exists — which is exactly when the numbering needs to ask.
    isRelayTab: (t) => !!channel && channel.isKnownRelayTab(t),
    onMove: (msg) => {
      moveLog.push(msg);
      if (moveLog.length > 24) moveLog.shift();
    },
    onMoveReset: () => { moveLog = []; },
  });

  debug = createDebug({
    getState: () => ({
      hasPopup: () => popup.isOpen(),
      leaderActive: () => !!(leader && leader.active),
      chromeOwnsKeys: () => chromeOwnsKeys(window),
      leaderPending: () => !!(leader && leader.hasPending()),
      lastAction: () => lastAction,
      lastMoveDebug: () => (moveLog.length ? moveLog.join(" | ") : null),
      statusMounted: () => status.mounted(),
      statusPosition: () => cfg.config.statusBarPosition || "bottom",
      dlActive: () => status.dlActive(),
      isFullscreen: () => status.isFullscreen(),
      activeSplitView: () => split.activeSplitView(),
      realTabs: () => split.realTabs(),
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
    // A sub-key that takes a NUMBER (move tab N into the split) needs the
    // leader's one-shot capture; the leader controller owns it.
    armDigits: (apply, timeoutMs) => {
      if (!leader) return;
      leader.armPending(apply, timeoutMs || 3000);
    },
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
    fromActor?: boolean,
    noKeyup?: boolean
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

  // Releasing a HELD leader clears the hold, NOT the leader itself.
  //
  // A tap is keydown *and* keyup, so hiding on release would disarm the leader
  // instantly and `;` plus a binding would stop working everywhere. Release
  // only ends the chaining: the leader stays armed exactly as a normal tap
  // leaves it, and the next binding disarms it as usual.
  //
  // This is the ONE definition of "the leader key came up", deliberately
  // shared rather than written twice. A real keyup and a synthetic one — the
  // `#lfc=keys` channel's release — must not be able to disagree about what a
  // release means, because the held-leader feature is exactly that agreement:
  // if the synthetic path skipped it, the harness could not express a hold at
  // all and every synthetic `;` would look permanently pressed.
  const releaseLeaderHold = (key: string): void => {
    try {
      releaseHoldOnKeyup(leader, (cfg.config && cfg.config.leader) || ";", key);
    } catch (err) {
      // ignore — a dead view must not break the key path
    }
  };

  window.addEventListener(
    "keyup",
    (e) => {
      releaseLeaderHold(e.key);
    },
    true
  );

  // A keyup can be LOST, and the hold must not outlive the window's attention.
  //
  // Press `;`, alt-tab (or click another application, or let a modal steal
  // focus) before letting go: the release is delivered to whatever has focus
  // by then, so this window never sees it and the leader stays marked as
  // physically held. The user comes back to a lit indicator, a leader that
  // never disarms, and a keyboard whose next keystrokes are eaten as bindings.
  // The same happens when the tab is hidden or the window is minimized.
  //
  // Clearing the hold is the whole fix, and only the hold: the leader stays
  // armed exactly as a released tap leaves it, because losing focus is not the
  // user changing their mind about the sequence. Idempotent and cheap, and it
  // only does anything while a hold is actually outstanding.
  const releaseLostHold = (): void => {
    try {
      releaseLostHoldOnBlur(leader);
    } catch (err) {
      // ignore — a dead view must not break the key path
    }
  };
  window.addEventListener("blur", releaseLostHold, true);
  try {
    window.document.addEventListener("visibilitychange", () => {
      if (window.document.visibilityState !== "visible") releaseLostHold();
    });
  } catch (err) {
    // ignore
  }

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
      // The overlay may only paint while the chrome helper owns the page. On a
      // web page the content script owns the leader and paints its own overlay
      // there; without this gate the chrome one — a persistent host that only
      // loses its `on` class — stayed lit behind it, so switching from an
      // about:/command-center tab to a web page left TWO which-key overlays on
      // screen at once, one of them permanently stale. `enabled()` is the same
      // predicate the key path uses, so the pixels and the keyboard can never
      // disagree about who is in charge.
      () => cfg.config.whichKey !== false && chromeOwnsSurfaces(window),
      // Re-render the status bar the instant the leader arms/disarms so its
      // far-right indicator appears immediately (the 500ms poll would lag a
      // fast ;<key> press). The indicator works even when the which-key
      // overlay is disabled — it is then the only visible leader sign.
      () => {
        if (leader) {
          // The prefix rides along so the bar can show `; W` rather than a bare
          // glyph once a chord is half-committed: an indicator that looks
          // identical at ";" and at ";W" says nothing about which key comes
          // next, which is the only thing the user wants to know at that point.
          status.setLeaderSignal(leader.active || leader.hasPending(), leader.prefix);
        }
        status.compute();
      },
      // A plain binding always beats a category head. Supplying this is what
      // stops registering `;W` / `;Z` from ever being able to take over a key
      // that already worked.
      (k) => !!leaderActions[k]
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
    // The nav-stack popup is a PLAIN binding on the SHIFTED keys: ;G / ;L open
    // it immediately, while ;g / ;l stay back/forward.
    //
    // It used to be a two-key sequence (;G then k) so that the shifted keys
    // could "never shadow" a plain binding. But Shift already makes G a
    // different key from g, so the extra key bought nothing — and cost the
    // whole feature. Pressing ;G armed a one-shot capture, showed nothing, and
    // on timeout fell through to a plain `G` action that does not exist. The
    // which-key table has advertised ";G = back history stack" throughout, so
    // the menu promised a key that did nothing.
    leaderActions["G"] = () => openNavPopup(ctx);
    leaderActions["L"] = () => openNavPopup(ctx);
    // The leader's two-key categories (`;W` window/layout, `;Z` zoom) are defined
    // once in shared/popups/categories.ts and registered here, so the chrome
    // helper and the content script cannot drift into disagreeing about them.
    for (const [head, final] of Object.entries(leaderCategories(ctx))) {
      leaderSequences[head] = { final, timeoutMs: CATEGORY_TIMEOUT_MS };
    }
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

  // Both chrome-side numberings — the one that COUNTS tabs for a typed digit
  // and the one that RESOLVES the digit to a tab — must agree about the relay
  // by REFERENCE, not only by URL: a relay whose page has not committed yet is
  // about:blank, and one list would count it while the other skipped it, so
  // the number the user typed named the wrong tab. Wired here because this is
  // the first point at which the channel exists.
  setRelayTabTest((t) => !!channel && channel.isKnownRelayTab(t));

  channel = createChannel({
    ctx,
    ops: chromeOps as unknown as { openTarget(which: string): boolean; openUrlNative(url: string): boolean; openResize(): void },
split,
    status,
    setContentPresent: noteContentPresent,
    cfg,
    debug,
    cache,
    // The `#lfc=keys` channel carries keyDOWNS and nothing else — there is no
    // keyup in the wire format and no way for the browser to invent one, so
    // every key it delivers is a tap. Passing `noKeyup` is what keeps a
    // synthesized `;` from marking the leader as physically HELD, which would
    // otherwise leave it chained for the rest of the window's life: the
    // indicator stuck on, every binding leaving the leader armed, and the next
    // real keystroke eaten. It is the difference between a test harness that
    // can drive a held key and one that quietly breaks the hold feature
    // everywhere it runs.
    //
    // `fromActor` stays false on purpose: this channel drives the real
    // selection, which may be a page whose content script owns its keys, and
    // claiming ownership here would handle one keystroke twice.
    keys: { dispatch: (e) => chromeKeyDown(e, false, true), release: releaseLeaderHold },
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
    // Presence is cached by tab POSITION, and removing a tab slides every tab
    // above it down one slot. Without this the map drifts by one per close, and
    // a stale "a content script is here" would be attributed to whatever page
    // inherited the slot — the helper would then defer on a page it should own,
    // which is the dead keyboard again, one tab-closing session later.
    window.gBrowser.tabContainer.addEventListener("TabClose", (e: Event) => {
      try {
        forgetContentFrom(Number((e as unknown as { index?: number }).index));
      } catch (err) {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      typing.reset();
      // Standing down is a TAB-SWITCH obligation, not a keypress one. The
      // which-key overlay and the popup are persistent hosts that only lose
      // their `on` class when something explicitly hides them, so switching
      // from a chrome-owned tab (about:, command center) onto a web page left
      // the chrome overlay lit for as long as the window lived — with the
      // content script's overlay painting over it. Two which-key panels at
      // once, one of them a ghost that never went away.
      //
      // Both are torn down together because they are one decision: this window
      // no longer owns this tab.
      //
      // The leader is fully HIDDEN, not merely unpainted, and the reason it is
      // safe to do that took checking: on a tab this window does not own, the
      // dispatcher returns before it ever consults `l.active`, so a stale
      // armed leader cannot swallow a key the content script is about to see.
      // Leaving it armed was worse than useless — the status bar's leader
      // indicator reads that flag, so a web page showed a permanently lit
      // leader chevron while the content script's leader was dark.
      try {
        if (!chromeOwnsSurfaces(window)) {
          leader!.hide();
          if (popup.isOpen()) popup.close();
        }
      } catch (e) {
        // ignore — a mid-collapse read must not break the tab switch
      }
      status.compute();
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
      true,
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
    // Stand down surfaces this window no longer owns. TabSelect covers a tab
    // switch, but a NAVIGATION WITHIN the selected tab does not fire it — and
    // that is the other way the chrome which-key overlay outlived its page:
    // arm it on the command center, navigate that same tab to a web page, and
    // the chrome overlay stayed lit under the content script's own. Polling is
    // the honest catch-all for an ownership change nothing else announces, and
    // it costs one attribute read when nothing needs doing.
    try {
      if (!chromeOwnsSurfaces(window) && (leader!.active || leader!.hasPending())) {
        leader!.hide();
      }
    } catch (e) {
      // ignore
    }
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
