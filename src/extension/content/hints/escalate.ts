// May the privileged (trusted-click) retry be attempted for this element?
//
// Split out of activate.ts so the rule is testable in Node — `activate.ts`
// names the DOM in its signatures and pulls in the toast overlay, which the unit
// tier cannot load. The rule itself is two lines and worth pinning anyway,
// because getting it wrong is not a cosmetic failure:
//
// ANCHORS ARE EXCLUDED. The synthetic click on a link has already navigated (or
// opened a tab), so a second, genuinely trusted press at the same coordinates
// performs the action TWICE — a double navigation, or two new tabs. The retry
// exists for controls that gate on `event.isTrusted`, which is a property of
// scripted widgets (YouTube's Skip button is a `<button>`); a link's activation
// is not gated that way at all, so nothing is lost by refusing it.
//
// A DOWNLOAD LINK is the same accident with a file attached, and it is excluded
// on its own attribute rather than only by its tag, because `<area download>`
// and a scripted `<a>` without an href are both real shapes.
//
// Anything else is allowed. The retry is fired at most once per activation, and
// only after the target's own state has been watched and found unchanged (see
// life.targetSignal) — the guard rail here is about not repeating an action that
// already happened, not about limiting how often the privileged path is used.
export function canEscalate(el: Element): boolean {
  try {
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "A" && el.hasAttribute("href")) return false;
    if (el.hasAttribute("download")) return false;
  } catch (e) {
    // A hostile element must not open the privileged path.
    return false;
  }
  return true;
}
