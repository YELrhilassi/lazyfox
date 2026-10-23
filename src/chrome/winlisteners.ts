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
import { chromeOwnsKeys } from "./keystate";
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
  // Release a physical hold when the selected tab changes; the chrome window
  // itself may stay focused, so a window blur is not guaranteed.
  releaseLeaderHoldOnTabSwitch(): void;
  // Recompute the status bar after a tab switch.
  status: { compute(): void };
  // Re-check the which-key mirror a split pane asked the window to paint: a
  // selection that moved to a tab which is neither that pane nor its split
  // sister leaves the mirror over a tab it does not describe.
  revalidatePagePanel?(): void;
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
      // Drop a record left over from an earlier press of this key: its tail
      // never arrived, so it would be spent by THIS press's keypress and eat a
      // character the user typed. See keyguard.beginPress.
      deps.keyGuard.beginPress(e);
      // The same rule the content script follows, for the same reason: only a
      // key THIS dispatch cut off has a tail that is ours to swallow (see
      // keyguard.consumeIfNewlyPrevented). Another chrome script's own gesture
      // has already had its keydown prevented, and its keypress still belongs
      // to whatever the user is typing into.
      const preventedBefore = e.defaultPrevented;
      if (deps.chromeKeyDown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      deps.keyGuard.consumeIfNewlyPrevented(e, preventedBefore, e.defaultPrevented);
    },
    true
  );

  // keypress/keyup do NOT obey the keydown's preventDefault, so a key the
  // helper consumed would still surface as a browser shortcut behind the
  // overlay. Swallow the tail of every CONSUMED key — and only that.
  //
  // There used to be a second clause here: swallow anything aimed outside an
  // open popup while it owns the keyboard. It was removed for the same reason
  // and in the same words as the identical clause in the content script's
  // listener (see content/contentdom.ts): the popup's ownership is STATE, not
  // an event, so any moment it was set — a popup whose teardown had not run, a
  // resize host, a dispatcher that consumed the keydown and then declined the
  // keystroke — turned every following `keypress` into a prevented one while
  // `keydown` still passed through. Firefox inserts text on the keypress
  // default action, so the visible result was "the letter does not print",
  // selectively, with no error anywhere, and pressing the key again was the
  // only way to make it appear. Text a user is typing must never be gated on
  // an overlay's bookkeeping: the KeyGuard record, which is written from the
  // keydown that was actually consumed, is the only honest reason to swallow a
  // tail, and every path that consumes a keydown already preventDefaults it.
  function onKeyTail(e: KeyboardEvent): void {
    // Always reconcile the guard (never short-circuit): a key we consumed once
    // must have its record cleared by the tail that follows, or a later,
    // legitimate press of the same key while typing would be swallowed too.
    const tail = deps.keyGuard.ownsTail(e);
    if (tail) {
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

  // THERE IS NO `TabClose` PRESENCE LISTENER ANY MORE, and its absence is the
  // fix rather than an omission. Presence is stored ON THE TAB ELEMENT
  // (keystate.noteContentPresent), so a closed tab's record dies with the tab
  // and no later tab can inherit it — which is the same guarantee the listener
  // used to give, without the cost it used to charge: it deleted every record at
  // or after the closed index, so every live document above the close lost its
  // answer and the helper claimed keys it should have deferred on until that
  // page happened to re-report. The other two strip changes (an INSERTION before
  // a reporting tab, and a MOVE, which is a permutation no event describes) were
  // never compensated at all and are now unrepresentable for the same reason.

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
      //
      // UNCONDITIONAL, and it used to be gated on `!chromeOwnsSurfaces(win)`.
      // That gate made the teardown depend on an answer this very module cannot
      // verify (see keystate.ts: presence is inferred, and an inferred "yes"
      // expires on the first pushState), so on an SPA the helper kept a lit
      // overlay for as long as the window lived — two which-key panels, one of
      // them a ghost. Standing down costs nothing when this window DOES own the
      // tab: the next keypress re-arms the leader, exactly as if the panel had
      // never been painted, and a popup is a surface the user opened here, on
      // this tab, which the switch closes on purpose. There is no state this
      // can lose that a keypress cannot restore.
      try {
        const leader = deps.leader();
        if (leader) leader.hide();
        deps.releaseLeaderHoldOnTabSwitch();
        if (deps.popup.isOpen()) deps.popup.close();
        // ...and the frame script's typing latch, which describes a focused
        // element in the tab that was JUST LEFT. It is reset on window blur and
        // never otherwise, so without this a caret in tab A's field keeps the
        // helper believing tab B is typing — and on a chrome-owned tab that
        // belief is the difference between the leader key working and the whole
        // keyboard being declined. A tab switch is exactly the moment the
        // answer changes; the frame script only speaks on focus changes, so
        // nothing would correct it on the way back in either.
        deps.typing.reset();
      } catch (e) {
        // ignore — a mid-collapse read must not break the tab switch
      }
      try {
        if (deps.revalidatePagePanel) deps.revalidatePagePanel();
      } catch (e) {
        // a mirror that fails to come down must not fail the tab switch
      }
      deps.status.compute();
    });
  } catch {
    // ignore
  }
}