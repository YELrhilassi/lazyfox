// Turning candidates into the batch that gets labels: in viewport → visible →
// reachable (not occluded) → not a nested/duplicate of something already kept.
//
// The order matters and the diagnostics page runs this exact function, so the
// numbers it reports are the numbers `;f` acted on.
import { hintVisible, inViewport, reachable } from "./probe";
import { specificity } from "./collect";

export interface SelectResult {
  kept: Element[];
  hidden: number;
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
export function selectHintables(candidates: Element[], limit: number): SelectResult {
  const kept: Array<{ el: Element; r: DOMRect; key: string }> = [];
  let hidden = 0;
  let covered = 0;
  let duplicate = 0;
  for (const el of candidates) {
    if (!inViewport(el) || !hintVisible(el)) {
      hidden++;
      continue;
    }
    if (!reachable(el)) {
      covered++;
      continue;
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
      // keeps the container's early slot (and therefore a short key).
      if (s.el.contains(el)) {
        if (specificity(el) > specificity(s.el)) kept[i] = { el: el, r: r, key: key };
        dup = true;
        break;
      }
      const sr = s.r;
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
      if (overlapFraction(r, sr) >= 0.85) {
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
    kept.push({ el: el, r: r, key: key });
    if (kept.length >= limit) break;
  }
  return {
    kept: kept.map((k) => k.el),
    hidden: hidden,
    covered: covered,
    duplicate: duplicate,
  };
}

