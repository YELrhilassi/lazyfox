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
//   winlisteners.ts        the chrome document's own listeners (key/blur/Tab*)
//   actorbridge.ts         keys forwarded by the content-process JS actor
//   actorscroll.ts         what a declined actor key means (pure)
//   winsync.ts             the pollers, the #lfc= route, tab-select bookkeeping
//
// No feature logic lives here beyond the wiring.

import { dbg } from "../shared/dev";
import { KeyGuard } from "../shared/keyguard";
import type { LeaderController } from "../shared/leader";
// The two hold-release rules live in shared/holdrelease.ts so BOTH hosts use
// one implementation and a unit test can pin the implementation, not a
// restatement of it. See that file for why that distinction mattered.
import {
  releaseHoldOnKeyup,
  releaseLostHold as releaseLostHoldOnBlur,
} from "../shared/holdrelease";
import { toast } from "../shared/overlay";
import { runLeaderAction, type PopupCtx } from "../shared/popups";
import { createChromeLeader } from "./leadersetup";

import { createAliveAnnounce, detectProfile } from "./alive";
import { createCacheCtl } from "./cache";
import { createChannel, type Channel } from "./channel";
import { applyHoverRevealPref, loadCfg, persistCfg, type ChromeCfg } from "./config";

import { ensureChromeCore, initChromeCore } from "./core";
import { createDebug, type DebugHandlers } from "./debug";
import { createChromeEnv } from "./env";
import { installWinListeners } from "./winlisteners";
import { installActorBridge } from "./actorbridge";
import { installWinSync } from "./winsync";
import { createChromeKeyDown } from "./keysdispatch";
import {
  chromeOwnsKeys,
  chromeOwnsSurfaces,
  contentScriptPresent,
  isCommandCenterTab,
  noteContentPresent,
} from "./keystate";
import { createChromeOps } from "./ops";
import { createPrimitives } from "./ops/primitives";
import { createPopupHost } from "./popup";
import { createScrollKeys } from "./scrollkeys";
import { createSplitView, type SplitView } from "./splitview";
import { createStatusBar, type StatusBarCtl } from "./statusbar";
import { createTypingChannel } from "./typing";

(function () {
  "use strict";

  if (window.top !== window) return;
  if (!window.gBrowser) return;

  // The chrome document's environment, taken ONCE and threaded into every
  // module below. This composition root is the one place allowed to touch the
  // ambient globals: everything it builds reads them through `env`, which is
  // what makes those modules constructible in Node (see src/chrome/env.ts).
  const env = createChromeEnv();
  const win = env.window;
  const doc = env.document;

  if (__DEV__) {
    dbg("chrome bundle loaded", "ff=" + env.services.appinfo.version,
      "evalSys=" + env.services.prefs.getBoolPref("security.allow_eval_with_system_principal", false),
      "evalParent=" + env.services.prefs.getBoolPref("security.allow_eval_in_parent_process", false));
  }

  initChromeCore();

  /* ===================== config (prefs) ===================== */

  const cfg: ChromeCfg = loadCfg();
  applyHoverRevealPref(cfg);
  const leaderKey = () => cfg.config.leader || ";";

  /* ===================== modules ===================== */

  const popup = createPopupHost(env);
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

  // The window primitives (tab identity, native URL loading, native data
  // sources). Built here rather than inside ops so the relay-tab predicate —
  // which cannot exist until the channel does, further down — has somewhere
  // late-bound to land.
  const primitives = createPrimitives(env);

  status = createStatusBar({
    env,
    realTabs: () => split.realTabs(),
    getConfig: () => cfg,
    getUi: () => ({ popup: popup.isOpen(), leader: !!(leader && leader.active) }),
  });

  split = createSplitView({
    env,
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
    env,
    getState: () => ({
      hasPopup: () => popup.isOpen(),
      leaderActive: () => !!(leader && leader.active),
      chromeOwnsKeys: () => chromeOwnsKeys(win),
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
    env,
    primitives,
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
    armDigits: (apply, timeoutMs, expect) => {
      if (!leader) return;
      leader.armPending(apply, { timeoutMs: timeoutMs || 3000, expect });
    },
    manualText: false,
  };
  // The table itself is built inside createChromeLeader (leadersetup.ts) and
  // assigned below; it is declared here because ctx closes over it: a popup
  // opened from a binding must be able to run another binding (the help
  // list), and that call resolves at key time, after the table exists.

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
    win: win,
    env,
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

  win.addEventListener(
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
  win.addEventListener("blur", releaseLostHold, true);
  try {
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState !== "visible") releaseLostHold();
    });
  } catch (err) {
    // ignore
  }

// The chrome leader's controller and its binding table. The table itself
  // (which keys the chrome helper answers, and which are only legal on some
  // pages) lives in leadersetup.ts, not here: adding a module and changing the
  // keymap are different reasons to touch this file, and keeping them apart is
  // what stops a keymap change from reading as a rewiring change.
  const built = createChromeLeader({
    ctx,
    switchSessionByMarker: (m) => chromeOps.switchSessionByMarker(m),
    // The overlay may only paint while the chrome helper owns the page. On a
    // web page the content script owns the leader and paints its own overlay
    // there; without this gate the chrome one — a persistent host that only
    // loses its `on` class — stayed lit behind it, so switching from an
    // about:/command-center tab to a web page left TWO which-key overlays on
    // screen at once, one of them permanently stale. This is the same predicate
    // the key path uses, so the pixels and the keyboard can never disagree
    // about who is in charge.
    overlayAllowed: () => cfg.config.whichKey !== false && chromeOwnsSurfaces(win),
    // Re-render the status bar the instant the leader arms/disarms so its
    // far-right indicator appears immediately (the 500ms poll would lag a fast
    // ;<key> press). The indicator works even when the which-key overlay is
    // disabled — it is then the only visible leader sign.
    //
    // The controller hands over its WHOLE readout as one value and the status
    // bar stores it as one value. Nothing here assembles it from `active` /
    // `hasPending()` / `prefix` / `pendingExpect` separately, which is what
    // used to let the bar paint a chord and an expectation read a moment apart
    // — a bar promising a digit for a capture that had already expired. See
    // LeaderController.signal.
    onChange: () => {
      status.setLeaderSignal(built.leader.signal());
      status.compute();
    },
    // A plain binding always beats a category head. Supplying this is what
    // stops registering `;W` / `;Z` from ever being able to take over a key
    // that already worked.
    hasBinding: (k) => !!built.actions[k],
    noteAction: (k) => {
      lastAction = k;
    },
  });
  leader = built.leader;
  leaderActions = built.actions;

  // ;f is link-hints, and who handles it depends on the page: the command
  // center arms hint-PICK and chrome-owned pages (about:, error pages) draw
  // their own hints — both live in the dispatcher — while web pages run the
  // shared popup engine's hint action (makeLeaderActions put it there). The
  // leader table keeps ONE entry that routes by page type.
  const startHintsAction = leaderActions["f"];
  leaderActions["f"] = () => {
    if (isCommandCenterTab(win) || chromeOwnsKeys(win)) {
      dispatch.runHintsAction();
      return;
    }
    if (startHintsAction) startHintsAction();
  };
  // The dispatcher's web-page path (a key forwarded to chrome on a page it
  // does not own) routes back to the shared engine's action.
  dispatch.setWebHints(() => {
    if (startHintsAction) startHintsAction();
  });

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

  const profile = detectProfile(env);
  const alive = createAliveAnnounce(win, () => channel, profile);

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
  primitives.setRelayTabTest((t) => !!channel && channel.isKnownRelayTab(t));

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
    // `fromActor` is not a constant here, and that is the fix. It means
    // "nobody else can own this key", and the answer is the product's own
    // presence fact (`contentScriptPresent`, from keystate.ts) applied to the
    // tab the key is FOR. The channel drives the real selection, so it was
    // hardcoding "the content script owns it" — which is true of a normal web
    // page and false of every page the content script cannot reach: a Firefox
    // error page (401/404/500/...), a page the extension is not allowed in, a
    // tab mid-navigation with no document. On those the dispatcher declined,
    // the key was forwarded to a page with no Lazyfox in it, and the window
    // was dead to the keyboard — for the synthetic path and, through the actor
    // bridge, potentially for the user. Asking the same question the actor
    // asks keeps one keystroke handled once and only once either way.
    keys: {
      dispatch: (e, target) => {
        // Asked of the SELECTED tab, because that is the tab this dispatcher
        // acts on. A key addressed at some other tab is not an ownership claim
        // about that tab — the dispatcher never reaches it — so it is reported
        // as content-owned, which is the conservative answer (declining is
        // always safe; claiming ownership twice is not).
        const sel = win.gBrowser && win.gBrowser.selectedTab;
        const fromActor = !sel || !target || target === sel
          ? !contentScriptPresent(sel, win)
          : false;
        return chromeKeyDown(e, fromActor, true);
      },
      release: releaseLeaderHold,
    },
  });


  /* ===================== window wiring ===================== */

  // Everything from here on is chrome-document wiring rather than composition,
  // and it is in modules for that reason: the listeners, the actor bridge and
  // the pollers each reach across every other module, so leaving them here made
  // "open main.ts" mean "read the event and timer rules first".
  installWinListeners({
    env,
    keyGuard,
    chromeKeyDown,
    popup,
    typing,
    leader: () => leader,
    status,
    isWindowActive: () => env.services.focus.activeWindow === win,
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
  });

  // Keys forwarded by the "Lazyfox" JS window actor (see actor-parent.ts /
  // actor-child.ts) run through the very same dispatcher as keys typed into the
  // browser window. When it declines the key, actorscroll.ts decides what the
  // child should do about it.
  installActorBridge({
    env,
    chromeKeyDown,
    scrollKeysEnabled: () => cfg.config.scrollKeys,
    now: () => Date.now(),
  });

  // The pollers, the #lfc= progress route and the per-tab-select bookkeeping.
  installWinSync({
    env,
    channel,
    alive,
    split,
    status,
    leader: () => leader,
  });
})();
