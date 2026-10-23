// The "why isn't this hinted?" report.
//
// It re-runs the ordinary collection and the ordinary viewport pass with
// counters attached, so what it reports is exactly what `;f` would do — not a
// second implementation that drifts. Nothing here clicks anything.
import { rectCenter, reachable, shortName, deepHit, inViewport, hintVisible, sheetOver } from "./probe";
import { collectHintables, type CollectStats } from "./collect";
import { selectHintables, type Rejection } from "./select";
import { createVisibilityPass } from "./visibility";
import { MAX_HINTS } from "./selectors";
import type { HintProbe } from "../../../shared/types";

export interface HintDiagnosticsSnapshot {
  candidates: number;
  hinted: number;
  /**
   * Hinted, with a DIMMED label: something is over the control right now. It is
   * a state of the batch, not a rejection — the key still fires.
   */
  covered: number;
  rejected: { hidden: number; duplicate: number; behind: number };
  /**
   * In view, visible, and left out because the batch was full. `;f` says this
   * number out loud; the page shows it so "why is that row not hinted" has an
   * answer that is not a guess.
   */
  more: number;
  /**
   * The expensive tier did not finish the document. The SELECTOR matches are
   * complete; what may be missing from this run is a control only the
   * cursor:pointer / media-surface tier would have found. `truncatedBy` says
   * which bound was hit: `probes` is the deterministic node budget, `time` the
   * emergency wall-clock stop, `deferred` an over-full off-screen list, `scan`
   * the cheap tier's MAX_SCAN. See hints/collect.ts.
   */
  truncated: boolean;
  truncatedBy: "probes" | "time" | "deferred" | "scan" | null;
  shadowRoots: number;
  pointerControls: number;
  /** Candidates that qualified only as a large media surface (a player's video). */
  mediaSurfaces: number;
  /** Nodes the expensive tier probed, and the budget it was given. */
  probed: number;
  probeCap: number;
  probes: HintProbe[];
  /**
   * In view, visible, and NOT labelled — each with the pipeline rule that
   * dropped it and, for a duplicate, what won instead.
   *
   * This is the half of the report the counts could not express. `rejected`
   * said "110 were duplicates", which is not actionable: the questions are
   * WHICH rule and WHICH control took the slot, and on a dense app shell the
   * answer is often a generic wrapper beating a real link inside it.
   */
  unlabeled: Array<{ tag: string; name: string; reason: string }>;
}

/** The reason a rejected candidate carries, in words, for the report. */
function describeRejection(r: Rejection): string {
  if (r.reason === "duplicate") {
    const by = r.by ? shortName(r.by) : "?";
    return "duplicate of " + by + " (" + (r.rule || "?" ) + ")";
  }
  if (r.reason === "behind") return "behind a dialog or overlay";
  if (r.reason === "not-scanned") return "not reached (batch scan limit)";
  return "outside the viewport or not visible";
}

// The diagnostics page's view of the hint pipeline. It re-runs the ordinary
// collection and the ordinary viewport pass with counters attached, so what it
// reports is exactly what `;f` would do — not a second, drifting code path.
// Nothing here clicks anything.
export function diagnoseHints(limit: number): HintDiagnosticsSnapshot {
  const stats: CollectStats = {
    shadowRoots: 0,
    pointerControls: 0,
    mediaSurfaces: 0,
    truncated: false,
    truncatedBy: null,
    visited: 0,
    budgetMs: 0,
    probes: 0,
    probeCap: 0,
    deferred: 0,
  };
  // ONE pass for both halves, so the report describes the run the live flow
  // makes (same caches, same order, same costs).
  const pass = createVisibilityPass();
  const pool = collectHintables(stats, pass);
  // Same selection the live flow runs, so the counters are the truth. The
  // explain sink is the ONE difference and it changes no decision.
  const why = new Map<Element, string>();
  const sel = selectHintables(pool, MAX_HINTS, pass, undefined, undefined, (r) => {
    why.set(r.el, describeRejection(r));
  });
  const kept = new Set<Element>(sel.kept.map((k) => k.el));
  const unlabeled: HintDiagnosticsSnapshot["unlabeled"] = [];
  for (const el of pool) {
    if (kept.has(el)) continue;
    let seen = false;
    try {
      seen = inViewport(el) && hintVisible(el, pass);
    } catch (e) {
      seen = false;
    }
    if (!seen) continue;
    unlabeled.push({
      tag: String(el.tagName || "?").toLowerCase(),
      name: shortName(el),
      reason: why.get(el) || "not selected",
    });
  }

  const probes: HintProbe[] = [];
  for (const el of pool.slice(0, Math.max(0, limit))) {
    let cursor = "";
    let role = "";
    let href = false;
    try {
      cursor = getComputedStyle(el).cursor;
      role = el.getAttribute("role") || "";
      href = el.tagName === "A" && !!(el as HTMLAnchorElement).href;
    } catch (e) {
      // ignore
    }
    const vis = inViewport(el) && hintVisible(el, pass);
    const center = rectCenter(el);
    const hit = vis ? deepHit(center[0], center[1]) : null;
    const reach = vis && reachable(el);
    // Covered by a SEPARATE surface (a dialog, a popup sheet): the label is not
    // drawn at all, because it would be drawn on top of that surface.
    const sheet = reach ? null : sheetOver(el);
    let reason: string;
    // THE SELECTION'S OWN ANSWER COMES FIRST when the element has none: a row
    // that is visible and clickable but carries no label is the reported shape
    // ("the important ones don't show"), and "clickable here" was the least
    // useful thing to tell it. The rule that dropped it, and what took its slot,
    // is the answer.
    const dropped = kept.has(el) ? "" : why.get(el) || "";
    if (!vis) reason = "outside the viewport (page to it with ])";
    else if (dropped) reason = dropped + " \u2014 no label";
    else if (reach) reason = "clickable here";
    else if (sheet)
      reason =
        "behind " +
        String(sheet.tagName || "?").toLowerCase() +
        " (a dialog or overlay) \u2014 not hinted";
    else
      reason =
        "covered by " +
        (hit ? String(hit.tagName || "?").toLowerCase() : "another element") +
        " \u2014 still hinted, label dimmed";
    probes.push({
      tag: String(el.tagName || "?").toLowerCase(),
      role: role,
      name: shortName(el),
      href: href,
      cursor: cursor,
      reachable: reach,
      reason: reason,
    });
  }

  return {
    candidates: pool.length,
    hinted: sel.kept.length,
    covered: sel.covered,
    rejected: { hidden: sel.hidden, duplicate: sel.duplicate, behind: sel.behind },
    more: sel.more,
    truncated: stats.truncated,
    truncatedBy: stats.truncatedBy,
    shadowRoots: stats.shadowRoots,
    pointerControls: stats.pointerControls,
    mediaSurfaces: stats.mediaSurfaces,
    probed: stats.probes,
    probeCap: stats.probeCap,
    probes: probes,
    unlabeled: unlabeled,
  };
}
