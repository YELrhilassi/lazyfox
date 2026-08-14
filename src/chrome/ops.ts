// The chrome helper's ActionOps implementation: everything the shared leader
// actions and popups need, using chrome APIs (gBrowser, Places, Downloads,
// SearchSuggestionController) directly. Search/data functions are async so the
// shared popup engine can consume them uniformly.

import { core } from "../shared/core";
import { toast } from "../shared/overlay";
import type { ActionOps } from "../shared/ops";
import type { Config, PopupItem } from "../shared/types";

declare const Services: any;
declare const Cc: any;
declare const Ci: any;
declare const ChromeUtils: any;
declare const ZoomManager: any;

const XHTML = "http://www.w3.org/1999/xhtml";

function sysPrincipal() {
  return Services.scriptSecurityManager.getSystemPrincipal();
}

function el(tag: string, attrs?: Record<string, string> | null, text?: string | null): HTMLElement {
  const e = document.createElementNS(XHTML, tag) as HTMLElement;
  if (attrs) {
    for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
  }
  if (text != null) e.textContent = text;
  return e;
}

function loadUrl(url: string, newTab: boolean | undefined): void {
  if (!url) return;
  const openInNewTab = () => {
    try {
      const p = JSON.parse(Services.prefs.getStringPref("lazyfox.chrome.config", "{}"));
      return (p as Config).openInNewTab !== false;
    } catch (e) {
      return true;
    }
  };
  if (openInNewTab() || newTab === true) {
    window.gBrowser.selectedTab = window.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
  } else {
    try {
      window.gBrowser.loadURI(url, { triggeringPrincipal: sysPrincipal() });
    } catch (e) {
      window.gBrowser.selectedTab = window.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
    }
  }
  window.focus();
}

/* ---------- native data sources ---------- */

// Search suggestions from the default engine.
function suggestSearch(q: string): Promise<PopupItem[]> {
  return new Promise<PopupItem[]>((resolve) => {
    const text = (q || "").trim();
    const entries: PopupItem[] = [];
    if (!text) {
      resolve(entries);
      return;
    }
    entries.push({
      kind: "search",
      title: "Search the web for \u201C" + text + "\u201D",
      query: text,
    });
    try {
      const SC = ChromeUtils.importESModule(
        "resource://gre/modules/SearchSuggestionController.sys.mjs"
      ).SearchSuggestionController;
      Services.search.getDefault().then((engine: any) => {
        const c = new SC();
        c.maxLocalResults = 5;
        c.maxRemoteResults = 4;
        c.fetch(text, false, engine)
          .then((res: any) => {
            const out: string[] = [];
            for (const s of (res && res.remote) || []) out.push(s);
            for (const s of (res && res.local) || []) {
              if (out.indexOf(s) === -1) out.push(s);
            }
            for (const s of out.slice(0, 9)) {
              entries.push({ kind: "search", title: "Search \u201C" + s + "\u201D", query: s });
            }
            resolve(entries);
          })
          .catch(() => resolve(entries));
      }).catch(() => resolve(entries));
    } catch (e) {
      resolve(entries);
    }
  });
}

function histItems(text: string, maxResults: number): Array<{ title: string; url: string; time: number }> {
  const PlacesUtils = ChromeUtils.importESModule(
    "resource://gre/modules/PlacesUtils.sys.mjs"
  ).PlacesUtils;
  const query = PlacesUtils.history.getNewQuery();
  if (text) query.searchTerms = text;
  const opts = PlacesUtils.history.getNewQueryOptions();
  opts.maxResults = maxResults;
  opts.queryType = opts.QUERY_TYPE_HISTORY;
  opts.sortingMode = Ci.nsINavHistoryQueryOptions.SORT_BY_DATE_DESCENDING;
  const root = PlacesUtils.history.executeQuery(query, opts).root;
  root.containerOpen = true;
  const out: Array<{ title: string; url: string; time: number }> = [];
  for (let i = 0; i < root.childCount; i++) {
    const n = root.getChild(i);
    if (n.type !== n.RESULT_TYPE_URI || !n.uri) continue;
    out.push({ title: n.title || n.uri, url: n.uri, time: n.time || 0 });
  }
  root.containerOpen = false;
  return out;
}

function doSearch(query: string): void {
  const q = (query || "").trim();
  if (!q) return;
  try {
    Services.search.getDefault().then((engine: any) => {
      const sub = engine.getSubmission(q);
      loadUrl(sub.uri.spec, false);
    }).catch(() => {
      loadUrl("https://www.google.com/search?q=" + encodeURIComponent(q), false);
    });
  } catch (e) {
    loadUrl("https://www.google.com/search?q=" + encodeURIComponent(q), false);
  }
}

/* ---------- resize (wired by main.ts) ---------- */

function notWired(name: string): () => void {
  return () => {
    throw new Error("chromeOps." + name + " not wired by main");
  };
}

/* ---------- the ops object ---------- */

export const chromeOps: ActionOps = {
  searchSuggest: (q: string) => suggestSearch(q),
  urlSuggest: async (q: string) => {
    const text = (q || "").trim();
    const entries: PopupItem[] = [];
    if (!text) return entries;
    entries.push({ kind: "url", title: "Open URL", subtitle: text, url: text });
    try {
      const visited = histItems(text, 120);
      const ranked = await core.rankVisited(visited, text);
      for (const u of ranked) {
        entries.push({ kind: "page", title: u.title || u.url, subtitle: u.url, url: u.url });
      }
    } catch (e) {
      // Keep the "Open URL" entry even if ranking fails.
    }
    return entries;
  },
  listTabs: (q: string) => {
    const ql = q.trim().toLowerCase();
    const out: PopupItem[] = [];
    const tabs = window.gBrowser.tabs;
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      const uri = t.linkedBrowser.currentURI && t.linkedBrowser.currentURI.spec;
      const item: PopupItem = {
        id: i,
        title: t.label || uri || "",
        url: uri || "",
        active: t.selected,
        pinned: t.pinned,
        muted: !!t.muted,
        favIconUrl: (t.getAttribute && t.getAttribute("image")) || "",
      };
      if (!ql || (item.title + " " + item.url).toLowerCase().indexOf(ql) !== -1) out.push(item);
    }
    return Promise.resolve(out);
  },
  history: (q: string) => {
    const text = (q || "").trim();
    return Promise.resolve(histItems(text, text ? 80 : 30));
  },
  bookmarks: async (q: string) => {
    try {
      const PlacesUtils = ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      ).PlacesUtils;
      const text = (q || "").trim();
      if (text) {
        const items = await PlacesUtils.bookmarks.search({ query: text });
        return items
          .filter((b: any) => b.url)
          .map((b: any) => ({ title: b.title || b.url, url: b.url }));
      }
      const out: PopupItem[] = [];
      const walk = (nodes: any[]) => {
        for (const n of nodes) {
          if (n.url) out.push({ title: n.title || n.url, url: n.url });
          if (n.children) walk(n.children);
        }
      };
      const tree = await PlacesUtils.promiseBookmarksTree("root________", {
        includeItemIds: true,
      });
      walk([tree]);
      return out.slice(0, 100);
    } catch (e) {
      return [];
    }
  },
  downloads: async (q: string) => {
    try {
      const Downloads = ChromeUtils.importESModule(
        "resource://gre/modules/Downloads.sys.mjs"
      ).Downloads;
      const list = await Downloads.getList(Downloads.ALL);
      const items = await list.getAll();
      const ql = q.trim().toLowerCase();
      dlSeq = 0;
      downloadsById.clear();
      return items
        .sort((a: any, b: any) => (b.endTime || 0) - (a.endTime || 0))
        .slice(0, 60)
        .map((d: any) => {
          const id = ++dlSeq;
          downloadsById.set(id, d);
          return {
            id: id,
            filename: (d.target && d.target.path ? d.target.path.split(/[\\/]/).pop() : "") || d.source.url || "",
            url: d.source.url || "",
            state: d.succeeded ? "done" : d.error ? "failed" : "active",
          };
        })
        .filter((d: PopupItem) => !ql || ((d.filename || "") + " " + (d.url || "")).toLowerCase().indexOf(ql) !== -1);
    } catch (e) {
      return [];
    }
  },

  openUrl: (url: string, newTab?: boolean) => loadUrl(url, newTab),
  search: (query: string) => doSearch(query),
  newTab: () => {
    const tab = window.gBrowser.addTab("about:newtab", { triggeringPrincipal: sysPrincipal() });
    if (tab) window.gBrowser.selectedTab = tab;
    window.focus();
  },
  closeTab: (id?: number) => {
    if (id == null) {
      window.gBrowser.removeCurrentTab();
      return;
    }
    const tabs = window.gBrowser.tabs;
    const t = tabs[id];
    if (t) {
      if (t.selected) window.gBrowser.removeCurrentTab();
      else window.gBrowser.removeTab(t);
    }
  },
  moveTab: (id: number, dir: number) => {
    const t = window.gBrowser.tabs[id];
    if (!t) return;
    const i = window.gBrowser.tabs.indexOf(t);
    const ni = i + (dir > 0 ? 1 : -1);
    if (ni >= 0 && ni < window.gBrowser.tabs.length) window.gBrowser.moveTabTo(t, ni);
  },
  moveActiveTab: (dir: number) => {
    const tabs = window.gBrowser.tabs;
    const i = tabs.indexOf(window.gBrowser.selectedTab);
    if (i < 0) return;
    const ni = i + (dir > 0 ? 1 : -1);
    if (ni >= 0 && ni < tabs.length) window.gBrowser.moveTabTo(window.gBrowser.selectedTab, ni);
    window.focus();
  },
  reopenTab: () => {
    try {
      window.undoCloseTab();
    } catch (e) {
      try {
        const sb = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs");
        sb.SessionStore.undoCloseTab(window);
      } catch (e2) {
        // give up
      }
    }
  },
  duplicateTab: () => {
    const t = window.gBrowser.duplicateTab(window.gBrowser.selectedTab);
    window.gBrowser.selectedTab = t;
    window.focus();
  },
  reload: () => window.gBrowser.reload(),
  back: () => window.gBrowser.goBack(),
  forward: () => window.gBrowser.goForward(),
  activateTab: (id: number) => {
    const t = window.gBrowser.tabs[id];
    if (t) {
      window.gBrowser.selectedTab = t;
      window.focus();
    }
  },
  tabNav: (dir: number) => {
    const tabs = window.gBrowser.tabs;
    const cur = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
    if (cur < 0 || !tabs.length) return;
    const next = (cur + dir + tabs.length) % tabs.length;
    window.gBrowser.selectedTab = tabs[next];
    window.focus();
  },
  tabJump: (n: number) => {
    const tabs = window.gBrowser.tabs;
    if (!tabs.length) return;
    const idx = n === 9 ? tabs.length - 1 : Math.min(Math.max(0, n - 1), tabs.length - 1);
    window.gBrowser.selectedTab = tabs[idx];
    window.focus();
  },
  zoom: (delta: number, factor?: number) => {
    try {
      const b = window.gBrowser.selectedBrowser;
      if (factor != null) {
        ZoomManager.setZoomForBrowser(b, Math.max(0.3, Math.min(5, factor)));
      } else {
        ZoomManager.setZoomForBrowser(b, Math.max(0.3, Math.min(5, ZoomManager.getZoomForBrowser(b) + delta)));
      }
    } catch (e) {
      // ignore
    }
  },
  openDownload: (id: number) => {
    const d = downloadsById.get(id);
    if (d) {
      try {
        d.launch();
      } catch (e) {
        toast("could not open download");
      }
    }
  },
  copyUrl: () => {
    const url = window.gBrowser.currentURI && window.gBrowser.currentURI.spec;
    if (!url) return;
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(url);
      toast("copied URL");
    } catch (e) {
      // ignore
    }
  },
  muteTab: () => {
    // tab.muted is a getter-only property in current Firefox and the legacy
    // toggleMute/toggleMuteTab helpers are gone — the muted attribute on the
    // xul:tab element is the state the getter reflects.
    const tab = window.gBrowser.selectedTab;
    if (!tab) return;
    try {
      if (tab.hasAttribute("muted")) tab.removeAttribute("muted");
      else tab.setAttribute("muted", "true");
    } catch (e) {
      // ignore
    }
  },
  pinTab: () => {
    const tab = window.gBrowser.selectedTab;
    if (!tab) return;
    if (tab.pinned) window.gBrowser.unpinTab(tab);
    else window.gBrowser.pinTab(tab);
  },
  zen: () => {
    window.fullScreen = !window.fullScreen;
  },
  toggleReveal: notWired("toggleReveal"),
  focusFirstInput: () => {
    // Chrome cannot focus inputs in remote content; ask the background to relay
    // to the content script. Wired by main via requestBg.
    notWired("focusFirstInput")();
  },
  startHints: () => {
    notWired("startHints")();
  },
  openTarget: (which: string) => {
    const ABOUT: Record<string, string> = {
      preferences: "about:preferences",
      addons: "about:addons",
      history: "about:history",
      downloads: "about:downloads",
    };
    const url = ABOUT[which];
    if (!url) return false;
    try {
      if (typeof (window as any).switchToTabHavingURI === "function") {
        (window as any).switchToTabHavingURI(url, true, {});
      } else {
        const tab = window.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
        window.gBrowser.selectedTab = tab;
      }
      window.focus();
      return true;
    } catch (e) {
      return false;
    }
  },
  // Sessions on chrome-only pages are wired by main.ts through the #lfc=req
  // channel to the extension background (which owns browser.storage). The
  // stubs here satisfy the interface; main.ts overrides them with the relay.
  listSessions: () => Promise.resolve([]),
  saveSession: () => {
    toast("sessions work on web pages");
  },
  restoreSession: () => {
    toast("sessions work on web pages");
  },
  deleteSession: () => {
    toast("sessions work on web pages");
  },
  switchSessionByMarker: () => {
    toast("sessions work on web pages");
  },
  assignSessionMarker: () => {
    toast("sessions work on web pages");
  },
  splitTab: (_orientation: "horizontal" | "vertical") => {
    toast("split view needs a web page");
  },
  unsplitTab: () => {
    toast("split view needs a web page");
  },
  switchSplitPane: (_dir: number) => {
    toast("split view needs a web page");
  },
  splitAddTab: () => {
    toast("split view needs a web page");
  },
  sessionState: () => {
    const tabs = window.gBrowser.tabs;
    let idx = 1;
    const sel = tabs.indexOf(window.gBrowser.selectedTab);
    if (sel >= 0) idx = sel + 1;
    return Promise.resolve({
      name: "default",
      marker: 0,
      tabIndex: idx,
      tabCount: tabs.length,
      inSplit: false,
      sessions: [],
    });
  },
  openFind: () => {
    try {
      const fb = window.gFindBar || document.getElementById("FindToolbar");
      if (fb) {
        fb.open();
        return;
      }
    } catch (e) {
      // fall through
    }
    try {
      window.gBrowser.getFindBar().then((b: any) => b.open()).catch(() => toast("find bar unavailable"));
    } catch (e) {
      toast("find bar unavailable");
    }
  },
  openResize: notWired("openResize"),
};

// Download objects by the id handed out by downloads() (the popup hands the
// id back to openDownload()).
let dlSeq = 0;
const downloadsById = new Map<number, { launch(): void }>();
