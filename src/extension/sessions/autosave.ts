// Autosave + crash recovery: the current window is continuously checkpointed
// so nothing is ever lost — even when the current session was never given a
// name, and even when Firefox quits before the debounced save fires.
//
// Two debounces run on every tab change:
//   - scheduleAutosave (1.5s): persist into the named session (if any) AND
//     the crash-recovery "last" slot.
//   - scheduleSnapshot (250ms): refresh the in-memory lastSnapshot only, so
//     flushOnQuit can persist the newest state when the last window closes.

import type { Session } from "../../shared/types";
import { writeKey } from "../store";
import { readCurrentSessionName, readSessions, snapshotWindow, writeSessions, type WindowSnapshot } from "./storage";

// Last successfully-captured window snapshot, so a quit can flush it without
// re-querying (the window is already gone by the time windows.onRemoved fires,
// and an empty query would clobber the save).
let lastSnapshot: WindowSnapshot | null = null;

export function lastWindowSnapshot(): WindowSnapshot | null {
  return lastSnapshot;
}

export async function setLastWindowSnapshot(): Promise<void> {
  lastSnapshot = await snapshotWindow();
}

// Checkpoint: persist the current window before switching away. The snapshot
// is always written to the crash-recovery "last" slot, and if the window
// belongs to a named session, that session is updated in place too. A
// pre-captured snapshot (used by the quit flush) skips the re-query.
export async function autosaveCurrentSession(
  all: Record<string, Session>,
  preSnap?: WindowSnapshot
): Promise<void> {
  try {
    const snap = preSnap || (await snapshotWindow());
    lastSnapshot = snap;
    const recovery: Session = {
      name: "last",
      marker: 0,
      tabs: snap.tabs,
      active: snap.active,
      windowState: snap.windowState,
      updatedAt: Date.now(),
      splits: snap.splits
    };
    const name = await readCurrentSessionName();
    if (name && all[name]) {
      const existing = all[name];
      all[name] = {
        name,
        marker: existing.marker || 0,
        tabs: snap.tabs,
        active: snap.active,
        windowState: snap.windowState,
        updatedAt: Date.now(),
        splits: snap.splits
      };
      await writeSessions(all);
      await writeKey("lfLastSession", all[name]);
    } else {
      await writeKey("lfLastSession", recovery);
    }
  } catch {
    // ignore — checkpoint is best-effort
  }
}

let autosaveTimer: number | null = null;

export function scheduleAutosave(whileRestoring: () => boolean): void {
  if (whileRestoring()) return;
  if (autosaveTimer != null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    try {
      // Persist the CURRENT window into BOTH its named session (if it has one)
      // and the crash-recovery "last" slot. Writing only "last" here was the
      // data-loss bug: tabs opened after a session was saved never reached
      // that session's stored tab list.
      await autosaveCurrentSession(await readSessions());
    } catch {
      // ignore — autosave is best-effort
    }
  }, 1500);
}

let snapshotTimer: number | null = null;

// Short in-memory debounce, no storage write. Suppressed while a restore is
// rebuilding the window (it would capture a partial teardown); the restore
// refreshes lastSnapshot itself when it finishes.
export function scheduleSnapshot(whileRestoring: () => boolean): void {
  if (whileRestoring()) return;
  if (snapshotTimer != null) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    try {
      lastSnapshot = await snapshotWindow();
    } catch {
      // ignore — best-effort
    }
  }, 250);
}

// Flush on quit: when the last window closes, Firefox is quitting. Persist
// the last-known snapshot (captured on the previous tab change) so a tab
// opened moments before Alt+F4 isn't lost to the 1.5s autosave debounce.
// Uses lastSnapshot rather than re-querying: the window is already gone and
// an empty query would overwrite a good session with an empty one.
export async function flushOnQuit(): Promise<void> {
  const remaining = await browser.windows.getAll();
  if (remaining.length === 0 && lastSnapshot) {
    await autosaveCurrentSession(await readSessions(), lastSnapshot);
  }
}
