// Session restore: switching the live window to a stored snapshot, and the
// startup resume that reapplies the last session after a relaunch.
//
// restore = checkpoint the current window, rebuild the tab strip from the
// saved snapshot, re-create the native split groupings through the chrome
// helper, and re-activate the saved active tab. A re-entrancy guard
// (restoring) suppresses tab-change side effects during the rebuild and
// blocks overlapping restores.

import { core } from "../../shared/core";
import { splitPairsInRange } from "../../shared/splits";
import type { Session, SessionTab } from "../../shared/types";
import type { ChromeAction, ChromeReq } from "../../shared/protocol";
import { realTabsInWindow } from "../tabs";
import { openTabsInCurrentWindow } from "./storage";

// Chrome-helper hook, injected by the sessions facade (breaks the import
// cycle sessions -> relay -> sessions).
type RequestChrome = <K extends ChromeAction>(action: K, arg?: ChromeReq<K>) => void;
let requestChrome: RequestChrome = () => {};
export function bindRestoreRequestChrome(fn: RequestChrome): void {
  requestChrome = fn;
}

// True while restoreSession/resumeOnStartup is rebuilding the window; tab-change
// side effects (home conversion, autosave, status refresh) are suppressed
// during it. The facade exposes isRestoring() from this flag.
let restoring = false;
// The in-flight restore, if any. Restores SERIALIZE on this rather than being
// refused: switching sessions twice in quick succession used to drop the second
// request on the floor with a "restore already in progress" note, so the user
// asked for a session and silently got the other one. Waiting is the only
// answer that matches what they did — the second switch is the newer intent,
// so it must win.
let inFlight: Promise<unknown> | null = null;

export function isRestoringFlag(): boolean {
  return restoring;
}

/**
 * Run `fn` once every previous restore has finished.
 *
 * Errors from the PREVIOUS restore are swallowed here (it reported its own
 * failure through its own result); the caller's own error propagates.
 */
export function serializeRestore<T>(fn: () => Promise<T>): Promise<T> {
  const prev = inFlight || Promise.resolve();
  const next = prev.then(fn, fn);
  inFlight = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// 1-based tab positions grouped by native splitViewId, for the chrome helper to
// re-create split pairings after a restore (positions match the saved tab
// order, which restore reproduces exactly).
function splitGroupsOf(tabs: SessionTab[]): number[][] {
  const byId = new Map<number, number[]>();
  (tabs || []).forEach((t, i) => {
    if (t && typeof t.splitViewId === "number" && t.splitViewId >= 0) {
      const arr = byId.get(t.splitViewId) || [];
      arr.push(i + 1);
      byId.set(t.splitViewId, arr);
    }
  });
  return Array.from(byId.values()).filter((g) => g.length > 1);
}

// The split layout for a session as 1-based groups for the chrome helper.
//
// Preferred source is the Go-computed `splits` string; the per-tab
// splitViewId grouping is the fallback. But the preference is CONDITIONAL: the
// two are written together and should always agree, and when they don't the
// encoded string is the one that is wrong. A session can be captured while the
// window is mid-flight (a tab re-created by a restore, a request-hash tab that
// reloads into a different URL), which leaves `splits` pointing at a position
// the tab list no longer has. Pairing those positions silently restored a FLAT
// strip — the split just vanished, with no error anywhere. So the encoded
// pairs are accepted only when every index is inside the saved tab list; the
// per-tab grouping is derived from the same list and is therefore always
// self-consistent.
export async function splitGroupsOfSession(s: Session): Promise<number[][]> {
  const n = Array.isArray(s.tabs) ? s.tabs.length : 0;
  if (s.splits) {
    try {
      const pairs = await core.decodeSplits(s.splits);
      if (splitPairsInRange(pairs, n)) {
        return pairs.map(([a, b]) => [a + 1, b + 1]);
      }
    } catch {
      // fall through to the splitViewId grouping below
    }
  }
  return splitGroupsOf(s.tabs);
}

export function beginRestore(): void {
  restoring = true;
}

export function endRestore(): void {
  restoring = false;
}

// Whether the window's real tabs already match a saved session (same URLs in
// the same order, transient UI tabs ignored). True means Firefox's native
// restore reproduced the session, so a rebuild would only add launch jank.
function windowMatches(cur: any[], saved: SessionTab[]): boolean {
  if (cur.length !== (saved || []).length) return false;
  for (let i = 0; i < cur.length; i++) {
    const a = cur[i] ? cur[i].url || "" : "";
    const s = saved[i];
    const b = s ? s.url || "" : "";
    if (a !== b) return false;
  }
  return true;
}

// Whether the window is missing split pairings the saved session has. Native
// restore persists splitViewId on Firefox 149+, but a session saved on an
// older build (or before the feature) may still need the pairing re-created.
async function needsSplitRestore(cur: any[], saved: Session): Promise<boolean> {
  if (!saved.splits) return false;
  let pairs: [number, number][] = [];
  try {
    pairs = await core.decodeSplits(saved.splits);
  } catch {
    return false;
  }
  if (!splitPairsInRange(pairs, cur.length)) return false;
  for (const [a, b] of pairs) {
    const ta = cur[a] as any;
    const tb = cur[b] as any;
    const ia = ta && typeof ta.splitViewId === "number" ? ta.splitViewId : -1;
    const ib = tb && typeof tb.splitViewId === "number" ? tb.splitViewId : -1;
    if (ia < 0 || ia !== ib) return true;
  }
  return false;
}

// Apply a stored session to the current window: rebuild tabs, re-create split
// groupings, activate the saved tab. Returns the ordered tab ids. Caller owns
// the restoring guard and the post-restore snapshot refresh.
export async function applySessionToWindow(s: Session): Promise<number[]> {
  const ids = await openTabsInCurrentWindow(s.tabs);
  const groups = await splitGroupsOfSession(s);
  if (groups.length) {
    // The structured payload is the point of typing this channel: split
    // groupings travel as number[][], not as a JSON string the chrome side
    // has to parse. `expect` is how many real tabs the restore produced: the
    // chrome side must wait for the strip to hold exactly that many before
    // pairing, or it pairs positions against the tabs being torn down and the
    // session comes back flat.
    requestChrome("restoreSplits", { groups, expect: ids.length });
  }
  const active = Math.min(Math.max(0, s.active || 0), ids.length - 1);
  if (ids[active] != null) {
    await browser.tabs.update(ids[active], { active: true }).catch(() => {});
  }
  return ids;
}

export async function restoreSession(
  s: Session,
  checkpoint: () => Promise<void>,
  onRestored: () => Promise<void>
): Promise<void> {
  return serializeRestore(async () => {
    beginRestore();
    try {
      await applySessionToWindow(s);
      await onRestored();
    } finally {
      endRestore();
      // Refresh the in-memory snapshot to the freshly-restored window
      // immediately: flushOnQuit writes lastSnapshot into the current session
      // on quit, and without this a quit right after a switch would persist
      // the pre-switch checkpoint.
      await checkpoint();
    }
  });
}

// Resume the saved session on startup when autoRestore is on. This runs
// UNCONDITIONALLY (not just when the window is blank): Firefox's own session
// restore runs first and can't faithfully restore a tab that was navigated from
// the command center, leaving it blank. Waiting for native restore to settle,
// then rebuilding the window from OUR snapshot, fixes that.
export async function resumeOnStartup(
  last: Session | null,
  postRestore: () => Promise<void>
): Promise<void> {
  if (!last || !last.tabs || !last.tabs.length) return;
  // Let Firefox's native session restore (if enabled) finish populating the
  // window before we compare or rebuild — the wait only happens when there is
  // actually a session to resume.
  await new Promise((r) => setTimeout(r, 1000));
  const cur = await realTabsInWindow();
  if (windowMatches(cur, last.tabs)) {
    // Native restore already reproduced the saved tabs: don't tear the window
    // down and re-create every tab (the jank users see as a slow, churning
    // launch). Just re-activate the saved tab and repair any missing split
    // pairing.
    const active = Math.min(Math.max(0, last.active || 0), cur.length - 1);
    if (cur[active] && cur[active].id != null) {
      await browser.tabs.update(cur[active].id, { active: true }).catch(() => {});
    }
    if (await needsSplitRestore(cur, last)) {
      const groups = await splitGroupsOfSession(last);
      if (groups.length) {
        requestChrome("restoreSplits", { groups });
      }
    }
    return;
  }
  // Rebuild the window from the snapshot, replacing whatever Firefox natively
  // restored.
  beginRestore();
  try {
    await applySessionToWindow(last);
    await postRestore();
  } finally {
    endRestore();
  }
}
