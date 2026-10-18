// Autosave + crash recovery: the current window is continuously checkpointed
// so nothing is ever lost — even when the current session was never given a
// name, and even when Firefox quits before the debounced save fires.
//
// Two debounces run on every tab change:
//   - scheduleAutosave (1.5s): persist into the named session (if any) AND
//     the crash-recovery "last" slot.
//   - scheduleSnapshot (250ms): refresh the in-memory lastSnapshot only, so
//     flushOnQuit can persist the newest state when the last window closes.

import type { Session, SessionWindow } from "../../shared/types";
import { sessionFromWindows } from "../../shared/sessionwindows";
import { writeKey } from "../store";
import {
  layoutSettled,
  readCurrentSessionName,
  readSessions,
  snapshotWindows,
  writeSessions
} from "./storage";

// Last successfully-captured WINDOW SET, so a quit can flush it without
// re-querying (the windows are already gone by the time windows.onRemoved fires,
// and an empty query would clobber the save).
let lastSnapshot: SessionWindow[] | null = null;

export function lastWindowSnapshot(): SessionWindow[] | null {
  return lastSnapshot;
}

export async function setLastWindowSnapshot(): Promise<void> {
  lastSnapshot = await snapshotWindows();
}

// Checkpoint: persist the current window before switching away. The snapshot
// is always written to the crash-recovery "last" slot, and if the window
// belongs to a named session, that session is updated in place too. A
// pre-captured snapshot (used by the quit flush) skips the re-query.
export async function autosaveCurrentSession(
  all: Record<string, Session>,
  preSnap?: SessionWindow[]
): Promise<void> {
  try {
    const wins = preSnap && preSnap.length ? preSnap : await snapshotWindows();
    lastSnapshot = wins;
    // The session IS the window set now, so the checkpoint records every window
    // — not just the one on screen. The focused window stays mirrored in the
    // flat fields (sessionFromWindows), which is what every older reader and
    // the tab move/copy paths still address.
    const name = await readCurrentSessionName();
    const existing = name ? all[name] : null;
    if (name && existing) {
      const session = sessionFromWindows(wins, name, existing.marker || 0, Date.now());
      all[name] = session;
      await writeSessions(all);
      await writeKey("lfLastSession", session);
    } else {
      await writeKey("lfLastSession", sessionFromWindows(wins, "last", 0, Date.now()));
    }
  } catch {
    // ignore — checkpoint is best-effort
  }
}

// THE WAIT IS A DEBOUNCE WITH A CEILING, not a pure debounce.
//
// A pure debounce assumes the event stream goes quiet. It does not: the chrome
// helper's relay tab reloads on every relay hash write, so it can report a
// finished load many times a second for as long as the helper is talking to us,
// and any page that updates itself in a loop does the same. Under a pure
// debounce that means the checkpoint never fires again — the session the user
// saved before opening ten tabs stayed frozen at those ten tabs' absence, which
// is exactly the "tabs opened after saving are not persisted" failure that was
// measured here (200+ schedules in 15s, zero autosaves). The first change still
// starts the clock and a quiet page still saves 1.5s after its last change, but
// a change that arrives once the ceiling is reached no longer postpones the save
// that is already due.
const AUTOSAVE_DEBOUNCE_MS = 1500;
const AUTOSAVE_MAX_WAIT_MS = 4000;

let autosaveTimer: number | null = null;
// When the pending save first became due (only meaningful while one is pending).
let autosaveDueAt = 0;

export function scheduleAutosave(whileRestoring: () => boolean): void {
  if (whileRestoring()) return;
  const now = Date.now();
  if (autosaveTimer == null) autosaveDueAt = now;
  // Past the ceiling the pending save is allowed to happen: keeping the timer
  // it already has is what bounds the latency.
  else if (now - autosaveDueAt >= AUTOSAVE_MAX_WAIT_MS) return;
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
  }, AUTOSAVE_DEBOUNCE_MS);
}

// How long a layout report keeps re-measuring before it writes down what it has
// anyway. 250ms between reads, so this is about ten seconds — long enough for a
// pair the platform describes lazily, short enough that a report never leaves a
// window with no checkpoint at all.
const LAYOUT_SETTLE_TRIES = 40;
const LAYOUT_SETTLE_GAP_MS = 250;

let layoutTimer: number | null = null;
let layoutTries = 0;

/**
 * Record a LAYOUT CHANGE (a split formed, dissolved, or was rearranged).
 *
 * Unlike a tab change, this is not a measurement the moment it arrives: see
 * `layoutSettled` for why the first read can see half a pair. So the report
 * re-measures until the layout is fully described, keeps `lastSnapshot` fresh
 * on every pass (that is what a quit flushes when the window is already gone),
 * and only then persists it — a checkpoint written from a half-formed layout
 * would be indistinguishable from "no split" and nothing would come back to
 * fix it.
 */
export function scheduleLayoutSnapshot(whileRestoring: () => boolean): void {
  if (whileRestoring()) return;
  if (layoutTimer != null) clearTimeout(layoutTimer);
  layoutTries = 0;
  const step = async (): Promise<void> => {
    layoutTimer = null;
    // A restore can start while this loop is still running (the report that
    // began it is often the split the user just dissolved to switch sessions).
    // Its window is being torn down and rebuilt, so a measurement now would
    // capture a half-replaced strip and then WRITE it — over the session being
    // restored. The restore checkpoints the finished window itself, so the only
    // correct thing here is to stand down.
    if (whileRestoring()) return;
    let settled = true;
    try {
      lastSnapshot = await snapshotWindows();
      settled = await layoutSettled();
    } catch {
      // ignore — a failed read is not a reason to stop reading
    }
    if (settled || ++layoutTries >= LAYOUT_SETTLE_TRIES) {
      await autosaveCurrentSession(await readSessions(), lastSnapshot || undefined);
      return;
    }
    layoutTimer = setTimeout(() => void step(), LAYOUT_SETTLE_GAP_MS);
  };
  layoutTimer = setTimeout(() => void step(), LAYOUT_SETTLE_GAP_MS);
}

let snapshotTimer: number | null = null;
let snapshotDueAt = 0;
const SNAPSHOT_DEBOUNCE_MS = 250;
const SNAPSHOT_MAX_WAIT_MS = 1000;

// Short in-memory debounce, no storage write. Suppressed while a restore is
// rebuilding the window (it would capture a partial teardown); the restore
// refreshes lastSnapshot itself when it finishes.
//
// The ceiling is here for the same reason as the autosave one: a continuous
// event source would otherwise keep resetting this timer, and the snapshot a quit
// flush writes would stay frozen at whatever the window looked like when the
// churn started. Refreshing is a query, not a write, so it is cheap to bound.
export function scheduleSnapshot(whileRestoring: () => boolean): void {
  if (whileRestoring()) return;
  const now = Date.now();
  if (snapshotTimer == null) snapshotDueAt = now;
  else if (now - snapshotDueAt >= SNAPSHOT_MAX_WAIT_MS) return;
  if (snapshotTimer != null) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    try {
      lastSnapshot = await snapshotWindows();
    } catch {
      // ignore — best-effort
    }
  }, SNAPSHOT_DEBOUNCE_MS);
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
