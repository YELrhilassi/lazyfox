// The page half of Lazyfox's diagnostics: everything the content script knows
// about the page it is running in, collected on demand for the diagnostics page.
//
// It is deliberately the SAME code path the live features use — diagnoseHints
// re-runs the hint collection with counters, and the scroll report comes from
// the running scroll controller — so what the page shows is what `;f` and
// `j`/`k` would really do, not a second implementation that drifts.
//
// Nothing here clicks, scrolls, types or mutates the page: a diagnosis must
// never have side effects.

import type { PageReport } from "../../shared/types";
import { diagnoseHints, type LinkHints } from "./hints";
import type { ScrollController } from "./scroll";

// How many candidates the probe table shows. Enough to spot the pattern in a
// framework UI without turning the page into a wall of text.
const PROBE_LIMIT = 24;

// Frames per second over a short window. A page that answers `;f` in 30ms but
// repaints at 12fps is painful in a way no timing number shows.
function measureFps(ms: number): Promise<number> {
  return new Promise((resolve) => {
    let frames = 0;
    let start = 0;
    let done = false;
    const finish = (fps: number) => {
      if (done) return;
      done = true;
      resolve(fps);
    };
    // A hidden tab (or a page that never paints) would otherwise hang the
    // report forever.
    const bail = setTimeout(() => finish(-1), ms * 2 + 250);
    const tick = (t: number) => {
      if (done) return;
      if (!start) start = t;
      frames++;
      const elapsed = t - start;
      if (elapsed >= ms) {
        clearTimeout(bail);
        finish(elapsed > 0 ? Math.round((frames * 1000) / elapsed) : -1);
        return;
      }
      requestAnimationFrame(tick);
    };
    try {
      requestAnimationFrame(tick);
    } catch (e) {
      clearTimeout(bail);
      finish(-1);
    }
  });
}

function describeEditor(): string {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return "none";
  const tag = String(el.tagName || "").toLowerCase();
  const role = el.getAttribute("role") || "";
  const editable = el.isContentEditable ? " (contenteditable)" : "";
  const name = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  return (
    tag +
    (role ? "[" + role + "]" : "") +
    editable +
    (name ? " " + name.slice(0, 40) : "")
  );
}

function readPerf(): PageReport["perf"] {
  let domNodes = 0;
  try {
    domNodes = document.getElementsByTagName("*").length;
  } catch (e) {
    // ignore
  }
  let resources = 0;
  let transferKB = 0;
  let cachedResources = 0;
  let networkResources = 0;
  try {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    resources = entries.length;
    let bytes = 0;
    for (const r of entries) {
      const size = r.transferSize || 0;
      bytes += size;
      // transferSize is 0 when the response came from the browser cache (no
      // bytes crossed the wire) and non-zero for a real network fetch. The
      // one false positive is a cross-origin response with no
      // Timing-Allow-Origin header, which also reports 0 — a close-enough
      // proxy for "the browser did not need to download it this time".
      if (size > 0) networkResources++;
      else cachedResources++;
    }
    transferKB = Math.round(bytes / 1024);
  } catch (e) {
    // ignore
  }
  let loadMs = -1;
  let domContentLoadedMs = -1;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      loadMs = Math.round(nav.loadEventEnd || nav.duration || 0);
      domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd || 0);
    }
  } catch (e) {
    // ignore
  }
  let heapMB: number | null = null;
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    if (mem && typeof mem.usedJSHeapSize === "number") {
      heapMB = Math.round((mem.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
    }
  } catch (e) {
    heapMB = null;
  }
  return {
    domNodes,
    fps: -1,
    heapMB,
    resources,
    transferKB,
    cachedResources,
    networkResources,
    loadMs,
    domContentLoadedMs,
  };
}

export async function collectPageReport(
  scroll: ScrollController,
  linkHints?: LinkHints,
): Promise<PageReport> {
  const hints = diagnoseHints(PROBE_LIMIT);
  const perf = readPerf();
  const fps = await measureFps(400);
  return {
    ok: true,
    url: String(location.href || ""),
    title: String(document.title || ""),
    readyState: String(document.readyState || ""),
    hints: {
      candidates: hints.candidates,
      hinted: hints.hinted,
      rejected: hints.rejected,
      probes: hints.probes,
      shadowRoots: hints.shadowRoots,
      pointerControls: hints.pointerControls,
      // The outcome of the last activation, so the page can answer "I pressed
      // the key and nothing happened" with a fact instead of a guess.
      lastActivation: linkHints ? linkHints.lastActivation() : null,
    },
    scroll: {
      target: scroll.currentLabel(),
      custom: scroll.isCustom(),
      regions: scroll.regions(),
    },
    editor: describeEditor(),
    perf: { ...perf, fps },
  };
}
