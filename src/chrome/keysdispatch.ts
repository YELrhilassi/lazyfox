// The chrome-level key dispatcher: one function that decides, for every
// keydown in the browser window, whether Lazyfox consumes it.
//
// Shared by the window capture listener and the #lfc=keys test channel (which
// drives the command center because geckodriver's BiDi input is rejected on
// moz-extension contexts). Returns whether the key was consumed — the capture
// listener then preventDefaults/stops propagation, and the channel skips
// dispatching to content.
//
// Ownership order (first match wins):
//   1. web pages (content script's territory) — declined
//   2. an open chrome popup (Esc closes, resize keys, popup-targeted keys)
//   3. an armed leader / one-shot capture
//   4. Esc blur on chrome-owned pages
//   5. typing (an editable holds the keys; narrow leader exceptions)
//   6. the command center in command mode / chrome scroll keys / the leader key

import { KeyGuard } from "../shared/keyguard";
import { LeaderController } from "../shared/leader";
import {
  blurFocusedElement,
  signalCommandCenterFind
} from "./commandcenterfocus";
import { chromeOwnsKeys, isAboutPage, isChromeUiFocus, isCommandCenterTab } from "./keystate";
import type { PopupHost } from "./popup";
import { createChromePageHints } from "./pagehints";
import type { TypingChannel } from "./typing";

export interface KeyDispatchDeps {
  win: Window;
  leader: () => LeaderController | null;
  popup: PopupHost;
  typing: TypingChannel;
  keyGuard: KeyGuard;
  leaderKey: () => string;
  // Config hotkeys (Ctrl/Alt/Meta chords → about: pages) and the session
  // marker jump, both implemented by the ops adapter.
  handleHotkeyCombo: (combo: string) => boolean;
  switchSessionByMarker: (marker: number) => void;
  handleScrollKeys: (win: Window, e: { key: string }) => boolean;
  // The leader-action table's own `f` handler (web-page hints), set by the
  // composition root after the leader actions are built (breaks the mutual
  // reference).
  runWebHints: () => void;
}

// The actor-forwarded key shape (see actor-parent.ts). Those keys can only
// come from pages the extension's content script cannot reach, so the
// "web pages belong to the content script" gate must not decline them.
export interface ActorKey {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

export function createChromeKeyDown(deps: KeyDispatchDeps) {
  const { win, popup, typing } = deps;
  const pageHints = createChromePageHints(win, deps.leader);
  const leader = () => deps.leader();

  // ;f is link-hints. Web pages run a content script that owns them; the
  // command-center home has no page links, so there it arms hint-PICK (each
  // grid tile gets a letter and the next key runs it); and on chrome-owned
  // pages with no content script (about:, error pages) the helper draws its
  // own hints.
  function runHintsAction(): void {
    const l = leader();
    if (!l) return;
    if (isCommandCenterTab(win)) {
      signalCommandCenterFind(win, l);
      return;
    }
    // chromeOwnsKeys() is true exactly where the content script does not run
    // (about:, extension pages) — provide hints locally there.
    if (chromeOwnsKeys(win)) {
      pageHints.show();
      return;
    }
    // Web pages: the content script (or the shared popup engine) owns hints.
    deps.runWebHints();
  }

  function chromeKeyDown(e: ActorKey, fromActor?: boolean): boolean {
    if (e.isComposing) return false;

    // Web pages are the content script's territory (its own leader, popups,
    // hints and typing guard). If Firefox forwards their keys to this chrome
    // window listener (some builds do), never consume them here. An
    // actor-forwarded key is the exception: the actor only speaks for pages
    // with no content script, so there is no other owner to defer to.
    if (!fromActor && !chromeOwnsKeys(win) && !popup.isOpen()) return false;

    // A chrome popup is open: Esc closes it first (before the page/window).
    if (popup.isOpen()) {
      if (e.key === "Escape") {
        if (popup.resizeOnKey(e as KeyboardEvent)) return true;
        // Let the popup consume Esc itself (e.g. the sessions popup cancels a
        // pending copy/move target picker) before closing it.
        if (popup.handleKey(e as KeyboardEvent)) return true;
        popup.close();
        return true;
      }
      if (popup.resizeOnKey(e as KeyboardEvent)) return true;
      // Confine the keyboard to the popup. A key whose target lies in the
      // popup (its input/rows) is left to the popup's own listener; a key
      // aimed anywhere else must not reach the browser chrome behind the
      // overlay. Channel-driven keys carry no target and are dispatched
      // straight to the popup input by the caller — leave them alone.
      const target = (e as { target?: EventTarget | null }).target;
      if (target == null) return false;
      if (popup.containsTarget(target)) return false;
      return true;
    }

    const l = leader();
    if (!l) return false;

    const typingNow = typing.focusedIsTyping(e as KeyboardEvent);
    const typingValue = typing.focusedTypingValue(e as KeyboardEvent);

    // The leader (or a one-shot capture) is armed: the next key is a binding —
    // but only while the user isn't composing text. A field HOLDING text means
    // typing wins: a stale leader/capture must disarm and the key must type.
    // An EMPTY focused field keeps the binding (the command-center home input
    // and an about: page's search box hold focus but no text).
    if (l.active || l.hasPending()) {
      if (
        typingNow &&
        !(typingValue === "" && (isCommandCenterTab(win) || isAboutPage(win))) &&
        !isChromeUiFocus(win, typing, e as KeyboardEvent)
      ) {
        if (l.active) l.hide();
        if (l.hasPending()) l.cancelPending();
        return false;
      }
      if (l.hasPending()) {
        l.handlePending(e.key);
        return true;
      }
      l.handleKey(e as KeyboardEvent);
      return true;
    }

    // Esc on chrome-owned pages blurs the focused element so the page returns
    // to a neutral state. NOT consumed: the page also receives Esc. The
    // command center owns its Esc, and web pages are the content script's.
    if (e.key === "Escape") {
      if (!isCommandCenterTab(win)) blurFocusedElement(win);
      return false;
    }

    // Typing in an editable: never intercept — the leader key types like any
    // other. The exceptions are an EMPTY focused field on a Lazyfox-owned
    // page (so `;` arms the leader without a click or Esc first), and the
    // browser's own URL bar sitting on an about:/error page (after a failed
    // navigation Firefox hands focus to the URL bar with typed text, and the
    // typing rule would otherwise swallow the leader key on the very page it
    // is supposed to rescue). Only the leader key is excepted there.
    if (typingNow) {
      if (
        e.key === deps.leaderKey() &&
        !e.ctrlKey && !e.altKey && !e.metaKey &&
        (typingValue === "" || isChromeUiFocus(win, typing, e as KeyboardEvent)) &&
        (isCommandCenterTab(win) || isAboutPage(win))
      ) {
        l.show();
        return true;
      }
      return false;
    }

    // The command center is Lazyfox's own page. In command mode (input
    // blurred) the leader key must arm here so the home-screen shortcuts
    // work; in insert mode the typing check above already let `;` through.
    const k = e.key;
    if (
      k === deps.leaderKey() &&
      !e.ctrlKey && !e.altKey && !e.metaKey &&
      isCommandCenterTab(win)
    ) {
      l.show();
      return true;
    }

    // Ctrl+1-9: hot-swap to the session with that marker (tmux-style).
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      deps.switchSessionByMarker(Number(e.key));
      return true;
    }

    if (deps.handleHotkeyCombo(keyCombo(e as KeyboardEvent))) return true;

    // Ctrl/Alt/Meta chords are never the leader key on their own.
    if (e.ctrlKey || e.altKey || e.metaKey) return false;

    // Vim scroll keys on chrome-owned pages; the command center grid owns its
    // own j/k/h/l navigation, so it is excluded.
    if (!isCommandCenterTab(win) && deps.handleScrollKeys(win, e)) return true;

    if (k === deps.leaderKey()) {
      l.show();
      return true;
    }
    return false;
  }

  function keyCombo(e: KeyboardEvent): string {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    let key = e.key;
    if (key === " ") key = "Space";
    return mods.join("+") + (mods.length ? "+" : "") + key;
  }

  return {
    chromeKeyDown,
    runHintsAction,
    clearPageHints: pageHints.clear,
    setWebHints(fn: () => void) {
      deps.runWebHints = fn;
    },
  };
}
