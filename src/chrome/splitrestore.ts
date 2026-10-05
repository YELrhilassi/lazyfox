// Re-creating saved split groupings after a session restore.
//
// Split out of splitview.ts. Restoring splits is not a split operation: it
// never runs from a keypress, it runs once per session restore, and it has to
// WAIT for the window to finish rebuilding before it can mean anything. Keeping
// it next to `;W m` and `;|` made the wait-for-the-strip rule look like part of
// those, and it is the rule most likely to be re-broken by someone editing
// them.
//
// Two things this module exists to get right, both of which were measured:
//
//  - Positions resolve against realTabs() (which skips the splitpanel companion
//    and the throwaway #lfc= request relays), never gBrowser.tabs directly.
//    Indexing the raw list is shifted by those transient tabs and by any
//    pinned tabs the restore left in front, which pairs the wrong tabs or none.
//  - The saved order only exists once the restore has finished rebuilding the
//    strip. A tab opened into a fresh content process appears in the parent's
//    gBrowser.tabs a tick or two after tabs.create resolves, so pairing
//    immediately resolves a saved position against the OLD tabs still being
//    torn down, and the restored session comes back with a flat strip.

import type { ChromeTab } from "./tabs";

export interface SplitRestoreDeps {
  setTimeout(fn: () => void, ms: number): void;
  // The window's REAL tabs in strip order (no split panel, no relay).
  realTabs(): ChromeTab[];
  /** The window's native split-view entry point. */
  addTabSplitView(tabs: ChromeTab[], opts?: { insertBefore?: ChromeTab }): void;
  /** A stable snapshot of the strip order, to pin back after parking pairs. */
  stripSnapshot(): ChromeTab[];
  /** Park a pair exactly where it already sits instead of at the strip end. */
  insertOpt(pair: ChromeTab[]): { insertBefore?: ChromeTab };
  /** Pin the strip back to a snapshot after Firefox regroups it. */
  repinAfterSplit(want: ChromeTab[]): void;
  /** Refresh the remembered split so `;W m` still targets a restored group. */
  rememberSplit(): void;
  /** Is this build's native split view usable at all? */
  nativeSplitAvailable(): boolean;
}

export interface SplitRestorer {
  /**
   * @param groups 1-based positions over the SAVED tab list, grouped
   * @param expect how many real tabs the restore should end with, when the
   *   caller knows it. Without it the wait falls back to "at least as many tabs
   *   as the highest saved position", which the old strip usually satisfies
   *   while it is still being torn down.
   */
  (groups: number[][], expect?: number): void;
}

export function createSplitRestorer(deps: SplitRestoreDeps): SplitRestorer {
  function runRestoreSplits(groups: number[][]): void {
    try {
      // The restore re-opened the saved tabs in saved order, so the strip IS the
      // saved order right now. Snapshot it, form every group, then pin the strip
      // back — addTabSplitView parks each pair where it pleases (usually the
      // strip end), which would otherwise renumber every tab.
      const preStrip = deps.stripSnapshot();
      // Resolve the 1-based saved positions against non-pinned real tabs. A
      // restore re-opens saved tabs in order as unpinned tabs AFTER any pinned
      // tabs left in front, so pinned tabs must not offset the positions (split
      // view never involves pinned tabs).
      const real = deps.realTabs().filter((t) => !t.pinned);
      for (const g of groups) {
        const tabs = (g || []).map((i) => real[i - 1]).filter((t) => !!t);
        if (tabs.length > 1) {
          // Restored tabs are contiguous and in saved order, so the pair can be
          // parked exactly where it already sits instead of the strip end.
          deps.addTabSplitView(tabs, deps.insertOpt(tabs));
        }
      }
      deps.repinAfterSplit(preStrip);
      // Refresh the remembered split so a later `;W m` with the selected tab
      // outside the split still targets a restored group (the selected tab's
      // own .splitview only covers the case where it sits inside one).
      deps.rememberSplit();
    } catch (e) {
      // ignore
    }
  }

  return function restoreSplits(groups: number[][], expect?: number): void {
    try {
      if (!Array.isArray(groups) || !groups.length) return;
      if (!deps.nativeSplitAvailable()) return;
      // What identifies the settled state is the COUNT — after a restore of N
      // tabs the strip holds exactly N real (unpinned, non-transient) tabs.
      const need = groups.reduce((mx, g) => {
        const idx = Array.isArray(g) ? g.reduce((a, b) => (b > a ? b : a), 0) : 0;
        return idx > mx ? idx : mx;
      }, 0);
      const target = typeof expect === "number" && expect > 0 ? expect : need;
      const real = () => deps.realTabs().filter((t) => !t.pinned);
      const ready = () => {
        const n = real().length;
        return typeof expect === "number" && expect > 0 ? n === target : n >= target;
      };
      if (ready()) {
        runRestoreSplits(groups);
        return;
      }
      let tries = 0;
      const tick = () => {
        if (ready() || tries++ >= 60) {
          runRestoreSplits(groups);
          return;
        }
        deps.setTimeout(tick, 50);
      };
      deps.setTimeout(tick, 50);
    } catch (e) {
      // ignore
    }
  };
}