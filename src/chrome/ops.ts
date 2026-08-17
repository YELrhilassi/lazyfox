// The chrome helper's ActionOps implementation: everything the shared leader
// actions and popups need, using chrome APIs (gBrowser, Places, Downloads,
// SearchSuggestionController) directly. Search/data functions are async so the
// shared popup engine can consume them uniformly.
//
// Built by createChromeOps(deps): every capability that needs another module
// (the #lfc= channel, the native split view, the popup host, the status bar,
// config) is injected, so nothing is monkey-patched onto a singleton after the
// fact. The only late-bound dependency is the channel (created after ops
// because the channel wraps the popup context that wraps ops) — it is resolved
// through a getter that only runs at action time.

import { core } from "../shared/core";
import {
  dismissDownload as dismissBarNotifications,
  listDownloads,
  openDownload as launchDownload,
  openDownloadLocation as revealDownload,
  removeDownload as eraseDownload
} from "./downloads";
import { withConfig, type ChromeCfg } from "./config";
import { toast } from "../shared/overlay";
import type { ActionOps } from "../shared/ops";
import type { Config, PopupItem, SessionSummaryItem } from "../shared/types";

declare const Services: any;
declare const Cc: any;
declare const Ci: any;
declare const ChromeUtils: any;
declare const ZoomManager: any;

const XHTML = "http://www.w3.org/1999/xhtml";

// Armed close: when ;x would remove the window's LAST tab (closing the whole
// window), the first press arms a confirmation and a second press within 2.5s
// actually closes.
let closeArmed = false;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
function disarmClose() {
  closeArmed = false;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function sysPrincipal() {
  return Services.scriptSecurityManager.getSystemPrincipal();
}

// Real (user) tabs in strip order: skip the split-panel companion and the
// #lfc= request channel so tab numbers stay stable across splits/unsplits.
function realTabs(): any[] {
  const out: any[] = [];
  for (const t of window.gBrowser.tabs) {
    try {
      const spec =
        t && t.linkedBrowser && t.linkedBrowser.currentURI
          ? t.linkedBrowser.currentURI.spec
          : "";
      if (spec.indexOf("splitpanel.html") !== -1 || spec.indexOf("#lfc=") !== -1) continue;
      out.push(t);
    } catch (e) {
      out.push(t);
    }
  }
  return out;
}

function el(tag: string, attrs?: Record<string, string> | null, text?: string | null): HTMLElement {
  const e = document.createElementNS(XHTML, tag) as HTMLElement;
  if (attrs) {
    for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
  }
  if (text != null) e.textContent = text;
  return e;
}

// Mirrors the Go core's NormalizeUrl (scheme-less input gets https://). Any
// caller can hand loadUrl raw user text (the URL popup's onEnter fallback, a
// history item, etc.); a scheme-less string would otherwise make addTab/loadURI
// fail, leaving an about:blank tab that the background then converts to the
// lazyfox home page.
function loadableUrl(url: string): string {
  const t = (url || "").trim();
  if (!t) return t;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t;
  return "https://" + t;
}

function loadUrl(url: string, newTab: boolean | undefined): void {
  url = loadableUrl(url);
  if (!url) return;
  const openInNewTab = () => {
    try {
      const p = JSON.parse(Services.prefs.getStringPref("lazyfox.chrome.config", "{}"));
      return (p as Config).openInNewTab !== false;
    } catch (e) {
      return true;
    }
  };
  // newTab === true forces a new tab, newTab === false forces the current tab
  // (replace it), undefined defers to the openInNewTab config.
  const forceNew = newTab === undefined ? openInNewTab() : newTab;
  const browser = window.gBrowser.selectedBrowser;
  // The command center (home page) and blank/home tabs navigate in place: an
  // open there should reuse the tab instead of stacking up extra ones. This
  // matches the background's openUrl, which replaces the home page in place.
  let onHome = false;
  try {
    const u = browser && browser.currentURI ? browser.currentURI.spec : "";
    onHome = u.indexOf("commandcenter.html") !== -1 || /^about:(home|newtab|blank)$/i.test(u);
  } catch (e) {
    onHome = false;
  }
  if (onHome || forceNew === false) {
    // Navigate the current tab in place. gBrowser.loadURI is long gone, and
    // the <browser> element's loadURI() now takes an nsIURI — passing a
    // string throws, which used to fall through to addTab (so ;O / ;S and
    // opening from the home page wrongly spawned a new tab).
    // fixupAndLoadURIString is the supported string-loading path; it is a
    // no-op fixup for our already-normalized URLs.
    const navInPlace = (): boolean => {
      try {
        if (typeof browser.fixupAndLoadURIString === "function") {
          browser.fixupAndLoadURIString(url, { triggeringPrincipal: sysPrincipal() });
          return true;
        }
        const uri = Services.io.newURI(url);
        browser.loadURI(uri, { triggeringPrincipal: sysPrincipal() });
        return true;
      } catch (e) {
        console.error("lazyfox in-place load failed", e);
        return false;
      }
    };
    if (navInPlace()) {
      window.focus();
      return;
    }
  }
  window.gBrowser.selectedTab = window.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
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

function doSearch(query: string, replace = false): void {
  const q = (query || "").trim();
  if (!q) return;
  // ;S (replace) opens the results in the current tab; ;s defers to config.
  const open = (url: string) => loadUrl(url, replace ? false : undefined);
  try {
    Services.search.getDefault().then((engine: any) => {
      const sub = engine.getSubmission(q);
      open(sub.uri.spec);
    }).catch(() => {
      open("https://www.google.com/search?q=" + encodeURIComponent(q));
    });
  } catch (e) {
    open("https://www.google.com/search?q=" + encodeURIComponent(q));
  }
}

/* ---------- the ops factory ---------- */

export interface ChromeOpsDeps {
  // Native split view operations (splitview.ts).
  split: {
    splitCurrentTab(orientation: "horizontal" | "vertical"): boolean;
    unsplit(): boolean;
    switchPane(dir: number): boolean;
    swapPane(dir: number): boolean;
    addTabToSplitByIndex(n: number): boolean;
  };
  // The chrome popup host (popup.ts).
  popup: { openResizePopup(): void };
  // The window-level status bar (statusbar.ts): real tab ids + stealth flags
  // for the tab switcher, and the session list for the sessions popup.
  status: {
    getTabIds(): number[];
    getStealthFlags(): boolean[];
    getInfo(): { sessions: SessionSummaryItem[] };
  };
  // Chrome-side config (config.ts). Mutated in place for toggles so every
  // holder of the same ChromeCfg sees the new value.
  cfg: ChromeCfg;
  persistCfg(cfg: ChromeCfg, config?: Config): void;
  applyHoverRevealPref(cfg: ChromeCfg): void;
  // The #lfc= request channel (channel.ts). Created AFTER ops because the
  // channel needs the popup context that wraps ops; requestBg /
  // requestSessionState only run at action time, so a getter resolves the
  // construction cycle.
  getChannel(): {
    requestBg(action: string, arg?: string): void;
    requestSessionState(): Promise<void>;
    requestSessionTabs(name: string): Promise<PopupItem[]>;
  };
}

export function createChromeOps(deps: ChromeOpsDeps): ActionOps {
  // Session + split actions relay to the extension background (which owns
  // browser.storage) through the #lfc=req channel, then refresh the status
  // bar's session list once the action lands.
  const sessionAction = (action: string, arg?: string) => {
    deps.getChannel().requestBg(action, arg);
    setTimeout(() => void deps.getChannel().requestSessionState(), 900);
  };

  return {
    searchSuggest: (q: string) => suggestSearch(q),
    urlSuggest: async (q: string) => {
      const text = (q || "").trim();
      const entries: PopupItem[] = [];
      if (!text) return entries;
      // Normalize exactly like the background path (core.normalizeUrl) so the
      // picked row always carries a loadable URL. Passing raw scheme-less text
      // to gBrowser.addTab/loadURI fails (e.g. a bare word like a session name),
      // which leaves an about:blank tab that the background then converts to the
      // lazyfox home page.
      let url = text;
      try {
        url = await core.normalizeUrl(text);
      } catch (e) {
        // keep raw text on core failure
      }
      entries.push({ kind: "url", title: "Open URL", subtitle: url, url: url });
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
    listTabs: async (q: string) => {
      // Refresh the status bar's tab ids + stealth flags first so the rows
      // carry the true Firefox tab id and the stealth badge.
      await deps.getChannel().requestSessionState();
      const ql = (q || "").trim().toLowerCase();
      const out: PopupItem[] = [];
      const tabIds = deps.status.getTabIds();
      const stealthFlags = deps.status.getStealthFlags();
      const tabs = window.gBrowser.tabs;
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        try {
          const spec =
            t.linkedBrowser && t.linkedBrowser.currentURI
              ? t.linkedBrowser.currentURI.spec
              : "";
          if (spec.indexOf("splitpanel.html") !== -1 || spec.indexOf("#lfc=") !== -1) continue;
        } catch (e) {
          // ignore
        }
        let uri = "";
        try {
          uri = (t.linkedBrowser && t.linkedBrowser.currentURI && t.linkedBrowser.currentURI.spec) || "";
        } catch (e) {
          // ignore
        }
        const item: PopupItem = {
          id: i, // strip index — what the chrome ops address
          realId: tabIds[i], // true Firefox tab id, for display
          title: t.label || uri || "",
          url: uri,
          active: !!t.selected,
          pinned: !!t.pinned,
          muted: !!t.muted,
          stealth: !!stealthFlags[i],
          favIconUrl: (t.getAttribute && t.getAttribute("image")) || "",
        };
        if (!ql || ((item.title || "") + " " + (item.url || "")).toLowerCase().indexOf(ql) !== -1) {
          out.push(item);
        }
      }
      return out;
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
    downloads: (q: string) => {
      const ql = q.trim().toLowerCase();
      return Promise.resolve(
        listDownloads()
          .slice(0, 120)
          .map((d) => ({
            kind: "download",
            key: d.id,
            filename: d.filename,
            path: d.path,
            url: d.url,
            state: d.state,
            received: d.received,
            total: d.total,
            speed: d.speed,
            progress:
              d.total > 0
                ? Math.max(0, Math.min(100, Math.round((d.received / d.total) * 100)))
                : -1,
          }))
          .filter(
            (d) =>
              !ql ||
              ((d.filename || "") + " " + (d.path || "") + " " + (d.url || "")).toLowerCase().indexOf(ql) !== -1
          )
      );
    },

    openUrl: (url: string, newTab?: boolean) => loadUrl(url, newTab),
    search: (query: string, newTab?: boolean) => doSearch(query, newTab === false),
    newTab: () => {
      const tab = window.gBrowser.addTab("about:newtab", { triggeringPrincipal: sysPrincipal() });
      if (tab) window.gBrowser.selectedTab = tab;
      window.focus();
    },
    closeTab: (id?: number) => {
      if (id == null) {
        // Closing the last tab closes the window — confirm before doing it.
        if (realTabs().length <= 1) {
          if (closeArmed) {
            disarmClose();
            window.gBrowser.removeCurrentTab();
            return;
          }
          closeArmed = true;
          closeTimer = setTimeout(disarmClose, 2500);
          toast("last tab — press ;x again to close the window");
          return;
        }
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
      const tabs = realTabs();
      if (!tabs.length) return;
      let cur = tabs.indexOf(window.gBrowser.selectedTab);
      if (cur < 0) cur = dir > 0 ? -1 : 0;
      const next = (cur + dir + tabs.length) % tabs.length;
      window.gBrowser.selectedTab = tabs[next];
      window.focus();
    },
    tabJump: (n: number) => {
      const tabs = realTabs();
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
    openDownload: (key: string) => {
      void launchDownload(key).then((ok) => {
        if (!ok) toast("could not open download");
      });
    },
    openDownloadLocation: (key: string) => {
      void revealDownload(key).then((ok) => {
        if (!ok) toast("could not reveal download");
      });
    },
    removeDownload: (key: string) => {
      void eraseDownload(key).then((ok) => {
        toast(ok ? "download removed" : "could not remove download");
      });
    },
    dismissDownload: (key?: string) => {
      dismissBarNotifications(key);
    },
    stealthOpen: () => {
      deps.getChannel().requestBg("stealthOpen");
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
    zen: () => {
      window.fullScreen = !window.fullScreen;
    },
    toggleReveal: () => {
      const next = withConfig(deps.cfg, { hoverReveal: !deps.cfg.config.hoverReveal });
      deps.cfg.config = next.config;
      deps.persistCfg(deps.cfg, deps.cfg.config);
      deps.applyHoverRevealPref(deps.cfg);
      toast("toolbar reveal: " + (deps.cfg.config.hoverReveal ? "on" : "off"));
    },
    focusFirstInput: () => {
      // Chrome cannot focus inputs in remote content; ask the background to
      // relay to the content script.
      deps.getChannel().requestBg("focusFirstInput");
    },
    startHints: () => {
      deps.getChannel().requestBg("startHints");
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
    // Sessions on chrome-only pages relay through the #lfc=req channel to the
    // extension background (which owns browser.storage).
    listSessions: async (q: string) => {
      // Await a fresh status-bar refresh so the list reflects a just-completed
      // save/delete instead of the stale cache (the sessions popup reads this
      // list right after a mutation).
      await deps.getChannel().requestSessionState();
      const ql = (q || "").trim().toLowerCase();
      let items: PopupItem[] = deps.status.getInfo().sessions.map((s) => ({
        kind: "session",
        title: s.name,
        marker: s.marker || 0,
        subtitle:
          (s.marker ? "marker " + s.marker + " \u00b7 " : "") +
          (s.tabCount || 0) +
          " tabs" +
          (s.splitCount ? " \u00b7 " + s.splitCount + " split" : ""),
      }));
      if (ql) items = items.filter((s) => (s.title || "").toLowerCase().indexOf(ql) !== -1);
      return items;
    },
    listSessionTabs: (name: string) => deps.getChannel().requestSessionTabs(name),
    saveSession: (name: string) => sessionAction("saveSession", name),
    newSession: (name: string) => sessionAction("newSession", name),
    restoreSession: (name: string) => sessionAction("restoreSession", name),
    deleteSession: (name: string) => sessionAction("deleteSession", name),
    switchSessionByMarker: (marker: number) =>
      sessionAction("switchSessionByMarker", String(marker)),
    assignSessionMarker: (name: string, marker: number) =>
      sessionAction("assignSessionMarker", name + "\u0001" + marker),
    splitTab: (orientation: "horizontal" | "vertical") => {
      if (!deps.split.splitCurrentTab(orientation)) {
        const api = typeof window.gBrowser.addTabSplitView === "function";
        toast(api ? "could not split (pinned tab or stale split state)" : "native split needs Firefox 149+");
      }
    },
    unsplitTab: () => {
      if (!deps.split.unsplit()) toast("not in a split view");
    },
    switchSplitPane: (dir: number) => {
      if (!deps.split.switchPane(dir)) toast("not in a split view");
    },
    swapSplitPane: (dir: number) => {
      if (!deps.split.swapPane(dir)) toast("not in a split view");
    },
    splitAddTabByIndex: (n: number) => {
      if (!deps.split.addTabToSplitByIndex(n)) toast("no split view to move into");
    },
    toggleWhichKey: () => {
      const next = withConfig(deps.cfg, { whichKey: deps.cfg.config.whichKey === false });
      deps.cfg.config = next.config;
      deps.persistCfg(deps.cfg, deps.cfg.config);
      // Keep the background's stored config in step (the chrome helper only
      // caches a copy).
      deps.getChannel().requestBg("toggleWhichKey");
      toast("which-key: " + (deps.cfg.config.whichKey !== false ? "on" : "off"));
    },
    quit: () => {
      deps.getChannel().requestBg("quit");
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
    openResize: () => deps.popup.openResizePopup(),
  };
}
