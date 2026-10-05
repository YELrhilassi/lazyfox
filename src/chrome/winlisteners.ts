// The chrome window's DOM listeners.
//
// Split out of main.ts. The composition root's job is to decide WHAT the
// modules are and hand them to each other; these listeners are the wiring of
// the chrome document itself — keydown/keypress/keyup, blur, TabClose,
// TabSelect — and every one of them is a rule about an event rather than a
// piece of the product. They were the last ~120 lines of main.ts that were not
// composition, which made "open main.ts to add a feature" mean "read the event
// rules first".
//
// Each listener is registered exactly once, at install time, and the only
// mutable state it closes over is what the deps hand it. Everything it consults
// is late-bound by reference, because the modules involved (leader, status,
// channel) are created after this runs.

import type { KeyGuard } from "../shared/keyguard";
import { chromeOwnsKeys, chromeOwnsSurfaces, forgetContentFrom } from "./keystate";
import type { ChromeEnv } from "./env";

export interface WinListenersDeps {
  env: ChromeEnv;
  keyGuard: KeyGuard;
  // The capture-phase keydown dispatcher. Returns whether it consumed the key.
  chromeKeyDown(e: KeyboardEvent): boolean;
  // The popup host, for "is a popup open" and "does this event target it".
  popup: {
    isOpen(): boolean;
    close(): void;
    containsTarget(t: any): boolean;
  };
  // Whether focus is currently in a text field (the quick-find suppression).
  typing: { focusedIsTyping(e: Event): boolean; reset(): void };
  // The chrome leader, late-bound: it does not exist yet at install time.
  leader(): { active: boolean; hide(): void } | null;
  // Recompute the status bar after a tab switch.
  status: { compute(): void };
  // Is this still the focused OS window? Injected because the answer lives on
  // env.services.focus, and a blur fires on every tab switch — deciding on the
  // next tick, after the switch settles, is what makes it an ACTIVATION check
  // rather than a focus check.
  isWindowActive(): boolean;
  // setTimeout from the injected environment, so this module never touches the
  // ambient global.
  setTimeout(fn: () => void, ms: number): void;
}

export function installWinListeners(deps: WinListenersDeps): void {
  const win = deps.env.window as any;

  win.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (deps.chromeKeyDown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      // Record every key the chrome helper consumed so its keypress/keyup
      // tail is swallowed too — keydown's preventDefault does not cancel them.
      if (e.defaultPrevented) deps.keyGuard.consume(e);
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
    const escapePopup = deps.popup.isOpen() && !deps.popup.containsTarget(e.target);
    const tail = deps.keyGuard.ownsTail(e);
    if (escapePopup || tail) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  win.addEventListener("keypress", onKeyTail, true);
  win.addEventListener("keyup", onKeyTail, true);

  // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
  // and `'`, so it fires even after the leader has consumed the `keydown`.
  // Suppress it outside text fields so `;/` opens the find bar deliberately.
  // Also skip when a popup is open — the popup input must receive these
  // characters. Never suppress on web pages (the content script does that).
  win.addEventListener(
    "keypress",
    (e: KeyboardEvent) => {
      if (e.key !== "/" && e.key !== "'") return;
      if (!deps.typing.focusedIsTyping(e) && !deps.popup.isOpen() && chromeOwnsKeys(win)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  win.addEventListener("blur", () => {
    // A blur fires on every tab switch, so close only on a real deactivation
    // of the OS window — checked on the next tick, after the switch settles.
    deps.typing.reset();
    deps.keyGuard.clear();
    deps.setTimeout(() => {
      try {
        if (deps.isWindowActive()) return;
      } catch {
        // fall through and close
      }
      if (deps.popup.isOpen()) deps.popup.close();
      const leader = deps.leader();
      if (leader && leader.active) leader.hide();
    }, 0);
  });

  try {
    // Presence is cached by tab POSITION, and removing a tab slides every tab
    // above it down one slot. Without this the map drifts by one per close, and
    // a stale "a content script is here" would be attributed to whatever page
    // inherited the slot — the helper would then defer on a page it should own,
    // which is the dead keyboard again, one tab-closing session later.
    win.gBrowser.tabContainer.addEventListener("TabClose", (e: Event) => {
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
    win.gBrowser.tabContainer.addEventListener("TabSelect", () => {
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
        if (!chromeOwnsSurfaces(win)) {
          const leader = deps.leader();
          if (leader) leader.hide();
          if (deps.popup.isOpen()) deps.popup.close();
        }
      } catch (e) {
        // ignore — a mid-collapse read must not break the tab switch
      }
      deps.status.compute();
    });
  } catch {
    // ignore
  }
}