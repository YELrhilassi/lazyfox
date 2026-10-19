// The live session state pushed to the chrome helper's status bar: which
// session is current, where in the tab list you are, the native split state,
// the per-session pill summary, and the per-tab stealth flags.

import { core } from "../../shared/core";
import { isUITab } from "../tabs";
import { reconcileStealth, stealthContainers } from "../stealth";
import { readCurrentSessionName, readSessions } from "./storage";

export async function sessionState(): Promise<{
  name: string;
  marker: number;
  tabIndex: number;
  tabCount: number;
  inSplit: boolean;
  splitOrientation?: "horizontal" | "vertical";
  splitActive: number;
  splitPanes: number;
  sessions: { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[];
  tabIds: number[];
  activeStealth: boolean;
  stealthFlags: boolean[];
}> {
  await reconcileStealth();
  const allTabs = await browser.tabs.query({ currentWindow: true });
  const all = await readSessions();
  const name = (await readCurrentSessionName()) || "default";
  const cur = all[name];
  const marker = cur ? cur.marker || 0 : 0;
  // Numbering keys off REAL tabs only, so the status-bar tab index/count never
  // shifts when a companion split-panel pane is added/removed.
  const list = (allTabs || []).filter((t: any) => !isUITab(t));
  const active = list.findIndex((t: any) => t.active);
  let inSplit = false;
  let splitOrientation: "horizontal" | "vertical" | undefined;
  let splitActive = 0;
  let splitPanes = 0;
  if (active >= 0) {
    // Firefox 149+ native split view: tabs in the same split share a
    // splitViewId (read-only on the tabs API).
    const id = list[active] && (list[active] as any).splitViewId;
    if (typeof id === "number" && id >= 0) {
      const pair = (allTabs || []).filter((t: any) => t.splitViewId === id);
      inSplit = true;
      splitOrientation = "horizontal";
      splitPanes = pair.length || 2;
      splitActive = Math.max(0, pair.indexOf(list[active]));
    }
  }
  // Split count is derived in the Go core (decode the encoded layout, or fall
  // back to legacySplitTabs/2 for pre-encoding sessions), so this is a single
  // wasm call instead of one decode round-trip per session on every poll.
  const summaryInput: {
    name: string;
    marker: number;
    tabCount: number;
    splits: string;
    legacySplitTabs: number;
  }[] = [];
  for (const s of Object.values(all)) {
    summaryInput.push({
      name: s.name,
      marker: s.marker || 0,
      tabCount: (s.tabs || []).length,
      splits: s.splits || "",
      // Pre-encoding sessions: two tabs per split share one splitViewId.
      legacySplitTabs: (s.tabs || []).filter(
        (t: any) => typeof t.splitViewId === "number" && t.splitViewId >= 0
      ).length
    });
  }
  const summary = await core.sessionSummary(summaryInput, name);
  return {
    name,
    marker,
    tabIndex: active >= 0 ? active + 1 : 1,
    tabCount: list.length,
    inSplit,
    splitOrientation,
    splitActive,
    splitPanes,
    sessions: summary,
    // Real tab ids in strip order (transient tabs included), so the chrome
    // helper can show each tab's true id in the tab switcher popup.
    tabIds: (allTabs || []).map((t: any) => t.id),
    activeStealth:
      active >= 0 && !!list[active] && stealthContainers.has(list[active]!.cookieStoreId),
    // Parallel to tabIds (strip order) so the chrome helper can mark each
    // tab's stealth state without re-deriving it.
    stealthFlags: (allTabs || []).map((t: any) => stealthContainers.has(t.cookieStoreId))
  };
}
