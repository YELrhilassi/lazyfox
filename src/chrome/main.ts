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
  cancelHold,
  createHoldWatchdog,
  releaseHoldOnKeyup,
  releaseLostHold as releaseLostHoldOnBlur,
} from "../shared/holdrelease";
import { toast } from "../shared/overlay";
import { runLeaderAction, type PopupCtx } from "../shared/popups";
import { createChromeLeader } from "./leadersetup";

import { mergeConfig } from "../shared/config";
import { createAliveAnnounce, detectProfile } from "./alive";
import { createCacheCtl } from "./cache";
import { createChannel, type Channel } from "./channel";
import { applyHoverRevealPref, loadCfg, persistCfg, type ChromeCfg } from "./config";

import { ensureChromeCore, initChromeCore } from "./core";
import { createDebug, type DebugHandlers } from "./debug";
import { createChromeEnv } from "./env";
import { installWinListeners } from "./winlisteners";
import { installActorBridge } from "./actorbridge";
import { installBridgeMount } from "./bridgemount";
import { installWinSync } from "./winsync";
import { createChromeKeyDown } from "./keysdispatch";
import {
  chromeOwnsKeys,
  chromeOwnsSurfaces,
  commandCenterDocumentPresent,
  contentExpectation,
  contentScriptPresent,
  dropPresenceForSelectedTab,
  isCommandCenterTab,
  isDeveloperSurfaceTab,
  noteContentPresent,
  presenceSnapshot,
  presenceTabForReport,
} from "./keystate";
import {
  chromeFieldHoldsUserText,
  focusCommandCenterContent,
  focusIsInSelectedContent,
  focusSelectedBrowser,
  focusSelectedContent,
  selectedContentHasKeyboard,
} from "./commandcenterfocus";
import { chromeElementOnScreen } from "./chromefield";
import { createKeyboardFocus } from "./keyboardfocus";
import { keymapReady } from "../shared/keymap";
import { createChromeOps } from "./ops";
import { createPrimitives } from "./ops/primitives";
import { createPopupHost } from "./popup";
import { createScrollKeys } from "./scrollkeys";
import { createSplitView, type SplitView } from "./splitview";
import { createStatusBar, type StatusBarCtl } from "./statusbar";
import { createTypingChannel } from "./typing";
import { createGlobalWhichKey } from "./wkglobal";

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
    // A pane switch inside one split is not a tab switch the win-sync rule is
    // guaranteed to see, and the selected pane's docshell is not activated by
    // selecting it — so the keyboard stayed in the pane the user left.
    focusSelectedPane: () => {
      // The page repair first (it also focuses the command center's body when
      // the pane is the home page), then the operation that moves a split
      // pane's keyboard and is measured in commandcenterfocus.ts.
      keyboard.giveKeyboardToSelectedPage();
      focusSelectedBrowser(win, env.services.focus);
    },
    onSplitChange: () => {
      // The status bar tracks whether the split changed (layout, or the tab the
      // user is looking at); the LAYOUT report is a separate callback, because
      // only the layout module can tell a pane switch from a layout move.
      status.update();
    },
    // TELL THE BACKGROUND THE LAYOUT MOVED.
    //
    // The session snapshot (and the crash-recovery copy that a restart reads)
    // is captured from `tabs` on tab events. A split is not a tab event — the
    // same tabs are still there, they are just paired — so splitting a pair and
    // quitting never wrote the pairing down, and the next launch restored the
    // tabs flat. `layoutChanged` is that missing event; the background
    // re-measures the layout itself, so nothing here has to describe it.
    //
    // Fired at most once per distinct layout (and possibly a beat after the op,
    // while the platform finishes describing the new panes), so a TabSelect that
    // only moves the selection between panes of one split costs nothing: the
    // relay's single URL slot is shared with the key commands themselves, and a
    // report per pane switch would starve the very command that caused it.
    //
    // Late-bound and best-effort: `channel` does not exist while the first split
    // state is being established, and a layout report is never worth a throw on
    // a keypress path.
    onLayoutChanged: () => {
      try {
        if (channel) channel.requestBg("layoutChanged", {});
      } catch (e) {
        /* no relay yet: nothing to report to */
      }

    },
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
      // Did a SPLIT pane hand its menu to this window, and is the window
      // painting it? The only externally visible answer: the menu lives in a
      // closed shadow root, and in a split the page's copy is deliberately
      // absent (wkglobal.ts).
      pageWhichKey: () => !!(globalWhichKey && globalWhichKey.shown()),
      chromeOwnsKeys: () => chromeOwnsKeys(win),
      // WHERE THE KEYBOARD IS, not who owns the keys — see
      // ChromeStateFocusV1. Read from the browser's focus manager, which is the
      // only party that can answer it for an extension-process page.
      focus: () => {
        const f = env.services.focus;
        let activeWindow = false;
        try {
          activeWindow = !!f && f.activeWindow === win;
        } catch {
          activeWindow = false;
        }
        let el: any = null;
        try {
          el = f && f.focusedElement ? f.focusedElement : null;
        } catch {
          el = null;
        }
        let b: any = null;
        try {
          b = (win.gBrowser && win.gBrowser.selectedBrowser) || null;
        } catch {
          b = null;
        }
        let inSelectedContent = false;
        try {
          const doc = el && el.ownerDocument;
          inSelectedContent = !!el && !!b && (el === b || (!!doc && doc === (b.contentDocument || null)));
        } catch {
          inSelectedContent = false;
        }
        const tagId = (node: any): string | null => {
          try {
            if (!node) return null;
            return String(node.tagName || "").toLowerCase() + (node.id ? "#" + node.id : "");
          } catch {
            return null;
          }
        };
        // The four facts that turn "focused: null" into a diagnosis — see
        // ChromeStateFocusV1. Each is read in its own try so one unreadable
        // field cannot blank the others.
        let remote = false;
        try {
          remote = !!(b && b.isRemoteBrowser);
        } catch {
          remote = false;
        }
        let docShellActive = false;
        try {
          docShellActive = !!(b && b.docShell && b.docShell.isActive);
        } catch {
          docShellActive = false;
        }
        let focusedWindow: "this" | "other" | null = null;
        try {
          const fw = f && f.focusedWindow;
          if (fw) focusedWindow = fw === win ? "this" : "other";
        } catch {
          focusedWindow = null;
        }
        let chromeActive: string | null = null;
        try {
          chromeActive = tagId(env.document.activeElement);
        } catch {
          chromeActive = null;
        }
        let pageHasFocus: boolean | null = null;
        try {
          const cw = b && b.contentWindow;
          pageHasFocus = cw && cw.document ? !!cw.document.hasFocus() : null;
        } catch {
          pageHasFocus = null;
        }
        return {
          activeWindow,
          focused: tagId(el),
          inSelectedContent,
          remote,
          docShellActive,
          focusedWindow,
          chromeActive,
          pageHasFocus
        };
      },
      // THE KEYBOARD DECISION, AND THE REASONS IT WOULD NOT BE RUN (K5/M6).
      //
      // Everything above reports facts about the helper. This reports the one
      // agreement the user's keyboard depends on — does the helper answer this
      // page's keys AND is the keyboard in that page — plus the reasons the
      // repair for a disagreement would be refused. "Lazyfox froze until I
      // clicked" is that disagreement, and until this field existed it could
      // only be inferred from two facts three fields apart, in a report nobody
      // could collect from a user.
      //
      // Every read is defensive and each falls back to the answer that cannot
      // invent a reason: an unreadable chrome field is NOT the user composing
      // (see chromefield.ts for the direction of that unknown).
      keyboard: () => {
        const chDoc: any = doc;
        let chromeActive = "";
        let fieldValue = "";
        let onScreen = false;
        let hasUserText = false;
        try {
          const el: any = chDoc && chDoc.activeElement;
          if (el) {
            chromeActive = String(el.tagName || "").toLowerCase() + (el.id ? "#" + el.id : "");
            // The field's text, read the way the veto's own callers read it:
            // `value` for the browser's own inputs, `textContent` for an
            // editable, empty for anything else.
            if (el.value != null) fieldValue = String(el.value);
            else if (el.isContentEditable === true) fieldValue = String(el.textContent || "");
            onScreen = chromeElementOnScreen(el);
            hasUserText = chromeFieldHoldsUserText(win, el, fieldValue);
          }
        } catch {
          // Leave the defaults: no field, no text, no veto.
        }
        return {
          owns: chromeOwnsKeys(win),
          // Asked with the SAME function the repair's gate asks (and, like it,
          // with no event: a repair runs at a key, this is a read at rest).
          inPage: focusIsInSelectedContent(win, env.services.focus),
          devtools: isDeveloperSurfaceTab(win),
          chromeField: { active: chromeActive || null, onScreen, hasUserText },
          // The veto a PLAIN key would meet right now. The leader key is never
          // vetoed, which is why this is reported beside `owns`/`inPage` rather
          // than folded into them: `true` here means "the next letter key will
          // not clear this", not "the rescue is unreachable" — `;` is.
          veto: hasUserText,
        };
      },
      // The keyboard rule, callable on demand (the #lfc=focus channel). Wired to
      // the SAME controller the tab-select / location / load triggers use, so a
      // test can never measure a second implementation of the rule.
      giveKeyboard: () => keyboard.giveKeyboardToSelectedPage() as string,
      // IS THE LEADER'S TABLE THERE? An armed leader with no table buffers every
      // chord (shared/leader.ts handleKey) — the overlay lights, the leader
      // stays armed, and no binding can run until the fetch lands. From outside
      // that is indistinguishable from "the binding did nothing", which is the
      // most expensive shape to diagnose; the two facts are named instead.
      keymap: () => ({
        ready: keymapReady(),
        buffered: leader ? leader.bufferedCount() : -1,
      }),
      // The last keystrokes this helper's dispatcher saw and the branch each
      // one took (dev-only, in memory — see keysdispatch.ts). A key that did
      // nothing is otherwise indistinguishable from a key that never arrived.
      keyTrace: () => dispatch.dispatchTrace(),
      // WHERE THE "THIS PAGE ANSWERS ITS OWN KEYS" CLAIM ACTUALLY LIVES, one row
      // per tab. Ownership is read from the record on the SELECTED tab, so a
      // wrong answer is either "no record was ever placed" or "placed on the
      // wrong tab" — the two have opposite fixes and every other field of this
      // reply reports them identically.
      presence: () => presenceSnapshot(win),
      // THE WINDOW, WHICH IS THE ONE OWNERSHIP FACT THAT IS A TIMER rather than
      // a record or a URL class. A key declined by it looks exactly like a key
      // nobody answered, so a failure report has to be able to name it — and its
      // `gapMs` is the number CONTENT_EXPECT_MS should be set from (see
      // keystate.contentExpectation).
      expectation: () => contentExpectation(win),
      // Dev/verification: drop the selected tab's presence record — the way a
      // test is put in the state the field report describes (see
      // keystate.dropPresenceForSelectedTab).
      forgetPresence: () => dropPresenceForSelectedTab(win),
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
    // `;q` turns which-key off; the overlay on screen comes down with it.
    onWhichKeyChanged: (on) => {
      if (!on && leader) leader.unpaint();
    },
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
    armDigits: (apply, timeoutMs, expect, onTimeout) => {
      const generation = leader?.armPending(apply, { timeoutMs: timeoutMs || 3000, expect, onTimeout });
      return {
        cancel: () => { if (generation !== undefined) leader?.cancelPendingGeneration(generation); },
        retarget: (next: string) => {
          if (generation !== undefined && leader?.isPendingGeneration(generation)) leader.setPendingExpect(next);
        },
        isActive: () => generation !== undefined && !!leader?.isPendingGeneration(generation),
      };
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

  // The typing channel, told WHEN its two content-derived signals may be
  // believed: only while this tab still has a content script to keep them
  // honest. They outlive the document that set them, and a stale "typing" does
  // not merely mis-rank one key — it makes the helper decline every key on the
  // pages where nobody else can answer it (see TypingChannelOptions).
  const typing = createTypingChannel({
    contentSignalsLive: () => !chromeOwnsKeys(win),
  });
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
    onLeaderHeld: () => holdWatchdog.keepAlive(),
    // Esc / Ctrl+G: the overlay goes, and so does the hold. See
    // holdrelease.cancelHold — the part that is easy to leave out is not the
    // overlay but the claim, and a claim left standing is restored by the next
    // page the user lands on.
    cancelLeaderHold: () => {
      cancelHold(leader);
      holdWatchdog.stop();
    },
    // The user moved the caret into text after arming the leader. Doing so
    // already stands the sequence down; the physical hold and its published
    // claim must stand down as well or a subsequent navigation can resurrect
    // the leader over the field/page they chose instead.
    releaseLeaderHoldOnLostFocus: () => {
      if (releaseLostHoldOnBlur(leader)) holdWatchdog.stop();
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
  // A HOLD MUST BE KEPT ALIVE BY THE KEY ITSELF. This host clears a hold on the
  // keyup and on blur; a release that arrives at neither (the window was
  // replaced, the keyup went somewhere this listener never sees) used to leave
  // `sticky` set for the rest of the session — and while it is set every binding
  // runs AND LEAVES THE LEADER ARMED, so the keyboard becomes a chain of `;x`
  // bindings that never ends. The evidence that a hold is still a hold is the
  // leader key's auto-repeat (keysdispatch calls onLeaderHeld on the press and on
  // every repeat), so a hold that goes quiet stands down after HOLD_LIVENESS_MS.
  const holdWatchdog = createHoldWatchdog({
    leader: () => leader,
    now: () => env.window.Date.now(),
    setTimer: (fn, ms) => env.setTimeout(fn, ms),
    clearTimer: (handle) => env.clearTimeout(handle),
  });

  const releaseLeaderHold = (key: string): void => {
    try {
      if (releaseHoldOnKeyup(leader, (cfg.config && cfg.config.leader) || ";", key)) {
        holdWatchdog.stop();
      }
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
      if (releaseLostHoldOnBlur(leader)) holdWatchdog.stop();
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
    // The action table records what RAN, by action id. Nothing here decides which
    // key means that action: the keymap (core/keymap.go) does, and it cannot
    // disagree with the menu because it IS the menu.
    noteAction: (action) => {
      lastAction = action;
    },
  });
  leader = built.leader;
  leaderActions = built.actions;

  // ;f is link-hints, and which engine runs it is the dispatcher's decision —
  // made in ONE place.
  //
  // This used to be a gate here AND a decision inside `runHintsAction`, keyed on
  // the same two predicates ("is this the command center" / "does the helper own
  // the keys"), which is how two answers to one question drift: this copy asked
  // `isCommandCenterTab`, the URL, while the other asks the document. During a
  // provisional navigation out of the command center the two disagree, and the
  // copy that ran first — this one — sent `;f` to the shared engine for a page
  // that was still our own. Now the dispatcher's `runHintsAction` is the whole
  // rule (command center → the page's own picker; chrome-owned → the helper's
  // own hints; a web page → the shared engine, which `setWebHints` wires back
  // here), so there is nothing left to keep in step.
  // The shared engine's own `f` action, captured BEFORE the table entry is
  // replaced. It is the web-page answer, and it must be captured rather than
  // looked up later: once the entry below points at the dispatcher, reading
  // `leaderActions["f"]` from the web-page path would call the dispatcher again,
  // which would route back here for ever.
  const engineHintsAction = leaderActions["f"];
  leaderActions["f"] = () => {
    dispatch.runHintsAction();
  };
  // The dispatcher's web-page path (a key forwarded to chrome on a page it
  // does not own) routes back to the shared engine's action.
  dispatch.setWebHints(() => {
    if (engineHintsAction) engineHintsAction();
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
  const alive = createAliveAnnounce(env, win, () => channel, profile);

  /* ===================== cache control ===================== */

  // Per-tab / per-session page-cache enforcement. The pool of bypassable tabs
  // is keyed off the status bar's live tab-id snapshot (strip order).
  const cache = createCacheCtl({ getTabIds: () => status.getTabIds() });

  // THE WHICH-KEY MENU A SPLIT PAGE ASKS THE WINDOW TO PAINT (wkglobal.ts).
  // Only a page that says it is a pane sends one; every other page paints its
  // own. The selected index is read from the strip for the same reason the
  // status bar reads it: a leftover from another pane must not paint here.
  const globalWhichKey = createGlobalWhichKey({
    enabled: () => cfg.config.whichKey !== false,
    selectedIndex: () => {
      try {
        const t: any = (win.gBrowser as any).selectedTab;
        return t && typeof t.index === "number" ? t.index : -1;
      } catch {
        return -1;
      }
    },
  });

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
    // A presence report arrives carrying a STRIP INDEX, because that is the only
    // coordinate the sending document can be given — and it is resolved to the
    // tab it is about at the door. Everything past this point is keyed by the
    // tab itself, so a reorder cannot attach a live document's answer to
    // whatever tab slid into its slot (keystate.presenceTabFor, and the
    // §18.5 failure it closes).
    setContentPresent: (index, active, url, doc) =>
      noteContentPresent(presenceTabForReport(win, index, url, doc), active, url, doc),
    dismissDownloads: () => void chromeOps.dismissDownload(),
    // Firefox's native Screenshots (`;C f` / `;C v`), driven by ops, reached
    // from a page over the pushes.
    takeScreenshot: (shot) => void chromeOps.screenshot(shot),
    cfg,
    // The helper's cached config + prefs, applied in one place from both
    // directions: the options page's #lfc=cfg push, and the background's
    // `cfg` push after a toggle made on a web page (`;q` in a content script,
    // which used to reach storage and every page but never this window).
    applyConfig: (config) => {
      cfg.config = mergeConfig(config);
      persistCfg(cfg, cfg.config);
      applyHoverRevealPref(cfg);
      if (cfg.config.whichKey === false && leader) leader.unpaint();
      // ...and the mirror a split page asked for, which is not the helper's
      // own panel and would otherwise survive the toggle on screen.
      if (cfg.config.whichKey === false) globalWhichKey.clear();
    },
    pagePanel: (index, panel) => globalWhichKey.set(index, panel),
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
        //
        // TWO FACTS DECIDE WHERE THE KEY CAME FROM, and they used to be one.
        // "No content script" says who the OWNER is; it does not say the key was
        // delivered to the page. The actor runs in the CONTENT process, so it
        // sees exactly the keys that arrived there — which requires the page to
        // have the KEYBOARD. When the keyboard sits in the browser's own UI the
        // key is delivered in the PARENT process instead, and the product's real
        // path for it is the window listener (winlisteners → chromeKeyDown with
        // no actor flag). Declaring such a key an actor key made the dispatcher
        // treat it as coming from a page that cannot see keys at all, and —
        // measured — skipped the very repair that gives the page its keyboard
        // back: the harness sent `;` "as the user typed it into the URL bar" and
        // the prompt was answered as if it had come from the page.
        const sel = win.gBrowser && win.gBrowser.selectedTab;
        const fromActor =
          !sel || !target || target === sel
            ? !contentScriptPresent(sel, win) && selectedContentHasKeyboard(win, env.services.focus)
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
    releaseLeaderHoldOnTabSwitch: () => {
      if (releaseLostHoldOnBlur(leader)) holdWatchdog.stop();
    },
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

  // THE KEYBOARD FOLLOWS THE TAB. Built here because the two things it asks
  // about — whether Lazyfox's own popup owns the keyboard, and whether the
  // selected tab is one of Lazyfox's own carriers — exist here; the rule itself
  // and the two events that fire it live in chrome/keyboardfocus.ts and
  // chrome/winsync.ts.
  // `nsIFocusManager.FLAG_NOSCROLL`, read from the host when it is there: focus
  // without dragging the page to the element that took it.
  const focusFlags = (): number => {
    try {
      const v =
        env.Ci && env.Ci.nsIFocusManager && env.Ci.nsIFocusManager.FLAG_NOSCROLL;
      return typeof v === "number" ? v : 0;
    } catch {
      return 0;
    }
  };
  const keyboard = createKeyboardFocus({
    win,
    popupOpen: () => popup.isOpen(),
    isRelayTab: (t) => !!channel && channel.isKnownRelayTab(t),
    // THE DOCUMENT as well as the URL: during a provisional navigation the URL is
    // already the target while the page on screen is still the home page — the
    // same pair keysdispatch.ts uses, for the same reason.
    commandCenter: () => isCommandCenterTab(win) || commandCenterDocumentPresent(win),
    focusCommandCenter: () =>
      focusCommandCenterContent(win, env.services.focus, focusFlags()),
    focusContent: () => focusSelectedContent(win, env.services.focus, focusFlags()),
  });

  // The pollers, the #lfc= progress route and the per-tab-select bookkeeping.
  installWinSync({
    env,
    channel,
    alive,
    split,
    status,
    leader: () => leader,
    keyboard,
  });

  // The trusted-click channel (see bridgemount.ts for why it has to be
  // mounted from here rather than left to page keystrokes).
  installBridgeMount(env, win);
})();
