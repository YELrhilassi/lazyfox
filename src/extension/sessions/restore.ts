// Session restore: switching the live window set to a stored snapshot, and the
// startup resume that reapplies the last session after a relaunch.
//
// restore = checkpoint the current windows, rebuild the session's windows from
// the saved snapshot, re-create each window's native split groupings through
// THAT window's chrome helper, and re-activate the saved active tab. A
// re-entrancy guard (restoring) suppresses tab-change side effects during the
// rebuild and blocks overlapping restores.
//
// "The session's windows" is the part that used to be singular. A session is
// the whole window set now, so a restore is a loop over windows: the first one
// is rebuilt IN PLACE (the window the user is looking at, which is what makes a
// session switch feel like a switch rather than a rearrangement), the rest are
// created beside it, and the windows the session does not describe are closed —
// otherwise switching sessions would leave the previous session's windows lying
// around, which is the bug this replaces rather than a feature it keeps.

import { core } from "../../shared/core";
import {
  contentUrls,
  matchSavedWindow,
  sessionWindowsOf,
  splitGroupsOfTabs,
} from "../../shared/sessionwindows";
import { splitPairsInRange, splitTabsOf } from "../../shared/splits";
import type { Session, SessionWindow } from "../../shared/types";
import type { ChromeAction, ChromeReq } from "../../shared/protocol";
import { openTabsInWindow } from "./storage";

// Chrome-helper hooks, injected by the sessions facade (breaks the import
// cycle sessions -> relay -> sessions). Two of them because a restore now
// addresses a WINDOW: `requestChrome` follows the user's focus (the window
// being rebuilt in place), `requestChromeToWindow` names one (a window this
// restore just created, which has no focus yet and must not take any).
type RequestChrome = <K extends ChromeAction>(action: K, arg?: ChromeReq<K>) => void;
type RequestChromeToWindow = <K extends ChromeAction>(
  winId: number,
  action: K,
  arg?: ChromeReq<K>
) => void;
let requestChrome: RequestChrome = () => {};
let requestChromeToWindow: RequestChromeToWindow = () => {};
export function bindRestoreRequestChrome(fn: RequestChrome): void {
  requestChrome = fn;
}
export function bindRestoreRequestChromeToWindow(fn: RequestChromeToWindow): void {
  requestChromeToWindow = fn;
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

// The split layout of ONE saved window, as 1-based groups for the chrome helper.
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
export async function splitGroupsOfWindow(w: SessionWindow): Promise<number[][]> {
  const tabs = Array.isArray(w.tabs) ? w.tabs : [];
  const n = splitTabsOf(tabs).length;
  if (w.splits) {
    try {
      const pairs = await core.decodeSplits(w.splits);
      if (splitPairsInRange(pairs, n)) {
        return pairs.map(([a, b]) => [a + 1, b + 1]);
      }
    } catch {
      // fall through to the splitViewId grouping below
    }
  }
  // Numbered over the tabs a split can address (pinned ones excluded), which is
  // exactly how the chrome resolves the returned positions.
  return splitGroupsOfTabs(tabs);
}

// The focused window's layout, for callers that only have a Session.
export async function splitGroupsOfSession(s: Session): Promise<number[][]> {
  const first = sessionWindowsOf(s)[0];
  return first ? splitGroupsOfWindow(first) : [];
}

export function beginRestore(): void {
  restoring = true;
}

export function endRestore(): void {
  restoring = false;
}

// The user-visible tabs of ONE window, in strip order. The current-window form
// lives in tabs.ts; this one names its window, because a startup resume has to
// ask about a window it is not in.
async function realTabsIn(winId: number): Promise<any[]> {
  const tabs = ((await browser.tabs.query({ windowId: winId }).catch(() => [])) || []) as any[];
  return tabs.filter((t: any) => {
    const url = (t && t.url) || "";
    if (url.indexOf("relay.html") !== -1) return false;
    return !!url;
  });
}

// Whether a window is missing split pairings its saved counterpart has. Native
// restore persists splitViewId on Firefox 149+, but a session saved on an older
// build (or before the feature) may still need the pairing re-created — and a
// launch that restores the tabs faithfully but not the pairings is exactly the
// case this exists for.
async function needsSplitRestoreIn(cur: any[], saved: SessionWindow): Promise<boolean> {
  if (!saved.splits) return false;
  let pairs: [number, number][] = [];
  try {
    pairs = await core.decodeSplits(saved.splits);
  } catch {
    return false;
  }
  // Saved positions count the tabs a split can address, so a pinned tab left in
  // front must not shift the lookup — that would test the wrong pair.
  const real = splitTabsOf(cur);
  if (!splitPairsInRange(pairs, real.length)) return false;
  for (const [a, b] of pairs) {
    const ta = real[a] as any;
    const tb = real[b] as any;
    const ia = ta && typeof ta.splitViewId === "number" ? ta.splitViewId : -1;
    const ib = tb && typeof tb.splitViewId === "number" ? tb.splitViewId : -1;
    if (ia < 0 || ia !== ib) return true;
  }
  return false;
}

/**
 * Ask one window's chrome helper to re-create that window's split pairings.
 *
 * `expect` counts the tabs a split can ADDRESS, not every restored tab: pinned
 * tabs come back too but never take part in a split, and the chrome compares
 * this against its own unpinned count. Passing the full count made that
 * comparison impossible to satisfy, so a restore with any pinned tab waited out
 * the whole retry budget before pairing.
 */
async function repSplitWindow(winId: number | null, w: SessionWindow): Promise<void> {
  const groups = await splitGroupsOfWindow(w);
  if (!groups.length) return;
  const expect = splitTabsOf((w.tabs || []).filter((t) => t && t.url)).length;
  if (winId == null) requestChrome("restoreSplits", { groups, expect });
  else requestChromeToWindow(winId, "restoreSplits", { groups, expect });
}

/** Rebuild ONE window from its saved counterpart. Returns the created tab ids. */
async function restoreOneWindow(
  winId: number | null,
  w: SessionWindow,
  focus: boolean
): Promise<number[]> {
  const ids = await openTabsInWindow(winId, w.tabs, { focus });
  await repSplitWindow(winId, w);
  const active = Math.min(Math.max(0, w.active || 0), ids.length - 1);
  if (ids[active] != null) {
    await browser.tabs.update(ids[active], { active: true }).catch(() => {});
  }
  return ids;
}

/**
 * Create a window for a saved one that the browser did not bring back, fill it,
 * and re-pair its splits. Returns its window id, or null if it could not be
 * created (which is reported by the caller's own count, not by an exception —
 * one window that will not open must not stop the others).
 */
async function createRestoredWindow(w: SessionWindow): Promise<number | null> {
  let created: any = null;
  try {
    created = await browser.windows.create({ url: "about:blank", focused: false });
  } catch {
    created = null;
  }
  const id = created && created.id != null ? created.id : null;
  if (id == null) return null;
  // The blank host tab is reused for the first saved URL, so the window's tabs
  // are built by the same code (and land in the same order) as the focused one.
  await restoreOneWindow(id, w, false);
  return id;
}

// Close every normal window the session does not describe. Non-normal windows
// (popups, devtools) are left alone on purpose: they are not session windows,
// they were never saved, and closing them would be a bug rather than a switch.
async function closeWindowsNotIn(keep: Set<number>): Promise<void> {
  if (!keep.size) return; // never close the last window: that quits Firefox
  const wins = ((await browser.windows.getAll().catch(() => [])) || []) as any[];
  for (const w of wins) {
    if (!w || w.id == null) continue;
    if (w.type && w.type !== "normal") continue;
    if (keep.has(w.id)) continue;
    await browser.windows.remove(w.id).catch(() => {});
  }
}

/**
 * Apply a stored session to the live window set: rebuild the focused window in
 * place, create the session's other windows beside it, re-create every window's
 * split pairings, and close the windows the session does not describe.
 *
 * Returns the focused window's ordered tab ids. Caller owns the restoring guard
 * and the post-restore snapshot refresh.
 */
export async function applySessionToWindows(s: Session): Promise<number[]> {
  const targets = sessionWindowsOf(s);
  const first = targets[0] || { tabs: [], active: 0, windowState: "normal", splits: "" };
  // 1. In place. The user is looking at this window; a switch that recreated it
  //    would put the restored session in a different window than the one they
  //    were in, which reads as "my window jumped".
  const firstIds = await restoreOneWindow(null, first, true);
  const keep = new Set<number>();
  const curWin = (await browser.windows.getCurrent().catch(() => null)) as any;
  if (curWin && curWin.id != null) keep.add(curWin.id);
  // 2. The rest, created unfocused (focusing each in turn would flicker the
  //    user's screen through every window of the session), each filled by the
  //    same rebuild and re-paired through its own helper.
  for (let i = 1; i < targets.length; i++) {
    const tw = targets[i];
    if (!tw || !tw.tabs.length) continue;
    const id = await createRestoredWindow(tw);
    if (id != null) keep.add(id);
  }
  // 3. The session owns the window set: anything it does not describe is
  //    closed, AFTER the checkpoint the caller made, so the outgoing session
  //    still holds those windows' tabs.
  await closeWindowsNotIn(keep);
  return firstIds;
}

export async function restoreSession(
  s: Session,
  checkpoint: () => Promise<void>,
  onRestored: () => Promise<void>
): Promise<void> {
  return serializeRestore(async () => {
    beginRestore();
    try {
      await applySessionToWindows(s);
      await onRestored();
    } finally {
      endRestore();
      // Refresh the in-memory snapshot to the freshly-restored windows
      // immediately: flushOnQuit writes lastSnapshot into the current session
      // on quit, and without this a quit right after a switch would persist
      // the pre-switch checkpoint.
      await checkpoint();
    }
  });
}

// The live normal windows with their real tabs, focused window first, as the
// startup resume sees them.
async function liveWindows(): Promise<Array<{ winId: number; tabs: any[] }>> {
  const wins = ((await browser.windows.getAll().catch(() => [])) || []) as any[];
  const focused = (await browser.windows.getLastFocused().catch(() => null)) as any;
  const rows: Array<{ winId: number; tabs: any[]; focused: boolean; id: number }> = [];
  for (const w of wins) {
    if (!w || w.id == null) continue;
    if (w.type && w.type !== "normal") continue;
    const tabs = await realTabsIn(w.id);
    if (!tabs.length) continue;
    rows.push({ winId: w.id, tabs, focused: !!(focused && focused.id === w.id), id: w.id });
  }
  rows.sort((a, b) => Number(b.focused) - Number(a.focused) || a.id - b.id);
  return rows.map((r) => ({ winId: r.winId, tabs: r.tabs }));
}

// Wait until the browser has stopped bringing windows back. Firefox's native
// restore populates windows a beat apart, and creating a window for a saved one
// that has not appeared yet would produce TWO copies of it.
async function settleWindows(): Promise<void> {
  let last = -1;
  for (let i = 0; i < 6; i++) {
    const n = ((await browser.windows.getAll().catch(() => [])) || []).length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Resume the saved session on startup when autoRestore is on. This runs
 * UNCONDITIONALLY (not just when the window is blank): Firefox's own session
 * restore runs first and can't faithfully restore a tab that was navigated from
 * the command center, leaving it blank. Waiting for native restore to settle,
 * then reconciling each window with OUR snapshot, fixes that.
 *
 * Per WINDOW, because a session is a window set: each live window is matched to
 * the saved window with the same content, its selection and pairing are
 * repaired in place, and a saved window the browser did not bring back is
 * created. Only when NOTHING matches does this fall back to rebuilding the
 * whole set, which is the launch where Firefox restored something else
 * entirely (or nothing).
 */
export async function resumeOnStartup(
  last: Session | null,
  postRestore: () => Promise<void>
): Promise<void> {
  const targets = sessionWindowsOf(last);
  if (!targets.length || !targets.some((w) => (w.tabs || []).length)) return;
  // Let Firefox's native session restore finish populating the windows before
  // we compare or rebuild — the wait only happens when there is actually a
  // session to resume.
  await new Promise((r) => setTimeout(r, 1000));
  await settleWindows();
  const live = await liveWindows();
  const used = new Set<number>();
  for (const lw of live) {
    const idx = matchSavedWindow(contentUrls(lw.tabs), targets, used);
    if (idx < 0) continue;
    used.add(idx);
    const tw = targets[idx]!;
    const active = Math.min(Math.max(0, tw.active || 0), lw.tabs.length - 1);
    if (lw.tabs[active] && lw.tabs[active].id != null) {
      await browser.tabs.update(lw.tabs[active].id, { active: true }).catch(() => {});
    }
    if (await needsSplitRestoreIn(lw.tabs, tw)) {
      await repSplitWindow(lw.winId, tw);
    }
  }
  if (!used.size) {
    // Nothing matched: rebuild the whole set from the snapshot, replacing
    // whatever Firefox natively restored.
    beginRestore();
    try {
      await applySessionToWindows(last as Session);
      await postRestore();
    } finally {
      endRestore();
    }
    return;
  }
  // Windows the snapshot has that the browser did not bring back at all. This
  // is the "restore them all" half: a window that failed to come back would
  // otherwise take its session's layout with it, since nothing else re-creates
  // windows.
  const missing = targets.filter((_, i) => !used.has(i));
  if (missing.length) {
    beginRestore();
    try {
      for (const mw of missing) {
        if (!mw.tabs.length) continue;
        await createRestoredWindow(mw);
      }
      await postRestore();
    } finally {
      endRestore();
    }
  }
}
