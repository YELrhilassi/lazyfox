// Session storage + window snapshotting.
//
// storage owns the read/write of the named-session map and the current-session
// pointer. snapshot captures a live window (tabs, active index, window state,
// native split layout) into the persisted Session shape, and rebuild gives the
// restore path the primitives to turn a snapshot back into tabs.

import { core } from "../../shared/core";
import type { Session, SessionTab } from "../../shared/types";
import { CC_URL, isUITab } from "../tabs";
import { reconcileStealth, stealthContainers, stealthCreateTab } from "../stealth";
import { readKey, writeKey, vString, vSessions } from "../store";

// Sessions keep EVERY tab in the window (no cap — switching sessions must never
// drop tabs). Markers are the only 1-9 constraint, like tmux windows.
export const MAX_SESSION_MARKER = 9;

export async function readSessions(): Promise<Record<string, Session>> {
  return readKey("lfSessions", vSessions, {});
}

export async function writeSessions(all: Record<string, Session>): Promise<void> {
  await writeKey("lfSessions", all);
}

export async function readCurrentSessionName(): Promise<string> {
  return readKey("lfCurrentSession", vString, "");
}

export async function writeCurrentSessionName(name: string): Promise<void> {
  await writeKey("lfCurrentSession", name);
}

export type WindowSnapshot = {
  tabs: SessionTab[];
  active: number;
  windowState: string;
  splits: string;
};

export async function snapshotWindow(): Promise<WindowSnapshot> {
  await reconcileStealth();
  const win = await browser.windows.getCurrent();
  const tabs = await browser.tabs.query({ currentWindow: true });
  const list = tabs || [];
  // Transient tabs are internal plumbing, never user content: the #lfc=
  // request channel and the splitpanel companion pane. Excluding them keeps a
  // checkpoint from capturing them and a restore from re-opening them.
  const content = list.filter((t: any) => !isUITab(t));
  let active = content.findIndex((t: any) => t.active);
  if (active < 0) active = 0;
  // The split layout is computed once, in the Go core, from the read-only
  // splitViewId each tab carries, and stored as a compact "a:b,c:d" string.
  const svIds = content.map((t: any) =>
    typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : -1
  );
  const splits = await core.encodeSplits(await core.splitPairsOf(svIds));
  return {
    tabs: content.map((t: any) => {
      const svId = typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : undefined;
      return {
        url: t.url || "",
        title: t.title || "",
        pinned: !!t.pinned,
        splitViewId: svId,
        stealth: stealthContainers.has(t.cookieStoreId)
      };
    }),
    active,
    windowState: win && win.state ? win.state : "normal",
    splits
  };
}

// Rebuild a saved tab list in the current window, replacing what is there.
// Returns the ordered tab ids matching the saved order. Split into its own
// function because both restoreSession and resumeOnStartup need the exact
// same rebuild.
export async function openTabsInCurrentWindow(tabs: SessionTab[]): Promise<number[]> {
  await reconcileStealth();
  const win = await browser.windows.getCurrent();
  const cur = await browser.tabs.query({ currentWindow: true });
  const entries = (tabs || []).filter((t) => t && t.url);
  // Two different questions, previously answered by one list and therefore
  // wrong in both directions.
  //
  //   1. What may this restore DELETE? Everything unpinned except an in-flight
  //      `#lfc=req` tab (removing that one from inside its own onUpdated
  //      handler, while it is still being processed, can crash Firefox — its
  //      request handler cleans it up itself). This deliberately still includes
  //      stale `#lfc=` tabs and the split-panel pane: the window is being
  //      replaced, and leaving either behind leaves a stray pane in a session
  //      that was supposed to be rebuilt from scratch.
  //
  //   2. What may this restore REUSE as the host for the first saved URL? Only
  //      a REAL tab. An internal tab closes itself a moment later, so reusing
  //      one meant the first saved tab was destroyed with it: the restore came
  //      back a tab short, every position after it shifted by one, and a saved
  //      split pair silently dissolved. The old code reused the last removable
  //      tab, which could be a `#lfc=state` debug tab — the exact failure.
  const inFlightRequest = (t: any) =>
    !!(t && t.url && t.url.indexOf("#lfc=req") !== -1);
  const removable = (cur || []).filter(
    (t: any) => !t.pinned && !inFlightRequest(t)
  );
  // Never remove the window's last tab: closing it closes the whole window, so
  // the fallback below still has to be a tab we can update in place.
  const realCandidates = removable.filter((t: any) => !isUITab(t));
  // The host is the FIRST real tab, not the last. It is reused for the first
  // saved URL while the rest are appended after it, so its slot in the strip
  // decides where the whole restored session starts. Taking the last real tab
  // — which is what this did — left the first saved tab wherever the host
  // happened to be, so a restore reproduced the tabs but not their ORDER: the
  // numbering shifted and a saved split pair ended up on the wrong pair of
  // tabs. Choosing the first real tab makes "reused in place" and "opened in
  // order" the same thing, which is the property a restore actually needs.
  const host =
    realCandidates[0] ||
    removable[0] ||
    (cur || []).find((t: any) => t.active) ||
    (cur || [])[0] ||
    null;

  const created: number[] = [];
  let hostReused = false;

  if (!entries.length) {
    // Empty session (clean slate): park the host on the command center so a
    // fresh session opens on the home page instead of a leftover tab.
    if (host) {
      try {
        await browser.tabs.update(host.id, { url: CC_URL, active: true });
      } catch {
        // ignore
      }
      created.push(host.id);
      hostReused = true;
    }
  } else {
    const first = entries[0]!;
    if (first.stealth) {
      // Stealth tabs can't reuse the host (they need their own container);
      // open a fresh container tab first so the window never drops to zero.
      const t = await stealthCreateTab(first.url, true);
      if (t && t.id != null) created.push(t.id);
    } else if (host) {
      try {
        await browser.tabs.update(host.id, { url: first.url, active: true });
      } catch {
        // fall through — the tab may already be gone
      }
      created.push(host.id);
      hostReused = true;
    } else {
      const t = await browser.tabs.create({ url: first.url, active: true });
      if (t && t.id != null) created.push(t.id);
    }
    for (let i = 1; i < entries.length; i++) {
      const e = entries[i]!;
      const t = e.stealth
        ? await stealthCreateTab(e.url, false)
        : await browser.tabs.create({ url: e.url, active: false });
      if (t && t.id != null) created.push(t.id);
    }
  }

  // Remove the tabs the restore replaced (the reused host stays).
  for (const t of removable) {
    if (hostReused && host && t.id === host.id) continue;
    try {
      await browser.tabs.remove(t.id);
    } catch {
      // ignore
    }
  }
  try {
    await browser.windows.update(win.id, { focused: true });
  } catch {
    // ignore
  }
  return created;
}

// The split layout of a stored tab list, re-derived from each tab's
// window-local splitViewId the same way snapshotWindow computes it on save.
// Used after a tab is moved/copied so the stored "a:b,c:d" splits never
// reference a tab that left the session.
export async function refreshSplits(tabs: SessionTab[]): Promise<string> {
  try {
    const svIds = (tabs || []).map((t) =>
      typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : -1
    );
    return await core.encodeSplits(await core.splitPairsOf(svIds));
  } catch {
    return "";
  }
}
