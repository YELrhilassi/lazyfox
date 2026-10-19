// Session storage + window snapshotting.
//
// storage owns the read/write of the named-session map and the current-session
// pointer. snapshot captures a live window (tabs, active index, window state,
// native split layout) into the persisted Session shape, and rebuild gives the
// restore path the primitives to turn a snapshot back into tabs.

import { core } from "../../shared/core";
import { splitIdsOf } from "../../shared/splits";
import type { Session, SessionTab, SessionWindow } from "../../shared/types";
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

// A captured window is exactly a session window — one type, so a snapshot can
// never be shaped differently from the thing a restore reads.
export type WindowSnapshot = SessionWindow;

/**
 * Capture ONE window's tabs, selection and split layout.
 *
 * `tabs` is the window's raw tab list (the caller already knows which window it
 * asked for); `win` is that window object, for its state.
 */
async function windowPart(tabs: any[], win: any): Promise<SessionWindow> {
  // Transient tabs are internal plumbing, never user content: the #lfc=
  // request channel and the splitpanel companion pane. Excluding them keeps a
  // checkpoint from capturing them and a restore from re-opening them.
  const content = (tabs || []).filter((t: any) => !isUITab(t));
  let active = content.findIndex((t: any) => t.active);
  if (active < 0) active = 0;
  // The split layout is computed once, in the Go core, from the read-only
  // splitViewId each tab carries, and stored as a compact "a:b,c:d" string.
  // Positions count the tabs a split can address, so pinned tabs (never part of
  // a split) are excluded — the restore resolves them against that same list.
  const splits = await core.encodeSplits(await core.splitPairsOf(splitIdsOf(content)));
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

/** The window the background context is currently "in" — the focused one. */
export async function snapshotWindow(): Promise<WindowSnapshot> {
  await reconcileStealth();
  const win = await browser.windows.getCurrent().catch(() => null);
  const tabs = await browser.tabs.query({ currentWindow: true }).catch(() => []);
  return windowPart((tabs || []) as any[], win);
}

/**
 * Capture EVERY window, focused first.
 *
 * A session is the whole window set, so this is what a save and an autosave
 * record. Order is part of the behavior rather than a detail: the first window
 * is the one a switch rebuilds IN PLACE (the window the user is looking at) and
 * the rest are created after it.
 *
 * Two things are deliberately not windows here:
 *
 *  - a window that is not a normal browser window (a popup, a devtools window),
 *    because closing one on a session switch would be a bug rather than a
 *    feature; and
 *  - a window with no content tabs at all — the relay-only window a helper can
 *    leave behind. Saving it would restore a window that exists to hold
 *    plumbing.
 */
export async function snapshotWindows(): Promise<SessionWindow[]> {
  await reconcileStealth();
  const wins = ((await browser.windows.getAll().catch(() => [])) || []) as any[];
  const focused = (await browser.windows.getLastFocused().catch(() => null)) as any;
  const out: Array<{ id: number; focused: boolean; win: SessionWindow }> = [];
  for (const w of wins) {
    if (!w || w.id == null) continue;
    if (w.type && w.type !== "normal") continue;
    const tabs = ((await browser.tabs.query({ windowId: w.id }).catch(() => [])) || []) as any[];
    const win = await windowPart(tabs, w);
    if (!win.tabs.length) continue;
    out.push({ id: w.id, focused: !!(focused && focused.id === w.id), win });
  }
  out.sort((a, b) => Number(b.focused) - Number(a.focused) || a.id - b.id);
  return out.map((x) => x.win);
}

/**
 * Whether the window's split layout is fully described yet.
 *
 * Firefox assigns `splitViewId` to each pane a beat AFTER the split forms, so a
 * read taken too early sees exactly one pane of a fresh pair carrying an id.
 * `splitPairsOf` drops a lone id — "one pane of two" and "no split at all"
 * encode to the SAME empty layout, and since a split fires no `tabs.*` event
 * nothing would ever come back to correct it. That is how a pair that was on
 * screen at quit came back flat on the next launch.
 *
 * This is the question that separates the two, and it is answered by the
 * platform rather than by a delay we guessed: an id carried by fewer than two
 * tabs is a measurement still in flight. No ids at all is settled — there is
 * simply nothing split.
 */
export async function layoutSettled(): Promise<boolean> {
  try {
    // EVERY window, not just the focused one: a layout report can come from any
    // of them, and the id space is per window — so two windows may each hold
    // `splitViewId: 3` without being the same split. Keying by (window, id) is
    // what keeps "one pane of two" visible instead of averaging it away against
    // a pair in another window.
    const tabs = ((await browser.tabs.query({}).catch(() => [])) || []) as any[];
    const members = new Map<string, number>();
    for (const t of tabs) {
      if (isUITab(t)) continue;
      const sv = (t as any).splitViewId;
      if (typeof sv !== "number" || sv < 0) continue;
      const key = String((t as any).windowId) + ":" + sv;
      members.set(key, (members.get(key) || 0) + 1);
    }
    for (const n of members.values()) {
      if (n < 2) return false;
    }
    return true;
  } catch {
    // A read that failed cannot keep being retried: report the layout as settled
    // so the caller writes down what it has instead of looping forever.
    return true;
  }
}

// Rebuild a saved tab list in ONE window, replacing what is there. Returns the
// ordered tab ids matching the saved order. Split into its own function because
// both restoreSession and resumeOnStartup need the exact same rebuild.
//
// `winId` null means the window the background is "in" (the focused one); an id
// means that window — which is how the extra windows of a multi-window session
// are filled after they are created.
export async function openTabsInWindow(
  winId: number | null,
  tabs: SessionTab[],
  opts: { focus?: boolean } = {}
): Promise<number[]> {
  await reconcileStealth();
  const q: any = winId != null ? { windowId: winId } : { currentWindow: true };
  const win = winId != null ? { id: winId, state: "normal" } : await browser.windows.getCurrent();
  // Every tab this opens belongs to THIS window. Without it, `tabs.create`
  // targets the window the background context considers current, so a session
  // window built beside the focused one would collect tabs into the focused
  // window and leave the new one holding a blank host.
  const inWin: any = winId != null ? { windowId: winId } : {};
  const cur = ((await browser.tabs.query(q).catch(() => [])) || []) as any[];
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
      const t = await stealthCreateTab(first.url, true, winId);
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
      const t = await browser.tabs.create({ url: first.url, active: true, ...inWin });
      if (t && t.id != null) created.push(t.id);
    }
    for (let i = 1; i < entries.length; i++) {
      const e = entries[i]!;
      const t = e.stealth
        ? await stealthCreateTab(e.url, false, winId)
        : await browser.tabs.create({ url: e.url, active: false, ...inWin });
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
  if (opts.focus !== false) {
    try {
      await browser.windows.update(win.id, { focused: true });
    } catch {
      // ignore
    }
  }
  return created;
}

// The split layout of a stored tab list, re-derived from each tab's
// window-local splitViewId the same way snapshotWindow computes it on save.
// Used after a tab is moved/copied so the stored "a:b,c:d" splits never
// reference a tab that left the session.
export async function refreshSplits(tabs: SessionTab[]): Promise<string> {
  try {
    // Same coordinate space as snapshotWindow: pinned tabs do not count.
    return await core.encodeSplits(await core.splitPairsOf(splitIdsOf(tabs)));
  } catch {
    return "";
  }
}
