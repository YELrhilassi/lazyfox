// Extension background script: browser-API actions (tabs, windows, history,
// bookmarks, downloads, search), the #lfc=req request channel for the chrome
// helper, and the command-center home-tab conversion. URL normalization and
// visited ranking come from the Go core.

import { core, ensureCore } from "../shared/core";
import { mergeConfig } from "../shared/config";
import type { BgAction } from "../shared/protocol";

(function () {
  "use strict";

  const CC_URL = browser.runtime.getURL("commandcenter.html");
  const HOMEISH = /^about:(home|newtab)$/i;

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

  async function doSearch(query: string) {
    const q = (query || "").trim();
    if (!q) return { ok: false };
    const tab = await getActiveTab();
    if (isCommandCenter(tab)) {
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
      await browser.tabs.update(tab.id, { url, active: true });
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
      f = await browser.tabs.getZoom(tab.id);
      f = Math.max(0.3, Math.min(5, Math.round((f + delta) * 100) / 100));
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
      case "closeTab":
        if (data.id != null) {
          await browser.tabs.remove(data.id);
        } else {
          const tab = await getActiveTab();
          if (tab) await browser.tabs.remove(tab.id);
        }
        return { ok: true };
      case "newTab":
        await browser.tabs.create({});
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
    }
  });

  function maybeConvertHome(tab: any) {
    if (tab && tab.url && HOMEISH.test(tab.url)) {
      return browser.tabs.update(tab.id, { url: CC_URL }).catch(() => {});
    }
    return Promise.resolve();
  }

  browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
    if (info.status === "complete" && tab && tab.active) maybeConvertHome(tab);
  });

  // Chrome helper request channel: a background tab whose URL is
  // commandcenter.html#lfc=req.<action>. Handle the request, then remove the tab.
  async function handleReq(tab: any, action: string) {
    if (action === "alive") {
      await browser.storage.local.set({ chromeAlive: true });
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
  }

  browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
    if (info.status !== "complete" || !tab || !tab.url) return;
    if (stripHash(tab.url) !== CC_URL) return;
    const m = /#lfc=req\.([a-zA-Z]+)$/.exec(tab.url);
    if (!m) return;
    handleReq(tab, m[1])
      .catch(() => {})
      .then(() => browser.tabs.remove(tabId).catch(() => {}));
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

  // Warm the wasm core for the first URL suggestion.
  void ensureCore().catch(() => {});
})();
