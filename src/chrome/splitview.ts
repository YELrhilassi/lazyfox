// Native split view (Firefox 149+). Firefox ships a native split view (two
// real tabs side-by-side). It has no extension API yet (bug 2016928 — only a
// WECG proposal), but this chrome helper runs privileged and can drive it
// through gBrowser.addTabSplitView. When available it is strictly better than
// the iframe split: each pane is a real top-level tab, so no site can block
// embedding and both panes keep full focus/history/zoom state.
//
// This module owns every split operation (create, add-a-tab, unsplit, switch
// pane, swap panes, restore) plus the transient-tab helpers (split panel +
// #lfc= request channel) that keep tab numbering stable. It is pure chrome:
// it reports results as booleans and lets the caller decide the toast.

export interface SplitViewDeps {
  // Resolves the extension's moz-extension:// base URL (for the split panel).
  ccBaseUrl(): string | null;
  // Called whenever the split state may have changed so the caller can
  // re-evaluate the window-level status bar.
  onSplitChange(): void;
}

export interface SplitView {
  isSplitPanelTab(tab: any): boolean;
  isTransientTab(tab: any): boolean;
  // Real (user) tabs in strip order — the stable 1-9 identity space.
  realTabs(): any[];
  splitCurrentTab(orientation: "horizontal" | "vertical"): boolean;
  addTabToSplitByIndex(n: number): boolean;
  unsplit(): boolean;
  switchPane(dir: number): boolean;
  swapPane(dir: number): boolean;
  restoreSplits(json: string): void;
  activeSplitView(): any;
  rememberSplit(): void;
}

export function createSplitView(deps: SplitViewDeps): SplitView {
  // The split-panel companion pane (search/URL + move-a-tab list) is pure UI:
  // it must never accumulate as stray tabs or be offered as a move target.
  // Tabs we created as panels are tracked by reference because the panel's
  // currentURI is still about:blank for a moment after creation (the
  // splitpanel.html document has not committed yet).
  const createdPanelTabs = new Set<any>();

  // The split view wrapper the user last interacted with, so `;+` (move the
  // selected tab into the split) works even while the selected tab itself is
  // outside the split. gBrowser.activeSplitView covers the same case on newer
  // Firefox; this fallback guards older 149/150 builds where it was not yet
  // exposed. The wrapper is a DOM element, so isConnected detects unsplits.
  let lastNativeSplit: any = null;

  function nativeSplitAvailable(): boolean {
    try {
      if (typeof window.gBrowser.addTabSplitView !== "function") return false;
      let on = false;
      try {
        on = Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false);
      } catch (e) {
        on = false;
      }
      if (!on) {
        // The feature flag is not set in this profile (only the test profile
        // sets it via user.js). The chrome helper is privileged: enable it so
        // the split view works everywhere Firefox ships it.
        try {
          Services.prefs.setBoolPref("browser.tabs.splitView.enabled", true);
          on = true;
        } catch (e) {
          return false;
        }
      }
      return on;
    } catch (e) {
      return false;
    }
  }

  function isSplitPanelTab(tab: any): boolean {
    if (tab && createdPanelTabs.has(tab)) return true;
    try {
      const spec =
        tab && tab.linkedBrowser && tab.linkedBrowser.currentURI
          ? tab.linkedBrowser.currentURI.spec
          : "";
      return spec.indexOf("splitpanel.html") !== -1;
    } catch (e) {
      return false;
    }
  }

  // Transient tabs (the split panel + the #lfc= request channel) are not
  // user tabs: they are hidden from numbering so a tab's 1-9 identity never
  // changes just because a split/unsplit added or removed a companion pane.
  function isTransientTab(tab: any): boolean {
    try {
      if (isSplitPanelTab(tab)) return true;
      const spec =
        tab && tab.linkedBrowser && tab.linkedBrowser.currentURI
          ? tab.linkedBrowser.currentURI.spec
          : "";
      return spec.indexOf("#lfc=") !== -1;
    } catch (e) {
      return false;
    }
  }

  // Real (user) tabs in strip order — the stable 1-9 identity space.
  function realTabs(): any[] {
    const out: any[] = [];
    for (const t of window.gBrowser.tabs) {
      if (t && !isTransientTab(t)) out.push(t);
    }
    return out;
  }

  function rememberSplit(): void {
    try {
      const sv = activeSplitView();
      if (sv) lastNativeSplit = sv;
      else if (lastNativeSplit && lastNativeSplit.isConnected === false) lastNativeSplit = null;
    } catch (e) {
      // ignore
    }
    // A split appearing or dissolving flips whether the window-level status
    // bar owns the bottom of the window, so re-evaluate it right away instead
    // of waiting for the next TabSelect / location change.
    deps.onSplitChange();
  }

  function activeSplitView(): any {
    try {
      const tab = window.gBrowser.selectedTab;
      if (tab && tab.splitview) return tab.splitview;
      try {
        if (window.gBrowser.activeSplitView) return window.gBrowser.activeSplitView;
      } catch (e) {
        // not exposed on this build
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function splitCurrentTab(orientation: "horizontal" | "vertical"): boolean {
    if (orientation !== "horizontal") return false; // native is side-by-side only
    try {
      if (!nativeSplitAvailable()) return false;
      const active = window.gBrowser.selectedTab;
      if (!active || active.pinned) return false;
      // A stale .splitview reference can linger after an unsplit on some
      // builds; dissolve it first so ;| on the very same tab works again
      // instead of failing with a spurious "needs Firefox 149+" toast.
      if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
        try {
          active.splitview.unsplitTabs();
        } catch (e) {
          // ignore
        }
      }
      const base = deps.ccBaseUrl();
      const splitPanelUrl = base ? base + "splitpanel.html" : "about:blank";
      const activePos = window.gBrowser.tabs.indexOf(active);
      // Reuse a leftover split-panel tab (not in a split) instead of always
      // creating a new pane: it keeps the strip from accumulating panels.
      let blank: any = null;
      for (const t of window.gBrowser.tabs) {
        if (t && !t.pinned && !t.splitview && isSplitPanelTab(t)) {
          blank = t;
          break;
        }
      }
      if (!blank) {
        blank = window.gBrowser.addTab(splitPanelUrl, {
          // Keep the original tab selected: the pane the user was looking at
          // stays the active pane of the new split view. The new pane lands on
          // the split panel (search/URL + move-a-tab list) instead of a blank
          // page.
          inBackground: true,
          skipAnimation: true,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        createdPanelTabs.add(blank);
      } else {
        createdPanelTabs.add(blank);
      }
      // Park the panel immediately after the active tab so the pair is already
      // adjacent: gBrowser.addTabSplitView otherwise regroups the two tabs
      // (moving the pair to the end) and reshuffles every tab between them.
      try {
        const want = window.gBrowser.tabs.indexOf(active) + 1;
        const at = window.gBrowser.tabs.indexOf(blank);
        if (at !== want) window.gBrowser.moveTabTo(blank, { tabIndex: want });
      } catch (e) {
        // ignore
      }
      try {
        window.gBrowser.addTabSplitView([active, blank]);
      } catch (e) {
        // First attempt can fail with stale internal split state; dissolve the
        // active tab's split group and retry once.
        try {
          if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
            active.splitview.unsplitTabs();
          }
        } catch (e2) {
          // ignore
        }
        window.gBrowser.addTabSplitView([active, blank]);
      }
      // addTabSplitView may still regroup the pair (moving it to the end); pin
      // the active tab — and its partner, which travels with it — back to its
      // original slot so the strip order stays stable.
      try {
        const now = window.gBrowser.tabs.indexOf(active);
        if (now !== activePos && activePos >= 0) {
          window.gBrowser.moveTabTo(active, { tabIndex: activePos });
        }
      } catch (e) {
        // ignore
      }
      rememberSplit();
      return true;
    } catch (e) {
      return false;
    }
  }

  function addTabToSplit(): boolean {
    try {
      if (!nativeSplitAvailable()) return false;
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      if (!sv) return false;
      const tab = window.gBrowser.selectedTab;
      if (!tab || tab.pinned) return false;
      if (tab.splitview === sv) return true; // already in this split
      if (typeof sv.addTabs !== "function") return false;
      sv.addTabs([tab]);
      rememberSplit();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Drop the split-panel companion pane(s) from a split view — they are pure
  // UI ("move a tab into this split") and must not pile up as panes once a
  // real tab has been moved in or the split is dissolved.
  function removePanelPanes(sv: any): void {
    const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
    for (const p of panes) {
      try {
        if (!p || p.closing) continue;
        if (isSplitPanelTab(p)) {
          createdPanelTabs.delete(p);
          window.gBrowser.removeTab(p);
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // Move tab number `n` (1-based position among REAL tabs, ;+1-9) into the
  // active split view. Numbering skips the split-panel companion, so a tab's
  // number is stable: splitting/unsplitting never shifts it.
  //
  // When no split exists yet, the active tab is split DIRECTLY with tab n —
  // no companion panel pane, so auto-splitting never leaves an empty pane
  // behind. When a split exists with a panel companion, the moved tab
  // REPLACES the panel instead of stacking a third pane (the panel is added
  // first, so the split never drops below two panes and auto-unsplits).
  function addTabToSplitByIndex(n: number): boolean {
    try {
      if (!nativeSplitAvailable()) return false;
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      const tab = realTabs()[n - 1];
      if (!tab || tab.pinned) return false;
      if (!sv) {
        // Auto-split: pair the active tab with tab N directly.
        const active = window.gBrowser.selectedTab;
        if (!active || active.pinned || active === tab) return false;
        // A stale .splitview reference can linger after an unsplit; dissolve
        // it first so the auto-split succeeds instead of failing.
        if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
          try {
            active.splitview.unsplitTabs();
          } catch (e) {
            // ignore
          }
        }
        window.gBrowser.addTabSplitView([active, tab]);
        rememberSplit();
        return true;
      }
      if (tab.splitview === sv) return true; // already in this split
      // A dissolved split can leave a stale .splitview reference on the tab
      // (a known Firefox quirk after unsplit); Firefox's addTabs then refuses
      // the tab and the move silently fails. Dissolve any leftover reference
      // first — it is a different (disconnected) view, so this only clears
      // the stale state.
      if (tab.splitview && tab.splitview !== sv) {
        try {
          const stale = tab.splitview;
          if (typeof stale.unsplitTabs === "function") stale.unsplitTabs();
          else if (stale.isConnected === false) stale.unsplitTabs?.();
        } catch (e) {
          // ignore — the view is already gone
        }
      }
      if (typeof sv.addTabs !== "function") return false;
      sv.addTabs([tab]);
      removePanelPanes(sv);
      rememberSplit();
      return true;
    } catch (e) {
      return false;
    }
  }

  function unsplit(): boolean {
    try {
      const sv = activeSplitView();
      if (!sv || typeof sv.unsplitTabs !== "function") return false;
      const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      sv.unsplitTabs();
      // The companion split-panel pane is pure UI: close it once the split
      // dissolves so it never piles up as a stray tab. A pane the user
      // navigated to real content is kept.
      for (const p of panes) {
        try {
          if (!p || p.closing) continue;
          if (isSplitPanelTab(p)) {
            createdPanelTabs.delete(p);
            window.gBrowser.removeTab(p);
          }
        } catch (e) {
          // ignore
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function switchPane(dir: number): boolean {
    try {
      const sv = activeSplitView();
      if (sv && Array.isArray(sv.tabs) && sv.tabs.length > 1) {
        const active = window.gBrowser.selectedTab;
        const idx = sv.tabs.indexOf(active);
        const next =
          sv.tabs[(idx + (dir > 0 ? 1 : -1) + sv.tabs.length) % sv.tabs.length];
        if (next) {
          window.gBrowser.selectedTab = next;
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Swap the split panes around (tmux swap-pane): ;{ moves the active pane
  // left, ;} moves it right. Firefox's native split view ships reverseTabs,
  // but on splits formed via addTabs (the panel path) it leaves the tabs API
  // in a bad state (splitViewId queries start resolving undefined), and
  // moveTabTo keeps split pairs glued together — so the swap dissolves the
  // pair and re-splits it with the pane order flipped. The pane layout
  // follows the array passed to addTabSplitView, so no tab moves are needed.
  function swapPane(dir: number): boolean {
    try {
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      if (!sv || !Array.isArray(sv.tabs) || sv.tabs.length < 2) return false;
      const active = window.gBrowser.selectedTab;
      const idx = sv.tabs.indexOf(active);
      if (idx < 0) return false;
      const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      if (panes.length === 2) {
        // Two panes: swapping either direction reverses them.
        panes.reverse();
      } else {
        panes.splice(idx, 1);
        const ni = (idx + (dir > 0 ? 1 : -1) + panes.length) % panes.length;
        panes.splice(ni, 0, active);
      }
      if (typeof sv.unsplitTabs !== "function") return false;
      sv.unsplitTabs();
      if (typeof window.gBrowser.addTabSplitView === "function") {
        window.gBrowser.addTabSplitView(panes);
      }
      window.gBrowser.selectedTab = active;
      rememberSplit();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Re-create saved split groupings after a session restore. `json` is JSON
  // of [[index, ...], ...] with 1-based positions over the SAVED tab list —
  // which restore recreates exactly as the window's real (non-transient) tabs
  // in order. Positions must be resolved against realTabs() (which skips the
  // splitpanel companion and the #lfc= request channel): indexing
  // window.gBrowser.tabs directly would be shifted by those transient tabs
  // (and any pinned tabs the restore left in front), pairing the wrong tabs
  // or none at all.
  function restoreSplits(json: string): void {
    try {
      const groups = JSON.parse(json) as number[][];
      // Resolve the 1-based saved positions against non-pinned real tabs.
      // A restore re-opens saved tabs in order as unpinned tabs AFTER any
      // pinned tabs left in front, so pinned tabs must not offset the
      // positions (split view never involves pinned tabs).
      const real = realTabs().filter((t: any) => !t.pinned);
      for (const g of groups) {
        const tabs = (g || []).map((i) => real[i - 1]).filter((t: any) => !!t);
        if (tabs.length > 1 && typeof window.gBrowser.addTabSplitView === "function") {
          window.gBrowser.addTabSplitView(tabs);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return {
    isSplitPanelTab,
    isTransientTab,
    realTabs,
    splitCurrentTab,
    addTabToSplitByIndex,
    unsplit,
    switchPane,
    swapPane,
    restoreSplits,
    activeSplitView,
    rememberSplit,
  };
}
