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
import { noteHoldAlive } from "../shared/holdrelease";
import {
  blurFocusedElement,
  chromeFieldHoldsUserText,
  commandCenterPageReady,
  dispatchToCCPage,
  focusCCBody,
  focusSelectedContent,
  selectedContentHasKeyboard,
  signalCommandCenterFind
} from "./commandcenterfocus";
import {
  chromeOwnsKeys,
  commandCenterDocumentPresent,
  isAboutPage,
  isChromeUiFocus,
  isCommandCenterTab,
} from "./keystate";
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
  // Called on every fresh leader press AND on every auto-repeat of the leader
  // key, i.e. on the evidence that the key is still physically down. The
  // composition root wires it to the hold watchdog (shared/holdrelease.ts),
  // which stands a hold down once nothing is holding it any more.
  onLeaderHeld?: () => void;
  // End an outstanding HOLD because the user CANCELLED the gesture (Esc or
  // Ctrl+G) rather than because the key came up.
  //
  // A callback and not something this module does itself: `l.hide()` clears the
  // overlay, but the host is the party that also OWNS the published claim (the
  // per-tab hold the background keeps so a hold survives a navigation), and a
  // hold that ends without publishing its release is a hold the next page
  // dutifully restores — an armed leader for a key nobody is holding.
  cancelLeaderHold: () => void;
  // Stop the watchdog when this tab loses focus or changes ownership. The same
  // host that starts it owns cancellation, because its release may need to be
  // published across a navigation.
  releaseLeaderHoldOnLostFocus: () => void;
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

  // "This tab's document is Lazyfox's own page", asked of the DOCUMENT as well
  // as of the URL.
  //
  // The two halves are not the same question and the difference is reachable:
  // `isCommandCenterTab` reads currentURI, which during a provisional navigation
  // is already the URL being loaded while the document on screen is still the
  // command center. Keyed on the URL alone, every branch below then treated that
  // tab as a web page — so a key aimed at it (the `#lfc=keys` channel's, or the
  // actor's) was declined as "the content script owns it" and forwarded to a
  // document that did not exist yet, while the document that DID exist and was
  // still answering keys got nothing. See keystate.commandCenterDocumentPresent.
  const ccOwnsTab = (): boolean => isCommandCenterTab(win) || commandCenterDocumentPresent(win);

  // `nsIFocusManager.FLAG_NOSCROLL`, read from the host when it is there: focus
  // without dragging the page to the focused element.
  const focusFlags = (): number => {
    try {
      const v = deps.env.Ci && deps.env.Ci.nsIFocusManager && deps.env.Ci.nsIFocusManager.FLAG_NOSCROLL;
      return typeof v === "number" ? v : 0;
    } catch {
      return 0;
    }
  };

  // ;f is link-hints. Web pages run a content script that owns them; the
  // command-center home has no page links, so there it arms hint-PICK (each
  // grid tile gets a letter and the next key runs it); and on chrome-owned
  // pages with no content script (about:, error pages) the helper draws its
  // own hints.
  function runHintsAction(): void {
    const l = leader();
    if (!l) return;
    if (ccOwnsTab()) {
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

  // The leader key with no modifier on it — the one keystroke that must never
  // vanish, and the only key the command-center fallback below answers itself.
  // Written once because all four call sites mean exactly this.
  function isLeaderKeyPress(e: ActorKey): boolean {
    return e.key === deps.leaderKey() && !e.ctrlKey && !e.altKey && !e.metaKey;
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
  // THE DISPATCH TRACE, dev-only and read on demand.
  //
  // "Press `;o` on a chrome-owned page and nothing happens" has exactly one
  // honest diagnosis path: which branch consumed the key. Its other answers all
  // look identical from outside — the leader arms, the overlay lights, the
  // reply says the helper owns the keys, and no action ran — so a bug report
  // about it costs an afternoon without this.
  //
  // It is a RING IN MEMORY, not a mirror: nothing is written per key except one
  // array push, no attribute is painted, and the whole thing is compiled out of
  // release builds (every call site is behind __DEV__, which esbuild folds to
  // false so the body is tree-shaken). The e2e harness reads it from the chrome
  // state reply (`keyTrace`), which is the same pull-not-push rule the content
  // script's dispatch trace follows.
  // `__DEV__` is a build-time literal (globals.d.ts) and esbuild folds it, so
  // this constant is `false` in a release build and the trace bodies below are
  // eliminated. It is read DEFENSIVELY because this module is also driven
  // directly by the Node checks (scripts/test/keyhold.test.ts), where the
  // literal does not exist and a bare reference is a ReferenceError.
  const DEV = typeof __DEV__ !== "undefined" && __DEV__;
  const TRACE_LIMIT = 24;
  const trace: Array<Record<string, unknown>> = [];
  function noteTrace(entry: Record<string, unknown>): void {
    if (!DEV) return;
    trace.push(entry);
    if (trace.length > TRACE_LIMIT) trace.shift();
  }

  /** The trace, newest last. Empty in a release build (nothing is recorded). */
  function dispatchTrace(): Array<Record<string, unknown>> {
    return trace.slice();
  }

  // The branch the current key is in. Assigned at each decision point below and
  // read once, after the dispatch returns — so the labels cannot change what the
  // dispatcher does, which is the property that matters for an instrument that
  // ships inside the key path.
  let br = "entry";

  function chromeKeyDown(e: ActorKey, fromActor?: boolean, noKeyup?: boolean): boolean {
    br = "entry";
    const consumed = chromeKeyDownInner(e, fromActor, noKeyup);
    if (DEV) {
      let leaderState = 0;
      try {
        const l = leader();
        leaderState = l && l.hasPending() ? 2 : l && l.active ? 1 : 0;
      } catch (err) {
        leaderState = -1;
      }
      noteTrace({
        k: e.key,
        br: br,
        c: consumed,
        actor: !!fromActor,
        // Whether the key came with no keyup (a synthetic tap) — the flag that
        // decides tap-vs-hold, and the one that has bitten before.
        tap: !!noKeyup,
        cc: ccOwnsTab(),
        owns: chromeOwnsKeys(win),
        l: leaderState,
      });
    }
    return consumed;
  }

  function chromeKeyDownInner(e: ActorKey, fromActor?: boolean, noKeyup?: boolean): boolean {
    if (e.isComposing) {
      br = "composing";
      return false;
    }

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
    if (ccOwnsTab() && !popup.isOpen()) {
      if (fromActor || noKeyup) {
        // THE PAGE HAS TO BE ABLE TO ANSWER, and the helper can now tell.
        //
        // Forwarding is right — this page runs the same key engine a content
        // script does — but it was UNCONDITIONAL, and a command-center document
        // that has not finished loading its script yet (a tab caught mid-
        // redirect, i.e. a fresh new tab for a moment, or one whose reload is in
        // flight) has the URL and the static markup and none of the engine.
        // A key handed to that page was consumed by nobody: pressing `;` there
        // left the keyboard dead and only a navigation brought it back, which is
        // the "nothing responds, not even the leader key" report.
        //
        // The page declares whether it answers keys (`data-lf-engine`, set where
        // its listener is installed), so when it does not, the LEADER KEY is
        // answered here instead of vanishing. Every other key is forwarded
        // exactly as before — this is a rescue for the one key that has to work
        // on every tab, not a second opinion about the page's keys.
        if (!commandCenterPageReady(win) && isLeaderKeyPress(e)) {
          const l = leader();
          if (l && armHeldLeader(l, e, noKeyup)) {
            br = "cc-rescue";
            return true;
          }
        }
        // The modifiers travel with it: the page's own typing guard and its
        // Ctrl/Alt pairs read them, and a forwarded Ctrl+Enter that arrived as
        // a bare Enter would run the wrong action.
        dispatchToCCPage(win, e.key, e);
        br = "cc-forward";
        return true;
      }
      if (!isChromeUiFocus(win, typing, e as KeyboardEvent)) {
        br = "cc-decline";
        return false;
      }
      if (isLeaderKeyPress(e)) {
        // The same escalation the tab-select rule uses: an element focus is not
        // always enough, and the focus manager is the last word (see
        // commandcenterfocus.focusSelectedContent).
        focusCCBody(win, deps.env.services.focus, focusFlags());
      }
      br = "cc-refocus";
      return false;
    }

    // Web pages are the content script's territory (its own leader, popups,
    // hints and typing guard). If Firefox forwards their keys to this chrome
    // window listener (some builds do), never consume them here. An
    // actor-forwarded key is the exception: the actor only speaks for pages
    // with no content script, so there is no other owner to defer to.
    //
    // THE PAGE OWNS THE KEYS ONLY WHILE IT CAN SEE THEM, and this branch used to
    // assume that it could. A keydown is delivered to the FOCUSED document, so
    // when focus sits in the browser's own UI — the hidden URL bar Firefox parks
    // it in, the toolbar a hover reveals, the tab strip, a splitter, or nothing
    // at all after the window has been away — the page's listener never runs,
    // and the key declined here is answered by the browser chrome instead: `;`
    // is typed into the URL bar and Lazyfox looks frozen on a page that is
    // perfectly healthy, until the user clicks on the page. That click is the
    // repair, and it is the one repair a keyboard-first browser cannot ask for.
    //
    // So the keyboard is GIVEN BACK to the page at the key the user already
    // pressed, and the LEADER KEY is consumed as part of that repair: it must
    // never be spent as a character in the URL bar, and the user's next press
    // lands in the page and arms the page's own leader there. Every other key is
    // still declined — the same answer this branch has always given, since the
    // page may well want it once focus is back.
    //
    // The one thing that vetoes the repair is the user COMPOSING in a chrome
    // field: pulling focus out from under a caret the user is writing at would be
    // worse than the freeze. It is deliberately not "the field has text": the URL
    // bar shows the PAGE'S OWN ADDRESS on the very state this rescue exists for,
    // so a text test vetoed every rescue it was written for (measured). Firefox's
    // own "the user edited this value" flag is what answers it — the whole
    // argument, with the measurements, is in chromeFieldHoldsUserText.
    if (!fromActor && !chromeOwnsKeys(win) && !popup.isOpen()) {
      let composingInChrome = false;
      try {
        composingInChrome =
          typing.focusedIsTyping(e as KeyboardEvent) &&
          chromeFieldHoldsUserText(
            win,
            typing.focusedTypingTarget(e as KeyboardEvent),
            typing.focusedTypingValue(e as KeyboardEvent),
          );
      } catch {
        composingInChrome = false;
      }
      let fm: any = null;
      try {
        fm = deps.env && deps.env.services ? deps.env.services.focus : null;
      } catch {
        fm = null;
      }
      if (!composingInChrome && !selectedContentHasKeyboard(win, fm)) {
        focusSelectedContent(win, fm, focusFlags());
        if (isLeaderKeyPress(e)) {
          br = "web-page-leader-rescue";
          return true;
        }
        br = "web-page-refocus";
        return false;
      }
      br = "web-page";
      return false;
    }

    // A chrome popup is open: Esc closes it first (before the page/window),
    // and so does Ctrl+G — the shared predicate, so the chrome popup and the
    // content-script popup can never disagree about what dismisses them.
    if (popup.isOpen()) {
      if (isCancel(e)) {
        if (popup.resizeOnKey(e as KeyboardEvent)) {
          br = "popup-resize";
          return true;
        }
        // Let the popup consume Esc itself (e.g. the sessions popup cancels a
        // pending copy/move target picker) before closing it.
        if (popup.handleKey(e as KeyboardEvent)) {
          br = "popup-key";
          return true;
        }
        popup.close();
        br = "popup-close";
        return true;
      }
      if (popup.resizeOnKey(e as KeyboardEvent)) {
        br = "popup-resize";
        return true;
      }
      // Confine the keyboard to the popup. A key whose target lies in the
      // popup (its input/rows) is left to the popup's own listener; a key
      // aimed anywhere else must not reach the browser chrome behind the
      // overlay. Channel-driven keys carry no target and are dispatched
      // straight to the popup input by the caller — leave them alone.
      const target = (e as { target?: EventTarget | null }).target;
      if (target == null) {
        br = "popup-chan";
        return false;
      }
      if (popup.containsTarget(target)) {
        br = "popup-inner";
        return false;
      }
      br = "popup-outside";
      return true;
    }

    const l = leader();
    if (!l) {
      br = "no-leader";
      return false;
    }

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
        br = "leader-cancel";
        l.cancelPending();
        l.hide();
        // A cancel ends the HOLD too, not just the overlay. `hide()` clears the
        // pixels; the host is the one that knows the hold also has to be
        // published as released, or the next page to load restores a gesture
        // the user explicitly backed out of.
        deps.cancelLeaderHold();
        return true;
      }
      const chromeUiFocus = isChromeUiFocus(win, typing, e as KeyboardEvent);
      const leaderKeyPress = isLeaderKeyPress(e);
      const emptyLazyfoxField =
        typingValue === "" && (isCommandCenterTab(win) || isAboutPage(win));
      // "The user is writing something." A field with text, or a field in the
      // page rather than in the browser's chrome UI.
      const typingWins = typingNow && (!chromeUiFocus || typingValue !== "");
      if (typingWins && !(leaderKeyPress && emptyLazyfoxField)) {
        br = "leader-typing";
        if (l.active) l.hide();
        if (l.hasPending()) l.cancelPending();
        deps.releaseLeaderHoldOnLostFocus();
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
        if (armHeldLeader(l, e, noKeyup)) {
          br = "leader-rearm";
          return true;
        }
      }
      if (l.hasPending()) {
        // The capture's answer is honoured: `false` means "this key is not part
        // of the sequence I am collecting" (`;W m` then a letter, a leading
        // zero, or anything with Ctrl/Alt/Meta held). It used to be swallowed
        // here anyway, which is the one thing the handler promises not to do.
        br = "leader-pending";
        return l.handlePending(e);
      }
      // `handleKey` reports whether it CONSUMED the key, and that answer is
      // honoured. It used to be discarded here and in every other host, which
      // meant a key the leader declined — a bare modifier press, a chord with
      // no binding — was swallowed with nothing on screen saying so. The user
      // pressed it again, because the first press had visibly done nothing.
      br = "leader-chord";
      return l.handleKey(e);
    }

    // Esc on chrome-owned pages blurs the focused element so the page returns
    // to a neutral state. NOT consumed: the page also receives Esc. The
    // command center owns its Esc, and web pages are the content script's.
    //
    // A second Ctrl+G branch used to sit just below this one — "back out of an
    // armed leader without giving up the key" — and it was UNREACHABLE, because
    // the `l.active || l.hasPending()` block above returns on every path, so by
    // the time control arrives here `l.active` is false by construction. It read
    // like the escape hatch while the live one (the `isCancel` check at the top
    // of that block) sat somewhere else entirely, which is precisely how a
    // safety net gets "fixed" twice and tested once. Removed.
    if (e.key === "Escape") {
      if (!ccOwnsTab()) blurFocusedElement(win);
      br = "escape-blur";
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
        isLeaderKeyPress(e) &&
        (typingValue === "" || isChromeUiFocus(win, typing, e as KeyboardEvent)) &&
        (isCommandCenterTab(win) || isAboutPage(win))
      ) {
        if (armHeldLeader(l, e, noKeyup)) {
          br = "typing-arm";
          return true;
        }
      }
      br = "typing";
      return false;
    }

    // Ctrl+G IS LAZYFOX'S CHORD, SO IT NEVER REACHES THE BROWSER.
    //
    // Escape is deliberately left alone here — the page still gets it, which is
    // what Escape means on the web — but Ctrl+G has no page meaning at all on a
    // chrome-owned page, and Firefox's is FIND AGAIN. Falling through to it
    // opened the native find bar over an about: page or the command center,
    // which is the reported "sometimes Ctrl+G opens the page's own search":
    // "sometimes" is exactly the set of pages this helper owns rather than a
    // content script, and the popup/leader branches above are the ones that
    // already consumed the chord when something was up.
    //
    // It sits AFTER the typing guard on purpose: Ctrl+G while the caret is
    // somewhere in the browser's own chrome UI (the URL bar on a fresh tab) is
    // the browser's chord, and stealing it from there would break find-again on
    // the one surface where nothing of ours is on screen.
    if (isCancel(e) && e.key !== "Escape") {
      br = "cancel-chord";
      return true;
    }

    // The command center is Lazyfox's own page. In command mode (input
    // blurred) the leader key must arm here so the home-screen shortcuts
    // work; in insert mode the typing check above already let `;` through.
    const k = e.key;
    if (isLeaderKeyPress(e) && isCommandCenterTab(win)) {
      if (armHeldLeader(l, e, noKeyup)) {
        br = "cc-arm";
        return true;
      }
    }

    // Ctrl+1-9: hot-swap to the session with that marker (tmux-style).
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      deps.switchSessionByMarker(Number(e.key));
      br = "session-digit";
      return true;
    }

    if (deps.handleHotkeyCombo(keyCombo(e as KeyboardEvent))) {
      br = "hotkey";
      return true;
    }

    // Ctrl/Alt/Meta chords are never the leader key on their own.
    if (e.ctrlKey || e.altKey || e.metaKey) {
      br = "modifier";
      return false;
    }

    // Vim scroll keys on chrome-owned pages; the command center grid owns its
    // own j/k/h/l navigation, so it is excluded.
    if (!isCommandCenterTab(win) && deps.handleScrollKeys(win, e)) {
      br = "scroll";
      return true;
    }

    if (k === deps.leaderKey()) {
      if (armHeldLeader(l, e, noKeyup)) {
        br = "leader-arm";
        return true;
      }
    }
    br = "pass";
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
    // A repeat is DROPPED as intent and KEPT as evidence: it proves the key is
    // still down, which is the only thing that lets a hold be told apart from a
    // claim nobody is holding (see shared/holdrelease.ts). Dropping it silently
    // is what left a held leader armed forever after a release this host never
    // saw.
    if (!!(e as { repeat?: boolean }).repeat) {
      noteHoldAlive(l);
      if (deps.onLeaderHeld) deps.onLeaderHeld();
      return true;
    }
    l.sticky = !noKeyup;
    noteHoldAlive(l);
    l.show();
    if (deps.onLeaderHeld) deps.onLeaderHeld();
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
    /** The dev-only dispatch trace, pulled by the chrome state reply. */
    dispatchTrace,
    runHintsAction,
    clearPageHints: pageHints.clear,
    setWebHints(fn: () => void) {
      deps.runWebHints = fn;
    },
  };
}
