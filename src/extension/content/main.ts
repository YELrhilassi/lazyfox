// Content script entry: lazyfox standalone mode (chrome helper absent) and
// scroll keys / hints while the chrome helper is alive. All popups, the leader
// and its actions come from ../shared/* behind the ActionOps adapter
// (content/ops.ts); this file only owns config state, chrome-alive gating and
// the window-level key dispatch.

import { mergeConfig } from "../../shared/config";
import { ensureCore } from "../../shared/core";
import { isTypingEvent, isTypingTarget } from "../../shared/dom";
import { dbg } from "../../shared/dev";
import { installContentDom } from "./contentdom";
import { LeaderController, isCancel } from "../../shared/leader";
import { idleSignal, type LeaderSignal } from "../../shared/leadersignal";
import {
  releaseHoldOnKeyup,
  releaseLostHold as releaseLostHoldOnBlur,
  visibilityLostHold,
} from "../../shared/holdrelease";
import { openNavPopup } from "../../shared/popups/nav";
import { openPopup as overlayOpenPopup, toast, type PopupCtl } from "../../shared/overlay";
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
import type { ContentPopupShell } from "./find";

(function () {
  "use strict";

  try {
    if (window.top !== window) return;
  } catch (e) {
    // ignore
  }

  // Handshake for the browser-level helper: its content-process bridge keys
  // off this attribute to tell "a Lazyfox content script owns this page" from
  // the pages it must cover itself (about:/error pages, restricted sites).
  // Set before anything else can throw so it is always visible.
  try {
    document.documentElement.setAttribute("data-lf-content", "1");
  } catch (e) {
    // ignore
  }

  let config: Config = mergeConfig(undefined);

  function loadConfig() {
    try {
      void readKey("config", vConfig, {}).then((c) => {
        config = mergeConfig(c);
      });
    } catch (e) {
      // A storage hiccup must never take the keyboard handling down with it.
      if (__DEV__) dbg("config load failed", (e && (e as Error).message) || String(e));
    }
  }
  loadConfig();

  // Live config: re-read it when the options page writes it (drives scroll
  // keys, hint chars, open-in-new-tab). The status bar is NOT the content
  // script's to draw — the chrome helper owns the single window-level bar, and
  // standalone extension mode shows no bar at all.
  try {
    browser.storage.onChanged.addListener(
      (changes: { config?: { newValue?: Partial<Config> } }, area: string) => {
        if (area === "local" && changes.config) {
          config = mergeConfig(changes.config.newValue || {});
        }
      }
    );
  } catch (e) {
    // ignore — live config is a convenience, not a requirement
  }

  /* ===================== link hints ===================== */

  const hints = createLinkHints(() => config.hintChars);

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
      const ctl = overlayOpenPopup(html, (root) => build(root), () => {
        currentPopup = null;
      });
      currentPopup = ctl;
      return ctl;
    },
    close: closePopup,
  };

  /* ===================== leader + shared popups ===================== */

  const contentOps = createContentOps({
    shell: shell,
    config: () => config,
    startHints: () => void hints.start(),
    focusFirstInput: focusFirstInput,
    // Live find count: relay it to the chrome helper's window-level bar (the
    // only bar — this content script never draws one) so "N/M" follows the
    // find widget on web pages. count -1 = the widget closed (hide the bar
    // segment); 0 = a query with no matches (red 0); >0 = live cur/count.
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
    // A sub-key that takes a NUMBER (move tab N into the split) needs the
    // leader's one-shot capture; the leader controller owns it.
    armDigits: (apply, timeoutMs, expect) => {
      leader.armPending(apply, { timeoutMs: timeoutMs || 3000, expect });
    },
    manualText: true,
  };
  const leaderActions = makeLeaderActions(ctx);
  // Mirror the leader's armed state onto <html>, the same way the find
  // (data-lf-find), yank (data-lf-yank) and hint (data-lf-hints) overlays
  // already do. Without it the leader is invisible from outside the page: the
  // which-key overlay lives in a CLOSED shadow root, so nothing can read
  // whether it is up, and its host element persists after hide() (only the
  // "on" class is dropped). The attribute is the one honest, page-level answer
  // to "is the leader armed right now" — and it is what lets the e2e harness
  // wait for a dispatch to finish instead of guessing with a timer.
  const setLeaderAttr = (armed: boolean) => mirrorFlag("leader", armed);
  // What the armed capture wants next, mirrored in-page alongside
  // data-lf-leader.
  //
  // The obvious place to read this is the chrome bar, and that is where a user
  // reads it — but the bar lives in another process and the only way in is a
  // multi-hop round trip, while a digit capture lives for THREE seconds. A
  // read that can take as long as the state it is trying to observe cannot
  // test it. Mirroring it here makes the fact reachable from the same realm
  // that owns it, which is the same move as the other data-lf-* mirrors: the
  // attribute is a fact about the product, not a convenience for one test.
  const setLeaderExpect = (want: string) => mirror("lead-expect", want || null);
  // ONE value for the whole readout, produced by the controller and forwarded
  // unchanged: in-page mirror, the wire to the background, the bar. Nothing here
  // re-assembles it, so nothing here can half-report it.
  const readout = (): LeaderSignal => leader.signal();
  leader = new LeaderController(
    (action) => runLeaderAction(leaderActions, action),
    () => config.whichKey !== false,
    // The chrome helper owns the single window-level status bar and draws the
    // far-right leader indicator from the per-tab leader state it caches from
    // the background's leaderState push. Report every arm/disarm — with the
    // which-key overlay disabled that indicator is the only visible leader
    // sign.
    () => {
      const sig = readout();
      setLeaderAttr(sig.armed);
      setLeaderExpect(sig.expect);
      // The chord and the expected-next key travel with the arm flag. Without
      // them the chrome helper's bar — the only bar a web page has — could say
      // "a leader is armed" and nothing more, for the whole sequence.
      void send("syncLeader", { signal: sig });
    },
    // A chord the keymap does not know is REPORTED, never swallowed in
    // silence. The leader owns the keyboard while it is armed, so the key is
    // consumed either way — but the user is told which chord went nowhere, which
    // is the difference between a keymap they can learn and one they learn by
    // pressing things twice to see what sticks.
    (spec) => toast("no binding for ;" + spec)
  );
  // Clear any stale leader state this tab carried from a previous page (the
  // leader starts disarmed on every fresh load).
  void send("syncLeader", { signal: idleSignal() });
  // Report IN. The chrome helper has to know whether this page is covered by a
  // content script before it may claim or yield the keys and the screen, and
  // it cannot find out for itself: `selectedBrowser.contentDocument` is null
  // for every out-of-process tab, so reading this page's own beacon from the
  // parent always fails. Without this push the helper judged ownership by URL
  // alone, which is the dead-keyboard bug — during a slow load, and on the
  // error page Firefox shows for a bad host, nothing owned the keys at all.
  //
  // The URL travels with the report so the helper can throw the answer away
  // the moment this tab navigates, rather than trusting it until reload.
  const reportPresence = (active: boolean) => {
    let href = "";
    try {
      href = location.href;
    } catch (e) {
      // ignore — an unreadable location simply reports no URL
    }
    return send("syncContent", { active, url: href });
  };
  // THE HELD LEADER, ACROSS DOCUMENTS.
  //
  // `leader.sticky` is a claim about a key's lifecycle, but it lived in the
  // one document that received the keydown — so it evaporated exactly when the
  // user was relying on it. Hold `;`, press `x`: the tab closes, focus lands
  // on a different tab, and that tab's content script is a different object
  // with `sticky === false`. The second `x` was then a literal character typed
  // into a page. `;g`/`;l` failed the same way, because navigating builds a
  // new document too.
  //
  // So the hold is published to the background (a per-tab session value, the
  // same store syncTyping uses precisely because it outlives the script) and
  // read back on boot. The restored leader is ARMED as well as held: the whole
  // point is that the user does not press `;` a second time.
  //
  // The keyup still arrives — key events go to the FOCUSED document, which is
  // this one — so the restored hold is released normally, and blur/visibility
  // still release a lost one.
  const publishHold = (hold: boolean): void => {
    void send("syncHold", { hold });
  };
  void reportPresence(true).then((r) => {
    if (!r || !r.hold) return;
    leader.sticky = true;
    leader.show();
  });
  // ...and report OUT, so presence cannot outlive this document. `pagehide`
  // rather than `unload`: it is the one both a real navigation and a bfcache
  // eviction fire, and `unload` is unreliable on mobile and in some unload
  // paths. A missed report is self-limiting anyway — the helper discards any
  // answer whose URL no longer matches the tab.
  try {
    window.addEventListener("pagehide", () => void reportPresence(false), { capture: true });
  } catch (e) {
    // ignore — presence is re-derived on the next load regardless
  }
  // ...and assert it again whenever this document comes back, because ONE
  // report is not a durable answer. The helper keeps presence in a Map keyed by
  // tab, and the map has three ways to lose this document's entry while the
  // document is still alive and answering keys: a late `pagehide` from the page
  // it replaced (now filtered by URL, see keystate.noteContentPresent), a
  // forgetContentFrom when a tab above it closes, and a background that was
  // restarted. None of those is followable by a retraction, and a content
  // script that never speaks again cannot correct the helper — which then
  // claims the keys and paints its overlay over this page's.
  //
  // `pageshow` fires on every commit AND on a bfcache restore, i.e. exactly the
  // moments this document starts answering keys again, and it costs one message
  // per page life. Re-announcing is idempotent on the helper side (same index,
  // same URL).
  try {
    window.addEventListener("pageshow", () => void reportPresence(true), { capture: true });
  } catch (e) {
    // ignore — the initial report already covered the normal case
  }
  // HOST ACTIONS. Four actions need an object only this host has, so they are
  // filled in here rather than in the shared table — and they are NAMED, not
  // keyed, because the keymap that routes them is in Go and the coverage test
  // reads this list to tell "a host's job" apart from "nobody implemented
  // this".
  //
  //   backStack / forwardStack  ;G / ;L open the nav-stack popup. They are
  //         plain bindings on the SHIFTED keys, and that is exactly why they
  //         are unambiguous: `;g` and `;l` are Back and Forward, `;G` and `;L`
  //         are the stacks. The old system made this depend on a case-folding
  //         rule and a "a plain binding beats a head" rule, and it shipped
  //         advertised-but-dead more than once.
  leaderActions["backStack"] = () => openNavPopup(ctx);
  leaderActions["forwardStack"] = () => openNavPopup(ctx);
  // ;F / ;B = cycle the scroll target among the page's scroll regions (the
  // document scroller, then each pane/sidebar largest-first). The plain scroll
  // keys keep working on whatever is focused, and cycling back to "window"
  // restores the automatic behaviour. Content-only: chrome-owned pages have no
  // page scroll regions to cycle.
  leaderActions["scrollRegionNext"] = () => scroll.cycle(1);
  leaderActions["scrollRegionPrev"] = () => scroll.cycle(-1);

  /* ==================== scroll keys ==================== */

  // The scroll target: the document scroller by default, an inner pane when the
  // document cannot scroll (ChatGPT-style shells), or whichever region the user
  // cycled to with ;F / ;B (sidebars and secondary panes).
  const scroll = createScrollController();
  const handleScrollKeys = createScrollKeys(scroll, () => config);

  /* ==================== key dispatch ==================== */

  function onKeyDown(e: KeyboardEvent) {
    if (__DEV__) {
      // Dev-only trace: the last key the content script saw and the state it
      // dispatched under (page realm reads these attributes in the BiDi suite).
      try {
        const d = document.documentElement;
        d.setAttribute("data-lf-lastkey", e.key);
        d.setAttribute("data-lf-active", leader ? (leader.active ? "1" : "0") : "?");
        d.setAttribute("data-lf-popup", currentPopup ? "1" : "0");
      } catch (x) {
        // ignore
      }
    }
    if (e.isComposing) return;
    if (currentPopup) {
      e.preventDefault();
      e.stopImmediatePropagation();
      // The popup's own onKey gets first refusal. This is NOT optional: the
      // find popup consumes Esc to leave yank mode while KEEPING the widget
      // open, and the sessions popup uses it to cancel a pending copy/move or
      // step back a pane. Handling the cancel before onKey took those away and
      // closed the whole popup instead — so onKey always runs first, and the
      // cancel is only the fallback for popups that decline it.
      try {
        if (currentPopup.onKey && currentPopup.onKey(e)) return;
      } catch (err) {
        // Closing is the right recovery — a popup whose key handler throws
        // cannot be driven and must not stay on screen swallowing keys. But
        // closing SILENTLY is how a popup that throws on every keystroke can
        // look like "the key did nothing": there is no trace, and the failure
        // is attributed to whatever the user was trying to do. Say so, in the
        // dev console the e2e harness audits, and nowhere else.
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
      // Ctrl+G is the second cancel. Esc alone is not enough: it is the most
      // contested key on the web, so a site that binds it (closing its own
      // cookie banner, a video player, a mega-menu) and a Lazyfox popup open
      // at the same time means the two fight over one keystroke and the user
      // cannot tell which one they just dismissed. Ctrl+G is the universal
      // abort (emacs' abort-prefix, vim's Ctrl+[), it is a chord so no page
      // can receive it as text, and it sits far from anything a site binds.
      // It also works with the leader still held, which is how you back out of
      // a sequence without giving up the key.
      if (isCancel(e)) closePopup();
      return;
    }
    if (hints.active || hints.starting) {
      if (isTypingEvent(e)) {
        // The user focused a text field mid-hints: the hint batch must not
        // eat what they type there. Drop the hints and let the key through.
        hints.exit();
      } else if (e.key === "Escape") {
        // Esc exits the hints (clearing every hint's state) but is NOT
        // consumed here — it falls through to the shared Esc handling below,
        // which also blurs focus and lets the page close its own overlays.
        //
        // `starting` is in the condition on purpose. `hints.start()` walks the
        // document and then awaits the core, so between the `;f` keypress and
        // the batch appearing there is a window where `active` is still false.
        // Gating on `active` alone meant an Escape in that window cancelled
        // nothing at all: the hosts skipped exit(), nothing bumped the
        // session, and the batch finished building AFTER the user had asked
        // for it to stop — leaving a hint layer on screen that the Escape they
        // had already pressed did not dismiss.
        hints.exit();
      } else if (!hints.active) {
        // Starting, but not yet taking keys: the batch is still being built
        // and no hint character means anything yet, so let the key fall
        // through to the leader/popups rather than swallowing it.
      } else if (leader.active) {
        // The LEADER takes precedence over the hints. The hint layer is a
        // keyboard trap otherwise: it owned every key on the page, so while it
        // was open not one Lazyfox binding could be pressed — and `;K c`, whose
        // whole job is to act on the link the hints are pointed at, was
        // unreachable from the state it was designed for.
        //
        // It keeps running underneath. Pressing `;` does not exit it, so the
        // hint target `;K c`/`;K e` act on is still the one on screen; only the
        // keyboard moves. Esc still drops the hints outright, below.
      } else {
        // Only swallow what the hints actually handled. This branch used to
        // preventDefault unconditionally, which meant `;` — the leader key, not
        // a hint character — vanished into a layer that had no use for it, and
        // the leader could never be armed from a hinted page.
        if (hints.handleKey(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        // Not consumed: fall through and let the rest of the handler decide,
        // exactly as it would if the hints had never been open.
      }
    }
    // NOTE: the chrome helper announces itself as "alive" and was meant to own
    // the leader key everywhere, but current Firefox never forwards keys typed
    // into remote web content to the chrome window's listener (frame scripts
    // are inert for remote content too). So on web pages the content script
    // MUST own the leader, popups, hints, Esc and scroll keys itself — the
    // chrome helper only receives keys on in-process pages (about:, the
    // command center), where this content script does not run.
    if (isCancel(e)) {
      // The universal cancel key — Escape, or Ctrl+G for pages that own Escape
      // themselves. Clear every Lazyfox overlay state so the next invocation
      // starts fresh: link hints (typed prefix, items, pool), the leader and
      // any one-shot capture.
      //
      // ONE press, for the same reason the chrome host does it in one: a
      // category is an armed capture sitting on top of an armed leader, and
      // handing the Escape to the capture's sub-key table (which has no Escape
      // row) spent the capture and left the leader standing, so the menu stayed
      // up until a second press. `cancelPending` is the difference — it drops
      // the capture WITHOUT running it, which is what "cancel" means; the old
      // call ran the capture with the string "Escape", i.e. it pressed a key
      // on the user's behalf to say they wanted to press none.
      const cancelChord = e.key !== "Escape";
      if (hints.active || hints.starting) hints.exit();
      if (leader.hasPending()) leader.cancelPending();
      if (leader.active) leader.hide();
      // Return the scroll keys to the automatic target (document scroller on
      // ordinary pages) so a cycled sidebar can never trap them.
      if (scroll.isCustom()) scroll.reset();
      // Unfocus whatever element holds focus (an input, a button, a link) so
      // the page returns to its default state.
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) {
        try {
          (ae as HTMLElement).blur();
        } catch (err) {
          // ignore
        }
      }
      // Esc is deliberately NOT consumed: the page must also receive it so it
      // can close its own popups, info bars, cookie banners and fullscreen
      // video.
      //
      // Ctrl+G IS consumed. It exists precisely because a page that binds Esc
      // fights Lazyfox for it, and a page cannot receive Ctrl+G as text anyway —
      // so the chord is ours alone and nothing downstream needs it.
      if (cancelChord) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    // Focus is in a text field. A stale leader or one-shot capture must never
    // eat what the user is typing: pressing `;` on the page and then clicking
    // into a search box used to swallow the first character (and a stray `'`
    // re-armed the marker capture, so the next digit switched sessions).
    // Disarm both and let the key reach the field.
    if (isTypingEvent(e)) {
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
      return;
    }
    if (leader.hasPending()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.handlePending(e);
      return;
    }
    if (leader.active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.handleKey(e);
      if (__DEV__) {
        try {
          document.documentElement.setAttribute("data-lf-dispatched", e.key);
        } catch (x) {
          // ignore
        }
      }
      return;
    }
    // Ctrl+1-9: hot-swap to the session with that marker (tmux-style). Skips
    // text fields so Ctrl+1 inside an input is untouched.
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      if (!isTypingEvent(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        contentOps.switchSessionByMarker(Number(e.key));
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (handleScrollKeys(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === config.leader) {
      e.preventDefault();
      e.stopImmediatePropagation();
      // Auto-repeat is the whole reason a held leader used to misbehave: the
      // OS re-fires keydown several times a second, and each one re-armed the
      // leader, so holding it to run two actions in a row tore the sequence
      // apart between them. A repeated leader keydown carries no new intent,
      // so it is dropped entirely.
      if (e.repeat) return;
      // Held down: bindings run and the leader stays armed, so `;` then
      // back/forward (or close-tab twice) costs one keystroke per action.
      leader.sticky = true;
      publishHold(true);
      leader.show();
    }
  }

  // Releasing the leader clears the HOLD, not the leader itself.
  //
  // This distinction is the whole trick, and getting it wrong breaks the
  // feature it was meant to add: a tap is keydown *and* keyup, so hiding on
  // release disarms the leader instantly and `;` then a binding stops
  // working at all. Releasing must therefore leave the leader armed exactly
  // as it always has been after a tap.
  //
  // What changes is only that the leader is no longer STICKY: the next
  // binding runs and disarms as usual, instead of chaining.
  window.addEventListener(
    "keyup",
    (e) => {
      try {
        if (releaseHoldOnKeyup(leader, config.leader, e.key)) publishHold(false);
      } catch (err) {
        // ignore
      }
    },
    true
  );

  // A keyup can be LOST, and the hold must not outlive the page's attention.
  //
  // Press `;`, then switch tabs, windows or applications before letting go: the
  // release is delivered wherever focus ended up, so this document never sees
  // it and the leader stays marked as physically held. The user comes back to a
  // lit indicator, a leader that never disarms, and a page whose next
  // keystrokes are eaten as bindings instead of reaching the document. Hiding
  // the tab does the same thing, and so does minimizing the window.
  //
  // Only the hold is cleared — the leader stays armed exactly as a released tap
  // leaves it, because losing focus is not the user changing their mind about
  // the sequence. Idempotent, and a no-op unless a hold is actually
  // outstanding, so it can run on every visibility change.
  const releaseLostHold = (): void => {
    try {
      if (releaseLostHoldOnBlur(leader)) publishHold(false);
    } catch (err) {
      // ignore
    }
  };
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

  // From focus, on the way in. The keydown path is the authoritative one (it
  // sees the event, not just the focus), but this keeps the flag honest
  // between keystrokes — and `isTypingTarget` walks shadow roots, so a field
  // inside a CLOSED root resolves correctly here too.
  function syncTypingAttr() {
    setTyping(isTypingTarget(document.activeElement));
  }

  /* ==================== boot ==================== */

  // Warm the wasm core AND the which-key bindings so the first leader press
  // is already synchronous (loading the binding table lazily on the first
  // `;` was the visible activation delay on web pages).
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

  // True while any Lazyfox surface owns the keyboard: a popup (including the
  // find widget and the resize panel), the leader bar, an armed one-shot
  // capture, or live link hints.
  function overlayOwnsKeys(): boolean {
    return !!currentPopup || hints.active || hints.starting || leader.active || leader.hasPending();
  }

  /* ==================== DOM wiring ==================== */

  // Every listener on window/document, plus the extension message port. Split
  // into contentdom.ts because these are rules about EVENTS, not about the
  // leader, the popups or the hints — so it takes their predicates, not the
  // modules themselves.
  installContentDom({
    onKeyDown,
    overlayOwnsKeys,
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
    pageReport: () => collectPageReport(scroll, hints),
    isDev: () => __DEV__,
    logError: (what, err) => dbg(what, (err && (err as Error).message) || String(err)),
  });
})();