// The content script's DOM wiring: keys, focus, blur, and the message listener.
//
// Split out of content/main.ts. That file is the content script's composition
// root, and this is the part of it that is wiring rather than composition: it
// registers listeners on `window` and `document` and forwards them to the
// modules above. Leaving it inline meant "open main.ts to add a focus
// behaviour" started with ninety lines of listeners.
//
// It holds no state of its own beyond the KeyGuard, and every rule in it is a
// rule about an EVENT rather than about the leader, the popups or the hints —
// which is why the deps are the handful of predicates those modules expose
// rather than the modules themselves.

import { KeyGuard } from "../../shared/keyguard";
import { isTypingEvent } from "../../shared/dom";

export interface ContentDomDeps {
  // The single keydown dispatcher. A throw inside it must not kill the
  // listener, so the wrapper catches and keeps going.
  onKeyDown(e: KeyboardEvent): void;
  /** True while any Lazyfox surface owns the keyboard. */
  overlayOwnsKeys(): boolean;
  /** Close whatever popup is open, if any. */
  closePopup(): void;
  /** True while link hints are showing. */
  hintsActive(): boolean;
  /** Leave link-hint mode. */
  exitHints(): void;
  /** True while the leader is armed; `hide()` disarms it without consuming. */
  leaderActive(): boolean;
  hideLeader(): void;
  /** An armed one-shot capture that would eat the next key. */
  leaderHasPending(): boolean;
  cancelLeaderPending(): void;
  /** Publish the current typing state to the page mirror and the background. */
  syncTypingAttr(): void;
  /** Ask the extension to start link hints. */
  startHints(): Promise<unknown>;
  // The `;K` link actions, answered by the page because the page is the only
  // place a link under the pointer exists. The chrome helper relays them here.
  copyLink(): void;
  editLink(): void;
  /** Focus the page's first text input (the `;f` flow). */
  focusFirstInput(): void;
  /** The hint badge state, for the `hintBadge` message. */
  hintBadge(): Record<string, unknown>;
  /** The diagnostics page's self-report for this tab. */
  pageReport(): Promise<any>;
  /** Only log a thrown handler when the dev build is on. */
  isDev(): boolean;
  logError(what: string, err: unknown): void;
}

export function installContentDom(deps: ContentDomDeps): void {
  const keyGuard = new KeyGuard();

  window.addEventListener(
    "keydown",
    (e) => {
      // A page-specific exception (a hostile handler, an unexpected element)
      // must not take down key handling for the whole session: catch it, keep
      // the listener, and let the next key try again.
      try {
        deps.onKeyDown(e);
      } catch (err) {
        if (deps.isDev()) deps.logError("keydown handler threw", err);
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
    if (deps.overlayOwnsKeys() || tail) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
    // and `'`, so it fires even after the leader has consumed the `keydown`.
    // Suppress it outside text fields so `;/` opens the Lazyfox find popup,
    // not the native find bar.
    if (e.type === "keypress" && (e.key === "/" || e.key === "'")) {
      if (!isTypingEvent(e)) {
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
    deps.closePopup();
    if (deps.hintsActive()) deps.exitHints();
    if (deps.leaderActive()) deps.hideLeader();
  });

  document.addEventListener("focusin", (e) => {
    deps.syncTypingAttr();
    // A stale leader or one-shot capture must never eat what the user types.
    // Disarm when focus moves to an editable element (e.g. clicking into a
    // search box after pressing `;` on the page).
    if (isTypingEvent(e)) {
      if (deps.leaderActive()) deps.hideLeader();
      if (deps.leaderHasPending()) deps.cancelLeaderPending();
    }
  });
  document.addEventListener("focusout", deps.syncTypingAttr);
  document.addEventListener("focus", deps.syncTypingAttr);

  browser.runtime.onMessage.addListener(
    (msg: { action?: string }) => {
      if (msg && msg.action === "startHints") {
        void deps.startHints();
        return Promise.resolve({ ok: true });
      }
      if (msg && msg.action === "copyLink") {
        deps.copyLink();
        return true;
      }
      if (msg && msg.action === "editLink") {
        deps.editLink();
        return true;
      }
      if (msg && msg.action === "focusFirstInput") {
        deps.focusFirstInput();
        return Promise.resolve({ ok: true });
      }
      if (msg && msg.action === "hintBadge") {
        return Promise.resolve({ ok: true, id: "amb", ...deps.hintBadge() });
      }
      if (msg && msg.action === "pageReport") {
        // The diagnostics page asks the ACTIVE tab's content script for a live
        // self-report. A rejection here is meaningful too (no content script on
        // this page), so the background turns it into "report: null".
        return deps
          .pageReport()
          .then((report) => ({ ok: true, report: report }))
          .catch(() => ({ ok: false, report: null }));
      }
      return undefined;
    }
  );
}