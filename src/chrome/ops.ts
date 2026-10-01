// The chrome helper's ActionOps implementation: everything the shared leader
// actions and popups need, using chrome APIs (gBrowser, Places, Downloads,
// SearchSuggestionController) directly.
//
// The implementation is split by domain into src/chrome/ops/:
//   primitives.ts — tab identity, native URL loading, native data sources
//   tabs.ts       — the tab strip actions + the tab switcher rows
//   sessions.ts   — session CRUD (relayed) + native split-view actions
//   ui.ts         — find bar, resize popup, downloads, stealth, zen, toggles
//
// This file composes those domains into the single ActionOps object. Every
// capability that needs another module (the relay channel, the native split
// view, the popup host, the status bar, config) is injected; the only
// late-bound dependency is the channel (created after ops because the channel
// wraps the popup context that wraps ops) — it is resolved through a getter
// that only runs at action time.

import { core } from "../shared/core";
import type { ActionOps } from "../shared/ops";
import type { Config, PopupItem, SessionSummaryItem } from "../shared/types";
import type { ChromeCfg } from "./config";
import type { RelayAction, RelayReq, RelayRes } from "../shared/protocol";
import {
  doSearch,
  histItems,
  loadUrl,
  openUrlNative,
  suggestSearch,
} from "./ops/primitives";
import { buildTabRows, createTabOps } from "./ops/tabs";
import { createSessionOps, createSplitOps } from "./ops/sessions";
import { createUiOps } from "./ops/ui";

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
  // The persistent relay channel (channel.ts). Created AFTER ops because the
  // channel needs the popup context that wraps ops; requestBg /
  // requestReply / requestSessionState only run at action time, so a getter
  // resolves the construction cycle.
  getChannel(): {
    requestBg<K extends RelayAction>(action: K, arg?: RelayReq<K>): void;
    requestReply<K extends RelayAction>(action: K, arg?: RelayReq<K>): Promise<RelayRes<K> | null>;
    requestSessionState(): Promise<void>;
    requestSessionTabs(name: string): Promise<PopupItem[]>;
    requestRecentlyClosed(): Promise<PopupItem[]>;
    ccBaseUrl(): string | null;
  };
}

export function createChromeOps(deps: ChromeOpsDeps): ActionOps {
  const tabs = createTabOps({
    requestBg: (action) => deps.getChannel().requestBg(action),
  });
  const tabOps = tabs;
  const sessions = createSessionOps(
    () => deps.getChannel(),
    deps.status
  );
  const splits = createSplitOps(deps.split);
  const ui = createUiOps({
    cfg: deps.cfg,
    persistCfg: deps.persistCfg,
    applyHoverRevealPref: deps.applyHoverRevealPref,
    popup: deps.popup,
    // Lazy, like the tabs ops above: the channel is created AFTER ops (it
    // needs the popup context that wraps ops), so calling deps.getChannel()
    // here at construction time captures undefined and every later
    // requestBg/requestReply dies with "A.channel is undefined". Resolving
    // the getter inside the wrappers defers to action time, when the channel
    // exists.
    channel: {
      requestBg: (action, arg) => deps.getChannel().requestBg(action, arg),
      requestReply: (action) => deps.getChannel().requestReply(action),
    },
  });

  return {
    searchSuggest: (q: string) => suggestSearch(q),

    urlSuggest: async (q: string) => {
      const text = (q || "").trim();
      const entries: PopupItem[] = [];
      if (!text) return entries;
      // Normalize exactly like the background path (core.normalizeUrl) so the
      // picked row always carries a loadable URL. Passing raw scheme-less text
      // to gBrowser.addTab/loadURI fails (e.g. a bare word like a session
      // name), which leaves a blank tab that never navigates.
      let url = text;
      try {
        url = await core.normalizeUrl(text);
      } catch {
        // keep raw text on core failure
      }
      entries.push({ kind: "url", title: "Open URL", subtitle: url, url: url });
      try {
        const visited = histItems(text, 120);
        const ranked = await core.rankVisited(visited, text);
        for (const u of ranked) {
          entries.push({ kind: "page", title: u.title || u.url, subtitle: u.url, url: u.url });
        }
      } catch {
        // Keep the "Open URL" entry even if ranking fails.
      }
      return entries;
    },

    listTabs: async (q: string) => {
      // Refresh the status bar's tab ids + stealth flags first so the rows
      // carry the true Firefox tab id and the stealth badge.
      await deps.getChannel().requestSessionState();
      return buildTabRows(deps.status, q);
    },

    history: (q: string) => {
      const text = (q || "").trim();
      return Promise.resolve(histItems(text, text ? 80 : 1000).map((h) => ({
        kind: "history" as const,
        title: h.title,
        url: h.url,
        time: h.time,
      })));
    },
    bookmarks: async (q: string) => {
      const ChromeUtils: any = (window as any).ChromeUtils;
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
      } catch {
        return [];
      }
    },
    downloads: (q: string) => ui.downloads(q),

    openUrl: (url: string, newTab?: boolean) => loadUrl(url, newTab),
    search: (query: string, newTab?: boolean) => doSearch(query, newTab === false),
    newTab: () => tabs.newTab(() => deps.getChannel().ccBaseUrl()),
    closeTab: (id?: number) => tabs.closeTab(id),
    moveTab: (id: number, dir: number) => tabs.moveTab(id, dir),
    moveActiveTab: (dir: number) => tabs.moveActiveTab(dir),
    reopenTab: () => tabs.reopenTab(),
    duplicateTab: () => tabs.duplicateTab(),
    reload: () => tabOps.reload(),
    back: () => tabOps.back(),
    forward: () => tabOps.forward(),
    activateTab: (id: number) => tabs.activateTab(id),
    tabNav: (dir: number) => tabs.tabNav(dir),
    tabJump: (n: number) => tabs.tabJump(n),
    alternateTab: () => tabs.alternateTab(),
    recentlyClosed: () => deps.getChannel().requestRecentlyClosed(),
    restoreClosedTab: (key: string) => deps.getChannel().requestBg("restoreClosedTab", { key }),
    restoreAllClosed: () => deps.getChannel().requestBg("restoreAllClosed"),
    removeHistory: (url: string) => deps.getChannel().requestBg("removeHistory", { url }),
    clearHistory: () => deps.getChannel().requestBg("clearHistory"),
    zoom: (delta: number, factor?: number) => tabs.zoom(delta, factor),
    openDownload: (key: string) => ui.openDownload(key),
    removeDownload: (key: string) => ui.removeDownload(key),
    openDownloadLocation: (key: string) => ui.openDownloadLocation(key),
    retryDownload: (key: string) => ui.retryDownload(key),
    dismissDownload: (key?: string) => ui.dismissDownload(key),
    stealthOpen: () => ui.stealthOpen(),
    copyUrl: () => tabs.copyUrl(),
    muteTab: () => tabs.muteTab(),
    zen: () => ui.zen(),
    toggleReveal: () => ui.toggleReveal(),
    toggleWhichKey: () => ui.toggleWhichKey(),
    quit: () => ui.quit(),
    focusFirstInput: () => ui.focusFirstInput(),
    startHints: () => ui.startHints(),
    openTarget: (which: string) => {
      const ABOUT: Record<string, string> = {
        preferences: "about:preferences",
        addons: "about:addons",
        history: "about:history",
        downloads: "about:downloads",
      };
      // which may carry a fragment ("preferences#searchResults") from the
      // background's prefix-matched about: URL.
      const fragIdx = which.indexOf("#");
      const base = fragIdx < 0 ? which : which.slice(0, fragIdx);
      const frag = fragIdx < 0 ? "" : which.slice(fragIdx);
      const url = ABOUT[base];
      if (!url) return;
      openUrlNative(url + frag);
    },
    openUrlNative: (url: string) => openUrlNative(url),

    openFind: () => ui.openFind(),
    openResize: () => ui.openResize(),
    openSetup: () => ui.openSetup(),
    openDiagnostics: () => ui.openDiagnostics(),

    listSessions: (q: string) => sessions.listSessions(q),
    listSessionTabs: (name: string) => sessions.listSessionTabs(name),
    saveSession: (name: string) => sessions.saveSession(name),
    newSession: (name: string) => sessions.newSession(name),
    restoreSession: (name: string) => sessions.restoreSession(name),
    deleteSession: (name: string) => sessions.deleteSession(name),
    switchSessionByMarker: (marker: number) => sessions.switchSessionByMarker(marker),
    assignSessionMarker: (name: string, marker: number) => sessions.assignSessionMarker(name, marker),
    sessionTabCopy: (from: string, index: number, to: string) => sessions.sessionTabCopy(from, index, to),
    sessionTabMove: (from: string, index: number, to: string) => sessions.sessionTabMove(from, index, to),
    splitTab: (orientation: "horizontal" | "vertical") => splits.splitTab(orientation),
    unsplitTab: () => splits.unsplitTab(),
    switchSplitPane: (dir: number) => splits.switchSplitPane(dir),
    swapSplitPane: (dir: number) => splits.swapSplitPane(dir),
    splitAddTabByIndex: (n: number) => splits.splitAddTabByIndex(n),
    sessionState: () => {
      const tabsAll = window.gBrowser.tabs;
      let idx = 1;
      const sel = tabsAll.indexOf(window.gBrowser.selectedTab);
      if (sel >= 0) idx = sel + 1;
      return Promise.resolve({
        name: "default",
        marker: 0,
        tabIndex: idx,
        tabCount: tabsAll.length,
        inSplit: false,
        sessions: [],
      });
    },
  };
}
