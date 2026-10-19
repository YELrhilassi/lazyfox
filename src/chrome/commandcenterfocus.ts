// Keyboard focus + key forwarding between the chrome window and the command
// center page it hosts.
//
// A fresh command-center tab starts with Firefox's URL-bar focus, which would
// swallow every key the keyboard-first home needs (the grid's hjkl, `;`, the
// `;f` hint-pick letters, Enter). These helpers pull focus into the page and
// forward keys into the page's own document.

import type { LeaderController } from "../shared/leader";
import { ANY_KEY_EXPECT } from "../shared/leadersignal";
import type { ChromeWindow } from "./env";
// The shared event synthesis: the SAME builder and the SAME text-insertion
// emulation the chrome channel uses when it hands a key to any other page
// (src/chrome/keys.ts). Reusing them is what makes a forwarded key and a
// synthetic one behave identically, which is the whole point of forwarding.
import { buildKeyEvent, maybeInsertText } from "./keys";
import { chromeElementOnScreen } from "./chromefield";

// Focus the command-center page's body (tabindex=-1) so keyboard focus sits in
// the page, in command mode, away from Firefox's URL bar and the page's own
// search input.
/**
 * The slice of `Services.focus` (nsIFocusManager) this file uses.
 *
 * Passed in rather than reached for, because every module here is constructible
 * in Node with no browser (see src/chrome/env.ts) — and because the ONE thing
 * worth doing with it is the thing a fake can record.
 */
export interface FocusService {
  /** The OS-active window. */
  activeWindow?: any;
  /** The element that has the keyboard, as the browser tracks it. */
  focusedElement?: any;
  /** `nsIFocusManager.setFocus`. */
  setFocus?(el: any, flags: number): void;
}

/**
 * Give the SELECTED tab's content the keyboard, whatever document it holds.
 *
 * The browser element is the only handle the parent process has on a tab's
 * keyboard: a page cannot be asked to focus itself when it has no keyboard to
 * take (its own `body.focus()` is then a no-op), and an out-of-process document
 * cannot be reached at all. Focusing the element restores the keyboard to the
 * document's own active element — the body in command mode, the caret in a
 * field if that is where the user left it — which is exactly the behaviour a
 * click on the page produces.
 *
 * AND IT ESCALATES, because that one call is not always enough — measured, not
 * assumed. `;n` opens the home tab: the tab is selected and in front, the
 * window is the OS-active one, the page reports `hasFocus: false` with the body
 * as its active element, and the browser's own focus manager reports
 * `focusedElement: null` — NOTHING has the keyboard, and neither the page's own
 * `body.focus()` nor `selectedBrowser.focus()` changes it. The user's repair is
 * a click, which is what this function has to do without one. So the state is
 * CHECKED between attempts and each next measure is only taken when the
 * keyboard is still nowhere: re-focus the chrome window (the element focus is
 * a request the window has to be able to grant), then the element again, then
 * the focus manager's own `setFocus` — the API the browser itself uses to move
 * the keyboard.
 *
 * The escalation never fires when the content ALREADY has the keyboard — in a
 * healthy state `focusedElement` is the `<browser>` element (or an element in
 * the selected document) — and it never touches the OS focus of another window:
 * a window that is not the active one is not ours to take.
 */
export function focusSelectedContent(win: ChromeWindow, fm?: FocusService, flags = 0): void {
  let b: any = null;
  try {
    b = (win as any).gBrowser.selectedBrowser || null;
  } catch {
    b = null;
  }
  if (!b) return;
  const focused = (): any => {
    try {
      return fm ? fm.focusedElement : null;
    } catch {
      return null;
    }
  };
  // "The content has it": the browser element itself, or an element inside the
  // selected document (which is what an in-process page reports).
  const held = (el: any): boolean => {
    if (!el) return false;
    if (el === b) return true;
    try {
      return !!b.contentDocument && el.ownerDocument === b.contentDocument;
    } catch {
      return false;
    }
  };
  try {
    if (typeof b.focus === "function") b.focus();
  } catch {
    // a torn-down tab has no keyboard to take
  }
  if (!fm) return;
  if (held(focused())) return;
  let active = false;
  try {
    active = !!fm.activeWindow && fm.activeWindow === win;
  } catch {
    active = false;
  }
  if (!active) return;
  try {
    win.focus();
  } catch {
    // a window that cannot be focused is a window whose page keeps no keyboard
  }
  try {
    if (typeof b.focus === "function") b.focus();
  } catch {
    // ignore
  }
  if (held(focused())) return;
  try {
    if (typeof fm.setFocus === "function") fm.setFocus(b, flags);
  } catch {
    // the focus manager refused: nothing else in this realm can ask for it
  }
}

/**
 * Does the SELECTED tab's content currently have the KEYBOARD?
 *
 * A different question from who OWNS the keys, and the one that decides whether
 * a declined keystroke will be answered by anybody at all. A keydown is
 * delivered to the FOCUSED document, so when focus sits in the browser's own UI
 * — the hidden URL bar Firefox parks it in, the toolbar a hover reveals, the tab
 * strip, a split's splitter — the page's own listener never runs, and every key
 * the chrome helper "declined because the page owns it" is answered by the
 * browser instead. That is the reported freeze: Lazyfox looks dead on a page
 * that is perfectly healthy, and a click on the page is what fixes it.
 *
 * THREE ANSWERS, and the third is the one that has to be right:
 *
 *   * `focusedElement` IS the selected browser, or an element inside its
 *     document: the page has it (a remote tab reports the <browser> itself —
 *     with a click in the page — and an in-process document reports the element);
 *   * `focusedElement` is some other element: the keyboard is somewhere this
 *     window can see and the page is not it;
 *   * NOTHING holds it, which is a real and measured state (see
 *     focusSelectedContent: the tab is in front, the window is active, and the
 *     focus manager reports `focusedElement: null`) — but ONLY while this window
 *     is the active one. An inactive window reports no focused element as a
 *     property of being inactive, and its page keeps the keyboard for the moment
 *     the user comes back, so that case must not be read as "nobody has it".
 *
 * An unreadable focus manager answers YES: a repair we cannot justify is a
 * caret yanked out of the field the user was typing in, which is worse than the
 * freeze it is meant to fix.
 */
/**
 * Does the selected tab's content have the keyboard — POSITIVELY?
 *
 * The strict twin of `selectedContentHasKeyboard`, and the difference is exactly
 * the exception that the lenient version makes on purpose: "an inactive window
 * reports no focused element as a property of being inactive, and its page keeps
 * the keyboard for the moment the user comes back".
 *
 * That exception is right for the TRIGGERS (a tab select, a load finishing: an
 * event that can fire in a window the user is not in, where pulling focus would
 * be an intrusion) and it is WRONG for a key. `givePageKeyboardBack` only runs
 * because a keydown was delivered to THIS window's own listener — which cannot
 * happen while the user's keyboard is in another window — so the focus manager's
 * "some other window is active" (a stale answer, and a null one, are both
 * measured Firefox states) is not a reason to believe the page has the keyboard.
 * Believing it is the reported freeze in its purest form: the helper declines the
 * key because "the page owns it", the page never sees a key because its document
 * is not focused, and nothing answers until the user CLICKS — which is also the
 * thing that finally makes the focus manager say the window is active.
 *
 * So this asks only the two questions that place the keyboard inside the selected
 * content, and answers "no" for everything else — including "nothing holds it"
 * and "an unreadable focus manager". Acting on "no" is safe in a way that the
 * other direction is not: the repair focuses the browser element (and, when this
 * window is not the active one, deliberately stops there — see
 * focusSelectedContent), so it cannot take the keyboard from another window.
 */
export function focusIsInSelectedContent(win: ChromeWindow, fm?: FocusService): boolean {
  // NO MANAGER, NO ANSWER — and the answer that acts least is "assume the page
  // has it". This is the one place the strict rule keeps the lenient default, and
  // the reason is that the repair has to be able to COMPLETE: with no focus
  // manager there is no `setFocus` to escalate to, so a repair that claims the
  // keyboard was moved would be a lie told to the keystroke that paid for it.
  if (!fm) return true;
  let b: any = null;
  try {
    b = (win as any).gBrowser.selectedBrowser || null;
  } catch {
    b = null;
  }
  if (!b) return false;
  let el: any = null;
  try {
    el = fm.focusedElement || null;
  } catch {
    el = null;
  }
  if (el === b) return true;
  if (!el) return false;
  try {
    return !!b.contentDocument && el.ownerDocument === b.contentDocument;
  } catch {
    return false;
  }
}

export function selectedContentHasKeyboard(win: ChromeWindow, fm?: FocusService): boolean {
  if (!fm) return true;
  let b: any = null;
  try {
    b = (win as any).gBrowser.selectedBrowser || null;
  } catch {
    b = null;
  }
  if (!b) return true;
  let el: any = null;
  try {
    el = fm.focusedElement || null;
  } catch {
    el = null;
  }
  if (el === b) return true;
  if (!el) {
    try {
      return fm.activeWindow !== win;
    } catch {
      return true;
    }
  }
  try {
    return !!b.contentDocument && el.ownerDocument === b.contentDocument;
  } catch {
    // A remote document is not reachable from here: the element is not the
    // browser and cannot be proved to be inside it, so the page does not have it.
    return false;
  }
}

/**
 * Is a browser-UI field holding a caret the USER is composing in?
 *
 * The veto on every repair that pulls the keyboard out of the browser's own UI:
 * a field the user has typed into belongs to them, and taking it back is worse
 * than the freeze the repair is for. It is a question about COMPOSITION, not
 * about text — and the difference is the whole reason this function exists.
 *
 * The URL bar is the case that forced it, and the value alone cannot answer it:
 * Firefox parks the keyboard in the address bar on a fresh document and shows
 * the PAGE'S OWN ADDRESS there, so `value !== ""` is true on exactly the state
 * the repair has to rescue, and the first version of this veto therefore
 * declined every rescue it was written for (measured end to end: the keyboard
 * never left the URL bar). An address nobody typed is not a composition.
 *
 * So the URL bar is asked the question it can actually answer, using Firefox's
 * own flags rather than a guess about its contents:
 *
 *   * `valueIsTyped` — the URL bar's own "the user has edited this value",
 *     measured FALSE while it held `http://127.0.0.1:.../hello` (an address put
 *     there by navigation) and true once the user types;
 *   * `usertyping` — the attribute the URL bar sets while the user is typing,
 *     measured ABSENT in the same state.
 *
 * Every OTHER chrome field keeps the simple rule (`value !== ""` is the user's
 * text), because for those the value really is user-written: the find bar's box
 * holds only what was typed into it. An unreadable URL bar answers "no": this
 * veto can only be justified by evidence, and the freeze is what the default
 * costs when there is none.
 */
export function chromeFieldHoldsUserText(win: ChromeWindow, el: unknown, value: string): boolean {
  if (!el) return false;
  const doc: any = (win as any).document;
  let owner: any = null;
  try {
    owner = (el as any).ownerDocument || null;
  } catch {
    owner = null;
  }
  // A field in a PAGE is not the browser's UI at all; the page's own typing
  // guard owns that case.
  if (!doc || owner !== doc) return false;
  // ...AND IT HAS TO BE A FIELD THE USER CAN SEE. `chromeFieldHoldsUserText` is
  // the only thing that can veto the rescue, and the rescue exists for a state
  // the veto used to make permanent: Lazyfox renders the URL bar with
  // `display:none`, so the field that holds the keyboard on a fresh tab (and the
  // field a stray keystroke lands in while the page is frozen) is invisible —
  // and `valueIsTyped`, once set by that one stray character, vetoed every
  // rescue on every key, for the life of the window, with nothing on screen to
  // explain it. The user's reproduction is exactly this state. See
  // chrome/chromefield.ts for the rule and for the direction of the unknown.
  if (!chromeElementOnScreen(el)) return false;
  let ub: any = null;
  let input: any = null;
  try {
    ub = (win as any).gURLBar || null;
    input = (ub && (ub.inputField || doc.getElementById("urlbar-input"))) || null;
  } catch {
    ub = null;
    input = null;
  }
  if (ub && (el === input || el === ub || el === ub.textbox)) {
    try {
      if (ub.valueIsTyped === true) return true;
    } catch {
      // an unreadable flag is not evidence of typing
    }
    try {
      if (ub.getAttribute && ub.getAttribute("usertyping")) return true;
    } catch {
      // same
    }
    try {
      if (input && input.getAttribute && input.getAttribute("usertyping")) return true;
    } catch {
      // same
    }
    return false;
  }
  return value !== "";
}

// "THE BODY IS THE ACTIVE ELEMENT" IS NOT "THE PAGE HAS THE KEYBOARD", and
// conflating the two is a dead keyboard rather than a cosmetic slip.
//
// A document with no focused element reports `activeElement === body` — that is
// the DEFAULT, not a claim that focus is inside it — so the guard below used to
// skip the focus call in exactly the state it exists to repair: the tab is
// selected and in front, the body is nominally active, and every key the user
// presses goes to the browser's own UI instead of the page. Measured end to end
// (`;n` opens the home tab, then `;`): the new command center reported
// `hasFocus: false` with `activeElement: BODY`, and the leader key did nothing
// until the page was clicked. The page had done its part — its `load` handler
// focuses the body — and the call did nothing, because a document whose window
// has no keyboard cannot take one.
//
// So the page's own answer to "is the keyboard here" (`document.hasFocus()`) is
// asked FIRST, and when it is false the tab is given the keyboard rather than
// asked to take it. Only then is the body focused, and only if the caret is
// somewhere else — which is the case the original function was written for
// (a search box the page had focused, a stale caret).
export function focusCCBody(win: ChromeWindow, fm?: FocusService, flags = 0): void {
  let doc: any = null;
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    doc = (cw && cw.document) || null;
  } catch {
    // cross-process (or a torn-down tab): no document to reach
    doc = null;
  }
  const body = doc && doc.body;
  let hasKeyboard = false;
  try {
    hasKeyboard = !!(doc && typeof doc.hasFocus === "function" && doc.hasFocus());
  } catch {
    hasKeyboard = false;
  }
  // The tab has no keyboard: give it one. Nothing reached from the page can do
  // this (see the note above), and the caret lands on the document's active
  // element, which for the home page in command mode is the body.
  if (!hasKeyboard) {
    focusSelectedContent(win, fm, flags);
    return;
  }
  try {
    if (body && doc.activeElement !== body && typeof body.focus === "function") {
      // A <body> is not focusable until something makes it so, and the page
      // only does that in its own `load` handler. Between the tab opening and
      // that handler running, `body.focus()` is a silent no-op — so the key
      // the user pressed went nowhere and, worse, whatever DID hold focus
      // (the hidden URL bar, or the search box the page had just blurred) kept
      // it. Making the body focusable here is the same one-line change the
      // page makes, it is idempotent, and it removes the load-order race from
      // every key action that depends on focus being in the page.
      if (!body.hasAttribute("tabindex")) body.setAttribute("tabindex", "-1");
      body.focus();
    }
  } catch {
    // the document went away mid-focus — the next key tries again
  }
}

/**
 * Whether the command-center document in the selected tab ANSWERS KEYS.
 *
 * The page declares it itself, with `data-lf-engine` on its root, set in the
 * same statement that installs its keydown listener (src/extension/
 * commandcenter.ts) — so "it has an engine" cannot be true without the listener
 * that acts on the keys, and the chrome helper can tell the difference between a
 * page that took a key and a page that was not there yet.
 *
 * That distinction is the whole point: the helper forwards a key into this page
 * for the `#lfc=keys` channel and for the content-process actor, and a
 * command-center document caught mid-redirect (URL committed, script still
 * loading — every fresh new tab for a moment) would take the key and drop it.
 * `;` on such a tab left the keyboard dead, and this is how the helper knows to
 * answer the leader key itself instead.
 *
 * False when the document cannot be reached at all (cross-process, torn down):
 * "no engine" is the honest answer there too, and the caller's fallback is safe
 * in exactly that case.
 */
export function commandCenterPageReady(win: ChromeWindow): boolean {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    const root = doc && doc.documentElement;
    return !!root && root.getAttribute("data-lf-engine") === "1";
  } catch {
    return false;
  }
}

// Move keyboard focus into the command-center tab's content document (out of
// the hidden URL bar / chrome UI), leaving it in command mode. Focuses the
// page body, never the <browser> element (which grabs the search input).
export function focusCommandCenterContent(win: ChromeWindow, fm?: FocusService, flags = 0): void {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    const input = doc && doc.getElementById("input");
    if (input && doc.activeElement === input && typeof input.blur === "function") {
      input.blur();
    }
  } catch {
    // ignore
  }
  focusCCBody(win, fm, flags);
}

// Forward a single key into the command-center page's document (the page's
// own keydown listener drives hint-pick / modes / typing from it). Built with
// the PAGE's KeyboardEvent constructor — an event created in the chrome realm
// is invisible to the page's listeners.
//
// THE INSERTION IS EMULATED, and leaving it out is a real bug rather than a
// test artefact. On a focused <input> the page deliberately does NOT touch the
// value: it returns early and lets the browser's native default action do the
// typing. A synthetic keydown has no default action, so a forwarded key landed
// on a focused field was consumed and then vanished — `i` focused the search
// box, and every letter after it disappeared. The chrome channel emulates the
// insertion for every other page (`maybeInsertText`), so forwarding goes
// through the very same helpers and cannot drift from it again.
export function dispatchToCCPage(
  win: ChromeWindow,
  key: string,
  // The modifiers of the key being forwarded. Omitted by callers that have
  // none (the hint-pick capture forwards a bare character).
  mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}
): void {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    if (!doc) return;
    const ctor = (cw as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent || KeyboardEvent;
    const target = (doc.activeElement as Element | null) || doc.documentElement;
    const spec = {
      key,
      shiftKey: !!mods.shiftKey,
      ctrlKey: !!mods.ctrlKey,
      altKey: !!mods.altKey,
      metaKey: !!mods.metaKey,
    };
    // No synthetic keypress (matching the chrome channel): a keypress carrying
    // a charCode makes an editor insert the character natively, which would
    // double-insert alongside maybeInsertText.
    const notCanceled = target.dispatchEvent(buildKeyEvent("keydown", spec, ctor));
    target.dispatchEvent(buildKeyEvent("keyup", spec, ctor));
    maybeInsertText(target, spec, notCanceled);
  } catch {
    // page unreachable — nothing to forward (safe no-op)
  }
}

// Tell the command-center page `;f` was pressed. The PAGE decides what that
// means — on the home grid it arms hint-pick, anywhere else it focuses its own
// search box — and it is the only thing that can decide, because only it knows
// whether it is showing the grid. After dispatching, the next key is captured
// and forwarded into the page: the home-grid hint-pick letter must reach the
// PAGE even when focus is NOT in it (Firefox keeps the hidden URL bar focused
// on a fresh new tab).
export function signalCommandCenterFind(win: ChromeWindow, leader: LeaderController): void {
  let reached = false;
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    if (doc && typeof doc.dispatchEvent === "function") {
      doc.dispatchEvent(new (cw as any).Event("lazyfox-find", { bubbles: false, cancelable: false }));
      reached = true;
    }
  } catch {
    // The page is not reachable from here; nothing below can work either.
  }
  // NOTHING focuses the page's search box from this side.
  //
  // It used to, unconditionally, right after dispatching — which quietly
  // undid the page's own decision. On the home grid the page had just armed
  // hint-pick and every tile was badged; the chrome side then pulled focus
  // into the search input, so the home page switched to insert mode while
  // hint-pick was still armed. Whether it ended up looking right depended on
  // `focusCCBody` winning the race to pull focus back out, and on a freshly
  // opened command-center tab that race is real: the page only makes its body
  // focusable in its own `load` handler, so before that runs `body.focus()`
  // does nothing and the search box kept the focus for good. That is the home
  // page "not reacting" to the keys the rest of the browser reacts to.
  //
  // The page already focuses its own input when it wants to (the non-home
  // branch of the same event), so the authority stays in one place.
  if (!reached) return;
  leader.armPending(
    (e) => {
      // The RAW key goes to the page, not the canonical spec. The page's own
      // engine normalises again on its side, and forwarding a spec would hand
      // it the string "shift+p" instead of the character the user pressed.
      dispatchToCCPage(win, e.key, e);
      return true;
    },
    {
      timeoutMs: 10000,
      // This capture eats the next keystroke and hands it to another realm,
      // where the page decides what it meant. Without a label the indicator
      // looks identical whether or not a key is being forwarded for the next
      // ten seconds — so the bar says so instead of sitting there looking idle.
      expect: ANY_KEY_EXPECT,
    }
  );
  // Pull focus into the page so keys AFTER the pick (and hjkl on the grid)
  // land naturally instead of in the hidden URL bar. Focus the page BODY,
  // never the <browser> element.
  focusCCBody(win);
}

// Esc on chrome-owned pages: blur whatever holds focus (an about: page's
// search box, a focused button) so the page returns to its neutral state and
// the vim keys / leader work without a click. Chrome UI fields (the URL bar)
// are left alone — the browser owns their Esc behavior.
export function blurFocusedElement(win: ChromeWindow): void {
  try {
    const fd = (win.document as unknown as { commandDispatcher?: { focusedElement?: Element | null } })
      .commandDispatcher;
    const el = fd && fd.focusedElement;
    if (
      el &&
      el !== win.document.body &&
      el !== win.document.documentElement &&
      typeof (el as HTMLElement).blur === "function"
    ) {
      (el as HTMLElement).blur();
      return;
    }
  } catch {
    // fall through to the content probe
  }
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    const ae = doc && doc.activeElement;
    // blur only exists on HTMLElement (SVGElement/MathMLElement have none);
    // the typeof guard is load-bearing.
    if (
      ae &&
      ae !== doc.body &&
      ae !== doc.documentElement &&
      typeof (ae as HTMLElement).blur === "function"
    ) {
      (ae as HTMLElement).blur();
    }
  } catch {
    // cross-process or dead — nothing to blur
  }
}
