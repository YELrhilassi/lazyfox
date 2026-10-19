// The "why isn't this hinted?" report.
//
// It re-runs the ordinary collection and the ordinary viewport pass with
// counters attached, so what it reports is exactly what `;f` would do — not a
// second implementation that drifts. Nothing here clicks anything.
import { rectCenter, reachable, shortName, deepHit, inViewport, hintVisible } from "./probe";
import { collectHintables, type CollectStats } from "./collect";
import { selectHintables } from "./select";
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
  rejected: { hidden: number; duplicate: number };
  shadowRoots: number;
  pointerControls: number;
  /** Candidates that qualified only as a large media surface (a player's video). */
  mediaSurfaces: number;
  probes: HintProbe[];
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
    visited: 0,
    budgetMs: 0,
  };
  // ONE pass for both halves, so the report describes the run the live flow
  // makes (same caches, same order, same costs).
  const pass = createVisibilityPass();
  const pool = collectHintables(stats, pass);
  // Same selection the live flow runs, so the counters are the truth.
  const sel = selectHintables(pool, MAX_HINTS, pass);

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
    let reason: string;
    if (!vis) reason = "outside the viewport (page to it with ])";
    else if (reach) reason = "clickable here";
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
    rejected: { hidden: sel.hidden, duplicate: sel.duplicate },
    shadowRoots: stats.shadowRoots,
    pointerControls: stats.pointerControls,
    mediaSurfaces: stats.mediaSurfaces,
    probes: probes,
  };
}
