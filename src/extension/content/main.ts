// Content script entry: lazyfox standalone mode (chrome helper absent) and
// scroll keys / hints while the chrome helper is alive. All popups, the leader
// and its actions come from ../shared/* behind the ActionOps adapter
// (content/ops.ts); this file only owns config state, chrome-alive gating and
// the window-level key dispatch.

import { mergeConfig } from "../../shared/config";
import { ensureCore } from "../../shared/core";
import { isTypingTarget } from "../../shared/dom";
import { dbg } from "../../shared/dev";
import { KeyGuard } from "../../shared/keyguard";
import { LeaderController, isCancel } from "../../shared/leader";
import { openNavPopup } from "../../shared/popups/nav";
import { openPopup as overlayOpenPopup, toast, type PopupCtl } from "../../shared/overlay";
import { mirrorFlag } from "../../shared/observability";
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
  leader = new LeaderController(
    (k) => runLeaderAction(leaderActions, k),
    () => config.whichKey !== false,
    // The chrome helper owns the single window-level status bar and draws the
    // far-right leader indicator from the per-tab leader state it caches from
    // the background's leaderState push. Report every arm/disarm — with the
    // which-key overlay disabled that indicator is the only visible leader
    // sign.
    () => {
      setLeaderAttr(leader.active);
      void send("syncLeader", { active: leader.active });
    }
  );
  // Clear any stale leader state this tab carried from a previous page (the
  // leader starts disarmed on every fresh load).
  void send("syncLeader", { active: false });
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
    void send("syncContent", { active, url: href });
  };
  reportPresence(true);
  // ...and report OUT, so presence cannot outlive this document. `pagehide`
  // rather than `unload`: it is the one both a real navigation and a bfcache
  // eviction fire, and `unload` is unreliable on mobile and in some unload
  // paths. A missed report is self-limiting anyway — the helper discards any
  // answer whose URL no longer matches the tab.
  try {
    window.addEventListener("pagehide", () => reportPresence(false), { capture: true });
  } catch (e) {
    // ignore — presence is re-derived on the next load regardless
  }
  // Two-key sequences for web pages (chrome helper registers its own table).
  // The nav-stack popup is a PLAIN binding on the shifted keys — ;G / ;L open
  // it right away, ;g / ;l stay back/forward. See the note in chrome/main.ts:
  // it was briefly a ;G-then-k sequence, which made the advertised binding do
  // nothing at all.
  leaderActions["G"] = () => openNavPopup(ctx);
  leaderActions["L"] = () => openNavPopup(ctx);
  // ;' = quick switch: capture the next digit and jump to the marked session.
  leaderActions["'"] = () =>
    leader.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        contentOps.switchSessionByMarker(Number(k));
        return true;
      }
      return false;
    }, 3000);
  // ;+1-9 = move tab N into the current split view.
  leaderActions["+"] =
    () =>
      leader.armPending((k) => {
        if (/^[1-9]$/.test(k)) {
          contentOps.splitAddTabByIndex(Number(k));
          return true;
        }
        return false;
      }, 3000);
  // ;F / ;B = cycle the scroll target among the page's scroll regions (the
  // document scroller, then each pane/sidebar largest-first). The plain scroll
  // keys keep working on whatever is focused, and cycling back to "window"
  // restores the automatic behaviour. Content-only: chrome-owned pages have no
  // page scroll regions to cycle.
  leaderActions["F"] = () => scroll.cycle(1);
  leaderActions["B"] = () => scroll.cycle(-1);

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
    if (hints.active) {
      if (isTypingTarget(e.target as Element)) {
        // The user focused a text field mid-hints: the hint batch must not
        // eat what they type there. Drop the hints and let the key through.
        hints.exit();
      } else if (e.key === "Escape") {
        // Esc exits the hints (clearing every hint's state) but is NOT
        // consumed here — it falls through to the shared Esc handling below,
        // which also blurs focus and lets the page close its own overlays.
        hints.exit();
      } else {
        e.preventDefault();
        e.stopImmediatePropagation();
        hints.handleKey(e);
        return;
      }
    }
    // NOTE: the chrome helper announces itself as "alive" and was meant to own
    // the leader key everywhere, but current Firefox never forwards keys typed
    // into remote web content to the chrome window's listener (frame scripts
    // are inert for remote content too). So on web pages the content script
    // MUST own the leader, popups, hints, Esc and scroll keys itself — the
    // chrome helper only receives keys on in-process pages (about:, the
    // command center), where this content script does not run.
    if (e.key === "Escape") {
      // Esc is the universal cancel key. Clear every Lazyfox overlay state so
      // the next invocation starts fresh: link hints (typed prefix, items,
      // pool), the leader and any one-shot capture.
      if (hints.active) hints.exit();
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.handlePending("Escape");
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
      // Deliberately NOT consumed: the page must also receive Esc so it can
      // close its own popups, info bars, cookie banners and fullscreen video.
      // preventDefault/stopImmediatePropagation here used to keep those open.
      return;
    }
    // Focus is in a text field. A stale leader or one-shot capture must never
    // eat what the user is typing: pressing `;` on the page and then clicking
    // into a search box used to swallow the first character (and a stray `'`
    // re-armed the marker capture, so the next digit switched sessions).
    // Disarm both and let the key reach the field.
    if (isTypingTarget(e.target as Element)) {
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
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
      if (!isTypingTarget(e.target as Element)) {
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
        if (e.key !== config.leader) return;
        leader.sticky = false;
      } catch (err) {
        // ignore
      }
    },
    true
  );

  function syncTypingAttr() {
    const ae = document.activeElement;
    const typing = isTypingTarget(ae);
    mirrorFlag("typing", typing);
    void send("syncTyping", { typing: typing });
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
    return !!currentPopup || hints.active || leader.active || leader.hasPending();
  }

  const keyGuard = new KeyGuard();

  window.addEventListener(
    "keydown",
    (e) => {
      // A page-specific exception (a hostile handler, an unexpected element)
      // must not take down key handling for the whole session: catch it, keep
      // the listener, and let the next key try again.
      try {
        onKeyDown(e);
      } catch (err) {
        if (__DEV__) dbg("keydown handler threw", (err && (err as Error).message) || String(err));
      }
      // Remember every key we consumed so its keypress/keyup tail is swallowed
      // too (see keyguard.ts). Without this the keystroke a user types into a
      // Lazyfox popup still reaches page scripts that listen on keypress/keyup
      // — the input leaking to the page behind the popup.
      if (e.defaultPrevented) keyGuard.consume(e);
    },
    true
  );

  // keypress/keyup do NOT obey the keydown's preventDefault, so swallowing
  // keydown alone is not enough. Swallow the tail of every key we consumed,
  // and everything at all while an overlay owns the keyboard, so nothing the
  // user types into Lazyfox can leak to the page behind it.
  function onKeyTail(e: KeyboardEvent): void {
    // Always reconcile the guard (never short-circuit): a key we consumed once
    // must have its record cleared by the tail that follows, or a later,
    // legitimate press of the same key while typing would be swallowed too.
    const tail = keyGuard.ownsTail(e);
    if (overlayOwnsKeys() || tail) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
    // and `'`, so it fires even after the leader has consumed the `keydown`.
    // Suppress it outside text fields so `;/` opens the Lazyfox find popup,
    // not the native find bar.
    if (e.type === "keypress" && (e.key === "/" || e.key === "'")) {
      if (!isTypingTarget(e.target as Element)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }
  window.addEventListener("keypress", onKeyTail, true);
  window.addEventListener("keyup", onKeyTail, true);


  window.addEventListener("blur", () => {
    // The window lost focus mid-key: no keyup is coming for anything we
    // consumed, so drop the records instead of letting them swallow a later
    // press of the same key.
    keyGuard.clear();
    if (currentPopup) closePopup();
    if (hints.active) hints.exit();
    if (leader.active) leader.hide();
  });
  document.addEventListener("focusin", (e) => {
    syncTypingAttr();
    // A stale leader or one-shot capture must never eat what the user types.
    // Disarm when focus moves to an editable element (e.g. clicking into a
    // search box after pressing `;` on the page).
    if (isTypingTarget(e.target as Element)) {
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
    }
  });
  document.addEventListener("focusout", syncTypingAttr);
  document.addEventListener("focus", syncTypingAttr);

  browser.runtime.onMessage.addListener(
    (msg: { action?: string }) => {
      if (msg && msg.action === "startHints") {
        void hints.start();
        return Promise.resolve({ ok: true });
      }
      if (msg && msg.action === "focusFirstInput") {
        focusFirstInput();
        return Promise.resolve({ ok: true });
      }
      if (msg && msg.action === "hintBadge") {
        return Promise.resolve({ ok: true, id: "amb", ...hints.enterBadge() });
      }
      if (msg && msg.action === "pageReport") {
        // The diagnostics page asks the ACTIVE tab's content script for a live
        // self-report. A rejection here is meaningful too (no content script on
        // this page), so the background turns it into "report: null".
        return collectPageReport(scroll, hints)
          .then((report) => ({ ok: true, report: report }))
          .catch(() => ({ ok: false, report: null }));
      }
      return undefined;
    }
  );
})();
