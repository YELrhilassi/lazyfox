// Native split view (Firefox 149+). Firefox ships a native split view (two
// real tabs side-by-side). It has no extension API yet (bug 2016928 — only a
// WECG proposal), but this chrome helper runs privileged and can drive it
// through gBrowser.addTabSplitView. When available it is strictly better than
// the iframe split: each pane is a real top-level tab, so no site can block
// embedding and both panes keep full focus/history/zoom state.
//
// This module is the OPERATIONS half and nothing else: split, add, unsplit,
// switch pane, swap panes, restore. The two things it used to also carry —
// "which tabs count as real" and "pin the strip back afterwards" — now live in
// their own modules, because they are different questions with different
// lifetimes:
//
//   splitidentity.ts  pure reads of the strip; no side effects at all
//   stripreconcile.ts the settle loop and the pin plan (Go-computed)
//   splitreadback.ts  the delayed observation that turns a trail into an
//                        outcome rather than an attempt
//   splitrestore.ts   re-forming saved splits after a session restore, which
//                        must WAIT for the strip to settle first
//   splitpanes.ts     where a pair is parked, and which panes are not real
//
// Firefox's own split machinery parks a freshly glued pair wherever it pleases
// (usually the strip end) and does so ASYNCHRONOUSLY, which is the entire
// reason the reconciler exists. The ordering math (coalesce + pin plan) is in
// the Go core (core/strip.go); only the browser glue is here.
//
// Transient tabs (the split panel + the throwaway #lfc= request relays) are
// hidden from numbering so a tab's 1-9 identity never changes just because a
// split/unsplit added or removed a companion pane — but a REAL tab carrying a
// momentary #lfc=keys/state request hash is never treated as transient, so
// mid-request numbering never shifts.

import type { ChromeTab, SplitViewWrapper } from "./tabs";
import type { ChromeEnv } from "./env";
import { createTabIdentity } from "./splitidentity";
import { createStripReconciler } from "./stripreconcile";
import { createSplitReadback } from "./splitreadback";
import { createSplitRestorer } from "./splitrestore";
import { removeSplitPanelPanes, splitInsertOpt as splitInsertOptFor } from "./splitpanes";

export interface SplitViewDeps {
  env: ChromeEnv;
  // Resolves the extension's moz-extension:// base URL (for the split panel).
  ccBaseUrl(): string | null;
  // Called whenever the split state may have changed so the caller can
  // re-evaluate the window-level status bar.
  onSplitChange(): void;
  // Diagnostic hook for the `;W m` move path (surfaced in the #lfc=state reply
  // so the e2e harness can assert WHY a move failed instead of guessing).
  onMove?(msg: string): void;
  // Clears the recorded move trail. One move's trail must not inherit the
  // previous one's: a stale line from an earlier operation is worse than no
  // line at all, because it reads as evidence about a move that never ran.
  onMoveReset?(): void;
  // Is this tab element the window's relay? The relay answers the URL test only
  // once relay.html has committed; before that it reports about:blank and is
  // indistinguishable from a user tab by URL alone. The channel keeps the
  // created-tab set that closes that gap, so the NUMBERING asks it rather than
  // re-deriving identity — otherwise a relay that is still settling shifts
  // every tab number after it by one, and `;4` moves the wrong tab.
  isRelayTab?(tab: ChromeTab | null | undefined): boolean;
}

export interface SplitView {
  isSplitPanelTab(tab: ChromeTab | null | undefined): boolean;
  isTransientTab(tab: ChromeTab | null | undefined): boolean;
  // Real (user) tabs in strip order — the stable 1-9 identity space.
  realTabs(): ChromeTab[];
  splitCurrentTab(orientation: "horizontal" | "vertical"): boolean;
  addTabToSplitByIndex(n: number): boolean;
  unsplit(): boolean;
  switchPane(dir: number): boolean;
  swapPane(dir: number): boolean;
  restoreSplits(groups: number[][], expect?: number): void;
  activeSplitView(): SplitViewWrapper | null;
  rememberSplit(): void;
}

export function createSplitView(deps: SplitViewDeps): SplitView {
  const env = deps.env;
  const win = env.window as any;

  const identity = createTabIdentity(env);
  // Late-bound: the channel is built after this module (it needs the popup
  // context that wraps ops), so the relay test is handed over rather than
  // captured at construction time.
  identity.setRelayTest((t) => !!(deps.isRelayTab && deps.isRelayTab(t)));

  const {
    idOf,
    tabUrl,
    rawUrl,
    stripSnapshot,
    realTabs,
    isSplitPanelTab,
    isTransientTab,
    activeSplitView: identityActiveSplitView,
    nativeSplitAvailable,
  } = identity;

  const reconcile = createStripReconciler({
    identity,
    presence: () => identity.stripSnapshot(),
    moveTabTo: (tab, tabIndex) => {
      win.gBrowser.moveTabTo?.(tab, { tabIndex });
    },
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
  });
  const { repinAfterSplit, coalescePairOrder, coalesceIntoGroupOrder } = reconcile;

  // The split view wrapper the user last interacted with, so `;W m` (move the
  // selected tab into the split) works even while the selected tab itself is
  // outside the split. gBrowser.activeSplitView covers the same case on newer
  // Firefox; this fallback guards older 149/150 builds where it was not yet
  // exposed. The wrapper is a DOM element, so isConnected detects unsplits.
  let lastNativeSplit: SplitViewWrapper | null = null;

  function activeSplitView(): SplitViewWrapper | null {
    return identityActiveSplitView();
  }

  function rememberSplit(): void {
    try {
      const sv = activeSplitView();
      if (sv) lastNativeSplit = sv;
      else if (lastNativeSplit && lastNativeSplit.isConnected === false) lastNativeSplit = null;
    } catch (e) {
      // ignore
    }
    // A split appearing or dissolving flips whether the window-level status bar
    // owns the bottom of the window, so re-evaluate it right away instead of
    // waiting for the next TabSelect / location change.
    deps.onSplitChange();
  }

  // The delayed observation every move ends with. Split out to splitreadback.ts
  // because the passes, the intervals and what each one waits for are one
  // decision, made once.
  const readbackSplit = createSplitReadback({
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
    stripIndexOf: (tab) => win.gBrowser.tabs.indexOf(tab),
    activeSplitView,
    lastSplit: () => lastNativeSplit,
    idOf,
    tabUrl,
  });
  // Both are in splitpanes.ts: every split operation undoes the same two
  // measured Firefox behaviours (parking at the strip end, asynchronously),
  // and four inline copies is how one of them grew a different one.
  const splitInsertOpt = (pair: ChromeTab[]): { insertBefore?: ChromeTab } =>
    splitInsertOptFor(pair, win.gBrowser.tabs);

  const removePanelPanes = (sv: SplitViewWrapper): void =>
    removeSplitPanelPanes(sv, isSplitPanelTab, (t) => win.gBrowser.removeTab(t));
  function splitCurrentTab(orientation: "horizontal" | "vertical"): boolean {
    if (orientation !== "horizontal") return false; // native is side-by-side only
    try {
      if (!nativeSplitAvailable()) return false;
      const active = win.gBrowser.selectedTab;
      if (!active || active.pinned) return false;
      // A stale .splitview reference can linger after an unsplit on some
      // builds; dissolve it first so `;|` on the very same tab works again
      // instead of failing with a spurious "needs Firefox 149+" toast.
      if (typeof active.splitview?.unsplitTabs === "function") {
        try {
          active.splitview.unsplitTabs();
        } catch (e) {
          // ignore
        }
      }
      const base = deps.ccBaseUrl();
      const splitPanelUrl = base ? base + "splitpanel.html" : "about:blank";
      // Reuse a leftover split-panel tab (not in a split) instead of always
      // creating a new pane: it keeps the strip from accumulating panels.
      let blank: ChromeTab | undefined;
      for (const t of win.gBrowser.tabs) {
        if (t && !t.pinned && !t.splitview && isSplitPanelTab(t)) {
          blank = t;
          break;
        }
      }
      if (!blank) {
        blank = win.gBrowser.addTab(splitPanelUrl, {
          // Keep the original tab selected: the pane the user was looking at
          // stays the active pane of the new split view. The new pane lands on
          // the split panel (search/URL + move-a-tab list) instead of a blank
          // page.
          inBackground: true,
          skipAnimation: true,
          triggeringPrincipal: env.services.scriptSecurityManager.getSystemPrincipal(),
        });
        identity.markPanelTab(blank);
      } else {
        identity.markPanelTab(blank);
      }
      // Park the split on the tab and the panel, keeping the strip order that
      // existed before the panel appeared: addTabSplitView otherwise regroups
      // the two tabs (moving the pair to the end) and shuffles every tab
      // between the pair and the strip end. The snapshot is taken AFTER the
      // park so the pair is contiguous in the desired order (the panel sits
      // right after the active tab) — a desired order with the panes apart
      // would make the pin treat them as singles and re-glue the pair.
      try {
        const want = win.gBrowser.tabs.indexOf(active) + 1;
        const at = win.gBrowser.tabs.indexOf(blank);
        if (at !== want) win.gBrowser.moveTabTo(blank, { tabIndex: want });
      } catch (e) {
        // ignore
      }
      const preStrip = stripSnapshot();
      try {
        // nativeSplitAvailable() already established the method exists; the
        // optional call is so the type reflects the version gate.
        win.gBrowser.addTabSplitView?.([active, blank], splitInsertOpt([active, blank]));
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
        win.gBrowser.addTabSplitView?.([active, blank], splitInsertOpt([active, blank]));
      }
      // addTabSplitView may still regroup the pair (moving it to the end); pin
      // the whole strip back to its pre-split order so the pairing lands where
      // it was left and nothing else changes its 1-9 numbering.
      repinAfterSplit(preStrip);
      rememberSplit();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Move tab number `n` (1-based position among REAL tabs, `;W m` then a digit)
  // into the active split view. Numbering skips the split-panel companion, so
  // a tab's number is stable: splitting/unsplitting never shifts it.
  //
  // When no split exists yet, the active tab is split DIRECTLY with tab n — no
  // companion panel pane, so auto-splitting never leaves an empty pane behind.
  // When a split exists with a panel companion, the moved tab REPLACES the
  // panel instead of stacking a third pane (the panel is added first, so the
  // split never drops below two panes and auto-unsplits).
  function addTabToSplitByIndex(n: number): boolean {
    // Each move owns its trail, so what a reader sees describes the move they
    // are looking at and nothing else.
    try {
      deps.onMoveReset && deps.onMoveReset();
    } catch (e) {
      /* ignore */
    }
    const mv = (msg: string) => {
      try {
        deps.onMove && deps.onMove(msg);
      } catch (e) {
        /* ignore */
      }
    };
    try {
      if (!nativeSplitAvailable()) {
        mv("nativeSplitAvailable=false");
        return false;
      }
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      const tab = realTabs()[n - 1];
      // The resolved tab's URL belongs in the trail: "n=4 landed on a tab that
      // already had a splitview" is an unreadable bug report without it, and
      // the whole question here is WHICH tab the number named.
      mv(
        "n=" +
          n +
          " -> " +
          tabUrl(tab) +
          " sv=" +
          (sv ? "yes" : "no") +
          " tab=" +
          (tab ? "yes" : "no") +
          " tabPinned=" +
          (tab && tab.pinned) +
          " addTabsFn=" +
          (sv ? typeof sv.addTabs : "n/a") +
          " tabSv=" +
          (tab && tab.splitview ? "yes" : "no") +
          " activeSv=" +
          (win.gBrowser.selectedTab && win.gBrowser.selectedTab.splitview ? "yes" : "no")
      );
      // The numbering itself, as the product saw it at this instant. "n=4 named
      // the wrong tab" is only diagnosable against the list the number was
      // taken from, and a strip snapshot taken seconds later is a different
      // strip.
      mv(
        "numbering=[" +
          realTabs()
            .map((t, i) => (i + 1) + ":" + tabUrl(t) + rawUrl(t))
            .join(" ") +
          "]"
      );
      if (!tab || tab.pinned) {
        mv("tab missing or pinned");
        return false;
      }
      if (!sv) {
        // Auto-split: pair the active tab with tab N directly.
        const active = win.gBrowser.selectedTab;
        if (!active || active.pinned || active === tab) {
          mv("auto: no active or active===tab");
          return false;
        }
        // A stale .splitview reference can linger after an unsplit; dissolve it
        // first so the auto-split succeeds instead of failing.
        if (typeof active.splitview?.unsplitTabs === "function") {
          try {
            active.splitview.unsplitTabs();
          } catch (e) {
            // ignore
          }
        }
        const preStrip = stripSnapshot();
        // Form the pair in the order that keeps the ACTIVE tab at its slot: if
        // the partner sat before it, split [partner, active] so the anchor
        // stays put; otherwise [active, partner]. (The pair's internal order
        // follows the array passed to addTabSplitView and cannot be changed by
        // moving the glued block.)
        const pair =
          preStrip.indexOf(tab) < preStrip.indexOf(active) ? [tab, active] : [active, tab];
        try {
          win.gBrowser.addTabSplitView?.(pair);
          mv("auto: addTabSplitView ok");
          readbackSplit(mv, tab);
        } catch (e) {
          mv("auto: addTabSplitView threw " + String(e));
          return false;
        }
        // The pair is glued somewhere addTabSplitView decided (usually the
        // strip end); pin it back so the active tab keeps its number and the
        // newcomer sits right next to it.
        repinAfterSplit(coalescePairOrder(preStrip, active, tab));
        rememberSplit();
        return true;
      }
      if (tab.splitview === sv) {
        mv("already in this split");
        return true;
      }
      // A tab can live in exactly one split view. Firefox's addTabs refuses a
      // tab that still belongs to another view — after an unsplit a stale
      // .splitview reference lingers on the tab (a known quirk), and a tab
      // genuinely in another split must leave it to be moved here. Either way
      // the old view is dissolved first.
      if (tab.splitview && tab.splitview !== sv) {
        try {
          const stale = tab.splitview;
          if (typeof stale.unsplitTabs === "function") stale.unsplitTabs();
          mv("dissolved stale tab.splitview");
        } catch (e) {
          // ignore — the view is already gone
        }
      }
      const preStrip = stripSnapshot();
      if (typeof sv.addTabs !== "function") {
        mv("sv.addTabs missing");
        return false;
      }
      try {
        mv("calling sv.addTabs([tab])");
        sv.addTabs([tab]);
        mv("addTabs returned ok; tab.splitview=" + (tab.splitview ? "yes" : "no"));
      } catch (e) {
        mv("addTabs threw " + String(e));
        return false;
      }
      readbackSplit(mv, tab);
      removePanelPanes(sv);
      // Keep the strip order stable: the moved tab joins the group AND the group
      // stays where it was (only the newcomer changes its number, to sit next to
      // its new panes).
      repinAfterSplit(coalesceIntoGroupOrder(preStrip, sv, tab));
      rememberSplit();
      return true;
    } catch (e) {
      mv("outer catch " + String(e));
      return false;
    }
  }

  function unsplit(): boolean {
    try {
      const sv = activeSplitView();
      if (!sv || typeof sv.unsplitTabs !== "function") return false;
      const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      const preStrip = stripSnapshot();
      sv.unsplitTabs();
      // The companion split-panel pane is pure UI: close it once the split
      // dissolves so it never piles up as a stray tab. A pane the user
      // navigated to real content is kept.
      for (const p of panes) {
        try {
          if (!p || p.closing) continue;
          if (isSplitPanelTab(p)) win.gBrowser.removeTab(p);
        } catch (e) {
          // ignore
        }
      }
      // Unsplit releases the panes in place on most builds, but pin the strip
      // back anyway: every tab must return to the exact slot it had, so the
      // user's 1-9 mapping never changes just because a split dissolved.
      repinAfterSplit(preStrip);
      return true;
    } catch (e) {
      return false;
    }
  }

  function switchPane(dir: number): boolean {
    try {
      const sv = activeSplitView();
      if (sv && Array.isArray(sv.tabs) && sv.tabs.length > 1) {
        const active = win.gBrowser.selectedTab;
        const idx = sv.tabs.indexOf(active);
        const next =
          sv.tabs[(idx + (dir > 0 ? 1 : -1) + sv.tabs.length) % sv.tabs.length];
        if (next) {
          win.gBrowser.selectedTab = next;
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Swap the split panes around (tmux swap-pane): `;W {` moves the active pane
  // left, `;W }` right. Firefox's native split view ships reverseTabs, but on
  // splits formed via addTabs (the panel path) it leaves the tabs API in a bad
  // state (splitViewId queries start resolving undefined), and moveTabTo keeps
  // split pairs glued together — so the swap dissolves the pair and re-splits
  // it with the pane order flipped. The pane layout follows the array passed to
  // addTabSplitView, so no tab moves are needed.
  function swapPane(dir: number): boolean {
    try {
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      if (!sv || !Array.isArray(sv.tabs) || sv.tabs.length < 2) return false;
      const active = win.gBrowser.selectedTab;
      const idx = sv.tabs.indexOf(active);
      if (idx < 0) return false;
      const panes = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      const preStrip = stripSnapshot();
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
      if (typeof win.gBrowser.addTabSplitView === "function") {
        win.gBrowser.addTabSplitView(panes, splitInsertOpt(panes));
      }
      win.gBrowser.selectedTab = active;
      // The re-formed split may regroup at the strip end; pin the strip back
      // to its pre-swap order so the pane swap never moves the pair around.
      repinAfterSplit(preStrip);
      rememberSplit();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Re-forming saved splits after a session restore is in splitrestore.ts: it
  // is not a keypress path, and the wait-for-the-strip rule it depends on is
  // the one most likely to be re-broken by editing the operations next to it.
  const restoreSplits = createSplitRestorer({
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
    realTabs,
    addTabSplitView: (tabs, opts) => win.gBrowser.addTabSplitView?.(tabs, opts),
    stripSnapshot,
    insertOpt: splitInsertOpt,
    repinAfterSplit,
    rememberSplit,
    nativeSplitAvailable,
  });
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
