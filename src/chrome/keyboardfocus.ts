// GIVE THE KEYBOARD BACK TO THE PAGE.
//
// THE REPORT THIS ANSWERS, in the user's words: "it stops responding and I have
// to click the page with the mouse". A keydown is delivered to the FOCUSED
// DOCUMENT and to nowhere else, so when keyboard focus is parked in the
// browser's own UI — the tab strip, the hidden URL bar a fresh tab starts with,
// whatever element the last chrome-side action left it on — the page's content
// script never sees the key at all. It is not a broken binding and not a
// swallowed keystroke: it is a keystroke that was never in the page. The one
// thing that puts it back is a click, and that is exactly the repair users
// discover and resent.
//
// WHERE IT COMES FROM. Lazyfox's own tab actions are the worst offenders,
// because they are the ones the user drives from the keyboard and never touches
// the mouse during: `;x` closes and lands on a neighbour, `;v` reopens (a
// `browser.tabs.create` in the BACKGROUND process), `;n` opens the home page,
// `;1`-`;9` / `;j` / `;k` jump, a session switch restores a different strip.
// Some of those paths happen to leave focus in the page (Firefox's own
// bookkeeping does it for a plain activation) and some do not, and the ones that
// do not are intermittent by nature — which is why this is a RULE at the one
// event that means "the keyboard's target changed" rather than a line added to
// each op.
//
// THE RULE. After the selected tab changes, the keyboard belongs to the page it
// changed to, with three exceptions — and each one is a state where the page is
// NOT where a keystroke should land:
//
//   * a chrome-side popup is open. Lazyfox's own popup host owns the keyboard by
//     design while it is up, and its close path gives it back (chrome/popup.ts);
//     pulling focus into the page underneath a live panel would type the user's
//     keys into the page behind the panel they are looking at.
//   * the selected tab is one of Lazyfox's own momentary carriers — the relay,
//     or a throwaway `#lfc=` request tab. Those are selected for the length of a
//     message and removed again; focusing them would hand the keyboard to a tab
//     that is about to cease to exist.
//   * focus is in a text field belonging to the browser's OWN UI and that field
//     HOLDS TEXT. This is the same exception the key dispatcher already makes
//     (keysdispatch.ts: "a field that holds TEXT always wins", and the browser's
//     own URL bar keeps its old behaviour because "an empty URL bar is where a
//     sequence continues"). A field the user has typed into is theirs; the hidden
//     EMPTY URL bar a fresh tab starts with is not, which is why that case pulls.
//
// Everything else — every web page, about: page, error page, and the command
// center — gets the keyboard, because that is where the user is looking.
//
// WHAT IT IS NOT. It is not a focus *behaviour* layered over the product's: the
// command center already had exactly this rule (winsync.ts focused its content
// on every tab switch because a fresh home tab starts with the URL bar focused),
// and this generalises that one rule to every page instead of teaching every op
// about focus. It reads no state the product does not already publish and it
// runs on an event that already existed.

import { isRelayTabUrl } from "../shared/transient";
import type { ChromeWindow } from "./env";

/** Where a keystroke should land after the tab changed. */
export type KeyboardTarget = "content" | "command-center" | "none";

/**
 * The facts the rule is decided on.
 *
 * Deliberately small, and deliberately all of them are things this window can
 * answer for itself: a rule that has to ask the page would be a rule that cannot
 * be applied at the moment it is needed (the page cannot be asked anything on a
 * cross-process tab).
 */
export interface KeyboardFacts {
  /** Lazyfox's own chrome-side popup owns the keyboard right now. */
  popupOpen: boolean;
  /** The selected tab is Lazyfox's own momentary carrier (relay / `#lfc=`). */
  transientTab: boolean;
  /** The selected document is Lazyfox's command center. */
  commandCenter: boolean;
  /** Focus is in a text field of the browser's own UI, and it holds text. */
  chromeFieldHasText: boolean;
}

/**
 * The whole rule, as a function, so it can be asserted directly instead of only
 * through a fake window.
 *
 * Exported for the same reason `keyIsClaimed` (content/framekeys.ts) is: a rule
 * this consequential must be readable, testable and impossible to change by
 * accident in one call site.
 */
export function keyboardTargetFor(f: KeyboardFacts): KeyboardTarget {
  if (f.popupOpen) return "none";
  if (f.transientTab) return "none";
  if (f.chromeFieldHasText) return "none";
  return f.commandCenter ? "command-center" : "content";
}

/** The applier, as the two call sites in winsync.ts see it. */
export interface KeyboardFocus {
  /**
   * Apply the rule to the window's CURRENT selected tab.
   *
   * Deliberately re-reads the selection every time rather than taking a tab:
   * both callers learn "something changed" and not "which tab is now in front",
   * and on a cross-process tab the caller could not name the tab anyway.
   */
  giveKeyboardToSelectedPage(): KeyboardTarget;
}

export interface KeyboardFocusDeps {
  /** The chrome window whose selected tab is being addressed. */
  win: ChromeWindow;
  /** Is Lazyfox's own chrome-side popup host open? */
  popupOpen(): boolean;
  /**
   * Is this tab element the window's RELAY, asked of the module that owns it
   * (channel.isKnownRelayTab) rather than re-derived here — the same predicate
   * `primitives.realTabs` uses to keep plumbing out of the numbering.
   */
  isRelayTab(tab: unknown): boolean;
  /** The selected tab's document is the command center. */
  commandCenter(): boolean;
  /** Pull focus into the command center's page (chrome/commandcenterfocus.ts). */
  focusCommandCenter(): void;
  /**
   * Give an ordinary page the keyboard (chrome/commandcenterfocus.ts
   * `focusSelectedContent`). Injected rather than done here because that helper
   * owns the escalation: one element focus is not always enough, and the
   * fallbacks it tries are its business (and its test's).
   */
  focusContent(): void;
}

/** The selected tab element, or null when the strip cannot be read. */
function selectedTabOf(win: ChromeWindow): any {
  try {
    return (win as any).gBrowser.selectedTab || null;
  } catch (e) {
    return null;
  }
}

/** The selected tab's URL, or "" when it cannot be read. */
function selectedUrlOf(win: ChromeWindow): string {
  try {
    const b = (win as any).gBrowser.selectedBrowser;
    const u = b && b.currentURI;
    return u ? String(u.spec || "") : "";
  } catch (e) {
    return "";
  }
}

/**
 * Whether the browser's own UI has a text field focused that holds text.
 *
 * Reads `document.activeElement` in the CHROME document, so it can only ever
 * answer about the browser's own fields (the URL bar, the find bar, a search
 * field in about:preferences) — a field in the page belongs to another document
 * and is not this question. An unreadable element is not a reason to refuse: the
 * answer defaults to "no text", i.e. the page gets the keyboard, which is the
 * direction that cannot leave the user with a dead keyboard.
 */
function chromeFieldHasText(win: ChromeWindow): boolean {
  try {
    const doc: any = win.document;
    const el: any = doc && doc.activeElement;
    if (!el) return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (tag !== "INPUT" && tag !== "TEXTAREA" && el.isContentEditable !== true) return false;
    if (el.value != null) return String(el.value).length > 0;
    const text = el.textContent;
    return text != null && String(text).length > 0;
  } catch (e) {
    return false;
  }
}

/** The facts, read from the window. */
export function readKeyboardFacts(deps: KeyboardFocusDeps): KeyboardFacts {
  const tab = selectedTabOf(deps.win);
  let relay = false;
  try {
    relay = !!tab && (deps.isRelayTab(tab) || isRelayTabUrl(selectedUrlOf(deps.win)));
  } catch (e) {
    // A read that throws must not become a stalled keyboard: treat the tab as a
    // real one, which is the same default the tab numbering uses.
    relay = false;
  }
  let cc = false;
  try {
    cc = deps.commandCenter();
  } catch (e) {
    cc = false;
  }
  let popup = false;
  try {
    popup = deps.popupOpen();
  } catch (e) {
    popup = false;
  }
  return {
    popupOpen: popup,
    transientTab: relay,
    commandCenter: cc,
    chromeFieldHasText: chromeFieldHasText(deps.win),
  };
}

/**
 * Apply the rule, and report what was decided.
 *
 * The return value is the DECISION rather than a success flag, because the two
 * refusals it can report are different states and a caller that wants to know
 * (a test, a diagnostic) needs to be able to tell them apart.
 */
export function giveKeyboardToSelectedPage(deps: KeyboardFocusDeps): KeyboardTarget {
  const target = keyboardTargetFor(readKeyboardFacts(deps));
  if (target === "none") return "none";
  if (target === "command-center") {
    // The command center focuses its own BODY rather than the browser element:
    // focusing the <browser> hands the caret to its search box, which is insert
    // mode, and the user's next keystroke would be typed instead of run.
    deps.focusCommandCenter();
    return target;
  }
  try {
    deps.focusContent();
  } catch (e) {
    // A torn-down tab cannot take the keyboard; the next tab switch tries again.
  }
  return target;
}

/** The applier bound to one window's facts. */
export function createKeyboardFocus(deps: KeyboardFocusDeps): KeyboardFocus {
  return { giveKeyboardToSelectedPage: () => giveKeyboardToSelectedPage(deps) };
}
