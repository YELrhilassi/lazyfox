// Search and suggestion sources for the command center and content popups.
//
// Owns the search-engine/URL/visited suggestion pipelines plus history and
// bookmark lookups. URL normalization and visited ranking come from the Go
// core; the module only glues browser APIs to that logic.

import { core } from "../shared/core";
import { getActiveTab, isCommandCenter } from "./tabs";

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

export async function suggestSearch(q: string) {
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

export async function suggestUrls(q: string) {
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

export async function searchUrlFor(q: string): Promise<string> {
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

export async function doSearch(query: string) {
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

export async function historySearch(q: string) {
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

export async function bookmarksSearch(q: string) {
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
