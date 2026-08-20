// Session manager: tmux-style named sessions that snapshot a window's tabs and
// split layout and restore them on demand.
//
// The module owns all session storage (read/write), snapshot/restore, marker
// assignment, crash-recovery autosave, and startup resume. Two chrome-helper
// hooks (requestChrome / pushSessionState) are injected via bindChromeHooks by
// the background entry point, which breaks what would otherwise be an import
// cycle: sessions -> chrome channel -> sessions. Every hook has a no-op default
// so the module is safe to import before binding.

import { core } from "../shared/core";
import type { PopupItem, Session, SessionTab } from "../shared/types";
import { CC_URL, isUITab, realTabsInWindow } from "./tabs";
import { reconcileStealth, stealthContainers, stealthCreateTab } from "./stealth";

const SESSIONS_KEY = "lfSessions";
const CURRENT_SESSION_KEY = "lfCurrentSession";
const LAST_SESSION_KEY = "lfLastSession";
// Sessions keep EVERY tab in the window (no cap — switching sessions must never
// drop tabs). Markers are the only 1-9 constraint, like tmux windows.
const MAX_SESSION_MARKER = 9;

// Chrome-helper hooks, injected by the background entry point.
type ChromeHooks = {
  requestChrome: (action: string, arg?: string) => void;
  pushSessionState: () => void;
};
let requestChrome: ChromeHooks["requestChrome"] = () => {};
let pushSessionState: ChromeHooks["pushSessionState"] = () => {};

export function bindChromeHooks(h: ChromeHooks): void {
  requestChrome = h.requestChrome;
  pushSessionState = h.pushSessionState;
}

async function readSessions(): Promise<Record<string, Session>> {
  try {
    const r = await browser.storage.local.get(SESSIONS_KEY);
    const v = r && r[SESSIONS_KEY];
    if (v && typeof v === "object") return v as Record<string, Session>;
  } catch (e) {
    // fall through
  }
  return {};
}

async function writeSessions(all: Record<string, Session>): Promise<void> {
  await browser.storage.local.set({ [SESSIONS_KEY]: all });
}

async function snapshotWindow(): Promise<{
  tabs: SessionTab[];
  active: number;
  windowState: string;
  splits: string;
}> {
  await reconcileStealth();
  const win = await browser.windows.getCurrent();
  const tabs = await browser.tabs.query({ currentWindow: true });
  const list = tabs || [];
  // Transient tabs are internal plumbing, never user content: the #lfc=
  // request channel (chrome-helper requests) and the splitpanel.html companion
  // pane (pure UI "move a tab into this split" page). Excluding them keeps a
  // checkpoint from capturing them and a restore from re-opening them.
  const content = list.filter((t: any) => !isUITab(t));
  let active = content.findIndex((t: any) => t.active);
  if (active < 0) active = 0;
  // The split layout is computed once, in the Go core, from the read-only
  // splitViewId each tab carries, and stored as a compact "a:b,c:d" string.
  // Restore reads it back through the same core so the pairing logic lives in
  // exactly one place and is Go-tested.
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
    active: active,
    windowState: win && win.state ? win.state : "normal",
    splits: splits
  };
}

async function openTabsInCurrentWindow(tabs: SessionTab[]): Promise<number[]> {
  await reconcileStealth();
  const win = await browser.windows.getCurrent();
  const cur = await browser.tabs.query({ currentWindow: true });
  const entries = (tabs || []).filter((t) => t && t.url);
  // Tabs we may remove: unpinned and not the transient chrome-helper request
  // tab (commandcenter #lfc=req...). Removing that tab from inside its own
  // onUpdated handler while it is still being processed can crash Firefox; the
  // request handler cleans it up itself after the restore.
  const removable = (cur || []).filter(
    (t: any) => !t.pinned && !(t.url && t.url.indexOf("#lfc=req") !== -1)
  );
  // Host tab for the first restored URL. Prefer a removable tab (never remove
  // the window's last tab: closing it closes the whole window). When every tab
  // is pinned or a transient request tab, fall back to the active tab so a
  // restore NEVER piles the saved tabs on top of an unremovable strip.
  const host =
    removable[removable.length - 1] ||
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
      } catch (e) {
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
      } catch (e) {
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
    } catch (e) {
      // ignore
    }
  }
  try {
    await browser.windows.update(win.id, { focused: true });
  } catch (e) {
    // ignore
  }
  // Ordered ids (host first, then created) matching the saved tab order.
  return created;
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
// Preferred source is the Go-computed `splits` string; fall back to grouping
// the per-tab splitViewId for sessions saved before the encoding existed.
async function splitGroupsOfSession(s: Session): Promise<number[][]> {
  if (s.splits) {
    try {
      const pairs = await core.decodeSplits(s.splits);
      if (pairs && pairs.length) return pairs.map((p) => [p[0] + 1, p[1] + 1]);
    } catch (e) {
      // fall through to the splitViewId grouping below
    }
  }
  return splitGroupsOf(s.tabs);
}

// Last successfully-captured window snapshot, so a quit can flush it without
// re-querying (the window is already gone by the time windows.onRemoved fires,
// and an empty query would clobber the save).
let lastSnapshot: Awaited<ReturnType<typeof snapshotWindow>> | null = null;

// Checkpoint: persist the current window before switching away so nothing is
// ever lost — even when the current session was never given a name. The
// snapshot is always written to the crash-recovery "last" slot, and if the
// window belongs to a named session, that session is updated in place too.
// A pre-captured snapshot (used by the quit flush) skips the re-query.
async function autosaveCurrentSession(
  all: Record<string, Session>,
  preSnap?: Awaited<ReturnType<typeof snapshotWindow>>
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
    const r = await browser.storage.local.get(CURRENT_SESSION_KEY);
    const name = r && r[CURRENT_SESSION_KEY];
    if (name && typeof name === "string" && all[name]) {
      const existing = all[name];
      all[name] = {
        name: name,
        marker: existing.marker || 0,
        tabs: snap.tabs,
        active: snap.active,
        windowState: snap.windowState,
        updatedAt: Date.now(),
        splits: snap.splits
      };
      await writeSessions(all);
      await browser.storage.local.set({ [LAST_SESSION_KEY]: all[name] });
    } else {
      await browser.storage.local.set({ [LAST_SESSION_KEY]: recovery });
    }
  } catch (e) {
    // ignore — checkpoint is best-effort
  }
}

// The split layout of a stored tab list, re-derived from each tab's
// window-local splitViewId the same way snapshotWindow computes it on save.
// Used after a tab is moved/copied so the stored "a:b,c:d" splits never
// reference a tab that left the session.
async function refreshSplits(tabs: SessionTab[]): Promise<string> {
  try {
    const svIds = (tabs || []).map((t) =>
      typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : -1
    );
    return await core.encodeSplits(await core.splitPairsOf(svIds));
  } catch (e) {
    return "";
  }
}

// Copy or move one tab (by its index in the source session's saved tabs) into
// another session. Sessions are stored snapshots, so this edits the saved tab
// lists — the live window is untouched until the target session is restored.
// The tab joins the target session WITHOUT its splitViewId: a split pairing is
// window-local (Firefox's native split views), so a tab transplanted between
// sessions must arrive as a single tab; both sessions' splits are re-derived
// afterwards so a moved tab can never leave a stale pair behind.
export async function moveTabBetweenSessions(
  from: string,
  index: number,
  to: string,
  mode: "move" | "copy"
): Promise<{ ok: boolean; note?: string }> {
  const srcName = (from || "").trim();
  const dstName = (to || "").trim();
  const i = Number(index);
  if (!srcName || !dstName || !(i >= 0)) return { ok: false, note: "bad request" };
  if (srcName === dstName) return { ok: false, note: "same session" };
  const all = await readSessions();
  const src = all[srcName];
  const dst = all[dstName];
  if (!src || !Array.isArray(src.tabs)) return { ok: false, note: "no source session" };
  if (!dst || !Array.isArray(dst.tabs)) return { ok: false, note: "no target session" };
  const tab = src.tabs[i];
  if (!tab) return { ok: false, note: "no such tab" };
  dst.tabs.push({ ...tab, splitViewId: undefined });
  dst.active = Math.min(Math.max(0, dst.active || 0), dst.tabs.length - 1);
  dst.splits = await refreshSplits(dst.tabs);
  dst.updatedAt = Date.now();
  if (mode === "move") {
    src.tabs.splice(i, 1);
    src.active = Math.min(Math.max(0, src.active || 0), Math.max(0, src.tabs.length - 1));
    src.splits = await refreshSplits(src.tabs);
    src.updatedAt = Date.now();
  }
  await writeSessions(all);
  pushSessionState();
  return { ok: true };
}

export async function sessionList(): Promise<{ sessions: Session[] }> {
  const all = await readSessions();
  const sessions = Object.keys(all)
    .map((k) => all[k])
    .filter((s): s is Session => !!s && Array.isArray(s.tabs))
    .sort((a, b) => (a.marker || 99) - (b.marker || 99));
  return { sessions };
}

// The tabs of one named session, as popup rows — for the sessions popup's
// right-hand pane ("what's inside this session").
export async function sessionTabs(name: string): Promise<PopupItem[]> {
  const all = await readSessions();
  const s = all[(name || "").trim()];
  if (!s || !Array.isArray(s.tabs)) return [];
  return s.tabs.map((t, i) => {
    const badges: string[] = [];
    if (t.pinned) badges.push("pinned");
    if (t.stealth) badges.push("stealth");
    return {
      kind: "sessionTab",
      sessionIndex: i,
      title: t.title || t.url || "",
      url: t.url || "",
      subtitle: (badges.length ? badges.join(" \u00b7 ") + " \u00b7 " : "") + (t.url || ""),
      active: i === (s.active || 0),
    };
  });
}

export async function saveSession(name: string): Promise<{ ok: boolean; session?: Session }> {
  const nm = (name || "").trim();
  if (!nm) return { ok: false };
  const snap = await snapshotWindow();
  const all = await readSessions();
  const existing = all[nm];
  const marker =
    (existing && existing.marker) ||
    (await core.assignSessionMarker(Object.values(all).map((s) => s.marker || 0)));
  const session: Session = {
    name: nm,
    marker: marker,
    tabs: snap.tabs,
    active: snap.active,
    windowState: snap.windowState,
    updatedAt: Date.now(),
    splits: snap.splits
  };
  all[nm] = session;
  await writeSessions(all);
  await browser.storage.local.set({
    [CURRENT_SESSION_KEY]: nm,
    [LAST_SESSION_KEY]: session
  });
  pushSessionState();
  return { ok: true, session };
}

// Create a clean, named session WITHOUT touching the current window: the new
// session starts empty (no tabs), so switching to it later gives a fresh slate
// and switching back restores whatever was left behind. The caller autosaves
// the current window only when it actually switches.
export async function newSession(name: string): Promise<{ ok: boolean; note?: string }> {
  const nm = (name || "").trim();
  if (!nm) return { ok: false, note: "no name" };
  const all = await readSessions();
  if (all[nm]) return { ok: false, note: "session already exists" };
  const session: Session = {
    name: nm,
    marker: await core.assignSessionMarker(Object.values(all).map((s) => s.marker || 0)),
    tabs: [],
    active: 0,
    windowState: "normal",
    updatedAt: Date.now(),
    splits: ""
  };
  all[nm] = session;
  await writeSessions(all);
  pushSessionState();
  return { ok: true };
}

export async function restoreSession(name: string): Promise<{ ok: boolean; note?: string }> {
  // Re-entrancy guard: two overlapping restores (e.g. a double key press while
  // the window is being rebuilt) would interleave tab teardown and double-open
  // tabs. Ignore the second request.
  if (restoring) return { ok: false, note: "restore already in progress" };
  const all = await readSessions();
  const s = all[(name || "").trim()];
  // A clean (empty) session is valid: it restores to a single blank home tab.
  // Only a missing session is an error.
  if (!s) return { ok: false };
  // Checkpoint before switching so the current window is never lost.
  await autosaveCurrentSession(all);
  // Suppress tab-change side effects (home-tab conversion, debounced autosave,
  // status polling) while the window is being torn down and rebuilt — otherwise
  // each removed/created tab re-renders the status bar and flashes the page.
  restoring = true;
  try {
    const ids = await openTabsInCurrentWindow(s.tabs);
    // Re-create native split groupings (groups of 1-based tab positions).
    const groups = await splitGroupsOfSession(s);
    if (groups.length) {
      // requestChrome already encodeURIComponent's its arg; pre-encoding here
      // would double-encode and break JSON.parse in the chrome helper.
      requestChrome("restoreSplits", JSON.stringify(groups));
    }
    // Restore the active tab by saved index (deterministic tab order).
    const active = Math.min(Math.max(0, s.active || 0), ids.length - 1);
    if (ids[active] != null) {
      await browser.tabs.update(ids[active], { active: true }).catch(() => {});
    }
    await browser.storage.local.set({ [CURRENT_SESSION_KEY]: s.name });
    pushSessionState();
    return { ok: true };
  } finally {
    restoring = false;
    // Refresh the in-memory snapshot to the freshly-restored window IMMEDIATELY.
    // flushOnQuit writes lastSnapshot into the current session on quit; without
    // this, quitting right after a switch would persist the pre-switch
    // checkpoint (e.g. the 1-tab window of the session we left) into the new
    // session, wiping its tabs down to that stale state.
    try {
      lastSnapshot = await snapshotWindow();
    } catch (e) {
      // ignore — fall back to the debounced autosave below
    }
    // Re-arm the crash-recovery snapshot so "last" reflects the newly restored
    // window (the guard suppressed it during the teardown).
    scheduleAutosave();
  }
}

export async function switchSessionByMarker(marker: number): Promise<{ ok: boolean; name?: string }> {
  const all = await readSessions();
  const s = Object.values(all).find((x) => (x.marker || 0) === marker && Array.isArray(x.tabs));
  if (!s) return { ok: false };
  await restoreSession(s.name);
  return { ok: true, name: s.name };
}

// ;Q (save and quit): persist the current window into its session FIRST
// (awaited, so it survives the shutdown), then close every window. Closing the
// last window quits Firefox.
export async function quitBrowser(): Promise<{ ok: boolean }> {
  try {
    await autosaveCurrentSession(await readSessions());
  } catch (e) {
    // ignore — still quit even if the snapshot fails
  }
  try {
    const wins = await browser.windows.getAll();
    for (const w of wins) {
      await browser.windows.remove(w.id).catch(() => {});
    }
  } catch (e) {
    // ignore
  }
  return { ok: true };
}

export async function deleteSession(name: string): Promise<{ ok: boolean; note?: string }> {
  const all = await readSessions();
  const nm = (name || "").trim();
  if (all[nm]) {
    delete all[nm];
    await writeSessions(all);
    // Deleting the CURRENT session would otherwise leave the status bar
    // pointing at a ghost name until the next Firefox restart — drop the
    // pointer so it falls back to "default" immediately.
    try {
      const r = await browser.storage.local.get(CURRENT_SESSION_KEY);
      if (r && r[CURRENT_SESSION_KEY] === nm) {
        await browser.storage.local.remove(CURRENT_SESSION_KEY);
      }
    } catch (e) {
      // ignore
    }
    pushSessionState();
    return { ok: true, note: "deleted" };
  }
  return { ok: false, note: "no such session" };
}

// Explicitly (re)assign a session's marker. If another session already holds
// the marker, it is unmarked so each marker stays unique. The clamping and
// auto-assignment live in the Go core; this is the storage mutation around them.
export async function assignSessionMarker(
  name: string,
  marker: number
): Promise<{ ok: boolean; note?: string }> {
  const all = await readSessions();
  const nm = (name || "").trim();
  const m = Number(marker);
  if (!all[nm]) return { ok: false, note: "no such session" };
  if (!(m >= 1 && m <= MAX_SESSION_MARKER)) {
    return { ok: false, note: "marker must be 1-9" };
  }
  for (const k of Object.keys(all)) {
    if (k !== nm && all[k] && (all[k]!.marker || 0) === m) {
      all[k]!.marker = 0;
    }
  }
  all[nm]!.marker = m;
  await writeSessions(all);
  pushSessionState();
  return { ok: true };
}

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
  let name = "default";
  try {
    const r = await browser.storage.local.get(CURRENT_SESSION_KEY);
    if (r && r[CURRENT_SESSION_KEY]) name = String(r[CURRENT_SESSION_KEY]);
  } catch (e) {
    // ignore
  }
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
    // splitViewId (read-only on the tabs API). Detect it so the status bar
    // reflects native splits created by the chrome helper.
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
    name: name,
    marker: marker,
    tabIndex: active >= 0 ? active + 1 : 1,
    tabCount: list.length,
    inSplit: inSplit,
    splitOrientation: splitOrientation,
    splitActive: splitActive,
    splitPanes: splitPanes,
    sessions: summary,
    // Real tab ids in strip order (transient tabs included), so the chrome
    // helper can show each tab's true id in the tab switcher popup.
    tabIds: (allTabs || []).map((t: any) => t.id),
    // Whether the active tab is stealth (drives the status-bar badge).
    activeStealth:
      active >= 0 && !!list[active] && stealthContainers.has(list[active]!.cookieStoreId),
    // Parallel to tabIds (strip order) so the chrome helper can mark each tab's
    // stealth state in its own tab switcher without re-deriving it.
    stealthFlags: (allTabs || []).map((t: any) => stealthContainers.has(t.cookieStoreId))
  };
}

// Debounced crash-recovery snapshot of the current window ("last" session).
let autosaveTimer: number | null = null;
// True while restoreSession is rebuilding the window; tab-change side effects
// (home conversion, autosave, status refresh) are suppressed during it.
let restoring = false;

export function isRestoring(): boolean {
  return restoring;
}

export function setRestoring(v: boolean): void {
  restoring = v;
}

export function scheduleAutosave(): void {
  if (restoring) return;
  if (autosaveTimer != null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    try {
      // Persist the CURRENT window into BOTH its named session (if it has one)
      // and the crash-recovery "last" slot. Writing only "last" here was the
      // data-loss bug: tabs opened after a session was saved never reached that
      // session's stored tab list, so its pill count stayed stale and the tabs
      // were gone after a quit/relaunch.
      await autosaveCurrentSession(await readSessions());
    } catch (e) {
      // ignore — autosave is best-effort
    }
  }, 1500);
}

// Keep lastSnapshot current in memory on tab changes (short debounce, no
// storage write). flushOnQuit persists lastSnapshot into the current session
// when the last window closes, so without this a quit right after a change —
// before the 1.5s autosave debounce fires — would flush a stale window and
// lose the newest tabs. Suppressed while a restore is rebuilding the window
// (it would capture a partial teardown); restoreSession refreshes lastSnapshot
// itself when it finishes.
let snapshotTimer: number | null = null;
export function scheduleSnapshot(): void {
  if (restoring) return;
  if (snapshotTimer != null) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    try {
      lastSnapshot = await snapshotWindow();
    } catch (e) {
      // ignore — best-effort
    }
  }, 250);
}

// Resume the saved session on startup when autoRestore is on. This runs
// UNCONDITIONALLY (not just when the window is blank): Firefox's own session
// restore runs first and can't faithfully restore a tab that was navigated from
// the command center, leaving it blank. Waiting for native restore to settle,
// then rebuilding the window from OUR snapshot, fixes that — the blank tab is
// replaced and everything else is restored exactly as saved.
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
  } catch (e) {
    return false;
  }
  for (const [a, b] of pairs) {
    const ta = cur[a] as any;
    const tb = cur[b] as any;
    const ia = ta && typeof ta.splitViewId === "number" ? ta.splitViewId : -1;
    const ib = tb && typeof tb.splitViewId === "number" ? tb.splitViewId : -1;
    if (ia < 0 || ia !== ib) return true;
  }
  return false;
}

export async function resumeOnStartup(autoRestore: boolean | undefined): Promise<void> {
  if (autoRestore === false) return;
  // Prefer the session that was current when we quit, so relaunching puts you
  // back in the SAME session; fall back to the crash-recovery "last" snapshot
  // for unnamed windows. Reading storage FIRST means a fresh launch (nothing
  // saved yet) returns immediately instead of paying a fixed startup delay.
  const r = await browser.storage.local.get([CURRENT_SESSION_KEY, LAST_SESSION_KEY]);
  let last = r && r[LAST_SESSION_KEY];
  const curName = r && r[CURRENT_SESSION_KEY];
  if (curName && typeof curName === "string") {
    const all = await readSessions();
    const cur = all[curName];
    if (cur && cur.tabs && cur.tabs.length) last = cur;
  }
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
        requestChrome("restoreSplits", JSON.stringify(groups));
      }
    }
    return;
  }
  // Rebuild the window from the snapshot, replacing whatever Firefox natively
  // restored (e.g. a blank tab where a command-center-navigated tab used to
  // be). restoring=true suppresses tab-change side effects (home conversion,
  // autosave) while the window is rebuilt.
  restoring = true;
  try {
    const ids = await openTabsInCurrentWindow(last.tabs);
    // Re-create native split pairings exactly like a session switch, so the
    // restored window looks the way it was left (not flattened).
    const groups = await splitGroupsOfSession(last);
    if (groups.length) {
      requestChrome("restoreSplits", JSON.stringify(groups));
    }
    // Restore the active tab by its saved index (deterministic order).
    const active = Math.min(Math.max(0, last.active || 0), ids.length - 1);
    if (ids[active] != null) {
      await browser.tabs.update(ids[active], { active: true }).catch(() => {});
    }
  } finally {
    restoring = false;
    // Same as restoreSession: keep lastSnapshot in sync with the restored
    // window so a fast quit can't flush a stale/partial snapshot into the
    // session.
    try {
      lastSnapshot = await snapshotWindow();
    } catch (e) {
      // ignore
    }
    scheduleAutosave();
  }
}

// Flush on quit: when the last window closes, Firefox is quitting. Persist the
// last-known snapshot (captured on the previous tab change) so a tab opened
// moments before Alt+F4 isn't lost to the 1.5s autosave debounce. Uses
// lastSnapshot rather than re-querying: the window is already gone and an empty
// query would overwrite a good session with an empty one.
export async function flushOnQuit(): Promise<void> {
  const remaining = await browser.windows.getAll();
  if (remaining.length === 0 && lastSnapshot) {
    await autosaveCurrentSession(await readSessions(), lastSnapshot);
  }
}
