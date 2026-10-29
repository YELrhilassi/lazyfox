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
import { isUITab } from "../tabs";
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
import { bumpRestoreEpoch } from "./epoch";

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
// EVERY window's helper, for the one command that is not about one window (the
// launch splash; see splashOff). Injected like the other two, so this module
// never reaches for the relay itself.
let broadcastChrome: RequestChrome = () => {};
export function bindRestoreRequestChrome(fn: RequestChrome): void {
  requestChrome = fn;
}
export function bindRestoreRequestChromeToWindow(fn: RequestChromeToWindow): void {
  requestChromeToWindow = fn;
}
export function bindRestoreBroadcastChrome(fn: RequestChrome): void {
  broadcastChrome = fn;
}

// True while a switch or a startup resume is rebuilding the window; tab-change
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

// Which switch currently owns the loader. Every accepted switch takes a number;
// only the newest one is allowed to clear the splash. That is what keeps a
// stale settle (a switch to B finishing its page wait after the user has
// already asked for C) from uncovering C's rebuild.
let switchSeq = 0;
// True while the splash is up (or has been announced and is waiting for the
// chrome's own paint delay). Guards against sending the same drop twice.
let splashUp = false;

export function isRestoringFlag(): boolean {
  return restoring;
}

/** A splash is up/announced right now: the answer a helper booting mid-switch
 * needs, so it covers itself instead of flashing through the rebuild. */
export function isSplashActive(): boolean {
  return splashUp;
}

// True from the moment a startup resume decides it has something to do until
// the last window has settled. This is NOT the same flag as `restoring`: that one
// gates tab-change side effects and is only up while windows are actually being
// rebuilt, whereas the splash has to cover the WHOLE wait — the settle pause and
// Firefox's own window-by-window native restore are part of what the user would
// otherwise watch happen.
//
// Read by the background's `alive` handler, which answers a helper booting
// mid-restore with the splash state (see bgrelay.ts).
let resumeActive = false;

export function isResumeActive(): boolean {
  return resumeActive;
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
  // Every autosave in flight now holds a measurement of a window that is about
  // to be replaced; the bump tells it to drop the write (see sessions/epoch.ts).
  bumpRestoreEpoch();
}

export function endRestore(): void {
  restoring = false;
  bumpRestoreEpoch();
}

// The user-visible tabs of ONE window, in strip order. The current-window form
// lives in tabs.ts; this one names its window, because a startup resume has to
// ask about a window it is not in.
//
// It uses the SAME predicate the snapshot uses for "what counts as a tab"
// (isUITab), which is the whole point: a split-panel companion pane or a
// throwaway `#lfc=` carrier is not session content. Counting one here made a
// launch that had such a tab fail to recognise the very window it was looking
// at — the match is by exact URL list, so one extra carrier turned the user's
// own window into a stranger, and the resume then left a partial window open
// AND created the saved one beside it (the reported "sessions don't reload
// properly", with the flashing that comes from the duplicate set).
async function realTabsIn(winId: number): Promise<any[]> {
  const tabs = ((await browser.tabs.query({ windowId: winId }).catch(() => [])) || []) as any[];
  return tabs.filter((t: any) => !!t && !!t.url && !isUITab(t));
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

/**
 * Rebuild ONE window from its saved counterpart. Returns the created tab ids.
 *
 * AN EMPTY RESULT MEANS THE WINDOW WAS NOT TOUCHED (see openTabsInWindow: the
 * outgoing tabs stay when nothing could be opened). Callers decide what that
 * costs them: a switch aborts, because a switch that reports success while the
 * old session is still on screen points the current-session name at a session
 * nobody is looking at, and the next checkpoint then writes the old window into
 * it. A resume skips that window and keeps the others.
 */
async function restoreOneWindow(
  winId: number | null,
  w: SessionWindow,
  focus: boolean
): Promise<number[]> {
  // The selection and the pins are applied INSIDE the rebuild (see
  // openTabsInWindow): activating here as well meant the window painted its
  // first tab and then jumped to the saved one.
  const ids = await openTabsInWindow(winId, w.tabs, { focus, active: w.active || 0 });
  await repSplitWindow(winId, w);
  await applyWindowState(winId, w.windowState);
  return ids;
}

/**
 * A saved window's size state, when it is one worth applying.
 *
 * Only maximized/fullscreen: "normal" is deliberately a no-op. Forcing it would
 * shrink a window the user had maximized by hand before the switch, which reads
 * as a bug rather than as a restored state.
 */
async function applyWindowState(winId: number | null, state: string | undefined): Promise<void> {
  if (winId == null) return;
  const st = state === "maximized" || state === "fullscreen" ? state : "";
  if (!st) return;
  try {
    await browser.windows.update(winId, { state: st });
  } catch {
    // A window that refuses the state keeps whatever it has; not a restore failure.
  }
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
  // The blank tab `windows.create` makes is replaced like every other outgoing
  // tab — same rebuild, same order, same pins as the focused window. A window
  // that could not be filled is reported as not created: the caller then leaves
  // it out of `keep`, and the cleanup pass closes it. One window that will not
  // open must never stop the others.
  try {
    await restoreOneWindow(id, w, false);
  } catch {
    return null;
  }
  return id;
}

// Close every normal window the session does not describe. Non-normal windows
// (popups, devtools) are left alone on purpose: they are not session windows,
// they were never saved, and closing them would be a bug rather than a switch.
async function closeWindowsNotIn(keep: Set<number>): Promise<void> {
  if (!keep.size) return; // never close the last window: that quits Firefox
  const wins = ((await browser.windows.getAll().catch(() => [])) || []) as any[];
  // In parallel: these windows are being discarded, and waiting for each one
  // to finish closing made a three-window switch visibly longer than the
  // rebuild it was cleaning up after.
  await Promise.all(
    wins
      .filter((w: any) => !!w && w.id != null && (!w.type || w.type === "normal") && !keep.has(w.id))
      .map((w: any) => browser.windows.remove(w.id).catch(() => {}))
  );
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
  //
  //    WHICH window is named explicitly now. `null` meant "the window the
  //    background considers current", and with more than one window alive that
  //    can be a different one than the user is looking at: the rebuild landed
  //    in the wrong window and closeWindowsNotIn then closed the intended one.
  //    getLastFocused is the same authority the snapshot uses.
  const curWin = (await browser.windows.getLastFocused().catch(() => null)) as any;
  const focusWinId = curWin && curWin.id != null ? curWin.id : null;
  const firstIds = await restoreOneWindow(focusWinId, first, true);
  // The window could not be rebuilt at all. Abort: the session is not on screen,
  // and the caller must not name the window after it.
  if (!firstIds.length) throw new Error("no tab could be opened for the session");
  const keep = new Set<number>();
  if (focusWinId != null) keep.add(focusWinId);
  // 2. The rest, created unfocused (focusing each in turn would flicker the
  //    user's screen through every window of the session), each filled by the
  //    same rebuild and re-paired through its own helper.
  //
  //    IN PARALLEL, because they are independent windows. One after another
  //    meant a three-window session paid three window-boot sequences end to
  //    end, which is most of what made a multi-window switch feel slow.
  const extras = targets
    .slice(1)
    .filter((tw): tw is SessionWindow => !!tw && (tw.tabs || []).length > 0);
  const extraIds = await Promise.all(extras.map((tw) => createRestoredWindow(tw)));
  for (const id of extraIds) if (id != null) keep.add(id);
  // 3. The session owns the window set: anything it does not describe is
  //    closed, AFTER the checkpoint the caller made, so the outgoing session
  //    still holds those windows' tabs.
  await closeWindowsNotIn(keep);
  return firstIds;
}

/* ========================== the switch lifecycle ========================== */
//
// A switch is three phases, and only the middle one takes the restore lock:
//
//   1. COVER. Raise the loader immediately, in every window (a session is a
//      window set). This happens before the lock so a switch queued behind a
//      slow one still gives the user feedback the moment they ask.
//   2. REBUILD. Serialized with every other switch and with a startup resume,
//      so two switches can never interleave their checkpoints and rebuilds.
//   3. SETTLE. Wait for the front page of every window, then drop the cover —
//      OUTSIDE the lock, or the next switch would wait for the previous
//      session's background pages to finish loading.

/**
 * Announce a user switch and take ownership of the loader.
 *
 * The label paints immediately in the chrome (see chrome/splash.ts): the user
 * asked for something, and the answer to that is a loader now, not 250ms from
 * now. The number it returns is what later proves this switch still owns the
 * cover; only the newest switch is allowed to clear it.
 */
export function beginSwitch(name: string): number {
  const seq = ++switchSeq;
  splashOn(true, "Switching to " + name + "\u2026");
  return seq;
}

/**
 * Is this switch still the newest one?
 *
 * A switch that was queued behind another and has been overtaken is no longer
 * the user's intent: rebuilding it would tear the window down and load a session
 * that is about to be replaced. The label over the window belongs to the newer
 * request too, so standing down costs nothing.
 */
export function ownsSwitch(seq: number): boolean {
  return seq === switchSeq;
}

/**
 * Take the cover down NOW, unless a newer switch has taken it over.
 *
 * Used when a switch fails: there is nothing left to hide, and waiting out the
 * page load of the session the user is staying in would hold a logo over a
 * window that is already showing the right thing.
 */
export function dropSwitchCover(seq: number): void {
  if (seq === switchSeq) splashOff();
}

/**
 * Wait for the pages this switch opened, then drop the cover — if this switch
 * is still the newest one.
 *
 * A switch bounds the wait to the ACTIVE tab of each window: the front page is
 * what the user is about to look at, and holding a logo over a window while its
 * background tabs finish loading is the difference between "snappy" and
 * "stuck". A startup resume waits for everything (see resumeOnStartup) because
 * there the background tabs are the session the user is coming back to.
 */
export async function settleSwitch(seq: number): Promise<void> {
  try {
    await waitForPagesLoaded("focused", PAGE_LOAD_WAIT_SWITCH_MS);
  } finally {
    if (seq === switchSeq) splashOff();
  }
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

// Are the live windows exactly the saved ones, all of them claimed?
//
// Saved windows with no tabs are ignored: they cannot appear in `live` (a window
// with no content tab is plumbing, not a session window), so counting them would
// make this never true and force every launch down the slow path.
function windowsMatchAll(live: Array<{ tabs: any[] }>, targets: SessionWindow[]): boolean {
  if (!live.length) return false;
  const used = new Set<number>();
  for (const lw of live) {
    const idx = matchSavedWindow(contentUrls(lw.tabs), targets, used);
    if (idx < 0) return false;
    used.add(idx);
  }
  return used.size === targets.filter((w) => (w.tabs || []).length > 0).length;
}

/**
 * Wait for Firefox's OWN session restore to stop adding windows and tabs, then
 * hand the resume the window set it should work from.
 *
 * WHY NOT A FIXED PAUSE. A launch used to sleep a flat second and then wait for
 * the WINDOW COUNT to stop changing. That is a second of logo on every launch —
 * including the common one, where native restore had already finished — and it
 * still could not see tabs arriving into a window that already existed, which is
 * exactly what made a near-miss window get rebuilt.
 *
 * Two signals, whichever comes first:
 *
 *   - every live window matches a saved one EXACTLY and every saved window is
 *     claimed: native restore is done and there is nothing left to wait for. The
 *     common launch, for the price of one poll.
 *   - the window/tab set stops changing for two reads, after a short floor so a
 *     launch that has not begun restoring is not mistaken for a settled one.
 *
 * Bounded: a browser that never settles must not hold the logo.
 */
async function settleLaunch(
  targets: SessionWindow[]
): Promise<Array<{ winId: number; tabs: any[] }>> {
  const floorMs = 750;
  const started = Date.now();
  let sig = "";
  let live = await liveWindows();
  for (let i = 0; i < 10; i++) {
    if (windowsMatchAll(live, targets)) return live;
    const next = live.length + ":" + live.reduce((n, w) => n + w.tabs.length, 0);
    if (next === sig && Date.now() - started >= floorMs) return live;
    sig = next;
    await new Promise((r) => setTimeout(r, 250));
    live = await liveWindows();
  }
  return live;
}

// How long the cover may stay up waiting for pages, and how often it looks.
// The loader exists to hide the churn of a restore, and the churn does not stop
// when a tab exists: its document is still arriving, the first paint still
// lands, a web app still hydrates. Dropping the cover at the former moment
// ("every window has its tabs") put that second wave back on screen a beat
// later, which is the reported "everything flashes while things are loading".
//
// BOUNDED on purpose: a stalled request must never leave a logo over the
// window, and the splash is an overlay rather than a gate — the user can click
// through it while it waits.
//
// A SWITCH gets a much shorter budget than a launch. The rebuild it has to hide
// is over in a few hundred milliseconds; what the cover would be waiting for
// afterwards is a page's own network, and past a couple of seconds the logo is
// no longer hiding churn, it is hiding the page the user asked for. A LAUNCH
// restores a whole working set and is allowed to be slower.
const PAGE_LOAD_WAIT_ALL_MS = 10000;
const PAGE_LOAD_WAIT_SWITCH_MS = 2500;
const PAGE_LOAD_POLL_MS = 120;

// "all": every real tab of every normal window. "active": only the tab each
// window is showing. "focused": only the tab the FOCUSED window is showing —
// the one the user is looking at, and the only one a switch can be judged by.
//
// A startup resume restores a whole working set and the background tabs are
// part of what the user is coming back to, so it waits for everything. A switch
// waits for the front page of the window in front: the other windows it built
// are loading out of sight, and holding a logo over the window the user is
// using until a background tab of another window finishes made a fast switch
// feel stuck for as long as the slowest page in the browser.
type LoadScope = "all" | "active" | "focused";

// Does any real tab in scope still report a document in flight?
async function pagesStillLoading(scope: LoadScope): Promise<boolean> {
  const wins = ((await browser.windows.getAll().catch(() => [])) || []) as any[];
  // "focused" narrows the WINDOW set; the TAB set inside it is the active one.
  // A browser with no focused window (minimized, a helper booting) falls back to
  // every window's active tab, which is the older behaviour rather than a wait
  // that can never finish.
  let onlyWin: number | null = null;
  if (scope === "focused") {
    const f = (await browser.windows.getLastFocused().catch(() => null)) as any;
    onlyWin = f && f.id != null ? f.id : null;
  }
  const activeOnly = scope !== "all";
  for (const w of wins) {
    if (!w || w.id == null) continue;
    if (w.type && w.type !== "normal") continue;
    if (onlyWin != null && w.id !== onlyWin) continue;
    const tabs = ((await browser.tabs.query({ windowId: w.id }).catch(() => [])) || []) as any[];
    const real = tabs.filter((t: any) => !!t && !!t.url && !isUITab(t));
    const check = activeOnly ? real.filter((t: any) => !!t.active) : real;
    for (const t of check) {
      // ONLY an explicit "loading" holds the cover. A host that does not
      // report `status` (a stripped build, a test fake) must not be read as
      // "loading forever" and sit out the whole timeout, and a discarded tab
      // reports "unloaded" — there is no document arriving to wait for.
      if (t.status === "loading") return true;
    }
  }
  return false;
}

/**
 * Hold the cover until the pages in scope have finished loading.
 *
 * TWO consecutive clean reads, not one: a tab that was just created can report
 * `complete` while it is still `about:blank`, and a document that is committed
 * but has not started its network load looks the same. Two polls apart is long
 * enough for that transition to become visible, short enough that a genuinely
 * loaded window drops the cover in a quarter of a second.
 */
async function waitForPagesLoaded(scope: LoadScope, capMs: number): Promise<void> {
  const deadline = Date.now() + capMs;
  let clean = 0;
  while (Date.now() < deadline) {
    try {
      if (await pagesStillLoading(scope)) clean = 0;
      else if (++clean >= 2) return;
    } catch {
      // A window torn down mid-wait is not a reason to keep the cover up.
      return;
    }
    await new Promise((r) => setTimeout(r, PAGE_LOAD_POLL_MS));
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
 * rebuilt — IN PLACE of a spare live window when there is one, and created
 * only when there is not. That last part is what makes a launch faithful
 * instead of additive: Firefox's native restore is frequently close to the
 * snapshot but not equal (a dropped tab, a re-created tab that came back
 * blank), and the old code answered a near-miss by creating a second window
 * beside the near-miss, so the session came back twice and the screen flashed
 * through both. A live window the session does not describe at all is closed,
 * exactly as a session switch closes it.
 */
export async function resumeOnStartup(
  last: Session | null,
  postRestore: () => Promise<void>
): Promise<void> {
  const targets = sessionWindowsOf(last);
  if (!targets.length || !targets.some((w) => (w.tabs || []).length)) return;
  // The splash is announced from here rather than from the caller because this
  // is the point at which a resume stops being hypothetical: the guards above
  // return for a fresh launch (nothing saved) and for autoRestore off, and those
  // launches must stay splash-free. It is cleared in a `finally` so no early
  // return, thrown error or closed window can leave a logo covering the window —
  // the helper's own failsafe is the second line of defence, not the first.
  resumeActive = true;
  // The resume takes a sequence number too. A switch that starts while a launch
  // is still settling is the newer intent: it takes ownership of the cover, and
  // this resume must not clear it when its own page wait ends.
  const seq = ++switchSeq;
  splashOn(false);
  try {
    // SERIALIZED with switches. Before this, a switch made during a launch
    // resume could interleave with the resume's rebuild and leave a window set
    // that belonged to neither session.
    await serializeRestore(() => resumeWindows(targets, postRestore));
    // LAST, and still inside the cover: the windows have their tabs by now, but
    // the pages in them are only starting to load, and that is the part of a
    // launch the user actually watches happen. Outside the lock: a user switch
    // must not have to wait for this.
    await waitForPagesLoaded("all", PAGE_LOAD_WAIT_ALL_MS);
  } finally {
    resumeActive = false;
    if (seq === switchSeq) splashOff();
  }
}

// The resume itself, with the saved window set already validated.
async function resumeWindows(
  targets: SessionWindow[],
  postRestore: () => Promise<void>
): Promise<void> {
  // Let Firefox's native session restore finish populating the windows before we
  // compare or rebuild (see settleLaunch: this returns as soon as what it brought
  // back already IS the saved set, and only a launch that restores something
  // different pays the floor).
  const live = await settleLaunch(targets);
  const usedLive = new Set<number>();
  const usedSaved = new Set<number>();

  // 1. Every live window the snapshot describes EXACTLY: keep its tabs, repair
  //    its selection and its split pairing. This is the common launch (Firefox
  //    restores the same set we saved) and it must stay rebuild-free, or every
  //    restart would churn every tab through the screen.
  for (const lw of live) {
    const idx = matchSavedWindow(contentUrls(lw.tabs), targets, usedSaved);
    if (idx < 0) continue;
    usedSaved.add(idx);
    usedLive.add(lw.winId);
    const tw = targets[idx]!;
    const active = Math.min(Math.max(0, tw.active || 0), lw.tabs.length - 1);
    if (lw.tabs[active] && lw.tabs[active].id != null) {
      await browser.tabs.update(lw.tabs[active].id, { active: true }).catch(() => {});
    }
    if (await needsSplitRestoreIn(lw.tabs, tw)) {
      await repSplitWindow(lw.winId, tw);
    }
  }

  // 2. The saved windows with no counterpart, and the live windows the session
  //    does not describe. The first group is rebuilt into the second group
  //    (in place, focused window first) before any new window is created.
  const spare = live.filter((lw) => !usedLive.has(lw.winId));
  const missing = targets
    .map((w, i) => ({ w, i }))
    .filter(({ w, i }) => !usedSaved.has(i) && (w.tabs || []).length);
  const leftovers = spare.slice(missing.length);
  if (!missing.length && !leftovers.length) return;
  beginRestore();
  try {
    for (let k = 0; k < missing.length; k++) {
      const w = missing[k]!.w;
      const s = spare[k];
      if (s) {
        usedLive.add(s.winId);
        try {
          await restoreOneWindow(s.winId, w, false);
        } catch {
          // A window that could not be filled keeps the tabs it had; the rest of
          // the session is still worth restoring.
        }
      } else {
        const id = await createRestoredWindow(w);
        if (id != null) usedLive.add(id);
      }
    }
    // 3. The session owns the window set: a live window it does not describe is
    //    closed, exactly as a session switch closes it. Only windows we SAW are
    //    closed (never a window whose tabs are still arriving — those were not
    //    in `live` at all), and never the last one.
    if (usedLive.size) {
      for (const lw of leftovers) {
        await browser.windows.remove(lw.winId).catch(() => {});
      }
    }
  } finally {
    endRestore();
  }
  // AFTER the guard comes down: the post-restore callback stores the finished
  // window set as the snapshot a quit flushes, and a measurement taken inside
  // the guard would be stamped with an epoch that `endRestore` immediately
  // invalidates (see sessions/epoch.ts), so the flush would refuse it. Its own
  // autosave re-arm is suppressed while `restoring` is true, for the same
  // reason.
  await postRestore();
}

// The chrome-side launch splash, announced to every window's helper.
//
// It is deliberately raised BEFORE the settle wait and dropped AFTER the last
// window is done, including on the paths that turn out to need no rebuilding at
// all: a launch that only has to repair a selection still shows the user a window
// full of native restore, and "something is loading" is the honest thing to say
// about it. The helper decides whether it is worth painting (see
// chrome/splash.ts) — the announce is cheap and idempotent, so this side does not
// try to predict the timing.
//
// The raise goes to whoever is listening through requestChrome (the focused
// window, queued for the relay if it is not up yet); the drop is a BROADCAST,
// because by then every window of the session has a helper that may be showing
// one — including windows this resume created itself.
function splashOn(all: boolean, label?: string): void {
  splashUp = true;
  try {
    const arg = label ? { on: true, label } : { on: true };
    if (all) broadcastChrome("splash", arg);
    else requestChrome("splash", arg);
  } catch {
    // A splash is cosmetic: never let it affect the restore.
  }
}

function splashOff(): void {
  if (!splashUp) return;
  splashUp = false;
  try {
    broadcastChrome("splash", { on: false });
  } catch {
    // ignore
  }
}
