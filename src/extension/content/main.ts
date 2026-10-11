// Content script entry: lazyfox standalone mode (chrome helper absent) and
// scroll keys / hints while the chrome helper is alive. All popups, the leader
// and its actions come from ../shared/* behind the ActionOps adapter
// (content/ops.ts); this file only owns config state, chrome-alive gating and
// the window-level key dispatch.

import { mergeConfig } from "../../shared/config";
import { ensureCore } from "../../shared/core";
import { blurTypingFocus, isTypingEvent, isTypingTarget } from "../../shared/dom";
import { dbg } from "../../shared/dev";
import { installContentDom } from "./contentdom";
import { LeaderController, isCancel } from "../../shared/leader";
import { idleSignal, type LeaderSignal } from "../../shared/leadersignal";
import { specToText } from "../../shared/keymap";
import {
  releaseHoldOnKeyup,
  releaseLostHold as releaseLostHoldOnBlur,
  shouldRestoreHold,
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
    // Taking the keyboard FOR the hints means handing it over first. This is one
    // half of the one-owner rule (the other half is the leader-key branch in
    // onKeyDown); without it a held `;f` left the leader armed underneath the
    // hint layer, and because a key the hints do not consume falls through to
    // the leader dispatcher, every hint letter ALSO ran a binding — `d` opened
    // Downloads, `g`/`l` navigated, `r` reloaded. That was the reported
    // "hints sometimes run my shortcuts", and it was intermittent only because
    // it depended on whether the leader was held.
    startHints: () => {
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
      void hints.start();
    },
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
    (spec) => toast("no binding for ;" + specToText(spec))
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
  // The identity of THIS document, for the lifetime of this script.
  //
  // The URL cannot do this job. `reportPresence` used to send only a URL, and
  // the chrome helper identified the report by it — so the first
  // `history.pushState` on any single-page app made the recorded URL stop
  // matching the tab's current one, and the helper concluded this document had
  // no content script for the rest of its life. It then claimed the keys and the
  // surfaces it should have deferred on, while the retraction guard dropped this
  // document's own pagehide for the same reason. A nonce is generated once, per
  // document, and compared only against the record it created.
  const docId =
    String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
  const reportPresence = (active: boolean) => {
    let href = "";
    try {
      href = location.href;
    } catch (e) {
      // ignore — an unreadable location simply reports no URL
    }
    return send("syncContent", { active, url: href, doc: docId });
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
    // BOUNDED IN TIME. The claim was written by a document that no longer
    // exists, and only a recently-made one can still be true — the whole point
    // of the restore is to survive the gap a navigation takes, not to arm a
    // leader for a key nobody is holding. A stale restore is the worst failure
    // in this file: the leader is marked held with no keyup left to release it,
    // so it never disarms and every subsequent key runs as a `;x` binding.
    if (!r || !shouldRestoreHold(!!r.hold, Number(r.holdAt) || 0, Date.now())) return;
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
  // report is not a durable answer. The helper keeps presence ON THE TAB, and
  // two things can still leave it without this document's entry while the
  // document is alive and answering keys: a late `pagehide` from the page this
  // one replaced (now filtered by the document nonce, see
  // keystate.noteContentPresent) and a background that was restarted. Neither
  // is followable by a retraction, and a content script that never speaks again
  // cannot correct the helper — which then claims the keys and paints its
  // overlay over this page's. (A THIRD cause used to be listed here: the
  // helper dropping every record above a closed tab, because records were kept
  // by strip position. Presence is keyed by the tab now, so closing a tab no
  // longer costs a live neighbour its answer.)
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

  // The dispatch trace, IN MEMORY — never in the document.
  //
  // This is the "last key the content script saw, and the state it dispatched
  // under" readout the e2e harness reads when a key did not do what a test
  // expected. It used to be three attributes on <html>, written on EVERY
  // keydown (and a fourth on every leader dispatch). Root-attribute writes
  // invalidate style and fire the page's own MutationObservers, so the product
  // paid for its own instrumentation on the one path where the cost is a
  // keystroke — on every page, for a reader that is not the user.
  //
  // It is a PULL now: the fields below are plain JS (a property write is free)
  // and `dispatchTrace()` hands them over when something asks — the dev-only
  // message handler in contentdom.ts. Same information, zero DOM cost, and
  // nothing on the page can observe the user's typing through it.
  const trace = { key: "", active: "?", popup: "0", dispatched: "" };

  // Clear every Lazyfox overlay state and give the focus back to the page.
  //
  // ONE function, called from the Escape/Ctrl+G cancel and from the unfocus
  // chord while a field has the caret. They started as one keystroke path, and
  // splitting the second key out must not let the two drift: "cancel" means the
  // same thing in both places — hints gone, capture dropped, leader hidden, the
  // scroll target back to automatic, and no field left focused that the user did
  // not ask to keep.
  function cancelOverlays(): void {
    if (hints.active || hints.starting) hints.exit();
    if (leader.hasPending()) leader.cancelPending();
    if (leader.active) leader.hide();
    // Return the scroll keys to the automatic target (document scroller on
    // ordinary pages) so a cycled sidebar can never trap them.
    if (scroll.isCustom()) scroll.reset();
    // Unfocus whatever holds focus (an input, a button, a link) so the page
    // returns to its default state. A FIELD is blurred through the deep helper:
    // a field inside a closed shadow root reports its HOST as activeElement, and
    // blurring the host — a custom element that is not focusable — leaves the
    // caret exactly where it was.
    if (isTypingTarget(document.activeElement)) {
      blurTypingFocus();
      return;
    }
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement) {
      try {
        (ae as HTMLElement).blur();
      } catch (err) {
        // ignore
      }
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (__DEV__) {
      trace.key = e.key;
      trace.active = leader ? (leader.active ? "1" : "0") : "?";
      trace.popup = currentPopup ? "1" : "0";
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
      if (e.key === config.leader) {
        // THE LEADER ALWAYS WINS OVER A HINT LAYER, explicitly. The hint
        // alphabet never contains the leader key, so this used to work by
        // falling through `handleKey`'s "not mine" answer — which is a
        // property of the DEFAULT hint chars and of a session that is still
        // answering at all. Saying it here makes it a rule instead of a
        // coincidence: the leader tears the layer down and falls through to
        // arm, so a hint layer can never make the leader key dead.
        hints.exit();
      } else if (isTypingEvent(e)) {
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
        // ONE OWNER AT A TIME.
        //
        // The leader and the hints must never both hold the keyboard, and this
        // branch is where that used to break: it did nothing, so a hint letter
        // fell through to the leader dispatcher below and ran a BINDING. That is
        // the reported "while hinting, typing `d` opens Downloads" — reachable
        // whenever the leader was still armed, which a held `;f` guaranteed
        // (sticky runs the action without hiding, see runOrStay).
        //
        // The state is now unrepresentable rather than merely unlikely: the
        // hints claim ownership when they start, and this is the reverse
        // transition — the leader taking the keyboard back means the hints stop.
        // Nothing is lost: `;K c` acts on the PAGE url, so it does not need the
        // hint target that this branch used to protect.
        hints.exit();
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
    // Focus is in a text field. A stale leader or one-shot capture must never
    // eat what the user is typing: pressing `;` on the page and then clicking
    // into a search box used to swallow the first character (and a stray `'`
    // re-armed the marker capture, so the next digit switched sessions).
    // Disarm both and let the key reach the field.
    //
    // THE TYPING GUARD COMES BEFORE THE CANCEL — deliberately, and it used to be
    // the other way round. Cancel blurs the focused element, so Escape while
    // typing used to take the caret out of the box the user was writing in: the
    // one key everybody presses to dismiss a stray suggestion became a keystroke
    // that destroyed their place. An edit in progress outranks every overlay
    // state, because there is nothing Lazyfox can be showing that justifies
    // interrupting it — which is still the rule for every OTHER key. See below
    // for the cancel itself, which is the one exception the guard cannot make:
    // "leave this field" is exactly what it used to be unable to express.
    if (isTypingEvent(e)) {
      // THE CANCEL, IN A FIELD: the same two keys, with the same one difference.
      //
      // Ctrl+G is the chord this codebase already teaches (isCancel), and until
      // recently it did NOTHING while the caret was in a field: this guard ran
      // first and simply returned, so the key a user reaches for to leave an
      // input was the key that could not. It now means "leave the field, cancel
      // Lazyfox, tell the page nothing", and it is consumed so a site with its
      // own Escape binding (a dialog with a form in it, a cookie wall, a player)
      // sees nothing and keeps its UI.
      //
      // Escape means the same thing AND lets the page act, because it is the key
      // every user already reaches for and "nothing happens here" reads as
      // broken rather than as safe. Being the master cancel is worth more than
      // protecting an edit nobody asked to protect: the caret is one click away
      // again, and the page's own Escape semantics are not Lazyfox's to deny.
      if (isCancel(e)) {
        // ESCAPE IS THE MASTER CANCEL HERE TOO, and it used to not be: while the
        // caret was in a field, Escape was passed straight through with the
        // overlays left standing, so the one key every user reaches for both
        // ways out was the only key that did nothing at all. It now clears
        // every Lazyfox surface exactly as the chord does — hints, leader,
        // capture, scroll target — and it still reaches the page, because that
        // is what Escape means on the web (a site closing its own menu, a
        // player leaving fullscreen).
        //
        // Ctrl+G is the difference the user gets to choose: the SAME cleanup,
        // consumed, so a page with its own Escape binding — the dialog with a
        // form in it — sees nothing and keeps its UI. Two keys, one meaning,
        // and the only disagreement is whether the page is told.
        cancelOverlays();
        if (e.key !== "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
      return;
    }
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
      cancelOverlays();
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
    // A HELD LEADER KEY IS NOT A CHORD — it is the OS restating one press.
    //
    // This is the same rule the chrome helper has always applied in
    // `armHeldLeader` ("a repeat carries no new intent"), and without it here a
    // HELD leader key was the single worst way to use the leader: the first
    // keydown arms it, and every auto-repeat that follows lands in the branch
    // below as a chord — `;` is not in the keymap, so each one is a MISS, i.e.
    // the panel repaints and a "no binding for ;;" toast is fired ~30 times a
    // second for as long as the key is down. The user sees the overlay flicker
    // and a message about a key they did not press, while the leader itself
    // looks unresponsive.
    //
    // Dropped BEFORE the capture is asked, too: a held `;` while `;W m` waits
    // for its digit must not be handed to that capture as if it were an answer
    // to it.
    if (e.repeat && e.key === config.leader && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (leader.hasPending()) {
      // A CAPTURE CAN DECLINE THE KEY, AND THE HOST HONOURS THAT.
      //
      // The armed capture is a sequence the user is in the middle of (`;W m`
      // then a digit), and its handler answers `false` for a key that is not
      // part of it — a letter, a leading zero, or anything with Ctrl/Alt/Meta
      // held. Every host discarded that answer and consumed the key anyway, so
      // the handler's own comment ("let the key through untouched") was a lie
      // and the keystroke vanished with nothing on screen to explain it: press
      // it again and maybe it works. Declining now means "not ours", and the
      // keystroke continues to the rest of this dispatcher and to the page,
      // exactly as if no capture had been armed.
      // `true` = taken: swallow it. `false` = declined, and the capture has
      // already disarmed itself, so this key falls THROUGH the rest of the
      // dispatcher exactly as if no capture had ever been armed — `;` arms the
      // leader, `j` scrolls, Ctrl+1 switches session, a modified key returns to
      // the page. Only the taken case consumes anything.
      if (leader.handlePending(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
    if (leader.active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.handleKey(e);
      if (__DEV__) trace.dispatched = e.key;
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
      //
      // The hints give the keyboard up here, which is the reverse of the
      // transition in startHints: the two surfaces are never armed at once, so
      // a key can never mean two things. See the owner rule in onKeyDown.
      if (hints.active || hints.starting) hints.exit();
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

  /* ==================== DOM wiring ==================== */

  // Every listener on window/document, plus the extension message port. Split
  // into contentdom.ts because these are rules about EVENTS, not about the
  // leader, the popups or the hints — so it takes their predicates, not the
  // modules themselves.
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
    }),
    isDev: () => __DEV__,
    logError: (what, err) => dbg(what, (err && (err as Error).message) || String(err)),
  });
})();