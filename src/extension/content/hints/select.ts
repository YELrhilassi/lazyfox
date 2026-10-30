// Turning candidates into the batch that gets labels: in viewport → visible →
// ON THE PAGE'S VISIBLE SURFACE → not a nested/duplicate of something already
// kept.
//
// The order matters and the diagnostics page runs this exact function, so the
// numbers it reports are the numbers `;f` acted on.
//
// OCCLUSION IS A SHARE, AND A LABEL IS ONLY DRAWN WHERE THE CONTROL IS VISIBLE.
//
// Two earlier policies both failed the user, in opposite directions:
//
//   1. `reachable()` was a veto, so a control with anything painted over any of
//      its points was dropped entirely. On a page with a sticky header or a
//      floating player bar that is most of the first screen: "there is a button
//      right there and no hint ever appears for it".
//   2. it became "keep it, flag it, draw it dimmed". That produced labels for
//      controls nobody can see: on a page that stacks two layers of content
//      (a carousel keeping its slides, a duplicated sticky shell, a drawer
//      holding the previous screen) the layer underneath got a whole faint batch
//      of its own, and a control behind a dialog got a label drawn ON the dialog
//      — because labels live in the top layer.
//
// The answer is neither: a control is on the user's surface by a DEGREE, and the
// degree decides both whether it may be labelled and where. `coverageOf` samples
// a grid over the control and reports the share of its own pixels the pointer can
// reach, the first thing covering the rest, whether the control is topmost at its
// own centre, and the free point its label belongs at.
//
//   * less than MIN_VISIBLE_SHARE of it is its own surface → NOT hinted. That is
//     the faint batch under a folded layer and the label on top of a dialog,
//     gone at the cause rather than dimmed;
//   * the rest of its surface is free → hinted, at full strength, anchored to
//     the visible part (see the overlay), because a label half under a sticky bar
//     is the same lie at a smaller scale;
//   * `covered` survives only as a DIAGNOSTIC: "part of this control is painted
//     over". It no longer changes how the label is drawn.
import { coverageOf, hintVisible, inViewport, type Coverage } from "./probe";
import { composedContains, createVisibilityPass, type VisibilityPass } from "./visibility";
import { specificity } from "./collect";
import { BATCH_SCAN_FACTOR, MIN_VISIBLE_SHARE } from "./selectors";
import { coverageBench } from "./probe";

function nowMs(): number {
  try {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * What the LAST selectHintables call cost, and where. Diagnostics only: the dev
 * snapshot reads this to answer "the select pass is slow" with numbers.
 * `coverage` aggregates the defaults real probe (coverageBench) whenever the
 * default cover is what was driven; an injected cover is a test's, and its cost
 * is not the engine's.
 */
export const selectBench = {
  /** Candidates handed in. */
  candidates: 0,
  /** Candidates the loop actually judged before the scan cap stopped it. */
  judged: 0,
  coverageCalls: 0,
  coverageMs: 0,
  clipMs: 0,
  sampleMs: 0,
  samples: 0,
};

/** One element that earned a label, and where its label belongs. */
export interface HintCandidate {
  el: Element;
  /**
   * Part of the control's own surface is painted over (a sticky bar, a badge),
   * so its label is anchored to the visible part (see `ax`/`ay`). This is a
   * fact for the diagnostics page only — the label is drawn at full strength.
   */
  covered: boolean;
  /** Fraction of the control's box the label should be anchored at. */
  ax?: number;
  ay?: number;
}

/**
 * Why one candidate did not get a label.
 *
 * Reported only when a caller asks (the diagnostics pass does, `;f` does not),
 * because it is the answer the "why isn't this important button hinted" report
 * has never had: a rejection count says SOMETHING was dropped, never which rule
 * dropped it nor what won instead.
 */
export interface Rejection {
  el: Element;
  reason: "hidden" | "behind" | "duplicate" | "not-scanned";
  /** Which duplicate rule collapsed it, when `reason` is "duplicate". */
  rule?: "nested" | "same-box" | "inside" | "same-target";
  /** The kept element the candidate lost to. */
  by?: Element;
}

export interface SelectResult {
  kept: HintCandidate[];
  hidden: number;
  /** Kept, with part of its surface painted over. Not a filter stage. */
  covered: number;
  duplicate: number;
  /**
   * Not enough of the control is on the page's visible surface to be honest
   * about: a dialog, a popup sheet, an opaque layer above it, or the layer
   * underneath a stacked page. These are NOT hinted at all — a label for a
   * control behind a dialog would be drawn on top of the dialog, and a label for
   * the layer under a folded page points at pixels nobody can see.
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
 * Two bands and nothing else. A fully-visible control outranks one that pokes
 * into the viewport only partly (a control half under the edge is harder to
 * read, and often half under a sticky bar); within a band the stable sort's
 * anchor — document order — decides, so the batch reads like the page: the nav
 * bar and the first rows get keys before the middle, and the ones that did not
 * fit are the page's BOTTOM, counted as `more`, not a silent hole in the top.
 *
 * The centre-distance term this ranking used to carry is gone, and that was
 * deliberate. It dropped the page's top edge on exactly the pages the user
 * reads first: a HN front page kept its middle rows and lost the nav bar and
 * the first five posts (the real-page diagnostic answered "not reached (batch
 * scan limit)" for the nav links). "Reading order" is also what the tie-break
 * has always been on a sub-cap page, so over the cap and under it now behave
 * the same way instead of two different heuristics.
 *
 * Deterministic by construction: geometry and index only — no clock, no
 * randomness, no state. Equal scores are resolved by the caller's stable sort,
 * i.e. document order.
 */
export function rankScore(r: DOMRect, vw: number, vh: number): number {
  const fullyIn = r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
  return fullyIn ? 8 : 0;
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

// One entry in the kept list. `top` is the candidate's answer to "is the pointer
// on me at my own centre?", which the duplicate rules use to tell a control that
// merely overlaps a bigger clickable box from a copy painted underneath it.
interface Kept {
  el: Element;
  r: DOMRect;
  key: string;
  covered: boolean;
  rank: number;
  top: boolean;
  ax: number;
  ay: number;
}

// The shared selection pipeline every hint surface runs:
//   viewport → CSS-visible → on the visible surface → not a duplicate/nested
//   target → ranked into the batch.
//
// Elements are kept in document order while the batch has room, so on an
// ordinary page the shortest keys still go to the first thing on the page. When
// a wrapper and a nested target both qualify the most specific actionable one
// wins and takes the wrapper's slot, so a `<button>` and the `<span>` inside it
// never produce two labels on the same pixels.
//
// WHEN THE PAGE HAS MORE CONTROLS THAN LABELS, the batch is RANKED (see
// rankScore): fully-visible controls first, then reading order — the top of the
// page is hinted before the bottom, the way the user reads. The cap used to be
// silent and first-come over everything INCLUDING off-screen controls — on a
// dense page the one thing visible got the keys and the user could not reach
// anything on it — and a later experiment ranked by distance to the viewport
// centre, which threw away the top edge on reading-first pages (the HN report:
// no nav, no first posts). Off-screen and half-clipped controls still lose to
// fully visible ones. The count of what did not fit comes back as `more`, so
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
  // The paint-coverage answer, injectable for the same reason the pass is: the
  // claim here is a POLICY (how much of a control must be on screen to earn a
  // label, and which control wins a shared area), and a policy should be
  // testable without a browser to stack two layers in. Defaults to the real
  // probe.
  cover: (el: Element) => Coverage = coverageOf,
  // Called once per rejected candidate, with the rule and the winner. Absent on
  // the live path (`;f`): the pass must not pay for an explanation nobody reads.
  explain?: (r: Rejection) => void
): SelectResult {
  const vis = pass || createVisibilityPass();
  const cap = Math.max(1, Math.floor(limit) || 1);
  selectBench.candidates = candidates.length;
  selectBench.judged = 0;
  selectBench.coverageCalls = 0;
  selectBench.coverageMs = 0;
  if (cover === coverageOf) {
    coverageBench.clipMs = 0;
    coverageBench.sampleMs = 0;
    coverageBench.samples = 0;
  }
  // Scan a bounded window past the cap: enough to keep what is on screen when a
  // page has far more controls than labels, small enough that the duplicate
  // scan below (quadratic by design) cannot own the main thread.
  const scanCap = cap * Math.max(1, Math.floor(BATCH_SCAN_FACTOR) || 1);
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const kept: Kept[] = [];
  let hidden = 0;
  let covered = 0;
  let duplicate = 0;
  let behind = 0;
  // How many candidates the loop actually judged (the rest are not-scanned).
  let visited = 0;
  // A partly covered control must not outrank a fully visible one that overlaps
  // it: the point of the label is to be read, and the earlier candidate is only a
  // duplicate because of where the page happened to put it. Replacing in place
  // keeps the survivor's slot (and therefore its short key).
  function outranks(s: Kept, cov: Coverage, isCovered: boolean): boolean {
    // The pointer is on the newcomer at its own centre and not on the incumbent:
    // the newcomer is the pressable surface, whatever the boxes say.
    if (cov.top && !s.top) return true;
    return s.covered && !isCovered;
  }
  // TWO PHASES, so the expensive samples are spent on the batch that could
  // exist.
  //
  // Phase 1 is the cheap gate — in viewport + CSS visible — plus the rank
  // favour lists. It runs over every candidate and costs one rect read each,
  // which the phase-2 body reuses instead of reading again.
  //
  // Phase 2 walks a WINDOW of at most scanCap candidates, the ranked best
  // (favour lists first, then document order), and spends the coverage
  // sampling and duplicate scanning there. When a page presents more visible
  // controls than the window can judge, coverage was previously paid for ALL
  // of them — nine hit tests each — and the surplus was discarded by the cap
  // at the end: hundreds of milliseconds of hits for labels that would never
  // exist. The surplus is still judged (phase 1) and, if the window is full,
  // reported as not-scanned; `more` says the cap, not the page, is why.
  //
  // Sub-cap pages are unchanged: with everything judged, the window is
  // document order and the kept list comes back in document order exactly as
  // before.
  interface Judged {
    el: Element;
    r: DOMRect;
    rank: number;
    idx: number;
  }
  const judged: Judged[] = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const el = candidates[ci]!;
    if (!inViewport(el) || !hintVisible(el, vis)) {
      hidden++;
      if (explain) explain({ el: el, reason: "hidden" });
      continue;
    }
    let r: DOMRect;
    try {
      r = el.getBoundingClientRect();
    } catch {
      hidden++;
      if (explain) explain({ el: el, reason: "hidden" });
      continue;
    }
    judged.push({ el: el, r: r, rank: rankScore(r, vw, vh), idx: ci });
  }
  const ranked = judged.length > scanCap
    ? judged.slice().sort((a, b) => b.rank - a.rank || a.idx - b.idx)
    : judged;
  for (const j of ranked) {
    visited++;
    const el = j.el;
    const covT0 = nowMs();
    const cov = cover(el);
    selectBench.coverageCalls++;
    selectBench.coverageMs += nowMs() - covT0;
    const share = cov.total > 0 ? cov.own / cov.total : 0;
    // NOT ENOUGH OF IT IS VISIBLE TO POINT AT. There is no label that can be
    // honest here: it would be painted on top of whatever is covering the
    // control (labels live in the top layer), or on the sliver of a layer the
    // page has folded away. See the note at the top of this file.
    if (share < MIN_VISIBLE_SHARE) {
      behind++;
      if (explain) explain({ el: el, reason: "behind" });
      continue;
    }
    // Part of it is painted over but most of it is on screen: keep it, and let
    // the anchor put the label on the visible part. No dimming — a faint label
    // is the same lie as a label on the covering layer, just quieter.
    const isCovered = cov.own < cov.total;
    if (isCovered) covered++;
    const r = j.r;
    const key = targetKey(el);
    const entry: Kept = {
      el: el,
      r: r,
      key: key,
      covered: isCovered,
      rank: j.rank,
      top: cov.top,
      ax: cov.ux,
      ay: cov.uy,
    };
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
      // COMPOSED containment, so a component host and the control its shadow
      // root paints are one click area rather than two labels on the same
      // pixels. `Node.contains` cannot see across that boundary; the composed
      // walk can, at any nesting depth.
      if (composedContains(s.el, el)) {
        if (specificity(el) > specificity(s.el) || outranks(s, cov, isCovered)) kept[i] = entry;
        else if (explain) explain({ el: el, reason: "duplicate", rule: "nested", by: s.el });
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
        if (outranks(s, cov, isCovered)) kept[i] = entry;
        else if (explain) explain({ el: el, reason: "duplicate", rule: "same-box", by: s.el });
        dup = true;
        break;
      }
      // "THIS BOX SITS ALMOST ENTIRELY INSIDE AN EARLIER ONE" IS NO LONGER A
      // DUPLICATE RULE, and deleting it is the fix for missing hints.
      //
      // The shape it was written for — an absolutely positioned overlay copy of
      // the same click area — is already gone before this point: if the copy is
      // painted under the earlier element, that element is what the pointer sees,
      // so the copy's coverage is zero and it was never hinted. What the rule
      // actually caught on real pages was a card's full-card link and the card's
      // own buttons drawn over it as SIBLINGS: both are visible, both are
      // pressable, both are separate actions, and the geometry merely says the
      // button's box is inside the link's. The button lost its key — the
      // reported "some hints are missing (maybe they got filtered out)".
      //
      // Two controls that both have their own pixels on screen are two controls.
      // Nested ones were already collapsed above (composed containment), and two
      // handlers for one destination are collapsed below by the href rule.
      //
      // Two handlers for the SAME destination that overlap heavily (a thumbnail
      // link stacked on the title link of one card) are one hint, not two.
      if (key && key === s.key && overlapFraction(r, sr) > 0.4) {
        if (outranks(s, cov, isCovered)) kept[i] = entry;
        else if (explain) explain({ el: el, reason: "duplicate", rule: "same-target", by: s.el });
        dup = true;
        break;
      }
    }
    if (dup) {
      duplicate++;
      continue;
    }
    kept.push(entry);
    if (kept.length >= scanCap) break;
  }
  selectBench.judged = visited;
  selectBench.clipMs = coverageBench.clipMs;
  selectBench.sampleMs = coverageBench.sampleMs;
  selectBench.samples = coverageBench.samples;
  if (explain) {
    // Ranked-out (cheap-judged but never cover-tested) and unjudged (beyond
    // the phase-1 gate list) are both "not scanned for a label"; give each
    // explanation its own element so a diagnostic cannot double-report.
    for (let i = visited; i < ranked.length; i++) {
      explain({ el: ranked[i]!.el, reason: "not-scanned" });
    }
    for (let i = ranked.length; i < candidates.length; i++) {
      explain({ el: candidates[i]!, reason: "not-scanned" });
    }
  }
  let more = 0;
  let chosen = kept;
  if (kept.length > cap) {
    // Stable sort (the spec guarantees it), so equal scores keep the order the
    // window was walked in — document order on a sub-cap page, and the ranked
    // window's own rank-then-document order on a full one.
    chosen = kept.slice().sort((a, b) => b.rank - a.rank);
    more = chosen.length - cap;
    chosen = chosen.slice(0, cap);
  }
  return {
    kept: chosen.map((k) => ({ el: k.el, covered: k.covered, ax: k.ax, ay: k.ay })),
    hidden: hidden,
    covered: covered,
    duplicate: duplicate,
    behind: behind,
    more: more,
  };
}
