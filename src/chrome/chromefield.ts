// Facts about a field in the BROWSER'S OWN UI — the tab strip, the URL bar, the
// find bar, a search box on an about: page.
//
// WHY THIS IS A MODULE. Two decisions in the chrome helper depend on whether a
// chrome field "belongs to the user" right now:
//
//   * `commandcenterfocus.chromeFieldHoldsUserText` — the veto that stops the
//     rescue from pulling focus out from under a caret the user is writing at,
//     and
//   * `keyboardfocus.chromeFieldHasText` — the same exception in the tab-select
//     rule that gives a page its keyboard back.
//
// Both used to answer "is the user composing here" from the field's TEXT alone.
// That is not the same question, and the difference is the reported freeze:
// Lazyfox's chrome CSS renders the URL bar with `display:none` (it is a hover
// overlay — src/static/chrome/userChrome.css), so the one chrome field that is
// focused on a fresh tab, and the one a stray keystroke lands in while the page
// is frozen, is a field **the user cannot see**. A field nobody can see cannot
// hold an intent: it cannot be deliberately typed into, its text cannot be read
// before it is thrown away, and once `valueIsTyped` is set — which is what
// happening to type one character into it does — it vetoes EVERY rescue, on
// every key, invisibly, for the life of the window. The user's own reproduction
// is exactly this state ("the keyboard focus was on the URL bar of the browser
// … and I never see the URL bar"), and the only repair it leaves is a click.
//
// So "the user is composing" now requires evidence that the field is ON SCREEN.
// The direction of the unknown is deliberate and is the same asymmetry the
// surrounding code already chose for an unreadable URL bar: a field whose size
// cannot be measured is not proof of a user composing, and the cost of being
// wrong that way (an address half typed in a hidden bar, which in a Lazyfox
// install is not a surface the user reaches without hovering the top strip) is
// smaller than the cost of being wrong the other way (a keyboard that is dead
// until the page is clicked, with nothing on screen to explain it).

/**
 * Is this element of the browser's own UI actually on screen?
 *
 * `false` for no element, for an element with no box (the hidden URL bar), and
 * for an element whose size cannot be read at all. See the note above for why
 * the last case is deliberately not treated as evidence.
 */
export function chromeElementOnScreen(el: unknown): boolean {
  if (!el) return false;
  const e = el as {
    checkVisibility?: () => boolean;
    getBoundingClientRect?: () => { width?: number; height?: number } | null;
    getClientRects?: () => { length?: number } | null;
  };
  // The browser's own answer first, where it exists: it accounts for
  // `display:none`, `visibility:hidden`, `content-visibility` and a collapsed
  // ancestor, which is exactly the state Lazyfox's toolbar-hiding CSS creates.
  try {
    if (typeof e.checkVisibility === "function") return e.checkVisibility() === true;
  } catch {
    // Older chrome documents (or a XUL element) may not implement it: the
    // geometry below is the fallback, not a failure.
  }
  try {
    if (typeof e.getBoundingClientRect === "function") {
      const r = e.getBoundingClientRect();
      if (r && (Number(r.width) > 0 || Number(r.height) > 0)) return true;
      // A measurable zero box IS evidence, and it is the answer for a hidden
      // field — so it is returned rather than falling through to the list
      // below, which would measure the same nothing.
      return false;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof e.getClientRects === "function") {
      const list = e.getClientRects();
      if (list && typeof list.length === "number") return list.length > 0;
    }
  } catch {
    // fall through
  }
  return false;
}
