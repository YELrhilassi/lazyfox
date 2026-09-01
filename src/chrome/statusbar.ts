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
  // Apply a sessionState reply from the background (the parsed state object,
  // delivered structured-cloned over the relay) and re-render.
  applySessionState(state: any): void;
  // True while a page element is in DOM fullscreen (a video, a gallery
  // lightbox, ...). Only then does the bar hide: browser-level fullscreen
  // (zen mode, F11) keeps the bar visible.
  isFullscreen(): boolean;
  getTabIds(): number[];
  getStealthFlags(): boolean[];
  // The stealth badge must track the tab you switched to immediately (without
  // a sessionState round-trip), so the caller sets the active flag locally.
  setActiveStealth(on: boolean): void;
  // Content-script leader state by tab-strip index (pushed by the background
  // on every arm/disarm). The window-level bar shows the LEADER chevron on
  // web pages — where the content script owns the leader key and the chrome
  // helper's own leader never arms — by consulting this per-index cache.
  setContentLeader(index: number, active: boolean): void;
  contentLeaderActive(index: number): boolean;
  // Content-script find-in-page state by tab-strip index (pushed by the
  // background on every count change). The window-level bar shows the live
  // match count for the selected web page, where the content script owns the
  // find widget and the chrome helper's own find bar never opens.
  setContentFind(index: number, count: number, cur: number): void;
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
  // Content-script leader arm state by tab-strip index (the index the
  // background's sender.tab.index reports — same ordering as gBrowser.tabs).
  let contentLeaderByIndex: Record<number, boolean> = {};
  // Content-script find-in-page state by tab-strip index (1-based current
  // match, 0 = query typed but nothing walked to; total matches).
  let contentFindByIndex: Record<number, { count: number; cur: number }> = {};

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
      // The selected browser can be a dead wrapper mid-collapse (its tab is
      // being torn down); any property access then throws. Skip it.
      if (b && Cu && Cu.isDeadWrapper(b)) return false;
      const doc = b && b.contentDocument;
      if (doc && doc.fullscreenElement) return true;
    } catch (e) {
      // ignore
    }
    return false;
  }

  function computeChromeStatus(): void {
    // Never throw out of here: the leader's status callback runs this MID key
    // dispatch (a ;| split collapses the window while the bar re-renders), so
    // a dead tab or a half-torn-down window must degrade to a best-effort
    // render instead of breaking the key. All reads below are already
    // defensive (realTabs skips dead wrappers); the try/catch is the final
    // backstop for anything that still throws.
    try {
      const tabs = window.gBrowser.tabs;
      const sel = tabs.indexOf(window.gBrowser.selectedTab);
      const mode = deps.getMode();
      const findState = sel >= 0 ? contentFindByIndex[sel] : undefined;
      // The CURRENT session's pill count tracks live tabs, so opening/closing
      // a tab updates the pill immediately — without a sessionState
      // round-trip (which used to create a transient tab and churn counts
      // under automation). Other sessions' counts are refreshed on session
      // actions/startup as usual. Numbering counts REAL tabs only: the
      // persistent relay tab and split companion panes are internal plumbing
      // and must never shift the user-visible index/count.
      const real = deps.realTabs();
      const liveCount = real.length;
      const realSel = real.indexOf(window.gBrowser.selectedTab);
      // The stealth badge is a LIVE property of the selected tab (its
      // container), never a cached flag: flags keyed by raw tab index go stale
      // the moment a tab closes and shift every index after it, so a normal
      // tab would inherit a dead tab's badge. userContextId > 0 means the tab
      // runs in an isolated container (Lazyfox stealth opens one per tab).
      let selStealth = false;
      try {
        const t = window.gBrowser.selectedTab;
        selStealth = !!(
          t && typeof t.userContextId === "number" && t.userContextId > 0
        );
      } catch (e) {
        // selection not readable mid-collapse; keep the pushed value
        selStealth = !!chromeStatusInfo.activeStealth;
      }
      const sessions = chromeStatusInfo.sessions.map((s) =>
        s.current ? { ...s, tabCount: liveCount } : s
      );
      chromeStatusBar.setData({
        name: chromeStatusInfo.name,
        marker: chromeStatusInfo.marker,
        tabIndex: (realSel < 0 ? 0 : realSel) + 1,
        tabCount: liveCount,
        inSplit: chromeStatusInfo.inSplit,
        splitOrientation: chromeStatusInfo.splitOrientation,
        splitActive: chromeStatusInfo.splitActive,
        splitPanes: chromeStatusInfo.splitPanes,
        activeStealth: selStealth,
        mode: mode,
        sessions: sessions,
        downloads: chromeStatusDownloads,
        // count -1 = no active find session (segment hidden); 0 = query with
        // no matches (red 0); >0 = live cur/count.
        find: findState && findState.count >= 0 ? findState : null,
      });
    } catch (e) {
      // a mid-collapse render must never escape
    }
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
      let percent = await core.downloadProgress(d.received, d.total);
      // 100% must only ever mean done: Firefox can report currentBytes ==
      // totalBytes a beat before finalize flips the state, which would show a
      // full bar while the file is still being written. Cap in-progress at 99;
      // the green ✓ takes over once the state becomes complete.
      if (percent >= 100 && d.state !== "complete") percent = 99;
      const speed = await core.formatSpeed(d.speed);
      out.push({ key: d.id, filename: d.filename, state: d.state, percent: percent, speed: speed });
    }
    chromeStatusDownloads = out;
    computeChromeStatus();
  }

  let downloadsPolling = false;
  async function pollDownloads(): Promise<void> {
    // Never overlap polls: a slow Downloads.sys.mjs read (large histories,
    // long-lived big downloads) must not pile up intervals that race on the
    // shared cache and corrupt the speed deltas.
    if (downloadsPolling) return;
    downloadsPolling = true;
    try {
      await updateDownloads();
      await refreshDownloadStatus();
    } catch (e) {
      // downloads are best-effort; never let a poll break the bar
    } finally {
      downloadsPolling = false;
    }
  }

  function applySessionState(state: any): void {
    try {
      state = state || {};
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
      // The background computes activeStealth at push time, which can race
      // the tab becoming SELECTED: tabs.create resolves before the selection
      // flips, so a push right after ;N can carry activeStealth=false for a
      // just-opened stealth tab, and the TabSelect fallback already ran with
      // the PREVIOUS reply's flags (no stealth tab yet). The flags are keyed
      // by raw tab index and the selection is live here, so re-derive the
      // badge from flags + current selection — always correct, never stale.
      try {
        const sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
        if (sel >= 0 && chromeStatusStealthFlags[sel]) {
          chromeStatusInfo.activeStealth = true;
        } else {
          chromeStatusInfo.activeStealth = !!chromeStatusInfo.activeStealth;
        }
      } catch (e) {
        // selection not readable mid-collapse; keep the pushed value
      }
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
    setContentLeader: (index, active) => {
      contentLeaderByIndex[index] = active;
      computeChromeStatus();
    },
    contentLeaderActive: (index) => !!contentLeaderByIndex[index],
    setContentFind: (index, count, cur) => {
      contentFindByIndex[index] = { count: count, cur: cur };
      computeChromeStatus();
    },
    mounted: () => chromeStatusBar.mounted,
    dlActive: () =>
      chromeStatusDownloads.map(
        (d) => d.filename + "|" + d.state + (d.percent >= 0 ? "|" + d.percent : "")
      ),
  };
}
