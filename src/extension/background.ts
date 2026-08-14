// Extension background script: browser-API actions (tabs, windows, history,
// bookmarks, downloads, search), the #lfc=req request channel for the chrome
// helper, and the command-center home-tab conversion. URL normalization and
// visited ranking come from the Go core.

import { core, ensureCore } from "../shared/core";
import { mergeConfig } from "../shared/config";
import type { BgAction } from "../shared/protocol";
import {
  buildSplitUrl,
  isSplitUrl,
  parseSplitUrl,
  splitPayload,
} from "../shared/split";
import type { Session, SessionTab, SplitView } from "../shared/types";

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
    const tabs = await browser.tabs.query({ currentWindow: true });
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
    const tabs = await browser.tabs.query({ currentWindow: true });
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
  const MAX_SESSION_TABS = 9;

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

  // A tab is a custom split container iff its URL points at the splitview page
  // (which encodes the pane layout). Returns the decoded layout, or null.
  function splitViewOf(t: any): SplitView | null {
    if (!t || !t.url) return null;
    return parseSplitUrl(t.url);
  }

  const SPLITVIEW_BASE = browser.runtime.getURL("");

  async function snapshotWindow(): Promise<{
    tabs: SessionTab[];
    active: number;
    windowState: string;
  }> {
    const win = await browser.windows.getCurrent();
    const tabs = await browser.tabs.query({ currentWindow: true });
    const list = tabs || [];
    let active = list.findIndex((t: any) => t.active);
    if (active < 0) active = 0;
    return {
      tabs: list.slice(0, MAX_SESSION_TABS).map((t: any) => {
        const split = splitViewOf(t);
        const svId = typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : undefined;
        return {
          url: t.url || "",
          title: t.title || "",
          pinned: !!t.pinned,
          split: split || undefined,
          splitViewId: svId,
        };
      }),
      active: active < MAX_SESSION_TABS ? active : 0,
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
    // Never remove the window's last tab: closing it closes the whole window
    // (default browser.tabs.closeWindowWithLastTab), which flashes/relaunches
    // the window for the user and orphans the WebDriver BiDi session. Keep
    // one removable tab and host the first restored URL on it instead.
    const keepOne = removable.length > 0 && removable.length === (cur || []).length;
    for (const t of keepOne ? removable.slice(0, -1) : removable) {
      try {
        await browser.tabs.remove(t.id);
      } catch (e) {
        // ignore
      }
    }
    const created: number[] = [];
    if (keepOne) {
      const keeper = removable[removable.length - 1];
      const first = urls.shift();
      if (first) {
        try {
          await browser.tabs.update(keeper.id, { url: first, active: true });
        } catch (e) {
          // fall through — the tab may already be gone
        }
      }
    }
    for (let i = 0; i < urls.length; i++) {
      const t = await browser.tabs.create({ url: urls[i], active: i === 0 && !keepOne });
      if (t && t.id != null) created.push(t.id);
    }
    try {
      await browser.windows.update(win.id, { focused: true });
    } catch (e) {
      // ignore
    }
    return created;
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

  async function restoreSession(name: string): Promise<{ ok: boolean }> {
    const all = await readSessions();
    const s = all[(name || "").trim()];
    if (!s || !s.tabs || !s.tabs.length) return { ok: false };
    await openTabsInCurrentWindow(s.tabs);
    await browser.storage.local.set({ [CURRENT_SESSION_KEY]: s.name });
    return { ok: true };
  }

  async function switchSessionByMarker(marker: number): Promise<{ ok: boolean; name?: string }> {
    const all = await readSessions();
    const s = Object.values(all).find((x) => (x.marker || 0) === marker && x.tabs && x.tabs.length);
    if (!s) return { ok: false };
    await restoreSession(s.name);
    return { ok: true, name: s.name };
  }

  async function deleteSession(name: string): Promise<{ ok: boolean }> {
    const all = await readSessions();
    const nm = (name || "").trim();
    if (all[nm]) {
      delete all[nm];
      await writeSessions(all);
    }
    return { ok: true };
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
    if (!(m >= 1 && m <= MAX_SESSION_TABS)) {
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

  // Split the active tab into a two-pane split view. The active tab's page
  // becomes the first pane and a fresh blank pane is added alongside it (the
  // user navigates a pane through the split bar's URL input). This is the
  // "split into a new tab" behaviour and never removes an existing tab.
  async function splitCurrentTab(
    orientation: "horizontal" | "vertical"
  ): Promise<{ ok: boolean; note?: string }> {
    const all = await browser.tabs.query({ currentWindow: true });
    const idx = all.findIndex((t: any) => t.active);
    if (idx < 0) return { ok: false, note: "no active tab" };
    const active = all[idx]!;
    if (isSplitUrl(active.url || "", SPLITVIEW_BASE)) {
      return { ok: false, note: "already a split view" };
    }
    const firstUrl = active.url && active.url !== "about:blank" ? active.url : "about:blank";
    const cfg: SplitView = {
      orientation: orientation,
      panes: [
        { url: firstUrl, title: active.title || "" },
        { url: "about:blank", title: "new tab" },
      ],
      activePane: 0,
    };
    await browser.tabs.update(active.id, { url: buildSplitUrl(SPLITVIEW_BASE, cfg) });
    return { ok: true };
  }

  // Tear the active split view apart: the first pane replaces the splitview
  // tab and every remaining pane is restored as its own tab.
  async function unsplitCurrentTab(): Promise<{ ok: boolean; note?: string }> {
    const tab = await getActiveTab();
    const cfg = splitViewOf(tab);
    if (!cfg) return { ok: false, note: "not in a split view" };
    const panes = cfg.panes.filter((p) => p.url && p.url !== "about:blank");
    if (!panes.length) return { ok: false, note: "nothing to restore" };
    await browser.tabs.update(tab.id, { url: panes[0]!.url, active: true });
    for (let i = 1; i < panes.length; i++) {
      await browser.tabs.create({ url: panes[i]!.url, active: false });
    }
    return { ok: true };
  }

  // Move focus to the previous/next pane of the active split view. The
  // splitview page owns the iframes; broadcast a focus request keyed by the
  // split payload so exactly the right page responds.
  async function switchSplitPane(dir: number): Promise<{ ok: boolean; note?: string }> {
    const tab = await getActiveTab();
    const id = tab && tab.url ? splitPayload(tab.url) : null;
    if (!id) return { ok: false, note: "not in a split view" };
    try {
      await browser.runtime.sendMessage({
        action: "lfSplitFocus",
        splitId: id,
        dir: dir > 0 ? 1 : -1,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, note: "could not switch split pane" };
    }
  }

  // Navigate the active pane of the active split view (the `;o` leader action
  // is rerouted here when the focused tab is a split container, so the split
  // itself is never navigated away from).
  async function navigateSplitPane(url: string): Promise<{ ok: boolean; note?: string }> {
    const tab = await getActiveTab();
    const id = tab && tab.url ? splitPayload(tab.url) : null;
    if (!id) return { ok: false, note: "not in a split view" };
    try {
      await browser.runtime.sendMessage({
        action: "lfSplitNavigate",
        splitId: id,
        url: url,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, note: "could not navigate split pane" };
    }
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
    const tabs = await browser.tabs.query({ currentWindow: true });
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
    const list = tabs || [];
    const active = list.findIndex((t: any) => t.active);
    let inSplit = false;
    let splitOrientation: "horizontal" | "vertical" | undefined;
    let splitActive = 0;
    let splitPanes = 0;
    if (active >= 0) {
      const sv = splitViewOf(list[active]);
      if (sv) {
        inSplit = true;
        splitOrientation = sv.orientation;
        splitActive = sv.activePane || 0;
        splitPanes = sv.panes.length;
      } else {
        // Firefox 149+ native split view: tabs in the same split share a
        // splitViewId (read-only on the tabs API). Detect it so the status bar
        // reflects native splits created by the chrome helper.
        const id = list[active] && (list[active] as any).splitViewId;
        if (typeof id === "number" && id >= 0) {
          const pair = list.filter((t: any) => t.splitViewId === id);
          inSplit = true;
          splitOrientation = "horizontal";
          splitPanes = pair.length || 2;
          splitActive = Math.max(0, pair.indexOf(list[active]));
        }
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
  function scheduleAutosave(): void {
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

  async function togglePin() {
    const tab = await getActiveTab();
    if (!tab) return { pinned: false };
    const pinned = !tab.pinned;
    await browser.tabs.update(tab.id, { pinned });
    return { pinned };
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
          const tabs = await browser.tabs.query({ currentWindow: true });
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
      case "pin":
        return togglePin();
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
        return splitCurrentTab(data.orientation === "vertical" ? "vertical" : "horizontal");
      case "sessionUnsplit":
        return unsplitCurrentTab();
      case "sessionSwitchPane":
        return switchSplitPane(data.dir || 1);
      case "sessionNavigatePane":
        return navigateSplitPane(data.url);
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
        const tabs = await browser.tabs.query({ currentWindow: true });
        return {
          tabs: (tabs || []).map((t: any, i: number) => ({
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
      void splitCurrentTab("horizontal");
    } else if (name === "split-next-pane") {
      void switchSplitPane(1);
    } else if (name === "split-prev-pane") {
      void switchSplitPane(-1);
    } else if (name === "unsplit") {
      void unsplitCurrentTab();
    }
  });

  function maybeConvertHome(tab: any) {
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
    if (action === "splitTab") {
      await splitCurrentTab(arg === "vertical" ? "vertical" : "horizontal");
      return;
    }
    if (action === "unsplitTab") {
      await unsplitCurrentTab();
      return;
    }
    if (action === "switchSplitPane") {
      await switchSplitPane(parseInt(arg || "1", 10) || 1);
      return;
    }
    if (action === "navigateSplitPane") {
      await navigateSplitPane(decodeURIComponent(arg || ""));
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

  /* ===================== split-view header stripping ===================== */

  // The custom split view renders arbitrary pages as <iframe>; most sites send
  // X-Frame-Options or a CSP frame-ancestors directive that would blank them.
  // Strip those headers for subframe requests initiated by our own extension
  // pages (only the splitview page embeds iframes), so any site embeds while
  // normal browsing is untouched.
  //
  // Firefox's blocking webRequest no longer applies response-header edits to
  // subframes reliably, so this uses a scoped declarativeNetRequest dynamic
  // rule instead. `initiatorDomains` is the extension's own moz-extension
  // origin, so the strip only ever affects the split view's panes (never the
  // user's normal tabs). DNR can only drop whole headers, so the page's CSP is
  // removed outright rather than just its frame-ancestors directive — an
  // acceptable trade-off for a locally-scoped, opt-in split view.
  async function installSplitHeaderRule(): Promise<void> {
    try {
      const uuid = browser.runtime
        .getURL("")
        .split("/")
        .filter((s: string) => s !== "")
        .pop();
      if (!uuid) return;
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1],
        addRules: [
          {
            id: 1,
            priority: 1,
            action: {
              type: "modifyHeaders",
              responseHeaders: [
                { header: "x-frame-options", operation: "remove" },
                { header: "content-security-policy", operation: "remove" },
                { header: "content-security-policy-report-only", operation: "remove" },
              ],
            },
            condition: {
              resourceTypes: ["sub_frame"],
              initiatorDomains: [uuid],
            },
          },
        ],
      });
    } catch (e) {
      // ignore — declarativeNetRequest unavailable on this Firefox
    }
  }
  void installSplitHeaderRule();


  // Warm the wasm core for the first URL suggestion.
  void ensureCore().catch(() => {});
})();
