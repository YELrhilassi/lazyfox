// Content script entry: lazyfox standalone mode (chrome helper absent) and
// scroll keys / hints while the chrome helper is alive. All popups, the leader
// and its actions come from ../shared/* behind the ActionOps adapter
// (content/ops.ts); this file only owns config state, chrome-alive gating and
// the window-level key dispatch.

import { mergeConfig } from "../../shared/config";
import { ensureCore } from "../../shared/core";
import { isTypingTarget } from "../../shared/dom";
import { dbg } from "../../shared/dev";
import { LeaderController } from "../../shared/leader";
import { openPopup as overlayOpenPopup, toast, type PopupCtl } from "../../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../../shared/popups";
import { send } from "../../shared/protocol";
import type { Config } from "../../shared/types";
import { createLinkHints, focusFirstInput } from "./hints";
import { createContentOps, type ContentPopupShell } from "./ops";

(function () {
  "use strict";

  try {
    if (window.top !== window) return;
  } catch (e) {
    // ignore
  }

  let config: Config = mergeConfig(undefined);

  function loadConfig() {
    void browser.storage.local.get("config").then(
      (r: { config?: Partial<Config> }) => {
        if (r && r.config) config = mergeConfig(r.config);
      },
      () => {}
    );
  }
  loadConfig();

  // Live config: re-read it when the options page writes it (drives scroll
  // keys, hint chars, open-in-new-tab). The status bar is NOT the content
  // script's to draw — the chrome helper owns the single window-level bar, and
  // standalone extension mode shows no bar at all.
  browser.storage.onChanged.addListener(
    (changes: { config?: { newValue?: Partial<Config> } }, area: string) => {
      if (area === "local" && changes.config) {
        config = mergeConfig(changes.config.newValue || {});
      }
    }
  );

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
  leader = new LeaderController(
    (k) => runLeaderAction(leaderActions, k),
    () => config.whichKey !== false,
    // The chrome helper owns the single window-level status bar and draws its
    // pulsing LEADER chevron from the per-tab leader state it caches from the
    // background's leaderState push. Report every arm/disarm so the chevron
    // tracks the content-script leader on web pages (where the content
    // script owns the leader key and the chrome helper's own leader never
    // arms).
    () => void send("syncLeader", { active: leader.active })
  );
  // Clear any stale leader state this tab carried from a previous page (the
  // leader starts disarmed on every fresh load).
  void send("syncLeader", { active: false });
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
  leaderActions["+"] = () =>
    leader.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        contentOps.splitAddTabByIndex(Number(k));
        return true;
      }
      return false;
    }, 3000);


  /* ==================== scroll keys ==================== */

  let lastG = false;
  function handleScrollKeys(e: KeyboardEvent): boolean {
    if (config.scrollKeys === false) return false;
    const k = e.key;
    if (k === "j") {
      window.scrollBy(0, 60);
      return true;
    }
    if (k === "k") {
      window.scrollBy(0, -60);
      return true;
    }
    if (k === "d") {
      window.scrollBy(0, Math.max(120, window.innerHeight * 0.5));
      return true;
    }
    if (k === "u") {
      window.scrollBy(0, -Math.max(120, window.innerHeight * 0.5));
      return true;
    }
    if (k === "G") {
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
      return true;
    }
    if (k === "g") {
      if (lastG) {
        window.scrollTo(0, 0);
        lastG = false;
      } else {
        lastG = true;
        setTimeout(() => {
          lastG = false;
        }, 600);
      }
      return true;
    }
    return false;
  }

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
      // The popup's own onKey gets first refusal (the sessions popup consumes
      // Esc to cancel a pending copy/move or step back to the left pane);
      // only when it declines does Esc close the popup.
      try {
        if (currentPopup.onKey && currentPopup.onKey(e)) return;
      } catch (err) {
        closePopup();
        return;
      }
      if (e.key === "Escape") closePopup();
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
      leader.show();
    }
  }

  function syncTypingAttr() {
    const ae = document.activeElement;
    const typing = isTypingTarget(ae);
    if (typing) document.documentElement.setAttribute("data-lf-typing", "1");
    else document.documentElement.removeAttribute("data-lf-typing");
    void send("syncTyping", { typing: typing });
  }

  /* ==================== boot ==================== */

  // Warm the wasm core so the first leader press is already synchronous.
  ensureCore()
    .then(() => {
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

  window.addEventListener("keydown", onKeyDown, true);
  // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
  // and `'`, so it fires even after the leader has consumed the `keydown`
  // (the keydown preventDefault does not cancel the keypress). Suppress it
  // outside text fields so `;/` opens the Lazyfox find popup, not the native
  // find bar.
  window.addEventListener(
    "keypress",
    (e) => {
      if (e.key !== "/" && e.key !== "'") return;
      if (!isTypingTarget(e.target as Element)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );


  window.addEventListener("blur", () => {
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
      return undefined;
    }
  );
})();
