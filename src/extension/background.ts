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
    const tabs = await realTabsInWindow();
    return {
      tabs: tabs.map((t: any) => ({
        id: t.id,
        title: t.title || t.url || "about:blank",
        url: t.url || "",
        active: t.active,
        pinned: t.pinned,
        muted: t.mutedInfo && t.mutedInfo.muted,
        favIconUrl: t.favIconUrl || ""
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

  function isBlankTab(t: any): boolean {
    return !t || !t.url || t.url === "about:blank" || /^about:(home|newtab)$/i.test(t.url);
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

  async function snapshotWindow(): Promise<{
    tabs: SessionTab[];
    active: number;
    windowState: string;
  }> {
    const win = await browser.windows.getCurrent();
    const tabs = await browser.tabs.query({ currentWindow: true });
    const list = tabs || [];
    // Transient #lfc= request tabs (the chrome-helper request channel) are
    // internal plumbing, never user content: exclude them so a checkpoint
    // never captures one and a restore never re-opens it (they would linger
    // and compound across switches).
    const content = list.filter(
      (t: any) => !(t.url && t.url.indexOf("#lfc=") !== -1)
    );
    let active = content.findIndex((t: any) => t.active);
    if (active < 0) active = 0;
    return {
      tabs: content.map((t: any) => {
        const svId = typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : undefined;
        return {
          url: t.url || "",
          title: t.title || "",
          pinned: !!t.pinned,
          splitViewId: svId,
        };
      }),
      active: active,
      windowState: win && win.state ? win.state : "normal",
    };
  }

  async function openTabsInCurrentWindow(tabs: SessionTab[]): Promise<number[]> {
    const win = await browser.windows.getCurrent();
    const cur = await browser.tabs.query({ currentWindow: true });
    const urls = (tabs || []).filter((t) => t && t.url).map((t) => t.url);
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
    for (const t of removable) {
      if (host && t.id === host.id) continue;
      try {
        await browser.tabs.remove(t.id);
      } catch (e) {
        // ignore
      }
    }
    const created: number[] = [];
    if (host) {
      const first = urls.shift();
      if (first) {
        try {
          await browser.tabs.update(host.id, { url: first, active: true });
        } catch (e) {
          // fall through — the tab may already be gone
        }
      }
      created.push(host.id);
    }
    for (let i = 0; i < urls.length; i++) {
      const t = await browser.tabs.create({ url: urls[i], active: i === 0 && !host });
      if (t && t.id != null) created.push(t.id);
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

  // Checkpoint: persist the current window before switching away so nothing is
  // ever lost — even when the current session was never given a name. The
  // snapshot is always written to the crash-recovery "last" slot, and if the
  // window belongs to a named session, that session is updated in place too.
  async function autosaveCurrentSession(all: Record<string, Session>): Promise<void> {
    try {
      const snap = await snapshotWindow();
      const recovery: Session = {
        name: "last",
        marker: 0,
        tabs: snap.tabs,
        active: snap.active,
        windowState: snap.windowState,
        updatedAt: Date.now(),
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
      .filter((s): s is Session => !!s && !!s.tabs)
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
    };
    all[nm] = session;
    await writeSessions(all);
    await browser.storage.local.set({
      [CURRENT_SESSION_KEY]: nm,
      [LAST_SESSION_KEY]: session,
    });
    return { ok: true, session };
  }

  async function restoreSession(name: string): Promise<{ ok: boolean; note?: string }> {
    // Re-entrancy guard: two overlapping restores (e.g. a double key press
    // while the window is being rebuilt) would interleave tab teardown and
    // double-open tabs. Ignore the second request.
    if (restoring) return { ok: false, note: "restore already in progress" };
    const all = await readSessions();
    const s = all[(name || "").trim()];
    if (!s || !s.tabs || !s.tabs.length) return { ok: false };
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
      const groups = splitGroupsOf(s.tabs);
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
    const s = Object.values(all).find((x) => (x.marker || 0) === marker && x.tabs && x.tabs.length);
    if (!s) return { ok: false };
    await restoreSession(s.name);
    return { ok: true, name: s.name };
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
  }> {
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
    const summary = await core.sessionSummary(
      Object.values(all).map((s) => ({
        name: s.name,
        marker: s.marker || 0,
        tabCount: (s.tabs || []).length,
        splitCount: (s.tabs || []).filter((t: any) => !!t.split).length,
      })),
      name
    );
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
        const snap = await snapshotWindow();
        await browser.storage.local.set({
          [LAST_SESSION_KEY]: {
            name: "last",
            marker: 0,
            tabs: snap.tabs,
            active: snap.active,
            windowState: snap.windowState,
            updatedAt: Date.now(),
          },
        });
      } catch (e) {
        // ignore
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
      limit: 60,
      orderBy: ["-startTime"]
    });
    return {
      items: items.map((d: any) => ({
        id: d.id,
        filename: (d.filename || "").split(/[\\/]/).pop() || d.url || "",
        url: d.url || "",
        state: d.state || "",
        mime: d.mime || ""
      }))
    };
  }

  async function openDownload(id: number) {
    try {
      await browser.downloads.open(id);
      return { ok: true };
    } catch (e) {
      try {
        await browser.downloads.show(id);
        return { ok: true, revealed: true };
      } catch (e2) {
        return { ok: false, error: String(e2) };
      }
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
      case "closeTab":
        if (data.id != null) {
          await browser.tabs.remove(data.id);
        } else {
          const tab = await getActiveTab();
          if (tab) await browser.tabs.remove(tab.id);
        }
        return { ok: true };
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
    const keepOpen = m[1] === "sessionState";
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
  });

  /* ===================== session autosave + restore ===================== */

  const onTabChange = () => scheduleAutosave();
  browser.tabs.onCreated.addListener(onTabChange);
  browser.tabs.onRemoved.addListener(onTabChange);
  browser.tabs.onMoved.addListener(onTabChange);
  browser.tabs.onAttached.addListener(onTabChange);
  browser.tabs.onDetached.addListener(onTabChange);
  browser.tabs.onActivated.addListener(onTabChange);
  browser.tabs.onUpdated.addListener((tabId: number, info: any) => {
    if (info.url || info.status === "complete") onTabChange();
  });

  // On startup, resume the last saved session when autoRestore is on and the
  // window is still blank (Firefox's own session restore hasn't already run).
  browser.runtime.onStartup.addListener(async () => {
    try {
      const c = await getConfig();
      if (c.autoRestore === false) return;
      const tabs = await browser.tabs.query({ currentWindow: true });
      if (!tabs.length || !tabs.every((t: any) => isBlankTab(t))) return;
      const r = await browser.storage.local.get(LAST_SESSION_KEY);
      const last = r && r[LAST_SESSION_KEY];
      if (last && last.tabs && last.tabs.length) {
        await openTabsInCurrentWindow(last.tabs);
      }
    } catch (e) {
      // ignore
    }
  });

  // Warm the wasm core for the first URL suggestion.
  void ensureCore().catch(() => {});
})();
