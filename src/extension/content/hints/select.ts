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
import { hintVisible, inViewport, reachable } from "./probe";
import { createVisibilityPass, type VisibilityPass } from "./visibility";
import { isMediaSurface, specificity } from "./collect";

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
//   viewport → CSS-visible → actually reachable (not occluded) → not a
//   duplicate/nested target.
// Elements are kept in document order, so the shortest keys still go to the
// first thing on the page. When a wrapper and a nested target both qualify the
// OUTER one wins (it owns the click) and the inner is dropped, so a `<button>`
// and the `<span>` inside it never produce two labels on the same pixels.
// The diagnostics page runs this exact function, so its numbers cannot drift
// from what `;f` really does.
// The shared selection pipeline every hint surface runs:
//   viewport → CSS-visible → actually reachable (not occluded) → not a
//   duplicate/nested target.
// Elements are kept in document order, so the shortest keys still go to the
// first thing on the page. When a wrapper and a nested target both qualify the
// OUTER one wins (it owns the click) and the inner is dropped, so a `<button>`
// and the `<span>` inside it never produce two labels on the same pixels.
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
  reach: (el: Element) => boolean = reachable
): SelectResult {
  const vis = pass || createVisibilityPass();
  const kept: Array<{ el: Element; r: DOMRect; key: string; covered: boolean }> = [];
  let hidden = 0;
  let covered = 0;
  let duplicate = 0;
  for (const el of candidates) {
    if (!inViewport(el) || !hintVisible(el, vis)) {
      hidden++;
      continue;
    }
    // Covered is a LABEL STATE, not a rejection (see the note at the top).
    const isCovered = !reach(el);
    if (isCovered) covered++;
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
      // keeps the container's early slot (and therefore a short key).
      if (s.el.contains(el)) {
        if (specificity(el) > specificity(s.el))
          kept[i] = { el: el, r: r, key: key, covered: isCovered };
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
        dup = true;
        break;
      }
      // This box sits almost entirely inside an earlier one: an absolutely
      // positioned overlay or inner copy of the same click area.
      if (!mediaPair && overlapFraction(r, sr) >= 0.85) {
        dup = true;
        break;
      }
      // Two handlers for the SAME destination that overlap heavily (a thumbnail
      // link stacked on the title link of one card) are one hint, not two.
      if (key && key === s.key && overlapFraction(r, sr) > 0.4) {
        dup = true;
        break;
      }
    }
    if (dup) {
      duplicate++;
      continue;
    }
    kept.push({ el: el, r: r, key: key, covered: isCovered });
    if (kept.length >= limit) break;
  }
  return {
    kept: kept.map((k) => ({ el: k.el, covered: k.covered })),
    hidden: hidden,
    covered: covered,
    duplicate: duplicate,
  };
}

