(function () {
  "use strict";

  async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  function normalizeUrl(text) {
    const t = (text || "").trim();
    if (!t) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
    if (/^(about|moz-extension|file):/i.test(t)) return t;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
    return "https://" + t;
  }

  function isLikelyUrl(text) {
    const t = (text || "").trim();
    if (!t) return false;
    if (/\s/.test(t)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return true;
    if (/\.\w{2,}/.test(t)) return true;
    if (/^(localhost|127\.0\.0\.1|\[?::1\]?)/i.test(t)) return true;
    return false;
  }

  function rankVisited(visited, q) {
    const ql = q.toLowerCase();
    const scored = [];
    for (const u of visited) {
      const url = (u.url || "").toLowerCase();
      const title = (u.title || "").toLowerCase();
      const host = (url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)/) || [])[1] || "";
      let score = 0;
      if (host.indexOf(ql) === 0) score += 120;
      else if (host.indexOf(ql) !== -1) score += 70;
      if (url.indexOf(ql) !== -1) score += 45;
      if (title.indexOf(ql) !== -1) score += 35;
      if (score > 0) {
        let p = 0;
        let sub = true;
        for (const ch of ql) {
          const i = url.indexOf(ch, p);
          if (i < 0) { sub = false; break; }
          p = i + 1;
        }
        if (sub && ql.length >= 3) score += 20;
      }
      if (score > 0) scored.push({ score: score, u: u });
    }
    scored.sort(
      (a, b) => b.score - a.score || (b.u.time || 0) - (a.u.time || 0)
    );
    return scored.slice(0, 9).map((o) => o.u);
  }

  let visitedCache = [];
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

  async function suggestSearch(q) {
    const text = (q || "").trim();
    const entries = [];
    if (!text) return { entries };
    let engine = "default search engine";
    try {
      const engines = await browser.search.get();
      const g = engines.find((e) => /google/i.test(e.name));
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

  async function suggestUrls(q) {
    const text = (q || "").trim();
    const entries = [];
    if (!text) return { entries };
    entries.push({
      kind: "url",
      title: "Open URL",
      subtitle: normalizeUrl(text),
      url: normalizeUrl(text)
    });
    const visited = await getVisited();
    for (const u of rankVisited(visited, text)) {
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

  async function doSearch(query) {
    const q = (query || "").trim();
    if (!q) return { ok: false };
    let engine = "";
    try {
      const engines = await browser.search.get();
      const g = engines.find((e) => /google/i.test(e.name));
      if (g) engine = g.name;
      await browser.search.search({ query: q, engine: g ? g.name : undefined });
      return { ok: true, engine: g ? g.name : "default" };
    } catch (e) {}
    try {
      await browser.search.search({ query: q });
      return { ok: true, engine: "default" };
    } catch (e2) {}
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

  async function resizeWindow(dx, dy) {
    const win = await browser.windows.getCurrent();
    const w = Math.max(420, (win.width || 1200) + (dx || 0));
    const h = Math.max(300, (win.height || 800) + (dy || 0));
    const up = await browser.windows.update(win.id, { width: w, height: h });
    return { width: up.width, height: up.height, state: up.state };
  }

  async function moveWindow(dx, dy) {
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

  async function activateTabByIndex(n) {
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

  async function toggleSidebar() {
    try {
      if (browser.sidebarAction && typeof browser.sidebarAction.toggle === "function") {
        await browser.sidebarAction.toggle();
        return { ok: true };
      }
      const st = (await browser.storage.local.get("sidebarOpen")) || {};
      const wantOpen = !st.sidebarOpen;
      if (wantOpen) await browser.sidebarAction.open();
      else await browser.sidebarAction.close();
      await browser.storage.local.set({ sidebarOpen: wantOpen });
      return { ok: true, open: wantOpen };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function tabsInWindow() {
    const tabs = await browser.tabs.query({ currentWindow: true });
    return {
      tabs: tabs.map((t) => ({
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

  async function historySearch(q) {
    const text = (q || "").trim();
    if (!text) return { items: [] };
    const items = await browser.history.search({
      text: text,
      startTime: 0,
      maxResults: 60
    });
    return {
      items: items.map((h) => ({
        title: h.title || h.url,
        url: h.url,
        time: h.lastVisitTime || 0
      }))
    };
  }

  async function bookmarksSearch(q) {
    const text = (q || "").trim();
    let items = [];
    if (text.length >= 1) {
      items = await browser.bookmarks.search({ query: text });
    } else {
      const tree = await browser.bookmarks.getTree();
      const out = [];
      const walk = (nodes) => {
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
      items: items.map((d) => ({
        id: d.id,
        filename: (d.filename || "").split(/[\\/]/).pop() || d.url || "",
        url: d.url || "",
        state: d.state || "",
        mime: d.mime || ""
      }))
    };
  }

  async function openDownload(id) {
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

  async function zoom(delta, factor) {
    const tab = await getActiveTab();
    if (!tab || tab.id === browser.tabs.TAB_ID_NONE) return { factor: 1 };
    let f = factor != null ? factor : null;
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
      return Object.assign({ openInNewTab: true }, r.config || {});
    } catch (e) {
      return { openInNewTab: true };
    }
  }

  async function openUrl(url, newTab) {
    if (!url) return { ok: false };
    if (newTab == null) {
      const c = await getConfig();
      newTab = c.openInNewTab !== false;
    }
    const tab = await getActiveTab();
    if (newTab || !tab) {
      await browser.tabs.create({ url, active: true });
    } else {
      await browser.tabs.update(tab.id, { url });
    }
    return { ok: true };
  }

  async function openPage(url) {
    await browser.tabs.create({ url, active: true });
    return { ok: true };
  }

  async function handleMessage(msg) {
    const data = msg.data || {};
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
      case "activateTabByIndex":
        return activateTabByIndex(data.index || 1);
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
      case "toggleSidebar":
        return toggleSidebar();
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
      case "query":
        return { url: location.href };
      default:
        return { ok: false, error: "unknown action" };
    }
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    return handleMessage(msg).catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err)
    }));
  });

  const CC_URL = browser.runtime.getURL("commandcenter.html");
  const HOMEISH = /^about:(home|newtab)$/i;

  function maybeConvertHome(tab) {
    if (tab && tab.url && HOMEISH.test(tab.url)) {
      return browser.tabs.update(tab.id, { url: CC_URL }).catch(() => {});
    }
    return Promise.resolve();
  }

  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === "complete" && tab && tab.active) maybeConvertHome(tab);
  });
  browser.tabs.onActivated.addListener((info) => {
    browser.tabs
      .get(info.tabId)
      .then((tab) => maybeConvertHome(tab))
      .catch(() => {});
  });
  browser.tabs.query({}).then((tabs) => {
    for (const t of tabs || []) {
      if (t.active) maybeConvertHome(t);
    }
  }).catch(() => {});
})();
