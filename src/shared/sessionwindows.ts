// A session's window set: the rules that decide what a session's windows ARE,
// and which live window one of them describes.
//
// A session used to be one window, unwrapped. It now carries `windows`, but the
// flat fields stay authoritative for the FOCUSED window — so every reader has to
// answer the same question the same way ("which windows does this session have
// and in what order?"), and every restore has to answer a second one ("is this
// live window the saved one?"). Both live here, DOM-free and browser-free, so
// they can be pinned by tests instead of discovered through a launch.
//
// Why the window-set order is load-bearing: the FIRST saved window is the one a
// switch rebuilds in place (the window the user is looking at), and the rest are
// created. Order is therefore part of the behavior, not a detail.

import { splitTabsOf } from "./splits";
import type { Session, SessionTab, SessionWindow } from "./types";

/** The subset of a session this module reasons about. */
export type WindowSetSource = Pick<Session, "tabs" | "active" | "windowState" | "splits" | "windows">;

/**
 * The windows a session describes, in the order they should be restored.
 *
 * `windows` when it is present AND non-empty; otherwise the flat fields as a
 * single window — the shape every session saved by an older build has, and a
 * clean (empty) session still has, because "no tabs" is a legitimate window
 * that a restore turns into a blank home tab.
 */
export function sessionWindowsOf(s: WindowSetSource | null | undefined): SessionWindow[] {
  if (!s) return [];
  const ws = Array.isArray(s.windows) ? s.windows.filter((w) => !!w) : [];
  if (ws.length) return ws;
  return [
    {
      tabs: Array.isArray(s.tabs) ? s.tabs : [],
      active: typeof s.active === "number" ? s.active : 0,
      windowState: typeof s.windowState === "string" ? s.windowState : "normal",
      splits: typeof s.splits === "string" ? s.splits : "",
    },
  ];
}

/**
 * Build a session from a captured window set.
 *
 * The flat fields MIRROR the first window rather than being dropped: they are
 * what every pre-windows reader (and the tab move/copy paths) still uses, and a
 * session whose flat list disagreed with its own first window would restore one
 * thing and report another.
 */
export function sessionFromWindows(
  windows: SessionWindow[],
  name: string,
  marker: number,
  updatedAt: number
): Session {
  const first: SessionWindow =
    windows[0] || { tabs: [], active: 0, windowState: "normal", splits: "" };
  return {
    name,
    marker,
    tabs: first.tabs,
    active: first.active,
    windowState: first.windowState,
    updatedAt,
    splits: first.splits || "",
    windows: windows.map((w) => ({
      tabs: w.tabs || [],
      active: w.active || 0,
      windowState: w.windowState || "normal",
      splits: w.splits || "",
    })),
  };
}

/**
 * One window's split groups from the per-tab ids: 1-based positions over the
 * tabs a split can address (pinned tabs excluded, see splitTabsOf).
 *
 * 1-based because that is what the chrome helper resolves them against, and a
 * group of one is dropped: a lone id is a measurement in flight, not a split
 * (see layoutSettled in sessions/storage.ts), and pairing a tab with itself is
 * not a thing native split view can do.
 */
export function splitGroupsOfTabs(
  tabs: Array<Pick<SessionTab, "pinned" | "splitViewId">> | null | undefined
): number[][] {
  const byId = new Map<number, number[]>();
  splitTabsOf(tabs).forEach((t, i) => {
    if (typeof t.splitViewId === "number" && t.splitViewId >= 0) {
      const arr = byId.get(t.splitViewId) || [];
      arr.push(i + 1);
      byId.set(t.splitViewId, arr);
    }
  });
  return Array.from(byId.values()).filter((g) => g.length > 1);
}

/** A window's tabs reduced to what identifies it: content URLs, in strip order. */
export function contentUrls(tabs: Array<Pick<SessionTab, "url">> | null | undefined): string[] {
  return (tabs || []).filter((t) => !!t && !!t.url).map((t) => withoutHash(String(t.url)));
}

// A tab's URL with its fragment removed. `#lfc=` request hashes ride on real
// URLs and change under the user's feet, so a comparison that kept them would
// fail to recognise the very window it is looking at.
function withoutHash(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

/**
 * Which saved window a live window is, or -1.
 *
 * Matching is by content URLs, in order, and it is deliberately exact: a window
 * that gained or lost a tab since the save is NOT that saved window, and pairing
 * its layout onto the wrong window is worse than leaving it flat (it would pair
 * tabs the user never paired). `used` excludes saved windows already claimed by
 * another live one, so two identical windows cannot both claim the same record.
 */
export function matchSavedWindow(
  liveUrls: string[],
  saved: SessionWindow[],
  used?: Set<number>
): number {
  // Both sides go through the same normalization. The live side arrives as real
  // tab URLs, which carry `#lfc=` hashes that change under the user's feet; a
  // comparison that kept them would fail to recognise the very window it is
  // looking at, and the failure would be silent ("no window matched", so the
  // resume falls back to rebuilding everything).
  const live = (liveUrls || []).filter((u) => !!u).map((u) => withoutHash(String(u)));
  if (!live.length) return -1;
  for (let i = 0; i < saved.length; i++) {
    if (used && used.has(i)) continue;
    const w = saved[i];
    if (!w) continue;
    const urls = contentUrls(w.tabs);
    if (urls.length !== live.length) continue;
    let same = true;
    for (let k = 0; k < urls.length; k++) {
      if (urls[k] !== live[k]) {
        same = false;
        break;
      }
    }
    if (same) return i;
  }
  return -1;
}
