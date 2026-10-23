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
//
// AND ONE NARROW CLASS GETS THE REAL PRESS FIRST (pressForReal, below): a
// control drawn inside a player's own video box. There the site's widget filters
// on isTrusted AND flips a pressed class for any press, so "the target reacted"
// is not evidence — the retry could never be reached there, which is exactly the
// "Skip ad does nothing" report.
import {
  MEDIA_SURFACE_MIN_H,
  MEDIA_SURFACE_MIN_W,
  MEDIA_SURFACE_SELECTOR,
} from "./selectors";
import { deepHit } from "./probe";

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

/**
 * Is this control drawn INSIDE a large media surface — i.e. is it one of a
 * player's own overlay controls?
 *
 * Geometry, not ancestry: a player lays its controls over the video as
 * SIBLINGS of it (#movie_player > video + .ytp-chrome-bottom), so
 * `closest("video")` answers nothing on the pages this is for. The question is
 * "does this control's box sit within the box of a video big enough to be the
 * player", which is what the user sees.
 *
 * Bounded and tolerant by construction: at most a handful of media elements are
 * queried, the read is wrapped, and an element that refuses a rect answers "no"
 * (the caller then keeps the ordinary synthetic press).
 */
export function insideMediaSurface(el: Element): boolean {
  try {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const doc = el.ownerDocument as Document | null;
    if (!doc || typeof doc.querySelectorAll !== "function") return false;
    const media = doc.querySelectorAll(MEDIA_SURFACE_SELECTOR);
    for (let i = 0; i < media.length; i++) {
      const m = media[i]!;
      const mr = m.getBoundingClientRect();
      if (mr.width < MEDIA_SURFACE_MIN_W || mr.height < MEDIA_SURFACE_MIN_H) continue;
      // A margin of a couple of pixels, because a player's overlay is often laid
      // out against the player's edge rather than strictly inside the video's.
      if (
        r.left >= mr.left - 2 &&
        r.right <= mr.right + 2 &&
        r.top >= mr.top - 2 &&
        r.bottom <= mr.bottom + 2
      ) {
        return true;
      }
    }
  } catch (e) {
    // A hostile element (or a document that refuses the query) must not open the
    // privileged path.
    return false;
  }
  return false;
}

/**
 * Should this control be pressed FOR REAL as its one and only activation?
 *
 * The privileged press exists for widgets that filter on `event.isTrusted`, and
 * the family that does so in practice is a video player's own overlay: YouTube's
 * "Skip ad" is the canonical one, every ad-capable player has an equivalent, and
 * they all share a second property that matters more here — they light up a
 * PRESSED state (a class, an animation) for ANY press, trusted or not, before
 * deciding whether the press counts.
 *
 * That cosmetic flip is what made the retry unreachable after the target/page
 * split (see this module's header): `targetSignal` reads it as "its class
 * changed", the verdict calls the press a success, and the privileged retry — the
 * only route that reaches the widget — never fires. Measured on a player-shaped
 * fixture (`/adplayer`, built from the real markup): label drawn, key pressed,
 * labels gone, ad still playing, nothing said. That is the report.
 *
 * So the ROUTE is chosen up front for this narrow class instead of being
 * inferred from the aftermath: one real press, exactly where a mouse would press
 * the control the user chose. The synthetic sequence is not sent first and is not
 * sent after, so nothing can be activated twice — the double-navigation hazard
 * that keeps links out of this path is excluded by canEscalate, and a second
 * press on a player toggle (mute, play/pause) would otherwise undo the first.
 *
 * Everything else keeps the old order — synthetic first, privileged retry only
 * when the target proves silent — because that order is cheaper and is right on
 * ordinary pages, where a class flip is real evidence.
 */
export function pressForReal(el: Element): boolean {
  return canEscalate(el) && insideMediaSurface(el);
}

/** The box a press was aimed at, captured BEFORE the press. */
export interface PressBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function boxOf(el: Element): PressBox | null {
  try {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  } catch (e) {
    return null;
  }
}

/**
 * Is the control still where the press left it?
 *
 * A couple of pixels of tolerance, and "no measurement" answers yes: this guard
 * exists to STOP a destructive second press, so it must never invent a failure
 * out of a missing rect.
 */
export function samePressBox(a: PressBox | null, b: PressBox | null): boolean {
  if (!a || !b) return true;
  return (
    Math.abs(a.left - b.left) <= 2 &&
    Math.abs(a.top - b.top) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2
  );
}

/**
 * Would a real second press still land on this control?
 *
 * THE PRIVILEGED RETRY IS DESTRUCTIVE WHEN THE FIRST PRESS WORKED, and on a
 * complex app the evidence for "it worked" is often only the layout: a search
 * field opens, a modal appears, a sidebar collapses. None of those touch the
 * control's own class/ARIA/value, and on a busy document the page-level mutation
 * rate cannot separate the press's burst from the app's own churn — so the
 * retry fires, and the real press lands on whatever now owns those coordinates
 * (the panel it opened, the backdrop, the moved button) and undoes the work. The
 * user sees it as "the action runs and then reverts".
 *
 * This is the question that needs no statistics: after a press that did
 * something, the control has MOVED (the layout reacted) or something else is on
 * top of its press point (the surface it opened). Either way a real click at the
 * old coordinates is no longer the same action, so the retry is refused. A press
 * the page genuinely ignored leaves both unchanged, which is the one state the
 * retry exists for.
 */
export function pressPointIntact(el: Element, before: PressBox | null): boolean {
  try {
    if (!el.isConnected) return false;
    const now = boxOf(el);
    if (!now) return false;
    if (!samePressBox(before, now)) return false;
    const hit = deepHit(now.left + now.width / 2, now.top + now.height / 2);
    // The same rule activation uses: the press point belongs to the control when
    // the topmost node is the control or something inside it. An ANCESTOR is not
    // enough here (unlike `reachable`): a real click on it would not activate the
    // control we are about to press a second time.
    return !!hit && (hit === el || el.contains(hit));
  } catch (e) {
    return false;
  }
}
