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
  focusIsInSelectedContent,
  focusSelectedContent,
  signalCommandCenterFind
} from "./commandcenterfocus";
import {
  chromeOwnsKeys,
  commandCenterDocumentPresent,
  contentOwnablePage,
  isChromeUiFocus,
  isDeveloperSurfaceTab,
  isCommandCenterTab,
} from "./keystate";
import type { ChromeEnv, ChromeWindow } from "./env";
import type { PopupHost } from "./popup";
import { createChromePageHints } from "./pagehints";
import type { TypingChannel } from "./typing";

export interface KeyDispatchDeps {
  // The window as a parameter, not the ambient global, so this module and the
  // whole ownership order below can be driven in Node with a fake (env.ts).
  win: ChromeWindow;
  // The seam itself, for collaborators that take it whole (page hints reads
  // env.services); passed so a test's fake env is the same object every
  // collaborator sees.
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
  // Web-page hint action, set by the composition root after the leader
  // actions are built (breaks the mutual reference).
  runWebHints: () => void;
  // Wired to the hold watchdog: repeats are the evidence the key is still
  // down; the watchdog stands a hold down once nothing is holding it.
  onLeaderHeld?: () => void;
  // End an outstanding HOLD because the user CANCELLED (Esc/Ctrl+G), not
  // because the key came up. A callback: the host, not this module, owns the
  // published claim (the per-tab hold that survives navigation), and a hold
  // that ends unpublished is dutifully restored by the next page — an armed
  // leader for a key nobody is holding.
  cancelLeaderHold: () => void;
  // Stop the watchdog when the tab loses focus or changes ownership; its
  // release may need to be published across a navigation.
  releaseLeaderHoldOnLostFocus: () => void;
}

// The actor-forwarded key shape (actor-parent.ts): those keys can only come
// from pages the content script cannot reach, so the "web pages belong to the
// content script" gate must not decline them.
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
  // as of the URL: currentURI during a provisional navigation already names
  // the URL being loaded while the document on screen is still the command
  // center, and keyed on the URL alone every branch below treated that tab as
  // a web page — declined, then forwarded to a document that did not exist
  // yet, while the document still answering got nothing.
  const ccOwnsTab = (): boolean => isCommandCenterTab(win) || commandCenterDocumentPresent(win);

  // `nsIFocusManager.FLAG_NOSCROLL`: focus without dragging the page.
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
    // chromeOwnsKeys() is true exactly where the content script does not run:
    // provide hints locally there.
    if (chromeOwnsKeys(win)) {
      pageHints.show();
      return;
    }
    deps.runWebHints();
  }

  // The leader key with no modifier on it — the keystroke that must never
  // vanish, and the only key the command-center fallback answers itself.
  function isLeaderKeyPress(e: ActorKey): boolean {
    return e.key === deps.leaderKey() && !e.ctrlKey && !e.altKey && !e.metaKey;
  }

  // `fromActor` and `noKeyup` are DIFFERENT facts and must not be conflated.
  // `fromActor` is about OWNERSHIP: the key was forwarded from the content
  // process for a page that has no content script, so deferring to the page
  // is not an option — while the `#lfc=keys` channel drives the real
  // selection, which may have a owning content script, and claiming there
  // would handle one keystroke twice. `noKeyup` is about LIFECYCLE: nothing
  // will deliver a matching keyup, so the key must be treated as a tap and
  // never as a hold (armHeldLeader).

  // THE DISPATCH TRACE, dev-only and read on demand. "Press `;o` and nothing
  // happens" has exactly one honest diagnosis path: which branch consumed the
  // key; its other answers all look identical from outside. A RING IN MEMORY
  // — one array push per key, no attribute writes, compiled out of release
  // builds (call sites behind __DEV__; esbuild folds the literal). Read from
  // the chrome state reply (`keyTrace`), pull-not-push like the content
  // script's trace. The Node checks drive this module without the __DEV__
  // literal, so it is read defensively.
  const DEV = typeof __DEV__ !== "undefined" && __DEV__;
  const TRACE_LIMIT = 24;
  const trace: Array<Record<string, unknown>> = [];
  // A MONOTONIC NUMBER PER ENTRY, because the ring is bounded: once full, its
  // length stops growing, and `after.length > before.length` is false for a
  // key that WAS recorded (measured in the content/focus suite). Also what
  // makes two reads orderable as numbers.
  let traceSeq = 0;
  function noteTrace(entry: Record<string, unknown>): void {
    if (!DEV) return;
    entry.n = ++traceSeq;
    trace.push(entry);
    if (trace.length > TRACE_LIMIT) trace.shift();
  }

  /** The trace, newest last. Empty in a release build. */
  function dispatchTrace(): Array<Record<string, unknown>> {
    return trace.slice();
  }

  // The branch the current key is in; assigned at each decision point and
  // read once after the dispatch — the instrument cannot change what the
  // dispatcher does.
  let br = "entry";

  /**
   * Give the SELECTED tab's page its keyboard back — the repair the user
   * performs with a click — and report what became of the key that asked.
   *
   * THREE answers rather than a boolean, because both callers must
   * distinguish "repaired and this key was spent on it" from "repaired, pass
   * the key on" from "nothing to do"; the boolean version shipped with the
   * first and third conflated and silently swallowed a letter on the way to a
   * page that never asked for it.
   *
   * The veto (user composing in a chrome field, see
   * chromeFieldHoldsUserText) deliberately never applies to the LEADER KEY:
   * with the toolbar hidden, a stray character in the invisible URL bar once
   * vetoed every rescue forever. `;` is the one key a Lazyfox user presses to
   * say "Lazyfox, now"; the typed text stays in the field. Every OTHER key
   * keeps the veto — revealing the toolbar and typing an address must work.
   *
   * STRICT question (`focusIsInSelectedContent`, not the window-independent
   * variant): at a key, the keyboard is provably in THIS window — the
   * "another window is active" state is stale, and trusting it declined a key
   * whose page was not focused until the user clicked.
   */
  function givePageKeyboardBack(e: ActorKey): "consumed" | "declined" | "not-needed" {
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
    if (composingInChrome && !isLeaderKeyPress(e)) return "not-needed";
    let fm: any = null;
    try {
      fm = deps.env && deps.env.services ? deps.env.services.focus : null;
    } catch {
      fm = null;
    }
    if (focusIsInSelectedContent(win, fm)) return "not-needed";
    focusSelectedContent(win, fm, focusFlags());
    return isLeaderKeyPress(e) ? "consumed" : "declined";
  }

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
        // `tap`: no keyup will ever come — the flag that decides tap-vs-hold,
        // and the one that has bitten before.
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

    // A DEVELOPER SURFACE IS NOT CLAIMED — not the key, not the repair, not
    // the leader. The order IS the fix: `chromeOwnsKeys` says false for
    // devtools documents, which would send the key down the WEB PAGE rescue,
    // moving the keyboard into the developer's console and spending the
    // leader key doing it. "Not ours" and "not touched" are the same answer
    // here, whatever the key was and wherever it came from.
    if (isDeveloperSurfaceTab(win)) {
      br = "devtools-surface";
      return false;
    }

    // LAZYFOX'S OWN PAGE OWNS ITS OWN KEYS. The command center runs the same
    // key engine a content script does; claiming its keys as well made a key
    // run twice in-process (and differently between new tabs). Three cases:
    //   * SYNTHETIC (channel/actor): the page never saw it — forward it in;
    //     the only key path a test has, since WebDriver cannot focus a
    //     moz-extension document.
    //   * REAL, focus in the chrome UI (the hidden URL bar on a fresh tab):
    //     the page cannot see it either — refocus the page so the NEXT key
    //     lands in the grid, never run a binding from this realm.
    //   * REAL, focus already in the page: its listener already ran; return
    //     false and leave the event as the page left it.
    if (ccOwnsTab() && !popup.isOpen()) {
      if (fromActor || noKeyup) {
        // Forwarding was UNCONDITIONAL and a command-center document that has
        // not finished loading its script (a fresh tab mid-redirect, a reload
        // in flight) had none of the engine: the key was answered by nobody
        // ("nothing responds, not even the leader"). The page declares
        // `data-lf-engine` where its listener is installed; when it is not up,
        // THE LEADER KEY is answered here instead of vanishing — a rescue for
        // the one key that must work on every tab, not a second opinion.
        if (!commandCenterPageReady(win) && isLeaderKeyPress(e)) {
          const l = leader();
          if (l && armHeldLeader(l, e, noKeyup)) {
            br = "cc-rescue";
            return true;
          }
        }
        // The modifiers travel with it: the page's typing guard and its
        // Ctrl/Alt pairs read them.
        dispatchToCCPage(win, e.key, e);
        br = "cc-forward";
        return true;
      }
      if (!isChromeUiFocus(win, typing, e as KeyboardEvent)) {
        br = "cc-decline";
        return false;
      }
      if (isLeaderKeyPress(e)) {
        // Same escalation as the tab-select rule: element focus is not
        // always enough; the focus manager is the last word.
        focusCCBody(win, deps.env.services.focus, focusFlags());
      }
      br = "cc-refocus";
      return false;
    }

    // Web pages are the content script's territory. If Firefox forwards their
    // keys to this chrome listener (some builds do), never consume them —
    // except an actor-forwarded key, which by construction has no other
    // owner. THE PAGE OWNS THE KEYS ONLY WHILE IT CAN SEE THEM: a keydown is
    // delivered to the FOCUSED document, so when Firefox parks focus in its
    // own UI (the hidden URL bar, the toolbar, the tab strip, or nothing
    // after the window has been away) the page's listener never runs — `;`
    // gets typed into the URL bar and Lazyfox looks frozen on a healthy page,
    // until the user clicks. That click is the one repair a keyboard-first
    // browser cannot ask for, so the keyboard is GIVEN BACK at the key the
    // user already pressed; the LEADER KEY is consumed by that repair and the
    // next press lands in the page.
    if (!fromActor && !chromeOwnsKeys(win) && !popup.isOpen()) {
      const r = givePageKeyboardBack(e);
      if (r === "consumed") {
        br = "web-page-leader-rescue";
        return true;
      }
      if (r === "declined") {
        br = "web-page-refocus";
        return false;
      }
      br = "web-page";
      return false;
    }

    // THE SAME REPAIR IS OWED WHEN THE HELPER IS THE ONE ANSWERING: the field
    // state is ";R ;S ;O ;D run but j/k/h/d/u are dead until the page is
    // clicked" — the helper's bindings run while the page sees no key at all.
    // The LEADER KEY is the only trigger: every other key is legitimate
    // chrome-UI business, and the veto cannot tell a URL bar showing its own
    // page address from one holding a half-typed URL. AND ONLY ON A DOCUMENT
    // THAT CAN OWN THE KEYS AT ALL — the missing qualifier spent the first
    // press of every leader chord on chrome-owned pages with no content
    // script (diagnostics, any about:): the repair handed the keyboard to a
    // document with no key engine while the leader key it spent never armed
    // anything, so ";T then ;x did nothing" (session step 23 measured it).
    //
    // AND WHEN THE REPAIR DOES FIRE, THE LEADER MUST ARM WITH IT. This branch
    // only runs while chromeOwnsKeys() is true — no content script present and
    // none expected — so the "; T H E   N E X T press" nobody else can answer:
    // a web document would (the repair exists there so the page's own leader
    // catches the next key), a helper-owned document has no such second
    // chance. Merely consuming the key turned the second press into a permanent
    // repair loop: one find (the native find bar parks the keyboard in the
    // browser chrome) and every later leader press on a neterror or uninjectable
    // page was spent on focus and armed nothing, again and again, and
    // ";f ;t ;o never came back". The repair AND the arm is the one honest
    // outcome on a page only the helper is answering.
    if (
      !fromActor &&
      chromeOwnsKeys(win) &&
      isLeaderKeyPress(e) &&
      !popup.isOpen() &&
      contentOwnablePage(win)
    ) {
      if (givePageKeyboardBack(e) === "consumed") {
        br = "web-page-leader-rescue-split";
        // No keyup path survives a synthetic channel key either — the same
        // tap-vs-hold routing the leader branch itself takes below.
        const rl = leader();
        if (rl && armHeldLeader(rl, e, noKeyup)) {
          br = "leader-rescue-arm";
        }
        return true;
      }
    }

    // A chrome popup is open: Esc closes it first (Ctrl+G too — the shared
    // predicate, so the chrome popup and the content popup never disagree).
    if (popup.isOpen()) {
      if (isCancel(e)) {
        if (popup.resizeOnKey(e as KeyboardEvent)) {
          br = "popup-resize";
          return true;
        }
        // Let the popup consume Esc itself (the sessions popup cancels a
        // pending copy/move picker) before closing it.
        if (popup.handleKey(e as KeyboardEvent)) {
          br = "popup-key";
          return true;
        }
        popup.close();
        br = "popup-close";
        return true;
      }
      // EVERY OTHER KEY REACHES THE POPUP'S CONTROLLER FIRST, and that is
      // load-bearing now that the selector has a NORMAL mode: its field is
      // deliberately unfocused while j/k navigate, so `i` and the vim keys are
      // typed nowhere and would otherwise be swallowed by the branch below
      // without ever being offered to the popup. A handler that declines (a
      // printable key in INSERT mode) falls through to the field as before.
      if (popup.handleKey(e as KeyboardEvent)) {
        br = "popup-key";
        return true;
      }
      if (popup.resizeOnKey(e as KeyboardEvent)) {
        br = "popup-resize";
        return true;
      }
      // Confine the keyboard to the popup: a key aimed anywhere else must not
      // reach the browser chrome behind the overlay. Channel-driven keys
      // carry no target (the caller dispatches them to the popup input).
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

    if (l.active || l.hasPending()) {
      // ONE cancel ends the WHOLE chain. A category is a capture AND an
      // armed leader at once (the head arms the capture), and the capture's
      // sub-key table has no Escape row — so Escape used to spend the
      // capture, leave the leader armed, and need a second press. The chord
      // and its menu are one user action; Ctrl+G is the same cancel and the
      // one that works on pages that bind Escape.
      if (isCancel(e)) {
        br = "leader-cancel";
        l.cancelPending();
        l.hide();
        // A cancel ends the HOLD too: hide() clears pixels, but the host
        // must publish the release or the next page restores a gesture the
        // user explicitly backed out of.
        deps.cancelLeaderHold();
        return true;
      }
      const chromeUiFocus = isChromeUiFocus(win, typing, e as KeyboardEvent);
      const leaderKeyPress = isLeaderKeyPress(e);
      // Same page class as the typing guard below — wherever the helper is
      // the only key engine, an empty field is not a reason to spend the
      // leader key as text.
      const emptyLazyfoxField =
        typingValue === "" && (isCommandCenterTab(win) || !contentOwnablePage(win));
      // "The user is writing something": a field with text, or a field in
      // the page (rather than the browser's chrome UI).
      const typingWins = typingNow && (!chromeUiFocus || typingValue !== "");
      if (typingWins && !(leaderKeyPress && emptyLazyfoxField)) {
        // TYPING WINS — the reported "shortcuts fire while I am typing in an
        // input field"; the empty-field exception once rendered whole
        // about:preferences as "keeps the binding".
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
        // The leader key in the one field where it is still a chord: treat
        // as a fresh press, never hand an armed capture a typed `;` (which
        // made `;` after `;W` do something arbitrary).
        if (armHeldLeader(l, e, noKeyup)) {
          br = "leader-rearm";
          return true;
        }
      }
      if (l.hasPending()) {
        // The capture's `false` ("not my sequence") is honoured: the key used
        // to be swallowed here anyway, breaking the handler's own promise.
        br = "leader-pending";
        return l.handlePending(e);
      }
      // `handleKey`'s "did I consume it" is honoured too: its decliner — a
      // bare modifier, a chord with no binding — used to be swallowed with
      // nothing on screen saying so.
      br = "leader-chord";
      return l.handleKey(e);
    }

    // Esc on chrome-owned pages blurs the focused element so the page returns
    // to neutral. NOT consumed (the page also receives Esc). A second Ctrl+G
    // branch below this once looked like an escape hatch and was
    // UNREACHABLE — the armed-leader block returns on every path; removed.
    if (e.key === "Escape") {
      if (!ccOwnsTab()) blurFocusedElement(win);
      br = "escape-blur";
      return false;
    }

    // Typing in an editable: never intercept. Only two exceptions, leader-key
    // wide: an EMPTY field on a Lazyfox-owned page (`;` arms without a click
    // or Esc), and the URL bar sitting on a page only Lazyfox can answer.
    // Note the "only Lazyfox can answer" spelling is contentOwnablePage, NOT
    // isAboutPage — a SUBSET: every moz-extension:// document (diagnostics,
    // options, the relay) is chrome-owned for the same reason and was once
    // missed (the other half of session step 23).
    if (typingNow) {
      if (
        isLeaderKeyPress(e) &&
        (typingValue === "" || isChromeUiFocus(win, typing, e as KeyboardEvent)) &&
        (isCommandCenterTab(win) || !contentOwnablePage(win))
      ) {
        if (armHeldLeader(l, e, noKeyup)) {
          br = "typing-arm";
          return true;
        }
      }
      br = "typing";
      return false;
    }

    // Ctrl+G IS LAZYFOX'S CHORD ON CHROME-OWNED PAGES: Firefox's is FIND
    // AGAIN, and falling through opened the native find bar over an about:
    // page or the command center ("sometimes Ctrl+G opens the page's own
    // search"). Escape is deliberately left alone here — the page still gets
    // it, which is what Escape means on the web. Sits AFTER the typing
    // guard: Ctrl+G with the caret already in the browser's UI (the URL bar
    // on a fresh tab) is the browser's find-again.
    if (isCancel(e) && e.key !== "Escape") {
      br = "cancel-chord";
      return true;
    }

    // The command center in command mode (input blurred): the leader arms
    // here so the home-screen shortcuts work; in insert mode the typing
    // check above already let `;` through.
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

    // Vim scroll keys on chrome-owned pages; the command center grid owns
    // its own j/k/h/l navigation, so it is excluded.
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
  // A key that stays down re-fires keydown at the OS repeat rate; treating
  // each as a fresh press tore down and re-armed the leader several times a
  // second, destroying holds-run-two-actions between them. A repeat carries
  // no intent but IS liveness evidence (the key is provably down — what
  // tells a hold from an abandoned claim in shared/holdrelease.ts), so it is
  // swallowed here: consumed, kept as evidence.
  //
  // A real press marks the leader STICKY so bindings run and stay armed until
  // the keyup (main.ts releases it next to the leader's construction).
  //
  // `noKeyup` — the actor bridge and the #lfc=keys channel dispatch a bare
  // keydown and can never deliver the release — deliberately never marks
  // sticky in the one place that decision is made: a stuck chained leader
  // lights the indicator forever and swallows the next keystroke in the
  // window. The `unknown` event shape: a real KeyboardEvent carries `repeat`,
  // a synthesized ActorKey does not (and is never a repeat).
  function armHeldLeader(
    l: { sticky: boolean; show(): void },
    e: unknown,
    noKeyup?: boolean
  ): boolean {
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
