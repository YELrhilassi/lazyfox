// Session manager facade: tmux-style named sessions that snapshot a window's
// tabs and split layout and restore them on demand.
//
// The implementation lives in the sessions/ folder:
//   - sessions/storage.ts  — the persisted session map + window snapshot/rebuild
//   - sessions/autosave.ts — debounced checkpoints, crash recovery, quit flush
//   - sessions/restore.ts  — applying a session to the live window, startup resume
//   - sessions/state.ts    — the live status-bar state push
//
// This file is the public API and the CRUD operations over stored sessions.
// Chrome-helper hooks are injected here via bindChromeHooks (by the background
// entry point) and threaded to the modules that need them, which breaks what
// would otherwise be an import cycle: sessions -> relay -> sessions.

import { core } from "../shared/core";
import type { PopupItem, Session, SessionTab } from "../shared/types";
import type { ChromeAction, ChromeReq } from "../shared/protocol";
import { realTabsInWindow } from "./tabs";
import { stealthCreateTab } from "./stealth";
import { readKeyOr, readKey, writeKey, removeKey, vSession, vString } from "./store";
import {
  MAX_SESSION_MARKER,
  readCurrentSessionName,
  readSessions,
  refreshSplits,
  snapshotWindow,
  writeCurrentSessionName,
  writeSessions
} from "./sessions/storage";
import {
  autosaveCurrentSession,
  flushOnQuit as flushOnQuitImpl,
  scheduleAutosave as scheduleAutosaveImpl,
  scheduleSnapshot as scheduleSnapshotImpl,
  setLastWindowSnapshot
} from "./sessions/autosave";
import {
  bindRestoreRequestChrome,
  isRestoringFlag,
  resumeOnStartup as resumeOnStartupImpl,
  restoreSession as restoreSessionImpl
} from "./sessions/restore";
import { sessionState as sessionStateImpl } from "./sessions/state";



// Chrome-helper hooks, injected by the background entry point.
type ChromeHooks = {
  // `arg` may be any structured-cloneable value (the relay delivers objects
  // as objects).
  requestChrome: <K extends ChromeAction>(action: K, arg?: ChromeReq<K>) => void;
  pushSessionState: () => void;
};
let pushSessionState: ChromeHooks["pushSessionState"] = () => {};

export function bindChromeHooks(h: ChromeHooks): void {
  pushSessionState = h.pushSessionState;
  bindRestoreRequestChrome(h.requestChrome);
}

export function isRestoring(): boolean {
  return isRestoringFlag();
}

export function scheduleAutosave(): void {
  scheduleAutosaveImpl(isRestoring);
}

export function scheduleSnapshot(): void {
  scheduleSnapshotImpl(isRestoring);
}

export async function flushOnQuit(): Promise<void> {
  await flushOnQuitImpl();
}

export async function resumeOnStartup(autoRestore: boolean | undefined): Promise<void> {
  if (autoRestore === false) return;
  // Prefer the session that was current when we quit, so relaunching puts you
  // back in the SAME session; fall back to the crash-recovery "last" snapshot
  // for unnamed windows. Reading storage FIRST means a fresh launch (nothing
  // saved yet) returns immediately instead of paying a fixed startup delay.
  const all = await readSessions();
  const curName = await readCurrentSessionName();
  const cur = curName ? all[curName] : null;
  // readKeyOr (not readKey): an ABSENT checkpoint must stay distinguishable
  // from a stored one, so a fresh launch returns immediately instead of
  // paying the fixed startup delay.
  const fallback = await readKeyOr("lfLastSession", vSession);
  const last =
    cur && cur.tabs && cur.tabs.length
      ? cur
      : fallback;
  if (!last || !last.tabs || !last.tabs.length) return;
  await resumeOnStartupImpl(last, async () => {
    await setLastWindowSnapshot();
    scheduleAutosave();
  });
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
    marker,
    tabs: snap.tabs,
    active: snap.active,
    windowState: snap.windowState,
    updatedAt: Date.now(),
    splits: snap.splits
  };
  all[nm] = session;
  await writeSessions(all);
  await writeKey("lfCurrentSession", nm);
  await writeKey("lfLastSession", session);
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

// The rebuild mechanics live in sessions/restore.ts, which also serializes
// concurrent restores: a second switch waits for the first instead of being
// refused. Refusing it meant the user asked for a session and silently got the
// other one, with nothing on screen saying so.
export async function restoreSession(name: string): Promise<{ ok: boolean; note?: string }> {
  const all = await readSessions();
  const s = all[(name || "").trim()];
  // A clean (empty) session is valid: it restores to a single blank home tab.
  // Only a missing session is an error.
  if (!s) return { ok: false };
  // Checkpoint before switching so the current window is never lost.
  await autosaveCurrentSession(all);
  await restoreSessionImpl(
    s,
    async () => {},
    async () => {
      await writeCurrentSessionName(s.name);
      pushSessionState();
    }
  );
  // Refresh the in-memory snapshot to the freshly-restored window immediately
  // (see sessions/autosave.ts for why a fast quit must not flush the stale
  // pre-switch snapshot), then re-arm the crash-recovery autosave the guard
  // suppressed during the rebuild.
  try {
    await setLastWindowSnapshot();
  } catch {
    // ignore — fall back to the debounced autosave
  }
  scheduleAutosave();
  return { ok: true };
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
  } catch {
    // ignore — still quit even if the snapshot fails
  }
  try {
    const wins = await browser.windows.getAll();
    for (const w of wins) {
      await browser.windows.remove(w.id).catch(() => {});
    }
  } catch {
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
    // Deleting the CURRENT session would leave the status bar pointing at a
    // ghost name until the next restart — drop the pointer so it falls back
    // to "default" immediately.
    if ((await readKey("lfCurrentSession", vString, "")) === nm) {
      await removeKey("lfCurrentSession");
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

// Copy or move one tab (by its index in the source session's saved tabs) into
// another session. Sessions are stored snapshots, so this edits the saved tab
// lists — the live window is untouched until the target session is restored.
// The tab joins the target session WITHOUT its splitViewId: a split pairing is
// window-local, so a tab transplanted between sessions must arrive as a single
// tab; both sessions' splits are re-derived afterwards.
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
  const tab: SessionTab | undefined = src.tabs[i];
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
  // If the source or target is the current session, mirror the edit in the
  // live window so the autosave converges on the intended result instead of
  // undoing it (see liveWindowSideEffects below).
  const curName = await readCurrentSessionName();
  await liveWindowSideEffects(srcName, dstName, tab, i, mode, curName || undefined);
  return { ok: true };
}

// The current session's stored snapshot is a live view of the window: the
// autosave re-syncs it from the window on every tab change. So a manual
// move/copy that involves the current session must take effect on the LIVE
// window too, or the autosave immediately undoes it — a tab moved OUT of the
// current session is restored from the window (the move seems to never happen)
// and one moved/copied IN is dropped because the window lacks it.
async function liveWindowSideEffects(
  srcName: string,
  dstName: string,
  tab: SessionTab,
  srcIndex: number,
  mode: "move" | "copy",
  curName: string | undefined
): Promise<void> {
  try {
    if (mode === "move" && srcName === curName) {
      const real = await realTabsInWindow();
      const byIdx = real[srcIndex];
      // Match by stored index first, falling back to a URL search. Never close
      // a tab we cannot positively identify: if the window diverged from the
      // stored snapshot, the index may point elsewhere and the URL may be
      // absent — closing that tab would be worse than letting the autosave
      // keep the snapshot in sync.
      const pick =
        byIdx && byIdx.url === tab.url
          ? byIdx
          : real.find((t) => t.url === tab.url);
      if (pick && pick.id != null) {
        if (real.length <= 1) {
          // Closing the last tab would close the window; replace it with a
          // fresh empty tab instead, and the autosave folds the blank tab
          // back into the session.
          await browser.tabs.update(pick.id, { url: "about:blank" });
        } else {
          await browser.tabs.remove(pick.id);
        }
      }
    }
    if (dstName === curName) {
      if (tab.stealth) await stealthCreateTab(tab.url, false);
      else await browser.tabs.create({ url: tab.url, active: false });
    }
  } catch {
    // Best-effort: the stored edit is already written; a failed side effect
    // only means the autosave keeps the snapshot in sync with the window.
  }
}

export async function sessionState() {
  return sessionStateImpl();
}
