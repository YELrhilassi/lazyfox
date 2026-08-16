// Extension background script: browser-API actions (tabs, windows, history,
// bookmarks, downloads, search), the #lfc=req request channel for the chrome
// helper, and the command-center home-tab conversion. URL normalization and
// visited ranking come from the Go core.

import { core, ensureCore } from "../shared/core";
import { mergeConfig } from "../shared/config";
import type { BgAction } from "../shared/protocol";
import type { Session, SessionTab } from "../shared/types";

(function () {
  "use strict";

  const CC_URL = browser.runtime.getURL("commandcenter.html");
  const HOMEISH = /^about:(home|newtab|blank)$/i;

  async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  let visitedCache: any[] = [];
  let visitedCacheAt = 0;
  async function getVisited() {
    const now = Date.now();
    if (visitedCache.length && now - visitedCacheAt < 60000) {
      return visitedCache;
    }
    try {
      const items = await browser.history.search({
        text: "",
        startTime: 0,
        maxResults: 5000
      });
      const seen = new Map();
      for (const h of items) {
        if (!h.url || /^(about|chrome|moz-extension|file):/i.test(h.url)) continue;
        const prev = seen.get(h.url);
        if (!prev || h.lastVisitTime > prev.lastVisitTime) {
          seen.set(h.url, {
            url: h.url,
            title: h.title || "",
            time: h.lastVisitTime || 0
          });
        }
      }
      visitedCache = Array.from(seen.values());
      visitedCacheAt = now;
    } catch (e) {}
    return visitedCache;
  }

  async function suggestSearch(q: string) {
    const text = (q || "").trim();
    const entries: any[] = [];
    if (!text) return { entries };
    let engine = "default search engine";
    try {
      const engines = await browser.search.get();
      const g = engines.find((e: any) => /google/i.test(e.name));
      if (g) engine = g.name;
    } catch (e) {}
    entries.push({
      kind: "search",
      title: "Search the web for \u201C" + text + "\u201D",
      subtitle: engine,
      query: text
    });
    return { entries };
  }

  async function suggestUrls(q: string) {
    const text = (q || "").trim();
    const entries: any[] = [];
    if (!text) return { entries };
    const url = await core.normalizeUrl(text);
    entries.push({
      kind: "url",
      title: "Open URL",
      subtitle: url,
      url: url
    });
    const visited = await getVisited();
    const ranked = await core.rankVisited(visited, text);
    for (const u of ranked) {
      entries.push({
        kind: "page",
        title: u.title || u.url,
        subtitle: u.url,
        url: u.url,
        time: u.time
      });
    }
    return { entries };
  }

  async function searchUrlFor(q: string): Promise<string> {
    let url = "";
    try {
      const engines = await browser.search.get();
      const e = engines.find((x: any) => /google/i.test(x.name)) || engines[0];
      if (e && e.searchUrl) {
        url = e.searchUrl
          .replace("{searchTerms}", encodeURIComponent(q))
          .replace("{inputEncoding}", "UTF-8");
      }
    } catch (e) {}
    if (!url) url = "https://www.google.com/search?q=" + encodeURIComponent(q);
    return url;
  }

  async function doSearch(query: string) {
    const q = (query || "").trim();
    if (!q) return { ok: false };
    const tab = await getActiveTab();
    if (isCommandCenter(tab)) {
      await browser.tabs.update(tab.id, { url: await searchUrlFor(q), active: true });
      return { ok: true, engine: "default", reused: true };
    }
    try {
      await browser.search.search({ query: q });
      return { ok: true };
    } catch (e) {}
    await browser.tabs.create({
      url: "https://www.google.com/search?q=" + encodeURIComponent(q),
      active: true
    });
    return { ok: true, engine: "Google" };
  }

  async function getWindowSize() {
    const win = await browser.windows.getCurrent();
    return {
      width: win.width,
      height: win.height,
      state: win.state,
      top: win.top,
      left: win.left
    };
  }

  async function resizeWindow(dx: number, dy: number) {
    const win = await browser.windows.getCurrent();
    const w = Math.max(420, (win.width || 1200) + (dx || 0));
    const h = Math.max(300, (win.height || 800) + (dy || 0));
    const up = await browser.windows.update(win.id, { width: w, height: h });
    return { width: up.width, height: up.height, state: up.state };
  }

  async function moveWindow(dx: number, dy: number) {
    const win = await browser.windows.getCurrent();
    if (win.state === "maximized" || win.state === "fullscreen") {
      return {
        left: win.left,
        top: win.top,
        state: win.state,
        note: win.state + " \u2014 Esc to leave move mode"
      };
    }
    const left = Math.round((win.left || 0) + (dx || 0));
    const top = Math.round((win.top || 0) + (dy || 0));
    const up = await browser.windows.update(win.id, { left: left, top: top });
    return { left: up.left, top: up.top, state: up.state };
  }

  async function activateTabByIndex(n: number) {
    const tabs = await realTabsInWindow();
    const idx = Math.max(0, (n || 1) - 1);
    const tab = tabs[Math.min(idx, tabs.length - 1)];
    if (!tab) return { ok: false };
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return { ok: true, title: tab.title || "" };
  }

  async function toggleMaximize() {
    const win = await browser.windows.getCurrent();
    const isMax = win.state === "maximized";
    const up = await browser.windows.update(win.id, {
      state: isMax ? "normal" : "maximized"
    });
    return { maximized: !isMax, state: up.state };
  }

  async function tabsInWindow() {
    await reconcileStealth();
    const tabs = await realTabsInWindow();
    return {
      tabs: tabs.map((t: any) => ({
        id: t.id,
        title: t.title || t.url || "about:blank",
        url: t.url || "",
        active: t.active,
        pinned: t.pinned,
        muted: t.mutedInfo && t.mutedInfo.muted,
        favIconUrl: t.favIconUrl || "",
        stealth: stealthContainers.has(t.cookieStoreId)
      }))
    };
  }

  /* ===================== sessions (tmux-style) ===================== */

  const SESSIONS_KEY = "lfSessions";
  const CURRENT_SESSION_KEY = "lfCurrentSession";
  const LAST_SESSION_KEY = "lfLastSession";
  // Sessions keep EVERY tab in the window (no cap — switching sessions must
  // never drop tabs). Markers are the only 1-9 constraint, like tmux windows.
  const MAX_SESSION_MARKER = 9;

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

  // Transient UI tabs (the split-panel companion and the #lfc= request
  // channel) are not user tabs: numbering (tab switcher, ;1-9, ;+N, the
  // status bar) skips them so a tab's identity never shifts when a
  // split/unsplit adds or removes a companion pane.
  function isUITab(t: any): boolean {
    const u = (t && t.url) || "";
    return u.indexOf("splitpanel.html") !== -1 || u.indexOf("#lfc=") !== -1;
  }

  async function realTabsInWindow(): Promise<any[]> {
    const tabs = await browser.tabs.query({ currentWindow: true });
    return (tabs || []).filter((t: any) => !isUITab(t));
  }

  /* ===================== stealth tabs (isolated + self-wiping) ===================== */

  const STEALTH_KEY = "lfStealth";
  // cookieStoreIds WE own. A tab's cookieStoreId alone can't identify a
  // stealth tab (a user's own container would look identical), so snapshot /
  // restore test membership in this set.
  const stealthContainers = new Set<string>();
  // Live tabId -> cookieStoreId so tabs.onRemoved wipes the right container.
  const stealthTabs = new Map<number, string>();
  let stealthReconcile: Promise<void> | null = null;

  async function readStealth(): Promise<{ containers: string[] }> {
    try {
      const r = await browser.storage.local.get(STEALTH_KEY);
      const v = r && r[STEALTH_KEY];
      if (v && Array.isArray(v.containers)) return v as { containers: string[] };
    } catch (e) {
      // fall through
    }
    return { containers: [] };
  }

  async function writeStealth(st: { containers: string[] }): Promise<void> {
    await browser.storage.local.set({ [STEALTH_KEY]: st });
  }

  async function persistStealth(): Promise<void> {
    await writeStealth({ containers: Array.from(stealthContainers) });
  }

  async function wipeStealthContainer(cs: string): Promise<void> {
    stealthContainers.delete(cs);
    try {
      // Remove everything the container stored (cookies, storage, cache, ...).
      await browser.browsingData.remove({ cookieStoreId: cs, since: 0 });
    } catch (e) {
      // ignore
    }
    try {
      await browser.contextualIdentities.remove(cs);
    } catch (e) {
      // ignore
    }
  }

  // Rebuild the live maps from storage and wipe any container whose tab is
  // already gone — the "racy cleanup" path: if Firefox quit before the close
  // handler ran, the orphan is caught here on next launch.
  async function doReconcileStealth(): Promise<void> {
    const st = await readStealth();
    const keep: string[] = [];
    for (const cs of st.containers || []) {
      let tabs: any[] = [];
      try {
        tabs = await browser.tabs.query({ cookieStoreId: cs });
      } catch (e) {
        tabs = [];
      }
      if (tabs.length === 0) {
        await wipeStealthContainer(cs);
      } else {
        keep.push(cs);
        stealthContainers.add(cs);
        for (const t of tabs) {
          if (t.id != null) stealthTabs.set(t.id, cs);
        }
      }
    }
    await writeStealth({ containers: keep });
  }

  function reconcileStealth(): Promise<void> {
    if (!stealthReconcile) {
      stealthReconcile = doReconcileStealth().catch(() => {});
    }
    return stealthReconcile;
  }

  async function createStealthContainer(): Promise<string> {
    const ci = await browser.contextualIdentities.create({
      name: "Stealth",
      color: "purple",
      icon: "fingerprint",
    });
    stealthContainers.add(ci.cookieStoreId);
    return ci.cookieStoreId;
  }

  async function stealthCreateTab(url: string, active: boolean): Promise<any> {
    const cs = await createStealthContainer();
    const t = await browser.tabs.create({ url, cookieStoreId: cs, active });
    if (t && t.id != null) stealthTabs.set(t.id, cs);
    await persistStealth();
    return t;
  }

  // Open the current page (or the command center) in a fresh stealth tab.
  async function stealthOpen(): Promise<{ ok: boolean; error?: string }> {
    await reconcileStealth();
    try {
      // The contextualIdentities API only exists when the permission was
      // granted at install time. A stale install (or one updated without
      // approving the new permission) silently loses it — `browser.
      // contextualIdentities` becomes undefined and .create throws. Diagnose
      // that case so the toast says what to do instead of a cryptic error.
      const ci: any = (browser as any).contextualIdentities;
      if (!ci || typeof ci.create !== "function") {
        return {
          ok: false,
          error:
            "contextualIdentities permission missing — reload the extension " +
            "(about:debugging → This Firefox → Lazyfox → Reload) or reinstall " +
            "the built dist/ extension so the new permissions apply"
        };
      }
      // Always open a FRESH empty stealth tab (the command center home page,
      // which renders with the stealth look) rather than cloning the current
      // page — ;N means "start somewhere new and isolated".
      await stealthCreateTab(CC_URL, true);
      void pushSessionStateToChrome();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e as any) && (e as any).message ? (e as any).message : e) };
    }
  }

  async function removeStealthContainerForTab(tabId: number): Promise<void> {
    const cs = stealthTabs.get(tabId);
    if (!cs) return;
    stealthTabs.delete(tabId);
    await wipeStealthContainer(cs);
    await persistStealth();
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
    // request channel (chrome-helper requests) and the splitpanel.html
    // companion pane (pure UI "move a tab into this split" page). Excluding
    // them keeps a checkpoint from capturing them and a restore from
    // re-opening them (they would linger and compound across switches).
    const content = list.filter((t: any) => !isUITab(t));
    let active = content.findIndex((t: any) => t.active);
    if (active < 0) active = 0;
    // The split layout is computed once, in the Go core, from the read-only
    // splitViewId each tab carries (Firefox bug 2016928), and stored as a
    // compact "a:b,c:d" string. Restore reads it back through the same core,
    // so the pairing logic lives in exactly one place and is Go-tested.
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
          stealth: stealthContainers.has(t.cookieStoreId),
        };
      }),
      active: active,
      windowState: win && win.state ? win.state : "normal",
      splits: splits,
    };
  }

  async function openTabsInCurrentWindow(tabs: SessionTab[]): Promise<number[]> {
    await reconcileStealth();
    const win = await browser.windows.getCurrent();
    const cur = await browser.tabs.query({ currentWindow: true });
    const entries = (tabs || []).filter((t) => t && t.url);
    // Tabs we may remove: unpinned and not the transient chrome-helper
    // request tab (commandcenter #lfc=req...). Removing that tab from inside
    // its own onUpdated handler while it is still being processed can crash
    // Firefox; the request handler cleans it up itself after the restore.
    const removable = (cur || []).filter(
      (t: any) => !t.pinned && !(t.url && t.url.indexOf("#lfc=req") !== -1)
    );
    // Host tab for the first restored URL. Prefer a removable tab (never
    // remove the window's last tab: closing it closes the whole window, which
    // flashes/relaunches and orphans the WebDriver session). When every tab
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
      // Empty session (clean slate): park the host on the command center so
      // a fresh session opens on the home page instead of a leftover tab.
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

  // 1-based tab positions grouped by native splitViewId, for the chrome helper
  // to re-create split pairings after a restore (positions match the saved
  // tab order, which restore reproduces exactly).
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
  // Preferred source is the Go-computed `splits` string (decode through the
  // core so the pairing logic lives in one place); fall back to grouping the
  // per-tab splitViewId for sessions saved before the encoding existed.
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
  // re-querying (the window is already gone by the time windows.onRemoved
  // fires, and an empty query would clobber the save).
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
        splits: snap.splits,
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
          splits: snap.splits,
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

  async function sessionList(): Promise<{ sessions: Session[] }> {
    const all = await readSessions();
    const sessions = Object.keys(all)
      .map((k) => all[k])
      .filter((s): s is Session => !!s && Array.isArray(s.tabs))
      .sort((a, b) => (a.marker || 99) - (b.marker || 99));
    return { sessions };
  }

  async function saveSession(name: string): Promise<{ ok: boolean; session?: Session }> {
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
      splits: snap.splits,
    };
    all[nm] = session;
    await writeSessions(all);
    await browser.storage.local.set({
      [CURRENT_SESSION_KEY]: nm,
      [LAST_SESSION_KEY]: session,
    });
    void pushSessionStateToChrome();
    return { ok: true, session };
  }

  // Create a clean, named session WITHOUT touching the current window: the
  // new session starts empty (no tabs), so switching to it later gives a
  // fresh slate and switching back restores whatever was left behind. The
  // caller autosaves the current window only when it actually switches.
  async function newSession(name: string): Promise<{ ok: boolean; note?: string }> {
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
      splits: "",
    };
    all[nm] = session;
    await writeSessions(all);
    void pushSessionStateToChrome();
    return { ok: true };
  }

  async function restoreSession(name: string): Promise<{ ok: boolean; note?: string }> {
    // Re-entrancy guard: two overlapping restores (e.g. a double key press
    // while the window is being rebuilt) would interleave tab teardown and
    // double-open tabs. Ignore the second request.
    if (restoring) return { ok: false, note: "restore already in progress" };
    const all = await readSessions();
    const s = all[(name || "").trim()];
    // A clean (empty) session is valid: it restores to a single blank home
    // tab. Only a missing session is an error.
    if (!s) return { ok: false };
    // Checkpoint before switching so the current window is never lost.
    await autosaveCurrentSession(all);
    // Suppress tab-change side effects (home-tab conversion, debounced
    // autosave, status polling) while the window is being torn down and
    // rebuilt — otherwise each removed/created tab re-renders the status bar
    // and flashes the page mid-switch.
    restoring = true;
    try {
      const ids = await openTabsInCurrentWindow(s.tabs);
      // Re-create native split groupings (groups of 1-based tab positions).
      const groups = await splitGroupsOfSession(s);
      if (groups.length) {
        // requestChrome already encodeURIComponent's its arg; pre-encoding
        // here would double-encode and break JSON.parse in the chrome helper.
        requestChrome("restoreSplits", JSON.stringify(groups));
      }
      // Restore the active tab by saved index (deterministic tab order).
      const active = Math.min(Math.max(0, s.active || 0), ids.length - 1);
      if (ids[active] != null) {
        await browser.tabs.update(ids[active], { active: true }).catch(() => {});
      }
      await browser.storage.local.set({ [CURRENT_SESSION_KEY]: s.name });
      void pushSessionStateToChrome();
      return { ok: true };
    } finally {
      restoring = false;
      // Re-arm the crash-recovery snapshot so "last" reflects the newly
      // restored window (the guard suppressed it during the teardown).
      scheduleAutosave();
    }
  }

  async function switchSessionByMarker(marker: number): Promise<{ ok: boolean; name?: string }> {
    const all = await readSessions();
    const s = Object.values(all).find((x) => (x.marker || 0) === marker && Array.isArray(x.tabs));
    if (!s) return { ok: false };
    await restoreSession(s.name);
    return { ok: true, name: s.name };
  }

  // ;Q (save and quit): persist the current window into its session FIRST
  // (awaited, so it survives the shutdown), then close every window. Closing
  // the last window quits Firefox.
  async function quitBrowser(): Promise<{ ok: boolean }> {
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

  async function deleteSession(name: string): Promise<{ ok: boolean; note?: string }> {
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
      void pushSessionStateToChrome();
      return { ok: true, note: "deleted" };
    }
    return { ok: false, note: "no such session" };
  }

  // Explicitly (re)assign a session's marker. If another session already holds
  // the marker, it is unmarked so each marker stays unique. The clamping and
  // auto-assignment live in the Go core; this is the storage mutation around
  // them.
  async function assignSessionMarker(
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
    void pushSessionStateToChrome();
    return { ok: true };
  }

  async function sessionState(): Promise<{
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
    // Numbering keys off REAL tabs only, so the status-bar tab index/count
    // never shifts when a companion split-panel pane is added/removed.
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
    const summaryInput: { name: string; marker: number; tabCount: number; splitCount: number }[] = [];
    for (const s of Object.values(all)) {
      let splitCount = 0;
      if (s.splits) {
        try {
          splitCount = (await core.decodeSplits(s.splits)).length;
        } catch (e) {
          splitCount = 0;
        }
      } else {
        // Pre-encoding sessions: two tabs per split share one splitViewId.
        splitCount = Math.floor(
          (s.tabs || []).filter(
            (t: any) => typeof t.splitViewId === "number" && t.splitViewId >= 0
          ).length / 2
        );
      }
      summaryInput.push({
        name: s.name,
        marker: s.marker || 0,
        tabCount: (s.tabs || []).length,
        splitCount: splitCount,
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
      // Parallel to tabIds (strip order) so the chrome helper can mark each
      // tab's stealth state in its own tab switcher without re-deriving it.
      stealthFlags: (allTabs || []).map((t: any) => stealthContainers.has(t.cookieStoreId)),
    };
  }

  // Debounced crash-recovery snapshot of the current window ("last" session).
  let autosaveTimer: number | null = null;
  // True while restoreSession is rebuilding the window; tab-change side effects
  // (home conversion, autosave, status refresh) are suppressed during it so
  // the switch does not flash.
  let restoring = false;
  function scheduleAutosave(): void {
    if (restoring) return;
    if (autosaveTimer != null) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      autosaveTimer = null;
      try {
        // Persist the CURRENT window into BOTH its named session (if it has
        // one) and the crash-recovery "last" slot. Writing only "last" here
        // was the data-loss bug: tabs opened after a session was saved never
        // reached that session's stored tab list, so its pill count stayed
        // stale and the tabs were gone after a quit/relaunch.
        await autosaveCurrentSession(await readSessions());
      } catch (e) {
        // ignore — autosave is best-effort
      }
    }, 1500);
  }

  async function historySearch(q: string) {
    const text = (q || "").trim();
    if (!text) return { items: [] };
    const items = await browser.history.search({
      text: text,
      startTime: 0,
      maxResults: 60
    });
    return {
      items: items.map((h: any) => ({
        title: h.title || h.url,
        url: h.url,
        time: h.lastVisitTime || 0
      }))
    };
  }

  async function bookmarksSearch(q: string) {
    const text = (q || "").trim();
    let items: any[] = [];
    if (text.length >= 1) {
      items = await browser.bookmarks.search({ query: text });
    } else {
      const tree = await browser.bookmarks.getTree();
      const out: any[] = [];
      const walk = (nodes: any[]) => {
        for (const n of nodes) {
          if (n.url) out.push(n);
          if (n.children) walk(n.children);
        }
      };
      walk(tree);
      items = out.slice(0, 100);
    }
    return {
      items: items
        .filter((b) => b.url)
        .map((b) => ({ title: b.title || b.url, url: b.url }))
    };
  }

  async function downloadsList() {
    const items = await browser.downloads.search({
      limit: 120,
      orderBy: ["-startTime"]
    });
    return {
      items: items.map((d: any) => {
        const path = d.filename || "";
        const state =
          d.state === "in_progress"
            ? d.paused
              ? "paused"
              : "in_progress"
            : d.state === "complete"
              ? "complete"
              : d.paused
                ? "paused"
                : "failed";
        const total = d.totalBytes || d.fileSize || 0;
        return {
          kind: "download",
          key: String(d.id),
          filename:
            (path ? path.split(/[\\/]/).pop() : "") ||
            (d.url || "").split("/").pop() ||
            d.url ||
            "",
          path: path,
          url: d.url || "",
          state: state,
          received: d.bytesReceived || 0,
          total: total,
          speed: 0,
          progress:
            total > 0
              ? Math.max(0, Math.min(100, Math.round(((d.bytesReceived || 0) / total) * 100)))
              : -1
        };
      })
    };
  }

  async function openDownload(id: string) {
    const n = Number(id);
    try {
      await browser.downloads.open(n);
      return { ok: true };
    } catch (e) {
      try {
        await browser.downloads.show(n);
        return { ok: true, revealed: true };
      } catch (e2) {
        return { ok: false, error: String(e2) };
      }
    }
  }

  async function removeDownload(id: string) {
    const n = Number(id);
    try {
      await browser.downloads.removeFile(n);
    } catch (e) {
      // the file may already be gone — keep going so history is cleared
    }
    try {
      await browser.downloads.erase({ id: n });
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: String(e2) };
    }
  }

  async function openDownloadLocation(id: string) {
    try {
      await browser.downloads.show(Number(id));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function toggleZen() {
    const win = await browser.windows.getCurrent();
    const isZen = win.state === "fullscreen";
    await browser.windows.update(win.id, {
      state: isZen ? "normal" : "fullscreen"
    });
    return { zen: !isZen };
  }

  async function zoom(delta: number, factor: number | undefined) {
    const tab = await getActiveTab();
    if (!tab || tab.id === browser.tabs.TAB_ID_NONE) return { factor: 1 };
    let f: number | null = factor != null ? factor : null;
    if (f == null) {
      f = Math.max(0.3, Math.min(5, Math.round(((await browser.tabs.getZoom(tab.id)) + delta) * 100) / 100));
    }
    await browser.tabs.setZoom(tab.id, f);
    return { factor: f };
  }

  async function toggleMute() {
    const tab = await getActiveTab();
    if (!tab) return { muted: false };
    const muted = !(tab.mutedInfo && tab.mutedInfo.muted);
    await browser.tabs.update(tab.id, { muted });
    return { muted };
  }

  async function reopenTab() {
    const closed = await browser.sessions.getRecentlyClosed({
      maxResults: 10
    });
    for (const item of closed) {
      if (item.tab) {
        await browser.sessions.restore(item.tab.sessionId);
        return { ok: true };
      }
    }
    return { ok: false };
  }

  async function getConfig() {
    try {
      const r = await browser.storage.local.get("config");
      return mergeConfig(r.config || {});
    } catch (e) {
      return mergeConfig({});
    }
  }

  function isCommandCenter(tab: any) {
    return !!(tab && tab.url && tab.url.indexOf(CC_URL) === 0);
  }

  function stripHash(url: string) {
    const i = url ? url.indexOf("#") : -1;
    return i < 0 ? url : url.slice(0, i);
  }

  async function openUrl(url: string, newTab: boolean | undefined) {
    if (!url) return { ok: false };
    const tab = await getActiveTab();
    if (isCommandCenter(tab)) {
      await browser.tabs.update(tab.id, { url, active: true });
      return { ok: true, reused: true };
    }
    if (newTab == null) {
      const c = await getConfig();
      newTab = c.openInNewTab !== false;
    }
    if (newTab || !tab) {
      await browser.tabs.create({ url, active: true });
    } else {
      await browser.tabs.update(tab.id, { url });
    }
    return { ok: true };
  }

  const CHROME_PAGES: { [k: string]: string } = {
    "about:preferences": "preferences",
    "about:addons": "addons",
    "about:history": "history",
    "about:downloads": "downloads"
  };

  async function openPage(url: string) {
    const target = CHROME_PAGES[url];
    const tab = await getActiveTab();
    if (target) {
      const base = CC_URL;
      if (isCommandCenter(tab)) {
        await browser.tabs.update(tab.id, {
          url: base + "#lfc=open." + target,
          active: true
        });
        try {
          await new Promise((r) => setTimeout(r, 800));
          const t = await browser.tabs.get(tab.id);
          if (t.url && t.url.indexOf("#lfc=") !== -1) {
            await browser.tabs.update(tab.id, { url: t.url.split("#")[0] });
          }
        } catch (e) {}
        return { ok: true, reused: true };
      }
      await browser.tabs.create({
        url: base + "#lfc=open." + target + ".c",
        active: true
      });
      return { ok: true };
    }
    if (isCommandCenter(tab)) {
      await browser.tabs.update(tab.id, { url, active: true });
      return { ok: true, reused: true };
    }
    await browser.tabs.create({ url, active: true });
    return { ok: true };
  }

  // Ask the chrome helper (userChrome.uc.js) to open one of its native popups.
  async function openUI(which: string) {
    const tab = await getActiveTab();
    const hash = "open." + which + ".c";
    if (isCommandCenter(tab)) {
      await browser.tabs.update(tab.id, {
        url: CC_URL + "#lfc=" + hash,
        active: true
      });
      try {
        await new Promise((r) => setTimeout(r, 800));
        const t = await browser.tabs.get(tab.id);
        if (t.url && t.url.indexOf("#lfc=") !== -1) {
          await browser.tabs.update(tab.id, { url: stripHash(t.url) });
        }
      } catch (e) {}
      return { ok: true, reused: true };
    }
    await browser.tabs.create({ url: CC_URL + "#lfc=" + hash, active: true });
    return { ok: true };
  }

  async function handleMessage(msg: BgAction, sender: any) {
    // `data` stays loose: each case reads only the fields its action declares.
    const data: any = msg.data || {};
    switch (msg.action) {
      case "searchSuggest":
        return suggestSearch(data.q);
      case "urlSuggest":
        return suggestUrls(data.q);
      case "tabs":
        return tabsInWindow();
      case "activateTab":
        await browser.tabs.update(data.id, { active: true });
        await browser.windows.update((await getActiveTab()).windowId, {
          focused: true
        });
        return { ok: true };
      case "activateTabAt":
        if (data.last) {
          const tabs = await realTabsInWindow();
          const t = tabs[tabs.length - 1];
          if (!t) return { ok: false };
          await browser.tabs.update(t.id, { active: true });
          await browser.windows.update(t.windowId, { focused: true });
          return { ok: true };
        }
        return activateTabByIndex(data.index || 1);
      case "moveTab": {
        const tabs = await browser.tabs.query({ currentWindow: true });
        const idx = tabs.findIndex((t: any) => t.id === data.id);
        if (idx < 0) return { ok: false };
        const dir = data.dir > 0 ? 1 : -1;
        const ni = Math.max(0, Math.min(tabs.length - 1, idx + dir));
        if (ni !== idx) await browser.tabs.move(data.id, { index: ni });
        return { ok: true };
      }
      case "moveActiveTab": {
        const tabs = await browser.tabs.query({ currentWindow: true });
        const idx = tabs.findIndex((t: any) => t.active);
        if (idx < 0) return { ok: false };
        const dir = data.dir > 0 ? 1 : -1;
        const ni = Math.max(0, Math.min(tabs.length - 1, idx + dir));
        if (ni !== idx) await browser.tabs.move(tabs[idx]!.id, { index: ni });
        return { ok: true };
      }
      case "closeTab": {
        // Removing the window's LAST tab closes the whole window (and Firefox,
        // if it's the only window). Guard it: report `last` so callers can ask
        // for confirmation, and only actually close on a second press (force).
        const targetId = data.id != null ? data.id : (await getActiveTab())?.id;
        const tabs = await realTabsInWindow();
        const isLast =
          tabs.length <= 1 && targetId != null && tabs[0] && tabs[0].id === targetId;
        if (isLast && !data.force) {
          return { ok: true, last: true };
        }
        if (targetId != null) await browser.tabs.remove(targetId);
        return { ok: true, last: false };
      }
      case "newTab":
        // A new tab is the command center, never a stray about:blank.
        await browser.tabs.create({ url: CC_URL, active: true });
        return { ok: true };
      case "reopenTab":
        return reopenTab();
      case "duplicateTab": {
        const tab = await getActiveTab();
        if (tab) await browser.tabs.duplicate(tab.id);
        return { ok: true };
      }
      case "reload": {
        const tab = await getActiveTab();
        if (tab) await browser.tabs.reload(tab.id);
        return { ok: true };
      }
      case "back": {
        const tab = await getActiveTab();
        if (tab) await browser.tabs.goBack(tab.id);
        return { ok: true };
      }
      case "forward": {
        const tab = await getActiveTab();
        if (tab) await browser.tabs.goForward(tab.id);
        return { ok: true };
      }
      case "openUrl":
        return openUrl(data.url, data.newTab);
      case "openPage":
        return openPage(data.url);
      case "openUI":
        return openUI(data.which);
      case "search":
        return doSearch(data.query || "");
      case "searchInPlace": {
        const q = (data.query || "").trim();
        if (!q) return { ok: false };
        const tab = await getActiveTab();
        if (tab) await browser.tabs.update(tab.id, { url: await searchUrlFor(q), active: true });
        return { ok: true };
      }
      case "windowSize":
        return getWindowSize();
      case "resizeWindow":
        return resizeWindow(data.dx || 0, data.dy || 0);
      case "moveWindow":
        return moveWindow(data.dx || 0, data.dy || 0);
      case "maximize":
        return toggleMaximize();
      case "history":
        return historySearch(data.q);
      case "bookmarks":
        return bookmarksSearch(data.q);
      case "downloads":
        return downloadsList();
      case "openDownload":
        return openDownload(data.id);
      case "removeDownload":
        return removeDownload(data.id);
      case "openDownloadLocation":
        return openDownloadLocation(data.id);
      case "zen":
        return toggleZen();
      case "zoom":
        return zoom(data.delta || 0, data.factor);
      case "mute":
        return toggleMute();
      case "copyUrl": {
        const tab = await getActiveTab();
        if (!tab) return { url: "", title: "" };
        return { url: tab.url || "", title: tab.title || "" };
      }
      case "getConfig":
        return browser.storage.local.get("config");
      case "setConfig":
        await browser.storage.local.set({ config: data.config });
        return { ok: true };
      case "syncTyping":
        if (sender && sender.tab && sender.tab.id != null) {
          try {
            await browser.sessions.setTabValue(
              sender.tab.id,
              "lfTyping",
              data.typing ? "1" : "0"
            );
          } catch (e) {}
        }
        return { ok: true };
      case "sessionList":
        return sessionList();
      case "sessionSave":
        return saveSession(data.name);
      case "sessionNew":
        return newSession(data.name);
      case "sessionRestore":
        return restoreSession(data.name);
      case "sessionDelete":
        return deleteSession(data.name);
      case "sessionSwitchByMarker":
        return switchSessionByMarker(data.marker);
      case "sessionAssignMarker":
        return assignSessionMarker(data.name, data.marker);
      case "sessionSplit":
        // Native splits are the chrome helper's domain (gBrowser.addTabSplitView);
        // relay the request through a transient #lfc= tab.
        requestChrome("splitTab");
        return { ok: true };
      case "sessionUnsplit":
        requestChrome("unsplit");
        return { ok: true };
      case "sessionSwitchPane":
        requestChrome("switchPane", String(data.dir > 0 ? 1 : -1));
        return { ok: true };
      case "sessionSwapPane":
        requestChrome("swapSplitPanes", String(data.dir > 0 ? 1 : -1));
        return { ok: true };
      case "sessionSplitAddTabByIndex": {
        // Moving a tab into a split view is a native-split capability owned by
        // the chrome helper (gBrowser.addTabSplitView). Relay via a transient
        // request tab the chrome helper handles and removes.
        const n = Number(data && data.index);
        if (!(n >= 1 && n <= 9)) return { ok: false, note: "tab number must be 1-9" };
        requestChrome("moveToSplit", String(n));
        return { ok: true };
      }
      case "splitPanelTabs": {
        // Number REAL tabs only (skip splitpanel + #lfc=), so the list's
        // numbers match ;+N and never shift when a companion pane is
        // added/removed.
        const tabs = await realTabsInWindow();
        return {
          tabs: tabs.map((t: any, i: number) => ({
            index: i + 1,
            id: t.id,
            url: t.url || "",
            title: t.title || "",
            active: !!t.active,
            inSplit: typeof t.splitViewId === "number" && t.splitViewId >= 0,
          })),
        };
      }
      case "moveTabToSplit": {
        const n = Number(data && data.index);
        if (!(n >= 1 && n <= 9)) return { ok: false };
        requestChrome("moveToSplit", String(n));
        return { ok: true };
      }
      case "toggleWhichKey": {
        const c = await getConfig();
        c.whichKey = !c.whichKey;
        await browser.storage.local.set({ config: c });
        return { whichKey: !!c.whichKey };
      }
      case "stealthOpen":
        return stealthOpen();
      case "quit":
        return quitBrowser();
      case "sessionState":
        return sessionState();
      default:
        return { ok: false, error: "unknown action" };
    }
  }

  browser.runtime.onMessage.addListener((msg: BgAction, sender: any) => {
    return handleMessage(msg, sender).catch((err: any) => ({
      ok: false,
      error: String(err && err.message ? err.message : err)
    }));
  });

  browser.commands.onCommand.addListener((name: string) => {
    if (name === "open-command-center") {
      browser.tabs
        .create({ url: browser.runtime.getURL("commandcenter.html"), active: true })
        .catch(() => {});
    } else if (name === "split-horizontal") {
      requestChrome("splitTab");
    } else if (name === "split-next-pane") {
      requestChrome("switchPane", "1");
    } else if (name === "split-prev-pane") {
      requestChrome("switchPane", "-1");
    } else if (name === "unsplit") {
      requestChrome("unsplit");
    }
  });

  function maybeConvertHome(tab: any) {
    if (restoring) return Promise.resolve();
    if (!tab || !tab.url || !HOMEISH.test(tab.url)) return Promise.resolve();
    // A blank/home tab that is already navigating somewhere (e.g.
    // browser.search.search opening a results tab) must be left alone — only
    // idle blank/home tabs are converted.
    if (tab.pendingUrl && tab.pendingUrl !== tab.url) return Promise.resolve();
    if (tab.url === "about:blank") {
      // about:blank is frequently a transient placeholder (search results,
      // in-flight navigations); convert it only once it has been idle briefly.
      const id = tab.id;
      setTimeout(() => {
        browser.tabs
          .get(id)
          .then((t: any) => {
            if (t && t.url === "about:blank" && !(t.pendingUrl && t.pendingUrl !== t.url)) {
              return browser.tabs.update(id, { url: CC_URL });
            }
          })
          .catch(() => {});
      }, 500);
      return Promise.resolve();
    }
    return browser.tabs.update(tab.id, { url: CC_URL }).catch(() => {});
  }

  browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
    if (restoring) return;
    if (info.status === "complete" && tab && tab.active) maybeConvertHome(tab);
  });

  // Chrome helper request channel: a background tab whose URL is
  // commandcenter.html#lfc=req.<action>[.<arg>]. Handle the request, then
  // remove the tab. The `sessionState` request is the one exception: its reply
  // is written back into the tab's hash and the chrome helper removes the tab
  // itself after reading it (otherwise it would race the removal).
  function b64utf8(s: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  }

  // Ask the chrome helper to do something only it can (native split view):
  // open a transient background tab whose #lfc= fragment the chrome helper's
  // progress listener handles; the chrome helper removes the tab itself. A
  // safety timeout drops it if the chrome helper never answers.
  function requestChrome(action: string, arg?: string): void {
    let frag = "lfc=" + action;
    if (arg != null && arg !== "") frag += "." + encodeURIComponent(arg);
    browser.tabs
      .create({ url: CC_URL + "#" + frag, active: false })
      .then((tab: any) => {
        setTimeout(() => {
          browser.tabs
            .remove(tab.id)
            .catch(() => {});
        }, 5000);
      })
      .catch(() => {});
  }

  // Push the fresh session summary to the chrome helper's status bar after a
  // session mutation that did NOT originate from the chrome helper itself (the
  // helper refreshes on its own actions; content-script and options actions
  // would otherwise leave its bar pointing at a stale session name). The push
  // rides the same #lfc=sessionState channel the helper's own requestSessionState
  // uses, so the helper updates its bar and removes the transient tab.
  async function pushSessionStateToChrome(): Promise<void> {
    try {
      const state = await sessionState();
      const nonce = "push" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
      requestChrome("sessionState." + b64utf8(JSON.stringify(state)), nonce);
    } catch (e) {
      // ignore
    }
  }

  async function handleReq(tab: any, action: string, arg: string) {
    if (action === "alive") {
      await browser.storage.local.set({ chromeAlive: true });
      return;
    }
    if (action === "toggleWhichKey") {
      // The chrome helper flipped its own cached copy; flip storage to match
      // so content scripts, the command center and options agree.
      const c = await getConfig();
      c.whichKey = !c.whichKey;
      await browser.storage.local.set({ config: c });
      return;
    }
    if (action === "startHints" || action === "focusFirstInput") {
      const t = await getActiveTab();
      if (!t || t.id === tab.id) return;
      try {
        await browser.tabs.sendMessage(t.id, { action: action });
      } catch (e) {}
      return;
    }
    if (action === "openOptions") {
      try {
        await browser.runtime.openOptionsPage();
      } catch (e) {}
      return;
    }
    if (action === "stealthOpen") {
      // Reply through the tab's hash so the chrome helper can toast the
      // outcome instead of failing silently; the chrome helper removes the
      // reply tab itself (see the reqResult handler).
      const r = await stealthOpen();
      const nonce = "req" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
      await browser.tabs
        .update(tab.id, {
          url: CC_URL + "#lfc=reqResult." + b64utf8(JSON.stringify(r)) + "." + nonce
        })
        .catch(() => {});
      return;
    }
    if (action === "sessionState") {
      // Round-trip for the chrome helper's status bar: reply into the hash so
      // the helper can read the current session name + the session list.
      const state = await sessionState();
      await browser.tabs.update(tab.id, {
        url: CC_URL + "#lfc=sessionState." + b64utf8(JSON.stringify(state)) + "." + (arg || "")
      });
      return;
    }
    if (action === "saveSession") {
      await saveSession(decodeURIComponent(arg || ""));
      return;
    }
    if (action === "newSession") {
      await newSession(decodeURIComponent(arg || ""));
      return;
    }
    if (action === "restoreSession") {
      await restoreSession(decodeURIComponent(arg || ""));
      return;
    }
    if (action === "deleteSession") {
      await deleteSession(decodeURIComponent(arg || ""));
      return;
    }
    if (action === "switchSessionByMarker") {
      await switchSessionByMarker(parseInt(arg || "0", 10));
      return;
    }
    if (action === "assignSessionMarker") {
      const raw = decodeURIComponent(arg || "");
      const sep = raw.indexOf("\u0001");
      const nm = sep < 0 ? raw : raw.slice(0, sep);
      const mk = sep < 0 ? 0 : parseInt(raw.slice(sep + 1), 10);
      await assignSessionMarker(nm, mk);
      return;
    }
    if (action === "quit") {
      await quitBrowser();
      return;
    }
    if (action === "splitAddTabByIndex") {
      // Legacy relay no longer used: the chrome helper drives native splits
      // directly now.
      return;
    }
  }

  browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
    if (info.status !== "complete" || !tab || !tab.url) return;
    if (stripHash(tab.url) !== CC_URL) return;
    const m = /#lfc=req\.([a-zA-Z]+)(?:\.([^#]*))?$/.exec(tab.url);
    if (!m) return;
    // sessionState and stealthOpen write their reply into the tab's hash and
    // let the chrome helper remove the tab after reading it.
    const keepOpen = m[1] === "sessionState" || m[1] === "stealthOpen";
    handleReq(tab, m[1]!, m[2] || "")
      .catch(() => {})
      .then(() => {
        if (!keepOpen) return browser.tabs.remove(tabId).catch(() => {});
      });
  });

  browser.tabs.onActivated.addListener((info: any) => {
    if (restoring) return;
    browser.tabs
      .get(info.tabId)
      .then((tab: any) => maybeConvertHome(tab))
      .catch(() => {});
  });
  browser.tabs
    .query({})
    .then((tabs: any[]) => {
      for (const t of tabs || []) {
        if (t.active) maybeConvertHome(t);
      }
    })
    .catch(() => {});

  // Chrome helper absent unless it pings "alive" on window startup; clear the
  // gate so a stale flag never permanently disables content-side handling.
  browser.runtime.onStartup.addListener(() => {
    browser.storage.local.set({ chromeAlive: false }).catch(() => {});
    void reconcileStealth();
  });
  // Also reconcile on background load (covers install/reload and the very
  // first launch after enabling the feature) — idempotent.
  void reconcileStealth();

  /* ===================== session autosave + restore ===================== */

  const onTabChange = () => scheduleAutosave();
  browser.tabs.onCreated.addListener(onTabChange);
  browser.tabs.onRemoved.addListener(onTabChange);
  // When a stealth tab closes, wipe its container data + remove the container.
  // (Racy if the browser dies first — reconcileStealth catches orphans next
  // launch.)
  browser.tabs.onRemoved.addListener((tabId: number) => {
    void removeStealthContainerForTab(tabId);
  });
  browser.tabs.onMoved.addListener(onTabChange);
  browser.tabs.onAttached.addListener(onTabChange);
  browser.tabs.onDetached.addListener(onTabChange);
  browser.tabs.onActivated.addListener(onTabChange);
  browser.tabs.onUpdated.addListener((tabId: number, info: any) => {
    if (info.url || info.status === "complete") onTabChange();
  });

  // On startup, resume the saved session when autoRestore is on. We do this
  // UNCONDITIONALLY (not just when the window is blank): Firefox's own session
  // restore runs first and can't faithfully restore a tab that was navigated
  // from the command center, leaving it blank. Waiting for native restore to
  // settle, then rebuilding the window from OUR snapshot, fixes that — the
  // blank tab is replaced and everything else is restored exactly as saved.
  browser.runtime.onStartup.addListener(async () => {
    try {
      const c = await getConfig();
      if (c.autoRestore === false) return;
      // Let Firefox's native session restore (if enabled) finish populating the
      // window so our rebuild replaces rather than races it.
      await new Promise((r) => setTimeout(r, 1000));
      // Prefer the session that was current when we quit, so relaunching puts
      // you back in the SAME session; fall back to the crash-recovery "last"
      // snapshot for unnamed windows.
      const r = await browser.storage.local.get([CURRENT_SESSION_KEY, LAST_SESSION_KEY]);
      let last = r && r[LAST_SESSION_KEY];
      const curName = r && r[CURRENT_SESSION_KEY];
      if (curName && typeof curName === "string") {
        const all = await readSessions();
        const cur = all[curName];
        if (cur && cur.tabs && cur.tabs.length) last = cur;
      }
      if (!last || !last.tabs || !last.tabs.length) return;
      // Rebuild the window from the snapshot, replacing whatever Firefox
      // natively restored. restoring=true suppresses tab-change side effects
      // (home conversion, autosave) while the window is rebuilt.
      restoring = true;
      try {
        const ids = await openTabsInCurrentWindow(last.tabs);
        // Re-create native split pairings exactly like a session switch, so
        // the restored window looks the way it was left (not flattened).
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
        scheduleAutosave();
      }
    } catch (e) {
      // ignore
    }
  });

  // When the last window closes, Firefox is quitting. Flush the last-known
  // snapshot (captured on the previous tab change) so a tab opened moments
  // before Alt+F4 isn't lost to the 1.5s autosave debounce. Uses lastSnapshot
  // rather than re-querying: the window is already gone and an empty query
  // would overwrite a good session with an empty one.
  browser.windows.onRemoved.addListener(async (windowId: number) => {
    try {
      const remaining = await browser.windows.getAll();
      if (remaining.length === 0 && lastSnapshot) {
        await autosaveCurrentSession(await readSessions(), lastSnapshot);
      }
    } catch (e) {
      // ignore
    }
  });

  // Warm the wasm core for the first URL suggestion.
  void ensureCore().catch(() => {});
})();
