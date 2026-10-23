// Keyboard focus + key forwarding between the chrome window and the command
// center page it hosts.
//
// A fresh command-center tab starts with Firefox's URL-bar focus, which would
// swallow every key the keyboard-first home needs (hjkl, `;`, the `;f`
// hint-pick letters, Enter). These helpers pull focus into the page and
// forward keys into its own document, with the SAME event builder and
// text-insertion emulation the chrome channel uses (./keys.ts) so a forwarded
// key and a synthetic one behave identically.

import type { LeaderController } from "../shared/leader";
import { ANY_KEY_EXPECT } from "../shared/leadersignal";
import type { ChromeWindow } from "./env";
import { buildKeyEvent, maybeInsertText } from "./keys";
import { chromeElementOnScreen } from "./chromefield";

// Slice of `Services.focus` (nsIFocusManager) this file uses, passed in so
// every module stays constructible in Node with no browser (see ./env.ts).
export interface FocusService {
  /** The OS-active window. */
  activeWindow?: any;
  /** The element that has the keyboard, as the browser tracks it. */
  focusedElement?: any;
  /** `nsIFocusManager.setFocus`. */
  setFocus?(el: any, flags: number): void;
}

// Give the SELECTED tab's content the keyboard, whatever document it holds.
// The browser element is the only handle the parent process has on a tab's
// keyboard (a page with no keyboard cannot focus itself, and a remote document
// is unreachable). Escalates — measured, not assumed: after `;n` the window is
// active, the page reports hasFocus:false and the focus manager reports
// focusedElement:null; neither body.focus() nor browser.focus() changes it.
// The user's repair is a click; each next measure below is only taken while
// the keyboard is still nowhere. It never fires when the content already has
// the keyboard, and never takes the OS focus of another window.
export function focusSelectedContent(win: ChromeWindow, fm?: FocusService, flags = 0): void {
  // LOAD-BEARING re-entry guard: every win.focus()/b.focus() below dispatches
  // the window's own focus/activate events, which reach giveKeyboardToSelected
  // Page and re-enter this function synchronously — measured as "too much
  // recursion" before the guard existed. A re-entrant call mid-repair has
  // nothing new to decide.
  if (inFocusApply) return;
  inFocusApply = true;
  try {
    focusSelectedContentInner(win, fm, flags);
  } finally {
    inFocusApply = false;
  }
}
// Synchronous window only, so a module-level flag is fine: two windows cannot
// focus their content in one call stack.
let inFocusApply = false;

function focusSelectedContentInner(win: ChromeWindow, fm?: FocusService, flags = 0): void {
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
  // selected document (an in-process page's report).
  const held = (el: any): boolean => {
    if (!el) return false;
    if (el === b) return true;
    try {
      return !!b.contentDocument && el.ownerDocument === b.contentDocument;
    } catch {
      return false;
    }
  };
  // A SPLIT PANE'S DOCSHELL IS NOT ACTIVATED BY SELECTING ITS TAB.
  //
  // In a native split view both panes stay on screen, each with its own
  // browser. Moving the selection to the other pane moves `selectedTab` (and
  // the URL bar) but leaves the NEW pane's docshell inactive and the keyboard
  // in the pane it came from: measured after `;W h`/`;W l`, the selected pane
  // reported docShell.isActive:false, pageHasFocus:false and focusedWindow
  // still the OTHER pane, while the previous pane's document still reported
  // hasFocus:true. Focusing the browser element alone does not fix it — the
  // focus manager treats that as "the browser is focused" and stops.
  //
  // Activating the docshell is the operation a click on the pane performs. Do
  // it before focusing, so every key after a pane switch lands in the pane the
  // user just moved to (and its content script — not the previous pane's —
  // draws the page UI).
  try {
    const ds: any = b.docShell;
    if (ds && ds.isActive === false) {
      if (typeof ds.makeActive === "function") ds.makeActive(true);
      else b.docShellIsActive = true;
    }
  } catch {
    // older/newer builds without either knob: the focus calls below remain
  }
  try {
    if (typeof b.focus === "function") b.focus();
  } catch {
    // a torn-down tab has no keyboard to take
  }
  // THE DOCUMENT ITSELF, not just its frame element. `browser.focus()` asks the
  // chrome element for focus; in a split view the platform is happy to say the
  // browser is focused while the previous pane's document still holds the
  // keyboard (measured: focusedElement === the selected <browser>,
  // focusedWindow still the other pane, pageHasFocus false). Asking the
  // document's own window to focus is what a click inside the pane does, and it
  // crosses to a remote document the same way.
  try {
    const cw = b.contentWindow;
    if (cw && typeof cw.focus === "function") cw.focus();
  } catch {
    // an inaccessible document falls back to the element focus above
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
    // unfocusable window: its page keeps no keyboard
  }
  try {
    if (typeof b.focus === "function") b.focus();
  } catch {
    // ignore
  }
  if (held(focused())) return;
  try {
    if (typeof fm.setFocus !== "function") return;
    // FLAG_NOSCROLL IS REFUSED BY A SPLIT PANE'S BROWSER. Measured after
    // `;W l` in a native split: this call with the scroll flag present was
    // accepted (no throw) and changed nothing — focusedElement stayed null,
    // document.activeElement stayed the OTHER pane's browser, and that pane's
    // document kept the keyboard — while the identical call with flags 0 moved
    // the focus on the first try. The flag exists to keep an ELEMENT focus from
    // scrolling the page; a <browser> is not in the page's scroll box, so
    // dropping it costs nothing and is the difference between "the pane switch
    // took the keyboard" and "every key after it ran in the pane you left".
    fm.setFocus(b, flags);
    if (!contentHasKeyboard(b)) fm.setFocus(b, 0);
  } catch {
    // the focus manager refused: nothing else in this realm can ask
  }
}

/**
 * Put the keyboard in the SELECTED SPLIT PANE, by the one call that measurably
 * moves it.
 *
 * Split view keeps both panes' documents alive and both browsing contexts
 * active, so the usual escalation in focusSelectedContent is answered "already
 * focused" while the keyboard is still in the pane the user left. Measured
 * after `;W l` in a native split: docShell.isActive false for BOTH panes,
 * focusedElement null, focusedWindow the other pane's window, and
 * document.activeElement in the chrome document was the other pane's <browser>.
 * `focus()` on the selected browser, its contentWindow, the tab element and the
 * browser container all changed nothing; `nsIFocusManager.setFocus(browser, 0)`
 * moved it on the first try. WITH FLAG_NOSCROLL IT DID NOT (accepted, no throw,
 * no effect) — see the note in focusSelectedContentInner.
 *
 * Called on a pane switch and once more after the platform has settled the
 * new selection (splitview.ts), because the first call can race the platform
 * moving the selected pane.
 */
export function focusSelectedBrowser(win: ChromeWindow, fm?: FocusService): void {
  let b: any = null;
  try {
    b = (win as any).gBrowser.selectedBrowser || null;
  } catch {
    b = null;
  }
  if (!b) return;
  try {
    win.focus();
  } catch {
    // unfocusable window: nothing below can land either
  }
  try {
    if (typeof b.focus === "function") b.focus();
  } catch {
    // a torn-down pane has no keyboard to take
  }
  try {
    if (fm && typeof fm.setFocus === "function") fm.setFocus(b, 0);
  } catch {
    // the focus manager refused: the pane keeps whatever it had
  }
  try {
    const cw = b.contentWindow;
    if (cw && typeof cw.focus === "function") cw.focus();
  } catch {
    // an inaccessible document falls back to the element focus above
  }
}

// Does the content document behind this browser hold the keyboard? Asked after
// the focus call rather than before, so it answers "did the repair land" — the
// one question the escalating path above is built on.
function contentHasKeyboard(b: any): boolean {
  try {
    const cw = b && b.contentWindow;
    return !!(cw && cw.document && cw.document.hasFocus());
  } catch {
    return false;
  }
}

// Does the SELECTED tab's content currently have the KEYBOARD?
//
// A different question from who OWNS the keys. A keydown is delivered to the
// FOCUSED document, so when focus sits in the browser's own UI the page's
// listener never runs and every keystroke the helper declined "because the
// page owns it" is answered by the browser instead — the reported freeze.
//
// Three answers, and the third has to be right:
//   * focusedElement IS the selected browser or inside its document — the
//     page has it;
//   * focusedElement is some other element — the keyboard is elsewhere in
//     this window;
//   * NOTHING holds it (a real, measured state — see focusSelectedContent) —
//     but ONLY while this window is the active one: an inactive window reports
//     no focused element as a property of being inactive, and its page keeps
//     the keyboard for the moment the user returns.
//
// An unreadable focus manager answers YES: an unjustified repair yanks the
// caret out of the field the user was typing in.
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
    // A remote document is unreachable from here: the element is not the
    // browser and cannot be proved to be inside it.
    return false;
  }
}

// The STRICT twin of selectedContentHasKeyboard, answering POSITIVELY only.
// The lenient exception (inactive window ⇒ page keeps the keyboard) is right
// for triggers — a tab select or load finishing can fire in a window the user
// is not in, where pulling focus would be an intrusion — and WRONG for a key:
// givePageKeyboardBack runs because a keydown arrived at THIS window, which
// cannot happen while the user's keyboard is in another window. Believing the
// stale/null answer is the freeze in its purest form: the helper declines the
// key, the page never sees it, and nothing answers until a click. Acting on
// "no" here is safe — the repair stops at the browser element when this window
// is not the active one.
//
// No manager ⇒ true, so the repair stays completable: without a focus manager
// there is no setFocus to escalate to, and "the keyboard was moved" would be a
// lie told to the keystroke that paid for it.
export function focusIsInSelectedContent(win: ChromeWindow, fm?: FocusService): boolean {
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

// Is a browser-UI field holding a caret the USER is composing in?
//
// The veto on every repair that pulls the keyboard out of the browser's own
// UI: a user-owned field is not ours to take. A question about COMPOSITION,
// not about text — the value alone cannot answer it. Firefox parks the
// keyboard in the address bar on a fresh document showing the PAGE'S OWN
// ADDRESS, so `value !== ""` is true on exactly the state the repair must
// rescue, and the first version vetoed every rescue it was written for.
//
// The URL bar is therefore asked Firefox's own flags: `valueIsTyped` (the
// "user has edited this value" flag — measured false while it held a
// navigated address, true once the user types) and the `usertyping` attribute.
// Every other chrome field keeps the simple rule, because its value really is
// user-written (e.g. the find bar). An unreadable URL bar answers "no": this
// veto needs evidence.
export function chromeFieldHoldsUserText(win: ChromeWindow, el: unknown, value: string): boolean {
  if (!el) return false;
  const doc: any = (win as any).document;
  let owner: any = null;
  try {
    owner = (el as any).ownerDocument || null;
  } catch {
    owner = null;
  }
  // A field in a PAGE is not the browser's UI; the page's typing guard owns it.
  if (!doc || owner !== doc) return false;
  // And it must be ON SCREEN. Lazyfox renders the URL bar with display:none,
  // so the field holding the keyboard on a fresh tab is invisible — and
  // valueIsTyped, once set by one stray character, vetoed every rescue on
  // every key for the life of the window. Rule and unknown-direction in
  // chromefield.ts.
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

// "Body is the active element" is NOT "the page has the keyboard": a document
// with no focused element reports body as the DEFAULT, so a guard keyed on it
// skipped the focus call in exactly the state it repairs (`;n` then `;` — the
// leader did nothing until a click). Ask the page's own hasFocus() first; when
// it is false, GIVE the tab a keyboard instead of asking it to take one. Only
// then focus the body, and only if the caret is elsewhere (a search box, a
// stale caret — the case this function was originally for).
export function focusCCBody(win: ChromeWindow, fm?: FocusService, flags = 0): void {
  let doc: any = null;
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    doc = (cw && cw.document) || null;
  } catch {
    // cross-process (or torn-down tab): no document to reach
    doc = null;
  }
  const body = doc && doc.body;
  let hasKeyboard = false;
  try {
    hasKeyboard = !!(doc && typeof doc.hasFocus === "function" && doc.hasFocus());
  } catch {
    hasKeyboard = false;
  }
  // The tab has no keyboard: give it one. Nothing reached from the page can
  // do this, and the caret lands on the document's active element (the body,
  // on the home page in command mode).
  if (!hasKeyboard) {
    focusSelectedContent(win, fm, flags);
    return;
  }
  try {
    if (body && doc.activeElement !== body && typeof body.focus === "function") {
      // A <body> is not focusable until the page makes it so in its own load
      // handler; before that runs, body.focus() is a silent no-op and
      // whatever held the focus kept it. Idempotent, and it removes the
      // load-order race from every key action that depends on page focus.
      if (!body.hasAttribute("tabindex")) body.setAttribute("tabindex", "-1");
      body.focus();
    }
  } catch {
    // the document went away mid-focus — the next key tries again
  }
}

// Whether the command-center document in the selected tab ANSWERS KEYS.
//
// The page declares it with `data-lf-engine` on its root, set in the same
// statement that installs its keydown listener — so "it has an engine" cannot
// be true without the listener that acts on keys. The helper forwards keys
// into this page, and a document caught mid-redirect (fresh new tab, script
// still loading) would take the key and drop it: this is how the helper knows
// to answer the leader key itself instead. Unreachable document ⇒ false; the
// caller's fallback is safe there too.
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

// Forward a single key into the command-center page's document, built with the
// PAGE's KeyboardEvent constructor — an event created in the chrome realm is
// invisible to the page's listeners.
//
// The insertion is emulated, not optional: on a focused <input> the page
// deliberately returns early and lets the native default action type, but a
// synthetic keydown has no default action — forwarded keys landed on a focused
// field and vanished (`i` focused the search box, every letter after it was
// lost). maybeInsertText is the chrome channel's own helper, so the two paths
// cannot drift.
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
    // No synthetic keypress (matching the chrome channel): one carrying a
    // charCode makes an editor insert natively, double-inserting beside
    // maybeInsertText.
    const notCanceled = target.dispatchEvent(buildKeyEvent("keydown", spec, ctor));
    target.dispatchEvent(buildKeyEvent("keyup", spec, ctor));
    maybeInsertText(target, spec, notCanceled);
  } catch {
    // page unreachable — nothing to forward (safe no-op)
  }
}

// Tell the command-center page `;f` was pressed. The PAGE decides what that
// means (arm hint-pick on the home grid, focus its own search box elsewhere) —
// only it knows which one it is showing. After dispatching, the next key is
// captured and forwarded: the hint-pick letter must reach the PAGE even when
// Firefox is keeping the hidden URL bar focused.
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
  // NOTHING here focuses the page's search box. It used to, right after
  // dispatching — undoing the page's own decision: on the grid the page had
  // just armed hint-pick, the chrome side pulled focus into the search input,
  // and the page switched to insert mode with hint-pick armed. On a fresh
  // command-center tab the page's load handler has not yet made the body
  // focusable, so the search box kept the focus for good. The page focuses
  // its own input when it wants to; authority stays in one place.
  if (!reached) return;
  leader.armPending(
    (e) => {
      // The RAW key, not the canonical spec: the page's engine normalises on
      // its side, and a spec would hand it "shift+p" instead of the character.
      dispatchToCCPage(win, e.key, e);
      return true;
    },
    {
      timeoutMs: 10000,
      // This capture eats the next keystroke and hands it to another realm;
      // the label keeps the indicator from looking idle for ten seconds.
      expect: ANY_KEY_EXPECT,
    }
  );
  // Pull focus into the page so keys AFTER the pick (and hjkl on the grid)
  // land naturally instead of in the hidden URL bar. The page BODY, never the
  // <browser> element.
  focusCCBody(win);
}

// Esc on chrome-owned pages: blur whatever holds focus (a search box, a
// focused button) so the page returns to its neutral state and the vim keys /
// leader work without a click. Chrome UI fields (the URL bar) are left alone —
// the browser owns their Esc behavior.
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
