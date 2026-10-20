// Turning candidates into the batch that gets labels: in viewport → visible →
// reachable (not occluded) → not a nested/duplicate of something already kept.
//
// The order matters and the diagnostics page runs this exact function, so the
// numbers it reports are the numbers `;f` acted on.
//
// OCCLUSION DEGRADES THE LABEL, IT DOES NOT DELETE THE CONTROL.
//
// This used to be a veto: `reachable()` false dropped the candidate, so any
// control with something painted over it — a sticky header over the first row, a
// cookie wall, a player's control bar, an ad layer — simply had no key. That is
// the one failure the hint layer cannot recover from, because the user has no
// way to learn the control exists: there is nothing on screen to say "this one is
// there, but something is on top of it right now". A hint under a scrim is
// usually still activatable (activation clicks the ELEMENT, not the point the
// label sits on — see hints/activate.ts, which deliberately keeps the pointer
// sequence off a foreign target and still calls the control's own click), and
// when it is not, the existing activation watcher reports "the page did nothing"
// rather than silence (docs/HINTS.md §3).
//
// So a covered control is KEPT and FLAGGED. The flag reaches the overlay, which
// draws that label dimmed, and it is in the hint snapshot so a test can assert
// the state instead of inferring it from a missing key.
import { hintVisible, inViewport, reachable, sheetOver } from "./probe";
import { createVisibilityPass, type VisibilityPass } from "./visibility";
import { isMediaSurface, specificity } from "./collect";
import { BATCH_SCAN_FACTOR } from "./selectors";

/** One element that earned a label, and whether something is over it right now. */
export interface HintCandidate {
  el: Element;
  /**
   * Nothing of the control's own surface could be hit-tested when the batch was
   * built — an overlay, a sticky bar or a scrim is on top of it. The label is
   * drawn DIMMED and the key still works; see the note at the top of this file.
   */
  covered: boolean;
}

export interface SelectResult {
  kept: HintCandidate[];
  hidden: number;
  /** Kept, and flagged as covered. Not a rejection count any more. */
  covered: number;
  duplicate: number;
  /**
   * Fully hidden behind a SEPARATE surface (a dialog, a popup sheet, a modal),
   * and therefore not hinted at all — see hints/probe.ts sheetOver. This is not
   * the dimmed case: a dimmed label is a statement about the same surface ("the
   * control is here, something is painted over it"), while a label for a control
   * behind a dialog would be drawn on top of the dialog.
   */
  behind: number;
  /**
   * In view, visible, and left out because the batch was full — the number the
   * session says out loud ("N more in view — ] for the next batch"). It is the
   * count within the scanned window, not a census of the whole page; the point
   * is to tell the user that the cap, not the page, is why the rest have no key.
   */
  more: number;
}

/**
 * How much a candidate deserves one of the limited labels, when there are more
 * candidates in view than the cap allows.
 *
 * Deterministic by construction: geometry and order only — no clock, no
 * randomness, no state. A fully-visible control outranks a partially-clipped one
 * (a control half under the viewport edge is harder to read, and often half
 * under a sticky bar), and within each band the nearer the viewport centre wins,
 * because that is what the user is looking at. Equal scores are resolved by the
 * caller's stable sort, i.e. document order.
 */
export function rankScore(r: DOMRect, vw: number, vh: number): number {
  const fullyIn = r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
  const nx = vw > 0 ? (r.left + r.width / 2 - vw / 2) / (vw / 2) : 0;
  const ny = vh > 0 ? (r.top + r.height / 2 - vh / 2) / (vh / 2) : 0;
  const d = Math.min(Math.sqrt(nx * nx + ny * ny), 2);
  return (fullyIn ? 8 : 0) + (2 - d);
}

// The fraction of the smaller box covered by the intersection of two rects.
export function overlapFraction(a: DOMRect, b: DOMRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? (w * h) / minArea : 0;
}

// The destination a candidate actually leads to (an absolute href), so two
// overlapping handlers for the SAME place collapse to one hint.
export function targetKey(el: Element): string {
  let href = "";
  try {
    href = el.getAttribute("href") || "";
  } catch (e) {
    href = "";
  }
  if (!href) return "";
  try {
    return new URL(href, location.href).href;
  } catch (e) {
    return href;
  }
}

// The shared selection pipeline every hint surface runs:
//   viewport → CSS-visible → reachable (not occluded) → not a duplicate/nested
//   target → ranked into the batch.
//
// Elements are kept in document order while the batch has room, so on an
// ordinary page the shortest keys still go to the first thing on the page. When
// a wrapper and a nested target both qualify the most specific actionable one
// wins and takes the wrapper's slot, so a `<button>` and the `<span>` inside it
// never produce two labels on the same pixels.
//
// WHEN THE PAGE HAS MORE CONTROLS THAN LABELS, the batch is RANKED (see
// rankScore) instead of being the first N in document order. That cap used to be
// silent and first-come: on a dense page the header and the sidebar took the
// keys and the rows on screen got none, with nothing telling the user the rest
// were reachable with `]`. The count of what did not fit comes back as `more`, so
// the session can say it out loud.
//
// The diagnostics page runs this exact function, so its numbers cannot drift
// from what `;f` really does.
export function selectHintables(
  candidates: Element[],
  limit: number,
  // The SAME pass collection used, when the caller has one: the two halves ask
  // about the same elements (in-viewport is a subset of collected), so sharing
  // the cache means the selector matches are not re-walked here. Given none, a
  // one-shot pass is created — the pre-cache cost, nothing left behind.
  pass?: VisibilityPass,
  // The occlusion answer, injectable for the same reason the pass is: the claim
  // here is a POLICY (covered is kept and flagged), and a policy should be
  // testable without a browser to paint a scrim in. Defaults to the real probe.
  reach: (el: Element) => boolean = reachable,
  // The "is it behind a separate surface" answer, injectable for the same reason
  // the reach probe is: the rule is a policy, and a policy should be testable
  // without painting a modal in a browser. Defaults to the real geometry.
  sheet: (el: Element) => Element | null = sheetOver
): SelectResult {
  const vis = pass || createVisibilityPass();
  const cap = Math.max(1, Math.floor(limit) || 1);
  // Scan a bounded window past the cap: enough to keep what is on screen when a
  // page has far more controls than labels, small enough that the duplicate
  // scan below (quadratic by design) cannot own the main thread.
  const scanCap = cap * Math.max(1, Math.floor(BATCH_SCAN_FACTOR) || 1);
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const kept: Array<{ el: Element; r: DOMRect; key: string; covered: boolean; rank: number }> = [];
  let hidden = 0;
  let covered = 0;
  let duplicate = 0;
  let behind = 0;
  // A covered control must not outrank a clickable one that overlaps it: the
  // point of the label is to be pressed, and the earlier candidate is only a
  // duplicate because of where the page happened to put it. Replacing in place
  // keeps the surviving control's slot (and therefore its short key).
  function winsOver(loser: { covered: boolean }, newCovered: boolean): boolean {
    return !newCovered && loser.covered;
  }
  for (const el of candidates) {
    if (!inViewport(el) || !hintVisible(el, vis)) {
      hidden++;
      continue;
    }
    // Covered is a LABEL STATE, not a rejection (see the note at the top) — with
    // one exception: a control hidden behind another SURFACE (a dialog, a popup
    // sheet). There the label would be painted on top of the surface the user is
    // looking at, and the key would fire at something that surfaces is covering,
    // so it is not a hint at all. The distinction lives in probe.sheetOver and is
    // made on geometry, not on the page's identity.
    const isCovered = !reach(el);
    if (isCovered) {
      if (sheet(el)) {
        behind++;
        continue;
      }
      covered++;
    }
    const r = el.getBoundingClientRect();
    const key = targetKey(el);
    let dup = false;
    for (let i = 0; i < kept.length; i++) {
      const s = kept[i]!;
      // Nested targets. The OLD rule was "the outer element wins", which is
      // safe for a <span> inside a <button> and catastrophic for a small
      // control inside a big clickable container: the container is seen first
      // (document order) and then suppresses everything inside it, so a video
      // player's "Skip ad" button never got a label at all — the player did.
      //
      // The rule now is "the most specific actionable control wins", and the
      // container is replaced IN PLACE when it loses, so the surviving control
      // keeps the container's early slot (and therefore a short key). A
      // clickable control also beats a covered one at the same place, whatever
      // their specificity: one of the two can actually be pressed.
      if (s.el.contains(el)) {
        if (specificity(el) > specificity(s.el) || winsOver(s, isCovered))
          kept[i] = { el: el, r: r, key: key, covered: isCovered, rank: rankScore(r, vw, vh) };
        dup = true;
        break;
      }
      const sr = s.r;
      // A media surface and a control drawn over it are DIFFERENT actions (Skip
      // ad over a video, a play button over a thumbnail), and which of the two is
      // seen first depends only on how the control was discovered — selector
      // matches first, then walk order. So the "sits almost entirely inside an
      // earlier box" rule is skipped for such a pair, in EITHER direction, and
      // both keep their own key. The same-box rule below is NOT skipped: two
      // candidates on identical pixels are one click area whatever they are.
      const mediaPair = isMediaSurface(el) || isMediaSurface(s.el);
      // Same box within a couple of pixels: a wrapper/copy of the same target.
      if (
        Math.abs(r.left - sr.left) <= 2 &&
        Math.abs(r.top - sr.top) <= 2 &&
        Math.abs(r.width - sr.width) <= 2 &&
        Math.abs(r.height - sr.height) <= 2
      ) {
        if (winsOver(s, isCovered))
          kept[i] = { el: el, r: r, key: key, covered: isCovered, rank: rankScore(r, vw, vh) };
        dup = true;
        break;
      }
      // This box sits almost entirely inside an earlier one: an absolutely
      // positioned overlay or inner copy of the same click area. That is true
      // for a copy — and false for the very common framework shape where a
      // card's overlay link covers the card and the row's own buttons sit on top
      // of it as SIBLINGS: the button is the one the pointer can press, so a
      // clickable newcomer replaces a covered earlier box instead of vanishing.
      if (!mediaPair && overlapFraction(r, sr) >= 0.85) {
        if (winsOver(s, isCovered))
          kept[i] = { el: el, r: r, key: key, covered: isCovered, rank: rankScore(r, vw, vh) };
        dup = true;
        break;
      }
      // Two handlers for the SAME destination that overlap heavily (a thumbnail
      // link stacked on the title link of one card) are one hint, not two.
      if (key && key === s.key && overlapFraction(r, sr) > 0.4) {
        if (winsOver(s, isCovered))
          kept[i] = { el: el, r: r, key: key, covered: isCovered, rank: rankScore(r, vw, vh) };
        dup = true;
        break;
      }
    }
    if (dup) {
      duplicate++;
      continue;
    }
    kept.push({ el: el, r: r, key: key, covered: isCovered, rank: rankScore(r, vw, vh) });
    if (kept.length >= scanCap) break;
  }
  let more = 0;
  let chosen = kept;
  if (kept.length > cap) {
    // Stable sort (the spec guarantees it), so equal scores keep document order.
    chosen = kept.slice().sort((a, b) => b.rank - a.rank);
    more = chosen.length - cap;
    chosen = chosen.slice(0, cap);
  }
  return {
    kept: chosen.map((k) => ({ el: k.el, covered: k.covered })),
    hidden: hidden,
    covered: covered,
    duplicate: duplicate,
    behind: behind,
    more: more,
  };
}

