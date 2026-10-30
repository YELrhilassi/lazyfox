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
import type { PopupItem, Session, SessionTab, SessionWindow } from "../shared/types";
import type { ChromeAction, ChromeReq } from "../shared/protocol";
import { realTabsInWindow } from "./tabs";
import { stealthContainers, sweepStealthTabs } from "./stealth";
import { readKeyOr, writeKey, removeKey, vSession } from "./store";
import {
  MAX_SESSION_MARKER,
  readCurrentSessionName,
  readSessions,
  refreshSplits,
  snapshotWindows,
  writeCurrentSessionName,
  writeSessions
} from "./sessions/storage";
import {
  autosaveCurrentSession,
  flushOnQuit as flushOnQuitImpl,
  scheduleAutosave as scheduleAutosaveImpl,
  scheduleLayoutSnapshot as scheduleLayoutSnapshotImpl,
  scheduleSnapshot as scheduleSnapshotImpl,
  setLastWindowSnapshot
} from "./sessions/autosave";
import { sessionFromWindows, sessionWindowsOf } from "../shared/sessionwindows";
import {
  applySessionToWindows,
  beginRestore,
  beginSwitch,
  bindRestoreBroadcastChrome,
  bindRestoreRequestChrome,
  bindRestoreRequestChromeToWindow,
  endRestore,
  isRestoringFlag,
  isResumeActive as isResumeActiveImpl,
  isSplashActive as isSplashActiveImpl,
  ownsSwitch,
  dropSwitchCover,
  resumeOnStartup as resumeOnStartupImpl,
  serializeRestore,
  settleSwitch
} from "./sessions/restore";
import { sessionState as sessionStateImpl } from "./sessions/state";



// Chrome-helper hooks, injected by the background entry point.
type ChromeHooks = {
  // `arg` may be any structured-cloneable value (the relay delivers objects
  // as objects).
  requestChrome: <K extends ChromeAction>(action: K, arg?: ChromeReq<K>) => void;
  // The same, addressed to a window by id: a restore re-creates the split
  // layout of every window it rebuilds, and only one of those windows is the
  // focused one.
  requestChromeToWindow: <K extends ChromeAction>(
    winId: number,
    action: K,
    arg?: ChromeReq<K>
  ) => void;
  // The same command to EVERY window's helper. A restore's splash is the one
  // thing that is addressed to all of them (see sessions/restore.ts).
  broadcastChrome: <K extends ChromeAction>(action: K, arg?: ChromeReq<K>) => void;
  pushSessionState: () => void;
};
let pushSessionState: ChromeHooks["pushSessionState"] = () => {};

export function bindChromeHooks(h: ChromeHooks): void {
  pushSessionState = h.pushSessionState;
  bindRestoreRequestChrome(h.requestChrome);
  bindRestoreRequestChromeToWindow(h.requestChromeToWindow);
  bindRestoreBroadcastChrome(h.broadcastChrome);
}

export function isRestoring(): boolean {
  return isRestoringFlag();
}

// "A switch or a launch resume is covering the windows right now": what a
// chrome helper booting mid-operation reads from its alive ack (see bgrelay).
export function isSplashActive(): boolean {
  return isSplashActiveImpl();
}

// "A launch is being resumed right now": what the chrome helper's alive ack
// carries, so a window that boots in the middle of a restore knows to cover
// itself with the splash instead of flashing its way through the rebuild.
export function isResumeActive(): boolean {
  return isResumeActiveImpl();
}

export function scheduleAutosave(): void {
  scheduleAutosaveImpl(isRestoring);
}

export function scheduleSnapshot(): void {
  scheduleSnapshotImpl(isRestoring);
}

// A LAYOUT change (a split appearing, dissolving or being rearranged). Separate
// from scheduleSnapshot because the first measurement of a fresh split is a
// half-formed one; see scheduleLayoutSnapshot.
export function scheduleLayoutSnapshot(): void {
  scheduleLayoutSnapshotImpl(isRestoring);
}

export async function flushOnQuit(): Promise<void> {
  await flushOnQuitImpl();
}

export async function resumeOnStartup(
  autoRestore: boolean | undefined,
  keepStealth?: boolean
): Promise<void> {
  // BEFORE anything reads the window set: close and wipe any stealth tab that
  // Firefox's own session restore brought back (stealth.sweepStealthTabs).
  //
  // THIS IS THE ONE CLEANUP POINT, and the only place `keepStealth` acts. A
  // stealth tab is not session content, so a session switch never touches it
  // (sessions/storage.openTabsInWindow) — that is the rule, not a setting. What
  // the setting decides is whether the RESTART ends the sandbox: off (the
  // default) means the browser's own restore of the jar is swept and wiped
  // before anything else runs, on means the tabs and their cookies come back
  // with the session they were open in.
  //
  // It runs whether or not autoRestore is on — the sweep is the jar's lifetime,
  // not a restore preference — and it runs first so the resume compares its
  // saved windows against a strip that does not have an extra tab in it (which
  // used to fail the window match and make the whole window flash through a
  // rebuild).
  if (!keepStealth) await sweepStealthTabs();
  if (autoRestore === false) {
    // The sweep may have wiped containers on this launch; the bar decides its
    // badge from the id set we send, so it has to hear about that even when
    // there is no session to resume.
    pushSessionState();
    return;
  }
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
  // "Has tabs" is asked of the session's WINDOW SET (sessionWindowsOf), not of
  // its flat tab list: a multi-window session whose focused window happened to
  // be empty is still a session worth resuming, and reading the flat field alone
  // made it look like nothing was saved.
  const hasTabs = (s: Session | null | undefined) =>
    !!s && sessionWindowsOf(s).some((w) => (w.tabs || []).length > 0);
  // A NAMED CURRENT SESSION WINS EVEN WHEN IT IS EMPTY.
  //
  // `newSession` creates an empty session on purpose. Reading "it has no tabs"
  // as "nothing was saved" fell back to the crash-recovery slot — the window the
  // user had just LEFT — and the resume rebuilt that window while the pointer
  // still named the new session, so its next checkpoint wrote the old tabs into
  // a session the user had explicitly started clean. The fallback is for windows
  // with NO named session at all, which is the only case it was written for.
  const named = curName && cur ? cur : null;
  const last = named || (hasTabs(fallback) ? fallback : null);
  if (!last || !hasTabs(last)) return;
  await resumeOnStartupImpl(last, async () => {
    await setLastWindowSnapshot();
    scheduleAutosave();
  });
  // The bar's own startup read can lose its race with this restore (the helper
  // boots while the windows are still being rebuilt), so give it the fresh
  // summary from HERE too — after the resume, including the wait for the pages
  // to load, which is the one moment the session set and its tab counts are
  // final. Unconditional: the resume's fast path (everything already matched)
  // returns before its own post-restore callback runs.
  pushSessionState();
}

export async function sessionList(): Promise<{ sessions: Session[]; current: string }> {
  const all = await readSessions();
  // WHICH SESSION IS THIS WINDOW'S is part of the list, not a second lookup:
  // the popup has to mark the current row, and asking twice let the mark and
  // the rows describe different reads.
  const current = await readCurrentSessionName().catch(() => "");
  const sessions = Object.keys(all)
    .map((k) => all[k])
    .filter((s): s is Session => !!s && Array.isArray(s.tabs))
    .sort((a, b) => (a.marker || 99) - (b.marker || 99));
  return { sessions, current };
}

// The tabs of one named session, as popup rows — for the sessions popup's
// right-hand pane ("what's inside this session").
export async function sessionTabs(name: string): Promise<PopupItem[]> {
  const all = await readSessions();
  const nm = (name || "").trim();
  const s = all[nm];
  if (!s || !Array.isArray(s.tabs)) return [];
  // THE ACTIVE TAB IS THE LIVE ONE when the session on screen is the session
  // this window is running: `s.active` is the index recorded the last time the
  // session was SAVED, so after browsing for a minute the accent sat on a tab
  // the user left long ago. A session that is not current has no live tab to
  // read, so it falls back to the saved index.
  // AN INDEX IS ONLY TRUSTWORTHY INSIDE THE LIST IT INDEXES. A session whose
  // `active` points past its tabs (tabs closed since the save, or a snapshot
  // written before the field was maintained) used to mark NOTHING: every row
  // kept the same ink, which is indistinguishable from a popup that does not
  // mark the active tab at all.
  let activeIdx =
    typeof s.active === "number" && s.active >= 0 && s.active < s.tabs.length ? s.active : -1;
  try {
    const current = await readCurrentSessionName();
    if (current && current === nm) {
      // REAL tabs in strip order — the same list the tab numbers and the saved
      // order use, so a companion UI tab can never shift the accent by one.
      const live = await realTabsInWindow();
      const i = (live || []).findIndex((t: any) => !!t.active);
      if (i >= 0) {
        // The saved list can lag the live window (autosave is debounced) and
        // can hold a different number of rows, so a bare INDEX only decides
        // when the two lists line up — at the same position or in length.
        // Otherwise the live tab is matched by its URL, which is what the row
        // actually represents; keying off the index would mark its neighbour.
        const liveUrl = (live[i] && live[i].url) || "";
        const sameAt = i < s.tabs.length && ((s.tabs[i] && s.tabs[i].url) || "") === liveUrl;
        if (sameAt || live.length === s.tabs.length) {
          activeIdx = i;
        } else {
          const byUrl = liveUrl
            ? s.tabs.findIndex((t) => (t.url || "") === liveUrl)
            : -1;
          activeIdx = byUrl;
        }
      }
    }
  } catch {
    // no live window (or the query was refused): the saved index still marks one
  }
  // A stale index must still leave ONE row marked: the pane's promise is that
  // the active tab is in the accent, and "none of them" is a broken promise.
  if (activeIdx < 0 && s.tabs.length) activeIdx = 0;
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
      active: i === activeIdx,
    };
  });
}

export async function saveSession(name: string): Promise<{ ok: boolean; session?: Session }> {
  const nm = (name || "").trim();
  if (!nm) return { ok: false };
  // SAVE THE WHOLE WINDOW SET, not just the window on screen: a session is what
  // you were doing, and "what you were doing" is every window.
  const wins = await snapshotWindows();
  const all = await readSessions();
  const existing = all[nm];
  const marker =
    (existing && existing.marker) ||
    (await core.assignSessionMarker(Object.values(all).map((s) => s.marker || 0)));
  const session: Session = sessionFromWindows(wins, nm, marker, Date.now());
  all[nm] = session;
  await writeSessions(all);
  await writeKey("lfCurrentSession", nm);
  await writeKey("lfLastSession", session);
  // Saving under a name makes this window that session's, so a switch away
  // checkpoints it there rather than guessing from a stale pointer.
  liveName = nm;
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

// The session the LIVE window set belongs to.
//
// Read from storage once, then maintained here. Every checkpoint has to name
// the session the window is LEAVING, and a switch only writes the new pointer
// after its rebuild succeeds — so storage's pointer is stale for the whole
// duration of a switch, and a second switch that read it would checkpoint the
// freshly-built window into the session it was about to leave. That is a
// recorded failure (rapid `;g`2 then `;g`3 rewrote session 2 with session 3's
// window), and it is why this is memory rather than a storage read per use.
let liveName: string | null = null;

async function liveSessionName(): Promise<string> {
  if (liveName === null) liveName = await readCurrentSessionName();
  return liveName;
}

// Wait (briefly) for a named session to become readable.
//
// A session can be created by the message IMMEDIATELY before the one that
// switches to it, and background message handlers are not serialized: the
// restore's read can win the race against the create's write. Four short looks
// cost nothing on the normal path (the first one finds it) and turn "no such
// session" on a brand-new name into a working `;P n`.
async function waitForSession(nm: string): Promise<Record<string, Session> | null> {
  let all = await readSessions();
  if (all[nm]) return all;
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => setTimeout(r, 60));
    all = await readSessions();
    if (all[nm]) return all;
  }
  return null;
}

// A switch, start to finish.
//
// Three rules make it reliable, and each one exists because of a measured
// failure:
//
//   1. THE FAST PATH READS MEMORY. Restoring the session you are in is a no-op,
//      not a rebuild of the window from a snapshot of itself (the reported
//      "navigating to the same session causes flashing").
//   2. EVERYTHING INSIDE THE LOCK RE-READS ITS INPUTS. A switch queued behind
//      another one used to check its target against storage read BEFORE the
//      first switch wrote anything, and then checkpoint into that stale name.
//      Re-reading inside the lock is what makes the second switch the one that
//      wins, with the first switch's result as its starting point.
//   3. THE PAGE WAIT IS OUTSIDE THE LOCK. The cover stays up until the front
//      pages have settled, but the next switch must not queue behind that wait.
//      A sequence number decides who owns the cover (see restore.beginSwitch).
export async function restoreSession(name: string): Promise<{ ok: boolean; note?: string }> {
  const nm = (name || "").trim();
  if (!nm) return { ok: false, note: "no name" };
  // Cheap rejections before the cover goes up: a missing session is an error,
  // and the session you are already in must not flash a loader at all.
  //
  // The short wait covers `;P n`: creating a session and switching to it are
  // two messages, and the second may reach storage before the first has
  // written. Only a MISSING name pays it, so a normal switch is unchanged.
  if (!(await waitForSession(nm))) {
    return { ok: false, note: "no such session" };
  }
  if ((await liveSessionName()) === nm) return { ok: true, note: "current" };

  const seq = beginSwitch(nm);
  try {
    const ok = await serializeRestore(async () => {
      // A NEWER SWITCH OWNS THE WINDOW SET. Pressing `;g`3 and then `;g`4 queues
      // this one, and rebuilding session 3 on the way to a window that is about
      // to be rebuilt into 4 is a full teardown plus a full load of tabs nobody
      // will ever see. The newer request already raised its own label over the
      // window, so standing down here loses nothing and saves the whole of the
      // intermediate restore — which is what a double press used to feel like.
      if (!ownsSwitch(seq)) return true;
      // AFTER the previous switch, not when this request was read.
      const all = await readSessions();
      const s = all[nm];
      if (!s) return false;
      const outgoing = await liveSessionName();
      // A queued switch to the same session has already rebuilt it; the newer
      // request is satisfied by what is on screen.
      if (outgoing === nm) return true;

      beginRestore();
      let rebuilt = false;
      try {
        // CHECKPOINT THE WINDOW WE ARE LEAVING into the session it belongs to,
        // against a FRESH map: the previous switch in this queue may have
        // rewritten it, and using the stale copy would undo that write.
        await autosaveCurrentSession(all, undefined, outgoing);
        try {
          await applySessionToWindows(s);
        } catch (e) {
          // PUT THE OUTGOING WINDOW BACK. A half-rebuilt window set is neither
          // session, and autosave would persist that mix into whichever name
          // was current — the outgoing one, since the pointer is only written
          // below. The checkpoint above has its exact pre-switch state, so a
          // best-effort re-apply turns a failed switch into a no-op instead of
          // a corrupted session. If the re-apply fails too, the pointer still
          // names the outgoing session and the user can switch again.
          const back = all[outgoing];
          if (back) {
            try {
              await applySessionToWindows(back);
            } catch {
              // the next switch (or the next launch) is the remaining repair
            }
          }
          throw e;
        }
        liveName = nm;
        await writeCurrentSessionName(nm);
        // The bar learns the new name NOW, not after the pages settle: the
        // name is already true, and waiting left it showing the old session
        // while the loader was up.
        pushSessionState();
        rebuilt = true;
      } finally {
        endRestore();
        // ONLY A FINISHED REBUILD IS WORTH SNAPSHOTTING. A failure here leaves
        // the window set half-replaced; refreshing the crash-recovery snapshot
        // from it would let a quit persist that mix into the session we were
        // leaving.
        if (rebuilt) {
          try {
            await setLastWindowSnapshot();
          } catch {
            // ignore — fall back to the debounced autosave
          }
        }
      }
      return true;
    });
    if (!ok) return { ok: false, note: "no such session" };
    return { ok: true };
  } catch {
    // The failed switch has already put the outgoing window back (or never
    // touched it), so there is nothing left to hide: the cover goes now rather
    // than after a page wait for a window that is already correct.
    dropSwitchCover(seq);
    return { ok: false, note: "restore failed" };
  } finally {
    // Cover down once this switch's front pages are ready — unless a newer
    // switch has taken over. NOT AWAITED: the reply that tells the caller the
    // rebuild finished must not wait behind page loads, and the loader owns
    // its own lifetime from here.
    void settleSwitch(seq).catch(() => {});
    // Re-arm the crash-recovery autosave the guard suppressed. Unconditional:
    // a failed switch suppressed nothing and a successful one must not stay
    // silent until the next tab event.
    scheduleAutosave();
  }
}

export async function switchSessionByMarker(
  marker: number
): Promise<{ ok: boolean; name?: string; note?: string }> {
  const all = await readSessions();
  const s = Object.values(all).find((x) => (x.marker || 0) === marker && Array.isArray(x.tabs));
  if (!s) return { ok: false, note: "no session at marker " + marker };
  // The SWITCH decides whether this worked. Reporting ok on the marker lookup
  // alone told the caller "switched" for a session whose restore had failed.
  const r = await restoreSession(s.name);
  if (!r.ok) return { ok: false, note: r.note || "restore failed" };
  // The NOTE travels too (the protocol already declares it): a reply of
  // "current" is a request that rebuilt nothing, and a caller has to be able to
  // tell that apart from a switch that happened.
  return { ok: true, name: s.name, note: r.note };
}

// ;Q (save and quit): persist the current window into its session FIRST
// (awaited, so it survives the shutdown), then close every window. Closing the
// last window quits Firefox.
export async function quitBrowser(): Promise<{ ok: boolean }> {
  try {
    await autosaveCurrentSession(await readSessions(), undefined, await liveSessionName());
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
    if ((await liveSessionName()) === nm) {
      await removeKey("lfCurrentSession");
      liveName = "";
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

// A stored edit to the FLAT tab list has to land in the WINDOW list too.
//
// `windows` is what a restore reads (`sessionWindowsOf` prefers it), and the flat
// fields are its mirror of window 1. Editing only the mirror meant "move a tab
// into session B" reported success, showed the tab in the popup, and then
// switching to B showed nothing: the change lived in a field the restore never
// looks at. A legacy session (flat only) has no window list to keep in step.
function syncFirstWindow(s: Session): void {
  if (!Array.isArray(s.windows) || !s.windows.length) return;
  const first: SessionWindow =
    s.windows[0] || { tabs: [], active: 0, windowState: "normal", splits: "" };
  s.windows[0] = { ...first, tabs: s.tabs, active: s.active, splits: s.splits || "" };
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
  syncFirstWindow(dst);
  if (mode === "move") {
    src.tabs.splice(i, 1);
    src.active = Math.min(Math.max(0, src.active || 0), Math.max(0, src.tabs.length - 1));
    src.splits = await refreshSplits(src.tabs);
    src.updatedAt = Date.now();
    syncFirstWindow(src);
  }
  await writeSessions(all);
  pushSessionState();
  // If the source or target is the current session, mirror the edit in the
  // live window so the autosave converges on the intended result instead of
  // undoing it (see liveWindowSideEffects below).
  const curName = await liveSessionName();
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
      // STEALTH TABS ARE NOT IN THE STORED LIST (they never are), so they must
      // not be in the list the stored INDEX is resolved against either: one of
      // them before the moved tab shifted every position by one, and the close
      // landed on a different tab than the one the user asked to move.
      const real = (await realTabsInWindow()).filter(
        (t) => !stealthContainers.has(t.cookieStoreId)
      );
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
      // No stealth branch: a stealth tab is never session content, and
      // readSessions strips any old snapshot that still records one. A stored
      // `stealth` flag here can only be a leftover, and honouring it would
      // re-open a jar the feature promises is gone.
      await browser.tabs.create({ url: tab.url, active: false });
    }
  } catch {
    // Best-effort: the stored edit is already written; a failed side effect
    // only means the autosave keeps the snapshot in sync with the window.
  }
}

export async function sessionState(winId?: number | null) {
  return sessionStateImpl(winId == null ? null : winId);
}
