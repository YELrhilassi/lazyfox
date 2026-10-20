// Content script entry: lazyfox standalone mode (chrome helper absent) and
// scroll keys / hints while the chrome helper is alive. All popups, the leader
// and its actions come from ../shared/* behind the ActionOps adapter
// (content/ops.ts); this file owns config state, chrome-alive gating and the
// window-level key dispatch.

import { mergeConfig } from "../../shared/config";
import { ensureCore } from "../../shared/core";
import { blurTypingFocus, isTypingEvent, isTypingTarget, typingTargetOf } from "../../shared/dom";
import { dbg } from "../../shared/dev";
import { installContentDom } from "./contentdom";
import { LeaderController, isCancel } from "../../shared/leader";
import { idleSignal, type LeaderSignal } from "../../shared/leadersignal";
import { specToText } from "../../shared/keymap";
import { createThrottle } from "../../shared/throttle";
import {
  cancelHold,
  createHoldWatchdog,
  releaseHoldOnKeyup,
  releaseLostHold as releaseLostHoldOnBlur,
  restoreHold,
  shouldRestoreHold,
  visibilityLostHold,
} from "../../shared/holdrelease";
import { openNavPopup } from "../../shared/popups/nav";
import {
  openPopup as overlayOpenPopup,
  popupIsAlive,
  toast,
  type PopupCtl,
} from "../../shared/overlay";
import { mirror, mirrorFlag } from "../../shared/observability";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../../shared/popups";
import { send } from "../../shared/protocol";
import { readKey, vConfig } from "../store";
import type { Config } from "../../shared/types";
import { collectPageReport } from "./diagnostics";
import { createLinkHints, focusFirstInput } from "./hints";
import { createContentOps } from "./ops";
import { createScrollController } from "./scroll";
import { createScrollKeys } from "./scrollkeys";
import { createDarkMode } from "./dark";
import { barVerdict, createVerdictLatch, type BarVerdict } from "./dark/verdict";
import { createReader } from "./reader";
import {
  installFrameChild,
  installFrameParent,
  type FrameKeyMessage,
} from "./framekeys";
import type { ContentPopupShell } from "./find";
import { createFieldPark } from "./parkrule";

(function () {
  "use strict";

  // A child frame hands its keys UP, and does nothing else: the owner of the
  // leader, popups, hints and overlays is the TOP document (framekeys.ts). A
  // frame must set no presence beacon, report no typing state, paint nothing —
  // those describe the tab's top document, and a frame claiming them would
  // make the chrome helper believe the wrong URL owns this tab.
  try {
    if (window.top !== window) {
      installFrameChild({ win: window, isTypingEvent });
      return;
    }
  } catch (e) {
    // ignore
  }

  // Handshake for the chrome helper: it keys off this attribute to tell "a
  // Lazyfox content script owns this page" from the pages it must cover
  // itself (about:/error pages, restricted sites). Set before anything throws.
  try {
    document.documentElement.setAttribute("data-lf-content", "1");
  } catch (e) {
    // ignore
  }

  let config: Config = mergeConfig(undefined);

  /* ===================== dark mode ===================== */

  // Built before config arrives; `early()` before anything throws, because a
  // dark theme has to get the FIRST frame right (see dark/index.ts). The
  // controller reads config lazily through the closure.
  const darkVerdicts = createVerdictLatch();
  // The verdict this document last published, so a presence re-assert can
  // republish it. Null until the engine has decided anything.
  let publishedVerdict: BarVerdict | null = null;
  function republishDarkVerdict(): void {
    if (!publishedVerdict) return;
    darkVerdicts.reset();
    if (!darkVerdicts.send(publishedVerdict)) return;
    void send("syncDark", publishedVerdict);
  }
  const darkMode = createDarkMode({
    doc: document,
    win: window,
    url: () => location.href,
    getConfig: () => config,
    setConfig: (next) => {
      // Optimistic locally, then through the background: the background
      // caches config, and writing storage behind its back lets the copies
      // disagree (docs/FINDINGS.md).
      config = next;
      void send("setConfig", { config: next });
    },
    toast,
    // "Already dark" pages report `native` even though we paint nothing —
    // "nothing to do, the site did it" is the most useful segment state.
    report: (s) => {
      // Published when it CHANGES, not per pass (dark/verdict.ts: the latch).
      const verdict = barVerdict(s);
      publishedVerdict = verdict;
      if (!darkVerdicts.send(verdict)) return;
      void send("syncDark", verdict);
    },
  });
  darkMode.early();

  function loadConfig() {
    try {
      void readKey("config", vConfig, {}).then((c) => {
        config = mergeConfig(c);
        darkVerdicts.reset();
        darkMode.update(config);
      });
    } catch (e) {
      // A storage hiccup must never take the keyboard handling down with it.
      if (__DEV__) dbg("config load failed", (e && (e as Error).message) || String(e));
    }
  }
  loadConfig();

  // Live config: re-read when the options page writes it. The status bar is
  // NOT ours to draw — the chrome helper owns the window-level bar.
  try {
    browser.storage.onChanged.addListener(
      (changes: { config?: { newValue?: Partial<Config> } }, area: string) => {
        if (area === "local" && changes.config) {
          config = mergeConfig(changes.config.newValue || {});
          darkVerdicts.reset();
          darkMode.update(config);
        }
      }
    );
  } catch (e) {
    // ignore — live config is a convenience, not a requirement
  }

  /* ===================== scroll target ==================== */

  // Built BEFORE the hint engine: the hint layer's paging (`]`, `[`, Tab)
  // moves the region the scroll keys move. One creation site at boot, one
  // answer to "which region do the keys move". The target is the document
  // scroller by default, an inner pane when the document cannot scroll
  // (ChatGPT-style shells), or whatever the user cycled to with ;F / ;B.
  const scroll = createScrollController();

  /* ===================== reader mode ===================== */

  // After the scroll controller: entering reader mode RESETS the scroll
  // target (the article becomes the page's only scroller).
  const reader = createReader({
    doc: document,
    win: window,
    getConfig: () => config,
    toast,
    resetScroll: () => scroll.reset(),
    accent: () => config.dark.accent,
  });

  /* ===================== link hints ===================== */

  const hints = createLinkHints(() => config.hintChars, () => scroll);

  /* ===================== popup shell ===================== */

  let currentPopup: PopupCtl | null = null;

  function closePopup(): void {
    if (currentPopup) {
      try {
        currentPopup.close();
      } catch (e) {
        // ignore
      }
      currentPopup = null;
    }
  }

  const shell: ContentPopupShell = {
    open: (html, build) => {
      closePopup();
      leader.hide();
      // The reverse half of the startHints handover: one owner at a time. A
      // popup opened over a live hint layer used to leave the layer RUNNING
      // (badges drawn, observers busy, keys dead).
      if (hints.active || hints.starting) hints.exit();
      const ctl = overlayOpenPopup(html, (root) => build(root), () => {
        currentPopup = null;
      });
      currentPopup = ctl;
      // `overlayOpenPopup` returns a dead controller when the panel build
      // threw; honour it immediately so the user's next key is not spent
      // closing a ghost.
      if (!popupIsAlive(currentPopup)) currentPopup = null;
      return ctl;
    },
    close: closePopup,
  };

  /* ===================== leader + shared popups ===================== */

  const contentOps = createContentOps({
    shell: shell,
    config: () => config,
    // The reverse half of the one-owner rule (the other half is the
    // leader-key branch in onKeyDown): without this a held `;f` left the
    // leader armed under the hint layer and every hint letter ALSO ran a
    // binding ("hints sometimes run my shortcuts").
    startHints: () => {
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
      void hints.start();
    },
    focusFirstInput: focusFirstInput,
    // Find count relayed to the chrome helper's bar — content -> background
    // -> helper, same path as the dark verdict. count -1 = widget closed.
    setFindState: (s) => {
      void send("syncFind", s ? { cur: s.cur, count: s.count } : { cur: 0, count: -1 });
    },
  });

  let leader: LeaderController;
  const ctx: PopupCtx = {
    ops: contentOps,
    open: shell.open,
    close: closePopup,
    toast: toast,
    runAction: (k) => runLeaderAction(leaderActions, k),
    bindings: () => leader.bindings(),
    armDigits: (apply, timeoutMs, expect, onTimeout) => {
      const generation = leader.armPending(apply, { timeoutMs: timeoutMs || 3000, expect, onTimeout });
      return {
        cancel: () => leader.cancelPendingGeneration(generation),
        retarget: (next: string) => {
          if (leader.isPendingGeneration(generation)) leader.setPendingExpect(next);
        },
        isActive: () => leader.isPendingGeneration(generation),
      };
    },
    manualText: true,
  };
  const leaderActions = makeLeaderActions(ctx);
  // Mirror the leader's armed state onto <html> like the find/yank/hint
  // overlays do. The which-key overlay lives in a CLOSED shadow root, so this
  // attribute is the only page-level answer to "is the leader armed" — and
  // what lets the e2e harness wait for a dispatch instead of guessing.
  const setLeaderAttr = (armed: boolean) => mirrorFlag("leader", armed);
  // Same move as the other data-lf-* mirrors: an armed digit capture lives
  // for three seconds — longer than any cross-process read could be trusted.
  const setLeaderExpect = (want: string) => mirror("lead-expect", want || null);
  // One value for the whole readout, forwarded unchanged everywhere.
  const readout = (): LeaderSignal => leader.signal();
  leader = new LeaderController(
    (action) => runLeaderAction(leaderActions, action),
    () => config.whichKey !== false,
    // The helper's bar draws the leader indicator from the per-tab state we
    // push; with the overlay disabled that indicator is the only leader sign.
    () => {
      const sig = readout();
      setLeaderAttr(sig.armed);
      setLeaderExpect(sig.expect);
      void send("syncLeader", { signal: sig });
    },
    // Unknown chords are REPORTED, never swallowed in silence.
    (spec) => toast("no binding for ;" + specToText(spec))
  );
  // A fresh load always starts disarmed.
  void send("syncLeader", { signal: idleSignal() });
  // Report IN: the helper cannot discover that this page has a content script
  // (selectedBrowser.contentDocument is null for OOP tabs). Without this push
  // it judged ownership by URL alone — the dead-keyboard bug on slow loads
  // and the error page. The doc id travels along: a URL stops matching after
  // the first pushState on an SPA, and the helper then concluded this
  // document had no script for the rest of its life.
  const docId =
    String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
  const reportPresence = (active: boolean) => {
    let href = "";
    try {
      href = location.href;
    } catch (e) {
      // ignore — an unreadable location simply reports no URL
    }
    // The dark verdict rides along on the way IN only: a leaving document
    // does not describe the next page's verdict.
    if (active) republishDarkVerdict();
    return send("syncContent", { active, url: href, doc: docId });
  };
  // The report is RE-ASSERTED, not sent once (docs/KEYBOARD-FREEZE.md): a
  // dropped report left the helper claiming keys the page owned while it was
  // alive and answering. A key is the proof the document still has the
  // keyboard; costs a background round trip + two session writes, so
  // throttle — the limiter's first call always passes.
  const PRESENCE_REASSERT_MS = 3000;
  const presenceThrottle = createThrottle(PRESENCE_REASSERT_MS);
  // A REFUSED report (answered by the background) must let the limiter try
  // again immediately: the window bought nothing. Hops beyond that are
  // counted by the helper itself (relay.gaps), not observable here.
  const reassertPresence = (): void => {
    if (!presenceThrottle.allow()) return;
    try {
      void Promise.resolve(reportPresence(true))
        .then((res: { ok?: boolean } | null | undefined) => {
          if (!res || res.ok === false) presenceThrottle.reset();
        })
        .catch(() => presenceThrottle.reset());
    } catch (e) {
      presenceThrottle.reset();
    }
  };
  // THE HELD LEADER ACROSS DOCUMENTS. `leader.sticky` lived in the one
  // document that got the keydown, so hold `;` + close a tab / navigate: the
  // next document had sticky === false and the second key became a literal
  // character. The hold is published to the per-tab session store
  // (syncTyping's, which outlives the script) and read back on boot; the
  // restored leader is ARMED as well as held. Generations on both writes let
  // the background drop an out-of-order release instead of trusting the port.
  let holdGeneration = 0;
  let pendingHoldReport: boolean | null = null;
  let holdRestoreCancelled = false;
  let presenceReady = false;
  let holdCommitChain: Promise<void> = Promise.resolve();
  let lastHoldCommitAt = 0;
  // docId is the ownership token for BOTH presence and holds; a second nonce
  // would fail the background's owner check and silently disable holds.
  const holdDoc = docId;
  const publishHoldState = (hold: boolean): void => {
    if (!presenceReady) {
      pendingHoldReport = hold;
      return;
    }
    const generation = ++holdGeneration;
    const commit = holdCommitChain.then(async () => {
      const result = await send("syncHold", { hold, generation, doc: holdDoc });
      if (result?.ok) lastHoldCommitAt = Date.now();
    });
    holdCommitChain = commit.catch(() => {});
  };
  // A held key must REPUBLISH its claim, or shouldRestoreHold judges it
  // expired (HOLD_RESTORE_GRACE_MS runs out mid-press). Repeats are the
  // evidence the key is down; throttled to 1/s — two orders beyond need.
  const HOLD_PUBLISH_INTERVAL_MS = 1000;
  let lastHoldPublish = 0;
  const republishHold = (): void => {
    const now = Date.now();
    if (now - lastHoldPublish < HOLD_PUBLISH_INTERVAL_MS) return;
    if (now - lastHoldCommitAt < HOLD_PUBLISH_INTERVAL_MS) return;
    lastHoldPublish = now;
    publishHoldState(true);
  };
  // A hold STEALS EVERY KEY until released. A release lost to a document
  // replacement would leave sticky set for the document's life ("the leader
  // stays active, then nothing responds"). The leader key's auto-repeat is
  // evidence this document always receives, so the watchdog re-arms on every
  // repeat and stands a quiet hold down.
  const holdWatchdog = createHoldWatchdog({
    leader: () => leader,
    onRelease: () => publishHoldState(false),
  });
  // A keyup seen HERE proves a restored claim is already spent (the release
  // can land before the async snapshot resolves, and restoring then would arm
  // a leader on a page nobody holds a key on).
  let leaderKeyUpSeen = false;
  let holdSnapshotInitialized = false;
  let holdInitInFlight: Promise<void> | null = null;
  const initializeHoldFromPresence = (): Promise<void> => {
    if (holdInitInFlight) return holdInitInFlight;
    holdInitInFlight = reportPresence(true)
      .then(async (r) => {
        // A failed startup message must not disable persistence; pageshow
        // retries the handshake if the background restarted.
        if (!r) return;
        presenceReady = true;
        if (holdSnapshotInitialized) return;
        holdSnapshotInitialized = true;
        if (r.holdDoc === holdDoc) holdGeneration = Number(r.holdGeneration) || 0;
        await holdCommitChain;
        if (pendingHoldReport !== null) {
          // Local input beats the old document's snapshot for the same key.
          const pending = pendingHoldReport;
          pendingHoldReport = null;
          publishHoldState(pending);
          return;
        }
        if (holdRestoreCancelled) return;
        if (!shouldRestoreHold(!!r.hold, Number(r.holdAt) || 0, Date.now())) return;
        if (leaderKeyUpSeen) {
          publishHoldState(false);
          return;
        }
        const age = Date.now() - (Number(r.holdAt) || 0);
        lastHoldPublish = Date.now();
        lastHoldCommitAt = Date.now() - Math.max(0, age);
        restoreHold(leader);
        holdWatchdog.keepAlive();
        leader.show();
      })
      .catch(() => {})
      .finally(() => {
        holdInitInFlight = null;
      });
    return holdInitInFlight;
  };
  // The BOOT report is sent at the END of this module, not earlier. The
  // report is a claim of ownership the helper honours instantly: sending it
  // before installContentDom ran left a window where nobody answered the
  // keys (e2e "a page that sends headers then stalls still answers the
  // leader key"). Late is safe; lost is repaired by reassertPresence and
  // pageshow.
  try {
    window.addEventListener("pagehide", () => void reportPresence(false), { capture: true });
  } catch (e) {
    // ignore — presence is re-derived on the next load regardless
  }
  // One report is not a durable answer: a late pagehide from the replaced
  // document (now filtered by the nonce in keystate.noteContentPresent) and a
  // restarted background both survive any retraction. pageshow re-announces
  // at commit AND bfcache restore, idempotently.
  try {
    window.addEventListener("pageshow", () => void initializeHoldFromPresence(), { capture: true });
  } catch (e) {
    // ignore — the initial report already covered the normal case
  }
  // Host actions, NAMED not keyed: the keymap routing them is in Go and the
  // coverage test reads this list. ;G/;L are the nav-stack popups on the
  // SHIFTED keys — deliberately unambiguous against ;g/;l Back/Forward.
  leaderActions["backStack"] = () => openNavPopup(ctx);
  leaderActions["forwardStack"] = () => openNavPopup(ctx);
  // ;F / ;B cycle the scroll target among the page's scroll regions.
  leaderActions["scrollRegionNext"] = () => scroll.cycle(1);
  leaderActions["scrollRegionPrev"] = () => scroll.cycle(-1);
  // ;R = reader mode: the article replaces the page in the same document, so
  // the leader, hints, find, yank and scroll controller keep working inside
  // it — why the host owns it instead of tabs.toggleReaderMode.
  leaderActions["readerMode"] = () => reader.toggle();
  // ;Y d/g/e/x = the theme family; each writes through setConfig so every
  // surface sees the same answer.
  leaderActions["darkToggleSite"] = () => darkMode.toggleSite();
  leaderActions["darkCycleGlobal"] = () => darkMode.cycleGlobal();
  leaderActions["darkEngineToggle"] = () => darkMode.toggleEngine();
  leaderActions["darkResetSite"] = () => darkMode.resetSite();

  /* ==================== scroll keys ==================== */

  const handleScrollKeys = createScrollKeys(scroll, () => config);

  /* ==================== key dispatch ==================== */

  // The dispatch trace, in memory (never on <html>: root-attribute writes per
  // keydown paid for instrumentation with style invalidation on every page).
  // Pull-based: `dispatchTrace()` hands it to the dev-only handler in
  // contentdom.ts. It is a RING, not a last-value readout — the state is
  // always read after the key that produced it was overwritten, and a bug
  // shows as "armed on the way in, armed on the way out" vs "never armed",
  // which are different bugs. `br` labels are shared with the chrome ring.
  const trace = { key: "", active: "?", popup: "0", dispatched: "" };
  interface KeyRecord {
    k: string; // the key
    br: string; // the branch that answered it (labels in onKeyDown)
    c: number; // 1 when Lazyfox consumed it
    rep: number; // auto-repeat (a held key restating one press)
    ty: number; // a text field had the caret
    pop: number; // a popup was up
    hnt: number; // a hint layer was up
    pg: number; // a one-shot capture was armed on the way in
    ar: number; // armed on the way in (what data-lf-leader publishes)
    pg2: number; // same two facts after the key was answered
    ar2: number;
    at: number; // ms since this document booted
    err?: string; // handler throw, when there was one — never a silent key
  }
  // Two full gestures plus aftermath: the arms WITH the keys that should
  // have disarmed them.
  const RING_LIMIT = 24;
  const ring: KeyRecord[] = [];
  const bootAt = Date.now();
  // State captured when the key arrived (reading it after the fact is too
  // late — the comparable state is already gone).
  let keyEntry: KeyRecord | null = null;
  // Set at each decision point in onKeyDown, read once by noteKey: the
  // instrument cannot change what the dispatcher does.
  let br = "entry";
  const armedNow = (): number => (leader.active || leader.hasPending() ? 1 : 0);

  /** Record one answered key. Runs from afterKey, exactly once per keydown. */
  function noteKey(outcome: { key: string; consumed: boolean; error?: unknown }): void {
    const e = keyEntry;
    keyEntry = null;
    if (!e) return;
    e.c = outcome.consumed ? 1 : 0;
    e.br = br;
    e.pg2 = leader.hasPending() ? 1 : 0;
    e.ar2 = armedNow();
    if (outcome.error) {
      e.err = String((outcome.error as Error)?.message || outcome.error).slice(0, 160);
    }
    ring.push(e);
    if (ring.length > RING_LIMIT) ring.shift();
    br = "entry";
  }

  // Clear every overlay state and give focus back to the page. ONE function
  // for Escape and Ctrl+G so "cancel" cannot drift. Returns whether it
  // removed something the user could SEE — the Escape ladder's rule for
  // consuming: changed something = ours; changed nothing = the page's.
  function cancelOverlays(): boolean {
    let cleaned = false;
    // Reader mode first: the article REPLACED the page, so leaving it
    // standing leaves the user trapped without `;R`.
    if (reader.active()) {
      reader.close();
      cleaned = true;
    }
    if (hints.active || hints.starting) {
      hints.exit();
      cleaned = true;
    }
    if (leader.hasPending()) {
      leader.cancelPending();
      cleaned = true;
    }
    if (leader.active) {
      leader.hide();
      cleaned = true;
    }
    // The hold belongs to the gesture being cancelled; leaving it standing is
    // how a cancel came back (the user backed out, then navigated, and the
    // new document restored a hold nobody was making).
    holdRestoreCancelled = true;
    publishHoldState(false);
    if (cancelHold(leader)) holdWatchdog.stop();
    // A cycled sidebar must never trap the scroll keys.
    if (scroll.isCustom()) {
      scroll.reset();
      cleaned = true;
    }
    // Blur whatever holds focus. A FIELD goes through the deep helper: a
    // field in a closed shadow root reports its HOST as activeElement, and
    // blurring the host leaves the caret exactly where it was.
    if (isTypingTarget(document.activeElement)) {
      blurTypingFocus();
      return true;
    }
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement) {
      try {
        (ae as HTMLElement).blur();
        cleaned = true;
      } catch (err) {
        // ignore
      }
    }
    return cleaned;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (__DEV__) {
      trace.key = e.key;
      trace.active = leader ? (leader.active ? "1" : "0") : "?";
      trace.popup = currentPopup ? "1" : "0";
      keyEntry = {
        k: e.key,
        br: "entry",
        c: 0,
        rep: e.repeat ? 1 : 0,
        ty: isTypingEvent(e) ? 1 : 0,
        pop: currentPopup ? 1 : 0,
        hnt: hints.active || hints.starting ? 1 : 0,
        pg: leader.hasPending() ? 1 : 0,
        ar: armedNow(),
        // Overwritten by noteKey, which always runs for this keydown.
        pg2: 0,
        ar2: 0,
        at: Date.now() - bootAt,
      };
      br = "entry";
    }
    if (e.isComposing) {
      br = "composing";
      return;
    }
    // A popup the PAGE removed must not keep owning the keyboard: the panel
    // is a child of <html>, so a re-render takes it without calling close().
    // Close (and run its teardown) instead of typing into a ghost.
    if (currentPopup && !popupIsAlive(currentPopup)) closePopup();
    if (currentPopup) {
      br = "popup";
      e.preventDefault();
      e.stopImmediatePropagation();
      // The popup's onKey gets FIRST refusal — the find popup consumes Esc
      // to leave yank mode while keeping the widget open, the sessions popup
      // uses it to cancel a pending copy/move. The isCancel below is only
      // the fallback for popups that decline it.
      try {
        if (currentPopup.onKey && currentPopup.onKey(e)) return;
      } catch (err) {
        // A popup whose key handler throws cannot be driven; close, but say
        // why — closing silently reads as "the key did nothing".
        if (__DEV__) {
          try {
            console.error("lazyfox popup key handler threw", err);
          } catch (x) {
            // ignore — logging must never become the new failure
          }
        }
        closePopup();
        return;
      }
      // Ctrl+G is the second cancel: Esc is the most contested key on the
      // web, Ctrl+G is a universal abort no page can receive as text, and it
      // works with the leader still held.
      if (isCancel(e)) {
        br = "popup-cancel";
        closePopup();
      }
      return;
    }
    if (hints.active || hints.starting) {
      if (e.key === config.leader) {
        // The leader ALWAYS wins over a hint layer: the hint alphabet never
        // contains the leader key, but saying it here makes it a rule
        // instead of a coincidence of the default hint chars.
        hints.exit();
      } else if (isTypingEvent(e)) {
        // The user focused a field mid-hints: the batch must not eat typing.
        hints.exit();
      } else if (e.key === "Escape") {
        // Esc exits the hints and falls through to the shared Esc handling
        // below; `starting` is load-bearing — between `;f` and the batch
        // appearing, `active` is still false, and an Escape in that window
        // must not leave the batch building after the user cancelled it.
        hints.exit();
      } else if (!hints.active) {
        // Starting, not yet taking keys: fall through to the leader/popups.
      } else if (leader.active) {
        // ONE OWNER AT A TIME. This branch is where "while hinting, typing
        // `d` opens Downloads" lived: a hint letter fell through to the
        // leader dispatcher and ran a binding whenever the leader was still
        // armed (a held `;f` guaranteed it).
        hints.exit();
      } else {
        // Swallow only what the hints handled. Unconditional preventDefault
        // used to eat the leader key itself.
        if (hints.handleKey(e)) {
          br = "hints";
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        // Not ours: fall through as if the hints had never been open.
      }
    }
    // On web pages the content script owns the leader/popups/hints/Esc/scroll
    // keys itself: Firefox never forwards keys typed into remote web content
    // to the chrome window's listener — the helper only receives keys on
    // in-process pages (about:, the command center), where this script does
    // not run.
    //
    // THE TYPING GUARD COMES BEFORE THE CANCEL, and not by taste: cancel
    // blurs the focused element, so guard-second made Escape destroy the
    // user's place. The cancel IN A FIELD is the one exception the guard
    // cannot swallow (below).
    if (isTypingEvent(e)) {
      if (isCancel(e)) {
        br = e.key === "Escape" ? "cancel-field" : "cancel-field-chord";
        // ESCAPE IS A LADDER, one rung per press: a press that changed
        // something on this screen is ours and consumed; a press that
        // changed nothing belongs to the page (that is how a dialog closes
        // at all). In a field, the rung is the caret: Escape leaves the
        // field and STOPS there — closing the dialog the field sits in on
        // the same keystroke destroyed work nobody asked to destroy. The
        // next Escape, with nothing left and no field focused, is the
        // page's. Ctrl+G always does the same cleanup and is ALWAYS
        // consumed: it exists for pages that fight Lazyfox for Escape.
        const cancelChord = e.key !== "Escape";
        const cleaned = cancelOverlays();
        if (cancelChord || cleaned) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      // THE PARKED-FIELD CLAIM (parkrule.ts): only the LEADER key escapes a
      // box the page parked the caret in; everything else — and every later
      // key in a touched box — types.
      if (fieldPark.isLeaderClaim(e, config.leader)) {
        fieldPark.noteUserType(typingTargetOf(e));
        // Blur NOW: with the caret still in the box the next keydown
        // re-enters this guard and disarms the leader the claim arms. The
        // deep helper, because a closed-root field blurs its host otherwise
        // (see cancelOverlays). If the blur is refused, fall through anyway.
        blurTypingFocus();
      } else {
        fieldPark.noteUserType(typingTargetOf(e));
        if (leader.active) leader.hide();
        if (leader.hasPending()) leader.cancelPending();
        return;
      }
      // Parked claim: fall through to the leader branch, which arms it.
    }
    if (isCancel(e)) {
      const cancelChord = e.key !== "Escape";
      br = cancelChord ? "cancel-chord" : "cancel";
      // The same ladder, one rung fewer: this press has no caret to put
      // down, so it is the page's the moment Lazyfox has nothing on screen.
      // One press for hints + leader + capture + reader + scroll region
      // (cancelPending DROPS the capture instead of running it with "Escape"
      // as its key). Ctrl+G is always consumed.
      const cleaned = cancelOverlays();
      if (cancelChord || cleaned) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    // A HELD LEADER KEY IS NOT A CHORD — it is the OS restating one press.
    // Otherwise every auto-repeat landed as a chord MISS: panel repaint plus
    // a "no binding for ;;" toast ~30x/s. Dropped as intent, KEPT as
    // liveness evidence (holdWatchdog; republishHold) — and dropped BEFORE
    // the capture is asked, so a held `;` is never an answer to `;W m`.
    if (e.repeat && e.key === config.leader && !e.ctrlKey && !e.altKey && !e.metaKey) {
      br = "leader-repeat";
      e.preventDefault();
      e.stopImmediatePropagation();
      holdWatchdog.keepAlive();
      if (leader.sticky) republishHold();
      return;
    }
    if (leader.hasPending()) {
      // A capture can DECLINE the key — `false` for not-its-keys (letters, a
      // leading zero, modifiers). Every host used to consume the key anyway;
      // declined now means "not ours" and the key continues down this
      // dispatcher exactly as if no capture had been armed.
      if (leader.handlePending(e)) {
        br = "capture";
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Declined: someone else labels the record below.
    }
    if (leader.active) {
      br = "leader";
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.handleKey(e);
      if (__DEV__) trace.dispatched = e.key;
      return;
    }
    // Ctrl+1-9: hot-swap to the session with that marker (tmux-style).
    // Fields are skipped, so Ctrl+1 inside an input is untouched.
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      if (!isTypingEvent(e)) {
        br = "session-marker";
        e.preventDefault();
        e.stopImmediatePropagation();
        contentOps.switchSessionByMarker(Number(e.key));
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) {
      br = "modified";
      return;
    }
    if (handleScrollKeys(e)) {
      br = "scroll";
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === config.leader) {
      br = "leader-key";
      e.preventDefault();
      e.stopImmediatePropagation();
      // Other repeats carry no binding intent here (the leader repeat was
      // liveness evidence, above; a re-armed repeat tore sequences apart).
      if (e.repeat) return;
      // Sticky: bindings run and the leader stays armed — `;` then
      // close-tab twice costs one keystroke. Hints give the keyboard up
      // here (the reverse transition of startHints), so the two surfaces
      // are never armed at once.
      if (hints.active || hints.starting) hints.exit();
      holdRestoreCancelled = false;
      leader.sticky = true;
      publishHoldState(true);
      holdWatchdog.keepAlive();
      leader.show();
      return;
    }
    // Nothing claimed it: the page gets the key. Named so the ring can never
    // report an unlabelled key.
    br = "page";
  }

  // Releasing the leader clears the HOLD, not the leader: a tap is
  // keydown + keyup, and hiding on release would disarm instantly (breaking
  // `;` then a binding). Release only drops STICKY, so the next binding runs
  // and disarms as usual.
  window.addEventListener(
    "keyup",
    (e) => {
      try {
        // The leader came UP in this document — whether it released a
        // restored hold or a claim we have not read yet — so the claim is
        // spent (see leaderKeyUpSeen).
        if (e.key === config.leader) {
          leaderKeyUpSeen = true;
          if (!leader.sticky) publishHoldState(false);
        }
        if (releaseHoldOnKeyup(leader, config.leader, e.key)) {
          publishHoldState(false);
          holdWatchdog.stop();
        }
      } catch (err) {
        // ignore
      }
    },
    true
  );

  // A keyup can be LOST (tab/window/OS switch between press and release) and
  // the hold must not outlive the page's attention. Only the hold is
  // cleared — the leader stays armed as a released tap leaves it. Idempotent.
  const releaseLostHold = (): void => {
    try {
      if (releaseLostHoldOnBlur(leader)) {
        publishHoldState(false);
        holdWatchdog.stop();
      }
    } catch (err) {
      // ignore
    }
  };

  const fieldPark = createFieldPark();
  fieldPark.install(document, document.activeElement as Element | null);

  window.addEventListener("blur", releaseLostHold, true);
  try {
    document.addEventListener("visibilitychange", () => {
      if (visibilityLostHold(document.visibilityState)) releaseLostHold();
    });
  } catch (err) {
    // ignore
  }

  function setTyping(typing: boolean) {
    mirrorFlag("typing", typing);
    void send("syncTyping", { typing: typing });
  }

  // The keydown path is authoritative; this keeps the flag honest between
  // keystrokes. isTypingTarget walks shadow roots, so a closed-root field
  // resolves correctly.
  function syncTypingAttr() {
    setTyping(isTypingTarget(document.activeElement));
  }

  /* ==================== boot ==================== */

  // Warm the wasm core AND the bindings so the first leader press is already
  // synchronous (lazy loading on the first `;` was the visible delay).
  ensureCore()
    .then(() => {
      void leader.bindings().catch(() => {});
      if (!__DEV__) return;
      try {
        document.documentElement.setAttribute("data-lf-debug", "core-ok");
      } catch (e) {
        // ignore
      }
    })
    .catch((e) => {
      if (!__DEV__) return;
      dbg("content core init failed", (e && e.message) || String(e));
      try {
        document.documentElement.setAttribute("data-lf-debug", "core-failed");
      } catch (x) {
        // ignore
      }
    });

  /* ==================== DOM wiring ==================== */

  // The frame bridge, in the TOP document, installed before the DOM wiring so
  // the first broadcast happens with the state the listeners serve.
  const frameBridge = installFrameParent({
    win: window,
    own: () => ({
      leader: config.leader,
      // "Everything" = the states in which this document consumes arbitrary
      // keys, and in which a frame must hand them over.
      all: !!leader.active || leader.hasPending() || !!hints.active || !!hints.starting,
    }),
    dispatch: dispatchForwardedKey,
  });

  // A frame's key runs through the SAME dispatch path as a real keystroke: a
  // real event on this document, so one implementation answers "what does ;
  // mean here". `bubbles: false` — capture still reaches the window, but the
  // page's bubble listeners must not see a phantom keydown the user did not
  // type here.
  function dispatchForwardedKey(m: FrameKeyMessage): void {
    try {
      const ev = new KeyboardEvent(m.type === "keyup" ? "keyup" : "keydown", {
        key: m.key,
        shiftKey: !!m.shift,
        repeat: !!m.repeat,
        bubbles: false,
        cancelable: true,
        composed: false,
      });
      const target = (document.activeElement as Element | null) || document.documentElement;
      target.dispatchEvent(ev);
    } catch (e) {
      // A key that cannot be rebuilt is dropped, never thrown.
    }
  }

  installContentDom({
    onKeyDown,
    closePopup,
    hintsActive: () => hints.active,
    exitHints: () => hints.exit(),
    leaderActive: () => leader.active,
    hideLeader: () => leader.hide(),
    leaderHasPending: () => leader.hasPending(),
    cancelLeaderPending: () => leader.cancelPending(),
    syncTypingAttr,
    startHints: () => hints.start(),
    focusFirstInput,
    hintBadge: () => hints.enterBadge(),
    hintSnapshot: () => hints.snapshot(),
    pageReport: () => collectPageReport(scroll, hints),
    dispatchTrace: () => ({
      key: trace.key,
      active: trace.active,
      popup: trace.popup,
      dispatched: trace.dispatched,
      // Newest last, like the chrome helper's ring — read side by side.
      ring: ring.slice(),
    }),
    isDev: () => __DEV__,
    logError: (what, err) => dbg(what, (err && (err as Error).message) || String(err)),
    afterKey: (info) => {
      noteKey(info);
      frameBridge.broadcast();
      // The helper is told this document still holds the keyboard after
      // every key it answers (see reassertPresence).
      reassertPresence();
    },
  });
  // THE LAST LINE, DELIBERATELY: the document is now answering keys, so this
  // is the first moment "a content script owns this page" is true in the
  // sense the helper spends it on. The hold snapshot it restores is designed
  // to read late.
  void initializeHoldFromPresence();
})();
