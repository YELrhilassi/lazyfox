// Where a split pair goes in the strip, and which panes are not real panes.
//
// Split out of splitview.ts. Both helpers exist because of the same measured
// behaviour — Firefox's addTabSplitView parks a new split at the STRIP END, and
// asynchronously — so every split operation that cares about tab numbering has
// to undo the same two things. They were inline in four separate operations,
// which is how one of them grew a subtly different copy.
//
//   insertOpt        tell Firefox where the pair already sits, so it does not
//                    move at all and the re-pin loop only has to absorb the
//                    asynchronous re-park
//   removePanelPanes drop the split-panel companion panes, which are pure UI
//                    ("move a tab into this split") and must not pile up once
//                    a real tab has moved in or the split has dissolved

import type { ChromeTab, SplitViewWrapper } from "./tabs";

/**
 * Options for addTabSplitView that keep a CONTIGUOUS, in-strip-order pair
 * exactly where it already sits.
 *
 * Firefox's default is to park a new split at the strip end (and to do so
 * asynchronously), so the re-pin loop would spend its first ticks hauling the
 * pair back. insertBefore places the wrapper before the tab that follows the
 * pair, so nothing moves at all; the loop then only needs to absorb Firefox's
 * async re-park. Builds before 152 that lack the options arg simply ignore it
 * (JS drops extra args) and the loop covers the parking shift exactly as
 * before.
 *
 * Only correct for an already contiguous pair — the auto-split path (a pair
 * forming from far-apart tabs) deliberately does NOT use it and relies on the
 * loop.
 */
export function splitInsertOpt(
  tabs: ChromeTab[],
  strip: ChromeTab[],
): { insertBefore?: ChromeTab } {
  try {
    let lastIdx = -1;
    for (const t of tabs) {
      const i = strip.indexOf(t);
      if (i > lastIdx) lastIdx = i;
    }
    const after = strip[lastIdx + 1];
    if (after) return { insertBefore: after };
  } catch (e) {
    // ignore
  }
  return {};
}

/**
 * Drop the split-panel companion pane(s) from a split view.
 *
 * They are pure UI — the "move a tab into this split" list — and must not pile
 * up as panes once a real tab has been moved in or the split is dissolved. A
 * pane the user navigated to real content is kept, which is why the test is
 * `isSplitPanelTab` rather than "is not the active tab".
 */
export function removeSplitPanelPanes(
  sv: SplitViewWrapper,
  isSplitPanelTab: (tab: ChromeTab) => boolean,
  removeTab: (tab: ChromeTab) => void,
): void {
  const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
  for (const p of panes) {
    try {
      if (!p || p.closing) continue;
      if (isSplitPanelTab(p)) removeTab(p);
    } catch (e) {
      // ignore
    }
  }
}