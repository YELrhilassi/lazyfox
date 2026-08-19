// The window-level status bar (tmux-style). The chrome helper draws ONE bar
// into the browser XUL document and reserves space by shrinking the #browser
// content area (margin), so the fixed bar sits in reserved space instead of
// overlapping the page — for a single tab and for split panes alike. The
// content script hides its own bar whenever the chrome helper is alive, so
// there is exactly one bar.
//
// This module owns the bar's data (current session, tab ids, stealth flags,
// download segment) and its render/update cycle. It is pure chrome: it reads
// the shared StatusBar renderer, the download manager and the injected
// getters, and never touches the leader or popups directly.

import { core } from "../shared/core";
import { StatusBar } from "../shared/statusbar";
import { activeDownloads, dismissDownload, updateDownloads } from "./downloads";
import type { DownloadEntry } from "../shared/types";
import type { ChromeCfg } from "./config";

export interface StatusBarDeps {
  // Real (user) tabs in strip order (splitview.realTabs) — the live count.
  realTabs(): any[];
  getConfig(): ChromeCfg;
  // Rendering mode for the bar: a popup or the leader overlay is open.
  getMode(): "POPUP" | "LEADER" | "NORMAL";
}

export interface StatusBarCtl {
  update(): void;
  compute(): void;
  refreshDownloads(): Promise<void>;
  pollDownloads(): Promise<void>;
  // Apply a sessionState reply from the background (base64 JSON) and
  // re-render. Returns the nonce the reply carried so the caller can resolve
  // its waiter.
  applySessionState(b64: string): void;
  // True while a page element is in DOM fullscreen (a video, a gallery
  // lightbox, ...). Only then does the bar hide: browser-level fullscreen
  // (zen mode, F11) keeps the bar visible.
  isFullscreen(): boolean;
  getTabIds(): number[];
  getStealthFlags(): boolean[];
  // The stealth badge must track the tab you switched to immediately (without
  // a sessionState round-trip), so the caller sets the active flag locally.
  setActiveStealth(on: boolean): void;
  mounted(): boolean;
  dlActive(): string[];
  getInfo(): {
    name: string;
    marker: number;
    inSplit: boolean;
    splitOrientation: "horizontal" | "vertical" | undefined;
    splitActive: number;
    splitPanes: number;
    activeStealth: boolean;
    sessions: { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[];
  };
}

export function createStatusBar(deps: StatusBarDeps): StatusBarCtl {
  const chromeStatusBar = new StatusBar(true, "#browser");
  // Clicking a download notification on the bar dismisses just that one (the
  // popup list keeps it). The download manager is this module's direct
  // dependency, so it is imported rather than threaded through deps.
  chromeStatusBar.setDownloadDismiss((key) => {
    dismissDownload(key);
    void refreshDownloadStatus();
  });

  let chromeStatusInfo = {
    name: "default",
    marker: 0,
    inSplit: false,
    splitOrientation: undefined as "horizontal" | "vertical" | undefined,
    splitActive: 0,
    splitPanes: 0,
    activeStealth: false,
    sessions: [] as { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[],
  };
  // Real tab ids in strip order from the last sessionState reply, so the tab
  // switcher popup can show each tab's true Firefox id.
  let chromeStatusTabIds: number[] = [];
  // Stealth flags parallel to chromeStatusTabIds (strip order), so the tab
  // switcher can badge stealth tabs without re-querying the containers.
  let chromeStatusStealthFlags: boolean[] = [];
  // Active (un-dismissed) downloads for the status bar's progress segment.
  let chromeStatusDownloads: { key: string; filename: string; state: string; percent: number; speed: string }[] = [];

  // Is the selected tab the extension's command center page?
  function isCommandCenterTab(): boolean {
    try {
      const b = window.gBrowser.selectedBrowser;
      const uri = b && b.currentURI;
      if (!uri) return false;
      const s = uri.spec || "";
      return s.indexOf("commandcenter.html") !== -1;
    } catch (e) {
      return false;
    }
  }

  // ONE window-level bar owns the bottom of the window for EVERY tab — plain
  // web pages, chrome-only pages, and split panes alike. The bar lives in the
  // chrome document (outside the web content) and reserves its 18px by
  // shrinking the #browser content area, so the page reflows above it instead
  // of rendering underneath it. Always true here: the chrome helper owns the
  // single bar for every page.
  function chromePageNeedsStatus(): boolean {
    return true;
  }

  function isFullscreen(): boolean {
    // DOM fullscreen (a video, a gallery lightbox) must hide the window
    // bar. Firefox signals it with the `inDOMFullscreen` attribute on the
    // chrome document root — an internal detail that has shifted before (a
    // Firefox update once left the bar on screen during video fullscreen).
    // Belt and suspenders: also read the selected tab's content document
    // through the STANDARD Fullscreen API (document.fullscreenElement), which
    // is stable across versions. Either signal alone hides the bar; the
    // 500ms poll plus the fullscreenchange events keep both edges fresh.
    try {
      if (document.documentElement.hasAttribute("inDOMFullscreen")) return true;
      const b = window.gBrowser && window.gBrowser.selectedBrowser;
      const doc = b && b.contentDocument;
      if (doc && doc.fullscreenElement) return true;
    } catch (e) {
      // ignore
    }
    return false;
  }

  function computeChromeStatus(): void {
    const tabs = window.gBrowser.tabs;
    const sel = tabs.indexOf(window.gBrowser.selectedTab);
    const mode = deps.getMode();
    // The CURRENT session's pill count tracks live tabs, so opening/closing a
    // tab updates the pill immediately — without a sessionState round-trip,
    // which would create a transient tab and churn counts under automation.
    // Other sessions' counts are refreshed on session actions/startup as usual.
    const liveCount = deps.realTabs().length;
    const sessions = chromeStatusInfo.sessions.map((s) =>
      s.current ? { ...s, tabCount: liveCount } : s
    );
    chromeStatusBar.setData({
      name: chromeStatusInfo.name,
      marker: chromeStatusInfo.marker,
      tabIndex: (sel < 0 ? 0 : sel) + 1,
      tabCount: tabs.length,
      inSplit: chromeStatusInfo.inSplit,
      splitOrientation: chromeStatusInfo.splitOrientation,
      splitActive: chromeStatusInfo.splitActive,
      splitPanes: chromeStatusInfo.splitPanes,
      activeStealth: chromeStatusInfo.activeStealth,
      mode: mode,
      sessions: sessions,
      downloads: chromeStatusDownloads,
    });
  }

  function updateChromeStatus(): void {
    const cfg = deps.getConfig();
    if (cfg.config.statusBar === false || isFullscreen()) {
      chromeStatusBar.hide();
      return;
    }
    chromeStatusBar.setPosition(cfg.config.statusBarPosition || "bottom");
    if (chromePageNeedsStatus()) chromeStatusBar.show();
    else chromeStatusBar.hide();
  }

  // Recompute the status bar's download segment from the manager cache (the
  // Go activeDownloads/formatSpeed/progress helpers do the work) and re-render.
  async function refreshDownloadStatus(): Promise<void> {
    const active = await activeDownloads();
    const out: { key: string; filename: string; state: string; percent: number; speed: string }[] = [];
    for (const d of active) {
      const percent = await core.downloadProgress(d.received, d.total);
      const speed = await core.formatSpeed(d.speed);
      out.push({ key: d.id, filename: d.filename, state: d.state, percent: percent, speed: speed });
    }
    chromeStatusDownloads = out;
    computeChromeStatus();
  }

  async function pollDownloads(): Promise<void> {
    try {
      await updateDownloads();
      await refreshDownloadStatus();
    } catch (e) {
      // downloads are best-effort; never let a poll break the bar
    }
  }

  function applySessionState(b64: string): void {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const state = JSON.parse(new TextDecoder().decode(bytes));
      chromeStatusInfo = {
        name: state && state.name ? String(state.name) : "default",
        marker: state && state.marker ? Number(state.marker) : 0,
        inSplit: !!(state && state.inSplit),
        splitOrientation:
          state && state.splitOrientation === "vertical" ? "vertical" : "horizontal",
        splitActive: state && typeof state.splitActive === "number" ? state.splitActive : 0,
        splitPanes: state && typeof state.splitPanes === "number" ? state.splitPanes : 0,
        activeStealth: !!(state && state.activeStealth),
        sessions: (state && state.sessions) || [],
      };
      chromeStatusTabIds = Array.isArray(state && state.tabIds) ? state.tabIds : [];
      chromeStatusStealthFlags = Array.isArray(state && state.stealthFlags)
        ? state.stealthFlags
        : [];
      computeChromeStatus();
    } catch (e) {
      // ignore
    }
  }

  return {
    update: updateChromeStatus,
    compute: computeChromeStatus,
    refreshDownloads: refreshDownloadStatus,
    pollDownloads,
    applySessionState,
    isFullscreen,
    getTabIds: () => chromeStatusTabIds.slice(),
    getStealthFlags: () => chromeStatusStealthFlags.slice(),
    getInfo: () => chromeStatusInfo,
    setActiveStealth: (on) => {
      chromeStatusInfo = { ...chromeStatusInfo, activeStealth: on };
    },
    mounted: () => chromeStatusBar.mounted,
    dlActive: () =>
      chromeStatusDownloads.map(
        (d) => d.filename + "|" + d.state + (d.percent >= 0 ? "|" + d.percent : "")
      ),
  };
}
