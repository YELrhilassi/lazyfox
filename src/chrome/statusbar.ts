// The window-level status bar. This module is the ONLY owner of the bar's
// lifecycle and the ONLY consumer of the bar's render model: it mounts the
// single StatusBar view into the browser document, pushes every raw event
// into the Go status store (the single source of truth — see core/status.go),
// and paints whatever the store's snapshot says. It holds no bar state of its
// own; `lastSnap` below is a read-only mirror of the Go snapshot kept only so
// synchronous consumers (the tab switcher, the debug relay, the TabSelect
// stealth badge) can read without crossing the async wasm boundary. Nothing
// else renders a bar, and nothing else may hold bar state.
//
// The content script never renders a bar: when the chrome layer is alive it
// owns the single window-level bar for every tab; when it is absent (stand-
// alone extension mode) there is simply no bar.

import { core, type StatusOp } from "../shared/core";
import { StatusBar, leaderSignalOn, type StatusBarData } from "../shared/statusbar";
import { updateDownloads } from "./downloads";
import type { ChromeCfg } from "./config";

export interface StatusBarDeps {
  // Real (user) tabs in strip order (splitview.realTabs) — the live count.
  realTabs(): any[];
  getConfig(): ChromeCfg;
  // Raw chrome-side UI signals that decide the bar's mode: whether a popup is
  // open and whether the chrome helper's own leader is armed. The content
  // leader on web pages is tracked per tab-strip index (setContentLeader).
  getUi(): { popup: boolean; leader: boolean };
}

export interface StatusBarCtl {
  update(): void;
  compute(): void;
  refreshDownloads(): Promise<void>;
  pollDownloads(): Promise<void>;
  // Apply a sessionState reply from the background (the parsed state object,
  // delivered structured-cloned over the relay) — pushed into the Go store.
  applySessionState(state: any): void;
  // True while a page element is in DOM fullscreen (a video, a gallery
  // lightbox, ...). Only then does the bar hide: browser-level fullscreen
  // (zen mode, F11) keeps the bar visible.
  isFullscreen(): boolean;
  getTabIds(): number[];
  getStealthFlags(): boolean[];
  // The stealth badge must track the tab you switched to immediately (without
  // a sessionState round-trip), so the caller sets it locally and it is
  // pushed into the store.
  setActiveStealth(on: boolean): void;
  // Content-script leader state by tab-strip index (pushed by the background
  // on every arm/disarm). The window-level bar shows the LEADER chevron on
  // web pages — where the content script owns the leader key and the chrome
  // helper's own leader never arms — by resolving this per-index state in the
  // Go store against the current selection.
  setContentLeader(index: number, active: boolean): void;
  // The far-right leader indicator for this context's own leader. Paints
  // synchronously (see shared/statusbar.ts) so it tracks the keypress exactly.
  setLeaderSignal(armed: boolean): void;
  // Content-script find-in-page state by tab-strip index (pushed by the
  // background on every count change). Same resolution as the leader chevron.
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
  // The leader prefix typed so far in the current sequence ("" when idle,
  // ";" after a bare leader press, "l" after `;l`). Set by the composition
  // root whenever the leader arms, shows a key, or disarms.
  let leaderPrefix = "";
  // The content script's leader state, as last pushed by the background, plus
  // the tab-strip index it belongs to. Mirrors the store so the indicator can
  // be repainted synchronously (the store roundtrip is too slow for a keypress).
  let contentLeaderIndex = -1;
  let contentLeaderArmed = false;
  // The selected tab's RAW strip index. This is the coordinate the background
  // pushes content-leader state in (sender.tab.index) and the one the Go store
  // resolves leaderByIndex against — NOT the real-tab index, which counts only
  // visible tabs and would disagree whenever plumbing tabs exist.
  function selectedStripIndex(): number {
    try {
      return window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
    } catch (e) {
      return -1;
    }
  }
  // Clicking a download notification on the bar dismisses just that one (the
  // popup list keeps it). Dismissal is store state — the Go store owns it.
  chromeStatusBar.setDownloadDismiss((key) => {
    void core.statusDismiss(key != null ? [key] : []).then(() => refreshDownloads());
  });

  // Read-only mirror of the Go store's snapshot, updated only in paint(). The
  // bar's authoritative state lives in Go; this exists for synchronous reads.
  let lastSnap: StatusBarData | null = null;

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

  // Pull the store's render model and paint it through the single view. Also
  // decides show/hide from config + fullscreen, so a mid-render fullscreen
  // transition can never leave the bar over full-screen content.
  async function paint(): Promise<void> {
    try {
      paintSnapshot(await core.statusSnapshot());
    } catch (e) {
      // a mid-collapse render must never escape
    }
  }

  // Paint an already-read snapshot. Split out of paint() so the batch path can
  // hand over the snapshot it just read instead of reading it a second time.
  function paintSnapshot(snap: StatusBarData): void {
    try {
      lastSnap = snap;
      const cfg = deps.getConfig();
      if (cfg.config.statusBar === false || isFullscreen()) {
        chromeStatusBar.hide();
        return;
      }
      chromeStatusBar.setPosition(cfg.config.statusBarPosition || "bottom");
      chromeStatusBar.show();
      chromeStatusBar.setData(snap);
    } catch (e) {
      // a mid-collapse render must never escape
    }
  }

  // Push several store updates and repaint, atomically.
  //
  // This used to take an array of promises, Promise.all them, and then call
  // paint() — which reads the snapshot back. That is five microtask hops
  // between a keystroke and a repaint, on a path that runs on every TabSelect
  // and every leader key, and it is worse than slow: each of those hops is an
  // await boundary, so two concurrent pushes could interleave and one paint
  // could read a snapshot where the other's updates had half landed. The store
  // is the single source of truth precisely so that cannot happen, and the
  // composition was quietly breaking that guarantee.
  //
  // statusBatch applies the whole batch synchronously against the resolved core
  // and returns the snapshot from the same call, so there is no window in
  // which another writer can slip in.
  function pushAndPaint(ops: StatusOp[]): void {
    void core
      .statusBatch(ops)
      .then((snap) => paintSnapshot(snap))
      .catch(() => {});
  }

  function update(): void {
    // Show/hide + position only (data re-renders via compute/paint). The
    // chrome helper owns the single bar for every page, so it always shows
    // unless disabled or in DOM fullscreen.
    const cfg = deps.getConfig();
    if (cfg.config.statusBar === false || isFullscreen()) {
      chromeStatusBar.hide();
      return;
    }
    chromeStatusBar.setPosition(cfg.config.statusBarPosition || "bottom");
    chromeStatusBar.show();
  }

  // Push the live chrome-side signals (selection, mode inputs, stealth badge)
  // and re-render. Never throws: the leader's status callback runs this MID
  // key dispatch (a ;| split collapses the window while the bar re-renders),
  // so a dead tab or a half-torn-down window must degrade to best-effort.
  function compute(): void {
    // The raw strip index, read defensively and SEPARATELY. It is the one
    // volatile input the leader indicator needs, and it is exactly what throws
    // when the window is mid-collapse — so it gets its own guarded read that
    // falls back to -1 ("selection not readable"), which leaderSignalOn
    // already handles by falling back to the other signals. Reading it here
    // rather than inside the batch try/catch below is what lets the indicator
    // still be repainted when the rest of the batch gives up.
    let sel = -1;
    try {
      sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
    } catch (e) {
      // mid-collapse; -1 is the documented "unreadable" coordinate
    }
    try {
      const real = deps.realTabs();
      const liveCount = real.length;
      const realSel = real.indexOf(window.gBrowser.selectedTab);
      const ui = deps.getUi();
      // The stealth badge is a LIVE property of the selected tab (its
      // container), never a cached flag: flags keyed by raw tab index go stale
      // the moment a tab closes. userContextId > 0 = isolated container.
      let selStealth = false;
      try {
        const t = window.gBrowser.selectedTab;
        selStealth = !!(
          t && typeof t.userContextId === "number" && t.userContextId > 0
        );
      } catch (e) {
        // selection not readable mid-collapse; keep the pushed value
        selStealth = !!(lastSnap && lastSnap.activeStealth);
      }
      pushAndPaint([
        { kind: "tab", selected: sel, tabIndex: (realSel < 0 ? 0 : realSel) + 1, tabCount: liveCount },
        { kind: "ui", popup: ui.popup, leader: ui.leader },
        { kind: "stealth", on: selStealth },
      ]);
    } catch (e) {
      // ignore — mid-collapse reads can throw. The leader indicator below is
      // deliberately OUTSIDE this guard: it is the one signal the user reads
      // as "did my key land", so a stale value here is the exact bug it
      // exists to prevent.
    }
    // The far-right indicator rides OUTSIDE the store batch: it is painted
    // directly on the view so a `;` press lights it with zero async hops, and
    // it is repainted even when the batch above could not run.
    // The decision (including the raw-strip-index rule) lives in
    // shared/statusbar.ts and is unit-tested there.
    try {
      const on = leaderSignalOn({
        prefix: leaderPrefix,
        uiLeader: deps.getUi().leader,
        contentArmed: contentLeaderArmed,
        contentIndex: contentLeaderIndex,
        // `sel` is the raw strip index, the same coordinate
        // contentLeaderIndex is pushed in.
        selectedStrip: sel,
      });
      // Same reason as setLeaderSignal: write the store in the same tick, so
      // the snapshot this repaint is about to produce already agrees with it.
      try {
        core.statusLeaderSignal(on, leaderPrefix);
      } catch (e) {
        // ignore
      }
      chromeStatusBar.setLeaderSignal(on);
    } catch (e) {
      // ignore — a dead view must not break key dispatch
    }
  }

  function refreshDownloads(): Promise<void> {
    return paint();
  }

  let downloadsPolling = false;
  async function pollDownloads(): Promise<void> {
    // Never overlap polls: a slow Downloads.sys.mjs read (large histories,
    // long-lived big downloads) must not pile up intervals that race the
    // store. updateDownloads pushes the fresh snapshot into Go, which owns
    // the merge, dismissed flags and speed.
    if (downloadsPolling) return;
    downloadsPolling = true;
    try {
      await updateDownloads();
      await paint();
    } catch (e) {
      // downloads are best-effort; never let a poll break the bar
    } finally {
      downloadsPolling = false;
    }
  }

  function applySessionState(state: any): void {
    try {
      state = state || {};
      const ui = deps.getUi();
      pushAndPaint([
        { kind: "session", state: {
          name: state.name ? String(state.name) : "default",
          marker: state.marker ? Number(state.marker) : 0,
          inSplit: !!state.inSplit,
          splitOrientation:
            state.splitOrientation === "vertical" ? "vertical" : "horizontal",
          splitActive: typeof state.splitActive === "number" ? state.splitActive : 0,
          splitPanes: typeof state.splitPanes === "number" ? state.splitPanes : 0,
          sessions: Array.isArray(state.sessions) ? state.sessions : [],
          tabIds: Array.isArray(state.tabIds) ? state.tabIds : [],
          stealthFlags: Array.isArray(state.stealthFlags) ? state.stealthFlags : [],
        } },
        // Re-derive the stealth badge from the fresh flags + current selection
        // (the background's activeStealth can race the tab becoming selected).
        {
          kind: "stealth",
          on: (() => {
            try {
              const sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
              return sel >= 0 && !!(state.stealthFlags && state.stealthFlags[sel]);
            } catch (e) {
              return !!(lastSnap && lastSnap.activeStealth);
            }
          })(),
        },
        { kind: "ui", popup: ui.popup, leader: ui.leader },
      ]);
    } catch (e) {
      // ignore
    }
  }

  return {
    update,
    compute,
    refreshDownloads,
    pollDownloads,
    applySessionState,
    isFullscreen,
    getTabIds: () => (lastSnap && lastSnap.tabIds ? lastSnap.tabIds.slice() : []),
    getStealthFlags: () =>
      lastSnap && lastSnap.stealthFlags ? lastSnap.stealthFlags.slice() : [],
    setActiveStealth: (on) => {
      pushAndPaint([{ kind: "stealth", on }]);
    },
    setContentLeader: (index, active) => {
      // Keep the store authoritative (it resolves which index is selected),
      // but light the indicator the moment the state arrives. On a web page
      // the content script owns the leader and this push has already crossed
      // content -> background -> relay tab -> here, so routing the *pixel*
      // through the Go batch as well left the chevron visibly trailing the key
      // press. Paint directly for the selected tab; the batch repaint that
      // follows just confirms the same decision.
      contentLeaderIndex = index;
      contentLeaderArmed = !!active;
      if (index === selectedStripIndex()) {
        // Keep the store's own leader state in step with the direct paint
        // (see setLeaderSignal): a later store repaint must not be able to
        // resurrect the value this push just replaced.
        try {
          core.statusLeaderSignal(!!active, "");
        } catch (e) {
          // ignore
        }
        chromeStatusBar.setLeaderSignal(!!active);
      }
      pushAndPaint([{ kind: "leader", index, active }]);
    },
    // The far-right indicator for the chrome helper's OWN leader. Painted
    // synchronously on the view — the store roundtrip would trail the key
    // press by several await hops and land visibly late.
    //
    // The synchronous core write is what keeps that fast path HONEST. Painting
    // only the view left the Go store holding the previous value, and the next
    // store repaint (any TabSelect, any poll) re-read that stale state and lit
    // the chevron again — so a `;` press followed by Esc could leave the
    // indicator on forever, which is exactly the "out of sync with the key"
    // symptom. `statusLeaderSignal` returns void, so it lands in the same tick
    // as the keypress: the store is authoritative, the view just follows it
    // immediately instead of waiting for the round trip.
    setLeaderSignal: (armed) => {
      leaderPrefix = armed ? ";" : "";
      try {
        core.statusLeaderSignal(armed, leaderPrefix);
      } catch (e) {
        // a wasm that is not up yet must not break key dispatch
      }
      chromeStatusBar.setLeaderSignal(armed);
    },
    setContentFind: (index, count, cur) => {
      pushAndPaint([{ kind: "find", index, cur, count }]);
    },
    mounted: () => chromeStatusBar.mounted,
    dlActive: () =>
      (lastSnap && lastSnap.downloads
        ? lastSnap.downloads.map(
            (d) => d.filename + "|" + d.state + (d.percent >= 0 ? "|" + d.percent : "")
          )
        : []),
    getInfo: () =>
      lastSnap
        ? {
            name: lastSnap.name,
            marker: lastSnap.marker,
            inSplit: lastSnap.inSplit,
            splitOrientation: lastSnap.splitOrientation,
            splitActive: lastSnap.splitActive,
            splitPanes: lastSnap.splitPanes,
            activeStealth: !!lastSnap.activeStealth,
            sessions: lastSnap.sessions || [],
          }
        : {
            name: "default",
            marker: 0,
            inSplit: false,
            splitOrientation: undefined,
            splitActive: 0,
            splitPanes: 0,
            activeStealth: false,
            sessions: [],
          },
  };
}
