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
import { LeaderController, isCancel } from "../shared/leader";
import {
  blurFocusedElement,
  dispatchToCCPage,
  focusCCBody,
  signalCommandCenterFind
} from "./commandcenterfocus";
import { chromeOwnsKeys, isAboutPage, isChromeUiFocus, isCommandCenterTab } from "./keystate";
import type { ChromeEnv, ChromeWindow } from "./env";
import type { PopupHost } from "./popup";
import { createChromePageHints } from "./pagehints";
import type { TypingChannel } from "./typing";

export interface KeyDispatchDeps {
  // The chrome window, as a parameter rather than the ambient global, so this
  // module — the whole ownership order below — can be driven in Node with a
  // fake window. See src/chrome/env.ts.
  win: ChromeWindow;
  // The seam itself, for collaborators that take it whole (page hints reads
  // env.services). Passed rather than derived from `win` so the fake env a
  // test builds is the same object every collaborator sees.
  env: ChromeEnv;
  leader: () => LeaderController | null;
  popup: PopupHost;
  typing: TypingChannel;
  keyGuard: KeyGuard;
  leaderKey: () => string;
  // Config hotkeys (Ctrl/Alt/Meta chords → about: pages) and the session
  // marker jump, both implemented by the ops adapter.
  handleHotkeyCombo: (combo: string) => boolean;
  switchSessionByMarker: (marker: number) => void;
  handleScrollKeys: (win: ChromeWindow, e: { key: string }) => boolean;
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
  const pageHints = createChromePageHints(deps.env, win, deps.leader);
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

  // `fromActor` and `noKeyup` are DIFFERENT facts and must not be conflated.
  //
  // `fromActor` is about OWNERSHIP: the key was forwarded from the content
  // process for a page that has no content script, so deferring to the page is
  // not an option. The `#lfc=keys` channel is not an actor in that sense — it
  // drives the real selection, which may well be a page whose content script
  // owns its keys, and claiming ownership there would make one keystroke
  // handled twice.
  //
  // `noKeyup` is about the key's LIFECYCLE: nothing will deliver a matching
  // keyup, so the key must be treated as a tap and never as a hold. Both
  // synthetic paths need it (the actor bridge and the `#lfc=keys` test
  // channel), and getting it wrong on either one leaves the leader marked as
  // PHYSICALLY HELD with nothing left to release it — see armHeldLeader.
  function chromeKeyDown(e: ActorKey, fromActor?: boolean, noKeyup?: boolean): boolean {
    if (e.isComposing) return false;

    // LAZYFOX'S OWN PAGE OWNS ITS OWN KEYS (see keystate.chromeOwnsKeys).
    //
    // The command center runs the same key engine a web page's content script
    // does, so this helper must not claim its keys as well — that is what made a
    // key run twice while the tab was in-process, and what made `;f` behave
    // differently from one new tab to the next. Three cases arrive here, and
    // each has exactly one right answer:
    //
    //   * SYNTHETIC (the #lfc=keys channel, or the window actor): the page never
    //     saw it, so forward it into the page's document and let the page act.
    //     That is also the only key path a test has, because WebDriver cannot
    //     focus a moz-extension document at all.
    //   * REAL, with focus in the chrome UI (the hidden URL bar Firefox parks
    //     focus in on a fresh tab): the page cannot see it either. The honest
    //     fix is to put focus back into the page so the NEXT key lands in the
    //     grid — never to run a binding from this realm while the page believes
    //     it owns the keyboard.
    //   * REAL, with focus in the page: the page's own listener already ran. Do
    //     nothing (returning false leaves the event exactly as the page left
    //     it).
    if (isCommandCenterTab(win) && !popup.isOpen()) {
      if (fromActor || noKeyup) {
        // The modifiers travel with it: the page's own typing guard and its
        // Ctrl/Alt pairs read them, and a forwarded Ctrl+Enter that arrived as
        // a bare Enter would run the wrong action.
        dispatchToCCPage(win, e.key, e);
        return true;
      }
      if (!isChromeUiFocus(win, typing, e as KeyboardEvent)) return false;
      if (e.key === deps.leaderKey() && !e.ctrlKey && !e.altKey && !e.metaKey) {
        focusCCBody(win);
      }
      return false;
    }

    // Web pages are the content script's territory (its own leader, popups,
    // hints and typing guard). If Firefox forwards their keys to this chrome
    // window listener (some builds do), never consume them here. An
    // actor-forwarded key is the exception: the actor only speaks for pages
    // with no content script, so there is no other owner to defer to.
    if (!fromActor && !chromeOwnsKeys(win) && !popup.isOpen()) return false;

    // A chrome popup is open: Esc closes it first (before the page/window),
    // and so does Ctrl+G — the shared predicate, so the chrome popup and the
    // content-script popup can never disagree about what dismisses them.
    if (popup.isOpen()) {
      if (isCancel(e)) {
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
    // but not while the user is typing.
    //
    // TYPING WINS. A field that holds TEXT always wins, and so does any field in
    // the page itself — including an EMPTY one, which is where this used to go
    // wrong: the empty-field exception rendered the whole page as "keeps the
    // binding", so arm the leader (one `;`), click into any of about:
    // preferences' empty inputs, type, and the first character ran a command
    // instead of appearing in the box. That is exactly "the shortcuts fire while
    // I am typing in an input field". The browser's own chrome UI keeps its old
    // behaviour (an empty URL bar is where a sequence continues after a failed
    // navigation), and the only other exception is one key wide: the LEADER KEY
    // in an empty field on a Lazyfox-owned page, so `;` still arms without a
    // click or an Escape first.
    if (l.active || l.hasPending()) {
      // ONE cancel ends the WHOLE chain.
      //
      // A category is a capture AND an armed leader at the same time (the head
      // arms the capture, the leader stays up behind it), and the capture is
      // consulted first. So Escape used to be handed to the category's sub-key
      // table, which has no Escape row: the capture was spent, the leader
      // stayed armed, and the second Escape is what finally dismissed it.
      // Escaping a two-key sequence therefore cost two presses, and from the
      // user's side `;W` then Esc looked like the key did nothing at all.
      //
      // The chord and the menu it opened are one user action, so they end in one
      // keystroke — and Ctrl+G is the same cancel, which is why this uses the
      // shared predicate rather than testing for Escape alone. Ctrl+G is the
      // one that works even on pages that bind Escape themselves.
      if (isCancel(e)) {
        l.cancelPending();
        l.hide();
        return true;
      }
      const chromeUiFocus = isChromeUiFocus(win, typing, e as KeyboardEvent);
      const leaderKeyPress =
        e.key === deps.leaderKey() && !e.ctrlKey && !e.altKey && !e.metaKey;
      const emptyLazyfoxField =
        typingValue === "" && (isCommandCenterTab(win) || isAboutPage(win));
      // "The user is writing something." A field with text, or a field in the
      // page rather than in the browser's chrome UI.
      const typingWins = typingNow && (!chromeUiFocus || typingValue !== "");
      if (typingWins && !(leaderKeyPress && emptyLazyfoxField)) {
        if (l.active) l.hide();
        if (l.hasPending()) l.cancelPending();
        return false;
      }
      if (
        typingNow &&
        leaderKeyPress &&
        (emptyLazyfoxField || (chromeUiFocus && typingValue === ""))
      ) {
        // The leader key in the one field where it is still a chord. Treat it as
        // a fresh press (re-arm, so holding `;` carries the sequence across) and
        // consume it — never hand it to an armed capture as if it were a
        // sub-key, which is what made `;` after `;W` do something arbitrary.
        if (armHeldLeader(l, e, noKeyup)) return true;
      }
      if (l.hasPending()) {
        l.handlePending(e);
        return true;
      }
      // `handleKey` reports whether it CONSUMED the key, and that answer is
      // honoured. It used to be discarded here and in every other host, which
      // meant a key the leader declined — a bare modifier press, a chord with
      // no binding — was swallowed with nothing on screen saying so. The user
      // pressed it again, because the first press had visibly done nothing.
      return l.handleKey(e);
    }

    // Esc on chrome-owned pages blurs the focused element so the page returns
    // to a neutral state. NOT consumed: the page also receives Esc. The
    // command center owns its Esc, and web pages are the content script's.
    if (e.key === "Escape") {
      if (!isCommandCenterTab(win)) blurFocusedElement(win);
      return false;
    }

    // Ctrl+G backs out of an armed leader without giving up the key. Escape
    // cannot: it is deliberately NOT consumed for a chrome page, because the
    // page itself receives it (see the comment above), so there was no way to
    // cancel a sequence that also worked while the leader was held.
    if (
      l.active &&
      e.ctrlKey && !e.altKey && !e.metaKey &&
      (e.key === "g" || e.key === "G")
    ) {
      l.hide();
      if (l.hasPending()) l.cancelPending();
      return true;
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
        if (armHeldLeader(l, e, noKeyup)) return true;
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
      if (armHeldLeader(l, e, noKeyup)) return true;
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
      if (armHeldLeader(l, e, noKeyup)) return true;
    }
    return false;
  }

  // Arm the leader for a HELD leader key, and drop auto-repeat.
  //
  // A key that stays down re-fires keydown at the OS repeat rate. Treating
  // each of those as a fresh leader press tore down and re-armed the leader
  // several times a second, so holding the leader to run two actions in a row
  // destroyed the sequence between them. A repeat carries no new intent, so
  // it is swallowed here — still consumed, so the character never leaks into
  // the page or the URL bar.
  //
  // A real (non-repeat) press marks the leader as held, so bindings run and
  // stay armed until the key comes up (see LeaderController.sticky). The
  // matching keyup lives in main.ts, next to the leader's own construction.
  //
  // A key with NO keyup to match is deliberately NOT sticky, and this is the
  // one place that decision is made. Two callers can produce one: the
  // content-process actor bridge, and the `#lfc=keys` channel the e2e harness
  // synthesizes through. Both dispatch a bare keydown; neither can ever deliver
  // the release. Marking either of them as held leaves the leader stuck
  // chained FOREVER — the indicator stays lit, every binding leaves the leader
  // up instead of disarming it, and the next keystroke in that window is
  // swallowed as a leader key rather than doing what the user asked. That is
  // not a cosmetic stuck badge: the keyboard goes dead until something else
  // happens to clear the flag.
  function armHeldLeader(
    l: { sticky: boolean; show(): void },
    e: unknown,
    noKeyup?: boolean
  ): boolean {
    // `unknown` because the two callers are not the same shape: a real DOM
    // KeyboardEvent carries `repeat`, while a synthesized ActorKey does not
    // have that field at all (and is never a repeat — see below).
    if (!!(e as { repeat?: boolean }).repeat) return true;
    l.sticky = !noKeyup;
    l.show();
    return true;
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
