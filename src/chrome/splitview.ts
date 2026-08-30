// Native split view (Firefox 149+). Firefox ships a native split view (two
// real tabs side-by-side). It has no extension API yet (bug 2016928 — only a
// WECG proposal), but this chrome helper runs privileged and can drive it
// through gBrowser.addTabSplitView. When available it is strictly better than
// the iframe split: each pane is a real top-level tab, so no site can block
// embedding and both panes keep full focus/history/zoom state.
//
// This module is a thin virtualization layer over the vanilla feature: it owns
// every split operation (create, add-a-tab, unsplit, switch pane, swap panes,
// restore), the stable 1-9 tab numbering, and the strip reconciliation that
// keeps every tab exactly where it was. Firefox's own split machinery parks a
// freshly glued pair wherever it pleases (usually the strip end) and does so
// ASYNCHRONOUSLY; rather than trusting it, this module snapshots the strip
// before each operation, computes the desired order with the Go core, and
// re-pins the physical strip to it until it stops moving. The ordering math
// (coalesce + pin plan) lives in the Go core (core/strip.go, Go-tested); here
// only the browser-driving glue remains.
//
// Transient tabs (the split panel + the throwaway #lfc= request relays) are
// hidden from numbering so a tab's 1-9 identity never changes just because a
// split/unsplit added or removed a companion pane — but a REAL tab carrying a
// momentary #lfc=keys/state request hash is never treated as transient, so
// mid-request numbering never shifts.

import { coalesceIntoGroup, coalescePair, planStrip } from "../shared/order";
import { isRelayTabUrl } from "../shared/transient";

export interface SplitViewDeps {
  // Resolves the extension's moz-extension:// base URL (for the split panel).
  ccBaseUrl(): string | null;
  // Called whenever the split state may have changed so the caller can
  // re-evaluate the window-level status bar.
  onSplitChange(): void;
  // Diagnostic hook for the ;+N move path (surfaced in the #lfc=state reply
  // so the e2e harness can assert WHY a move failed instead of guessing).
  onMove?(msg: string): void;
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

  // Firefox destroys tab wrappers mid-window-collapse: a tab that is being
  // removed can still be listed in gBrowser.tabs while its wrapper is already
  // dead, and ANY property access on a dead wrapper throws "can't access dead
  // object". Every tab-iteration path must skip those (the leader's status
  // callback re-renders the bar mid-collapse, so one dead tab would throw
  // straight through the key dispatch).
  function isDeadWrapper(o: any): boolean {
    try {
      return !!(Cu && Cu.isDeadWrapper(o));
    } catch (e) {
      return false;
    }
  }

  // The split view wrapper the user last interacted with, so `;+` (move the
  // selected tab into the split) works even while the selected tab itself is
  // outside the split. gBrowser.activeSplitView covers the same case on newer
  // Firefox; this fallback guards older 149/150 builds where it was not yet
  // exposed. The wrapper is a DOM element, so isConnected detects unsplits.
  let lastNativeSplit: any = null;

  // Monotonic token for the re-pin loop. Firefox parks a freshly glued pair
  // ASYNCHRONOUSLY, so every split operation spawns a re-pin loop that keeps
  // reconciling the strip back to its pre-operation order for up to ~1.2s.
  // Two operations back-to-back (e.g. ;| then ;+N) would otherwise run two
  // loops reconciling to DIFFERENT snapshots at the same time. Each loop
  // captures the token when it starts and stops the moment a newer operation
  // supersedes it, so only the most recent operation's loop is ever live.
  let repinSeq = 0;

  // Stable id for a tab in the strip-planning id space. linkedPanel is unique
  // and stable for a tab's lifetime; browserId is the fallback for a tab whose
  // panel has not attached yet.
  function idOf(t: any): string {
    try {
      if (t && t.linkedPanel) return String(t.linkedPanel);
      if (t && t.linkedBrowser && t.linkedBrowser.browserId != null) {
        return "b" + t.linkedBrowser.browserId;
      }
    } catch (e) {
      // fall through
    }
    return "";
  }

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
    if (isDeadWrapper(tab)) return false;
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

  // Transient tabs (the split panel + the persistent relay) are not user
  // tabs: they are hidden from numbering so a tab's 1-9 identity never
  // changes just because a split/unsplit added or removed a companion pane. A
  // REAL tab carrying a momentary #lfc=keys/state request hash is not
  // transient — excluding it is exactly what shifted ;+N targets mid-request.
  function isTransientTab(tab: any): boolean {
    if (isDeadWrapper(tab)) return true;
    if (isSplitPanelTab(tab)) return true;
    try {
      const spec =
        tab && tab.linkedBrowser && tab.linkedBrowser.currentURI
          ? tab.linkedBrowser.currentURI.spec
          : "";
      return isRelayTabUrl(spec);
    } catch (e) {
      return false;
    }
  }

  // Real (user) tabs in strip order — the stable 1-9 identity space. Dead
  // wrappers (a tab being torn down mid-collapse) are skipped, never counted.
  function realTabs(): any[] {
    const out: any[] = [];
    for (const t of window.gBrowser.tabs) {
      if (isDeadWrapper(t)) continue;
      if (t && !isTransientTab(t)) out.push(t);
    }
    return out;
  }

  // Full strip (every tab element, transient or not) in its current order.
  // Used as the "desired order" when re-pinning the strip after a split
  // operation: Firefox's split machinery can regroup pairs (parking them at
  // the end), which shuffles every tab between the pair and the strip tail.
  // Snapshotting BEFORE the operation and pinning back to that order AFTER
  // keeps a tab's 1-9 identity stable across splits, swaps and restores.
  function stripSnapshot(): any[] {
    try {
      return Array.prototype.slice.call(window.gBrowser.tabs);
    } catch (e) {
      return [];
    }
  }

  function stripKey(): string {
    return Array.from(window.gBrowser.tabs)
      .map((t: any) => (t && t.linkedPanel ? t.linkedPanel : idOf(t)))
      .join(",");
  }

  // Pin the strip back to `order` (tab elements): compute the minimal move
  // plan with the Go core (respecting glued split groups) and execute it.
  // Returns whether any move was issued so the repin loop can tell when the
  // strip has stopped settling. Tabs already at their slot are never moved.
  function reconcileTo(order: any[]): boolean {
    try {
      const tabs = Array.from(window.gBrowser.tabs);
      const present = new Set(tabs);
      order = order.filter((t: any) => !!t && !t.closing && present.has(t));
      const current = tabs.map((t: any) => idOf(t));
      const desired = order.map((t: any) => idOf(t));
      // Distinct splitview wrappers -> their panes as groups. The wrapper is
      // the element, so a wrapper that no longer exists yields no group and
      // its (now single) tabs are pinned as singles.
      const seen = new Set<any>();
      const groups: string[][] = [];
      for (const t of tabs) {
        const sv = t && (t as any).splitview;
        if (!t || !sv || seen.has(sv)) continue;
        seen.add(sv);
        const members = (Array.isArray(sv.tabs) ? sv.tabs : []).filter(
          (m: any) => !!m && present.has(m)
        );
        if (members.length > 1) {
          const ids = members.map((m: any) => idOf(m)).filter((x: string) => x !== "");
          if (ids.length > 1) groups.push(ids);
        }
      }
      const moves = planStrip(current, desired, groups);
      for (const [id, to] of moves) {
        const tab = tabs.find((t: any) => idOf(t) === id);
        if (!tab) continue;
        try {
          window.gBrowser.moveTabTo(tab, { tabIndex: to });
        } catch (e) {
          // Ignore a single failed move; keep pinning the rest of the strip.
        }
      }
      return moves.length > 0;
    } catch (e) {
      return false;
    }
  }

  // addTabSplitView parks the freshly glued pair where it pleases, and it
  // does so ASYNCHRONOUSLY (the park can land hundreds of ms after the
  // synchronous call returns, depending on the build). Pin the strip back to
  // `order` repeatedly until it stops changing: each pass is idempotent and
  // skips tabs that are already at their slot, so a pass that finds the strip
  // already correct is free. Stops after the strip is stable (or ~1.2s).
  function repinAfterSplit(order: any[]): void {
    const seq = ++repinSeq;
    let attempts = 0;
    let lastChanged = true;
    const tick = () => {
      if (seq !== repinSeq) return;
      attempts++;
      const before = stripKey();
      const changed = reconcileTo(order);
      const after = stripKey();
      const changedKey = after !== before;
      const quiet = !changed && !changedKey && !lastChanged;
      lastChanged = changed || changedKey;
      const elapsed = attempts * 150;
      // Keep re-pinning while the strip is still settling (Firefox can glide
      // the pair around asynchronously). Stop only after two consecutive
      // quiet passes AND a minimum settle window, so a late glide is still
      // corrected before the user's next action reads the strip.
      if (seq === repinSeq && attempts < 12 && (!quiet || elapsed < 600)) setTimeout(tick, 150);
    };
    setTimeout(tick, 0);
  }

  // Desired order for operations that GLUE two tabs that were not adjacent:
  // the anchor (the tab the user is acting on) keeps its pre-operation slot
  // and the partner moves next to it, so the anchor's 1-9 number never
  // changes. The pair keeps the partners' pre-split RELATIVE order and is
  // inserted where the anchor sat. Every other tab keeps its relative order.
  // (Pure math — computed by the Go core.)
  function coalescePairOrder(pre: any[], anchor: any, partner: any): any[] {
    const preIds = pre.map((t: any) => idOf(t));
    const want = coalescePair(preIds, idOf(anchor), idOf(partner));
    return want
      .map((id) => pre.find((t: any) => idOf(t) === id))
      .filter((t: any) => !!t);
  }

  // Desired order after moving `tab` INTO the split view `sv`: the whole
  // group (existing panes, then the new member) keeps the group's position
  // and every other tab keeps its relative order. (Pure math — Go core.)
  function coalesceIntoGroupOrder(pre: any[], sv: any, tab: any): any[] {
    const panes = Array.isArray(sv.tabs) ? sv.tabs : [];
    const preIds = pre.map((t: any) => idOf(t));
    const memberIds = panes
      .map((p: any) => idOf(p))
      .filter((x: string) => x !== "");
    const want = coalesceIntoGroup(preIds, memberIds, idOf(tab));
    return want
      .map((id) => pre.find((t: any) => idOf(t) === id))
      .filter((t: any) => !!t);
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
      // Park the split on the tab and the panel, keeping the strip order that
      // existed before the panel appeared: addTabSplitView otherwise regroups
      // the two tabs (moving the pair to the end) and shuffles every tab
      // between the pair and the strip end. The snapshot is taken AFTER the
      // park so the pair is contiguous in the desired order (the panel sits
      // right after the active tab) — a desired order with the panes apart
      // would make the pin treat them as singles and re-glue the pair.
      try {
        const want = window.gBrowser.tabs.indexOf(active) + 1;
        const at = window.gBrowser.tabs.indexOf(blank);
        if (at !== want) window.gBrowser.moveTabTo(blank, { tabIndex: want });
      } catch (e) {
        // ignore
      }
      const preStrip = stripSnapshot();
      try {
        window.gBrowser.addTabSplitView([active, blank], splitInsertOpt([active, blank]));
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
        window.gBrowser.addTabSplitView([active, blank], splitInsertOpt([active, blank]));
      }
      // addTabSplitView may still regroup the pair (moving it to the end);
      // pin the whole strip back to its pre-split order so the pairing lands
      // where it was left and nothing else changes its 1-9 numbering.
      repinAfterSplit(preStrip);
      rememberSplit();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Options for addTabSplitView that keep a CONTIGUOUS, in-strip-order pair
  // exactly where it already sits. Firefox's default is to park a new split at
  // the strip end (and to do so asynchronously), so the re-pin loop would spend
  // its first ticks hauling the pair back. insertBefore places the wrapper
  // before the tab that follows the pair, so nothing moves at all; the loop
  // then only needs to absorb Firefox's async re-park. Builds before 152 that
  // lack the options arg simply ignore it (JS drops extra args) and the loop
  // covers the parking shift exactly as before. Only correct for an already
  // contiguous pair — the auto-split path (pair forming from far-apart tabs)
  // deliberately does NOT use it and relies on the loop.
  function splitInsertOpt(pair: any[]): any {
    try {
      let lastIdx = -1;
      for (const t of pair) {
        const i = window.gBrowser.tabs.indexOf(t);
        if (i > lastIdx) lastIdx = i;
      }
      const after = window.gBrowser.tabs[lastIdx + 1];
      if (after) return { insertBefore: after };
    } catch (e) {
      // ignore
    }
    return {};
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
    const mv = (msg: string) => { try { deps.onMove && deps.onMove(msg); } catch (e) { /* ignore */ } };
    try {
      if (!nativeSplitAvailable()) { mv("nativeSplitAvailable=false"); return false; }
      let sv = activeSplitView();
      if (!sv && lastNativeSplit && lastNativeSplit.isConnected) sv = lastNativeSplit;
      const tab = realTabs()[n - 1];
      mv("n=" + n + " sv=" + (sv ? "yes" : "no") + " tab=" + (tab ? "yes" : "no") + " tabPinned=" + (tab && tab.pinned) + " addTabsFn=" + (sv ? typeof sv.addTabs : "n/a") + " tabSv=" + (tab && tab.splitview ? "yes" : "no") + " activeSv=" + (window.gBrowser.selectedTab && window.gBrowser.selectedTab.splitview ? "yes" : "no"));
      if (!tab || tab.pinned) { mv("tab missing or pinned"); return false; }
      if (!sv) {
        // Auto-split: pair the active tab with tab N directly.
        const active = window.gBrowser.selectedTab;
        if (!active || active.pinned || active === tab) { mv("auto: no active or active===tab"); return false; }
        // A stale .splitview reference can linger after an unsplit; dissolve
        // it first so the auto-split succeeds instead of failing.
        if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
          try {
            active.splitview.unsplitTabs();
          } catch (e) {
            // ignore
          }
        }
        const preStrip = stripSnapshot();
        // Form the pair in the order that keeps the ACTIVE tab at its slot:
        // if the partner sat before it, split [partner, active] so the anchor
        // stays put; otherwise [active, partner]. (The pair's internal order
        // follows the array passed to addTabSplitView and cannot be changed
        // by moving the glued block.)
        const pair = preStrip.indexOf(tab) < preStrip.indexOf(active) ? [tab, active] : [active, tab];
        try {
          window.gBrowser.addTabSplitView(pair);
          mv("auto: addTabSplitView ok");
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
      if (tab.splitview === sv) { mv("already in this split"); return true; }
      // A tab can live in exactly one split view. Firefox's addTabs refuses
      // a tab that still belongs to another view — after an unsplit a stale
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
      if (typeof sv.addTabs !== "function") { mv("sv.addTabs missing"); return false; }
      try {
        mv("calling sv.addTabs([tab])");
        sv.addTabs([tab]);
        mv("addTabs returned ok; tab.splitview=" + (tab.splitview ? "yes" : "no"));
      } catch (e) {
        mv("addTabs threw " + String(e));
        return false;
      }
      removePanelPanes(sv);
      // Keep the strip order stable: the moved tab joins the group AND the
      // group stays where it was (only the newcomer changes its number, to
      // sit next to its new panes).
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
          if (isSplitPanelTab(p)) {
            createdPanelTabs.delete(p);
            window.gBrowser.removeTab(p);
          }
        } catch (e) {
          // ignore
        }
      }
      // Unsplit releases the panes in place on most builds, but pin the strip
      // back anyway: every tab must return to the exact slot it had, so the
      // user's ;1-9 mapping never changes just because a split dissolved.
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
      if (typeof window.gBrowser.addTabSplitView === "function") {
        window.gBrowser.addTabSplitView(panes, splitInsertOpt(panes));
      }
      window.gBrowser.selectedTab = active;
      // The re-formed split may regroup at the strip end; pin the strip back
      // to its pre-swap order so the pane swap never moves the pair around.
      repinAfterSplit(preStrip);
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
  // splitpanel companion and the throwaway #lfc= request relays): indexing
  // window.gBrowser.tabs directly would be shifted by those transient tabs
  // (and any pinned tabs the restore left in front), pairing the wrong tabs
  // or none at all.
  function restoreSplits(json: string): void {
    try {
      const groups = JSON.parse(json) as number[][];
      if (!Array.isArray(groups) || !groups.length) return;
      // The restore re-opened the saved tabs in saved order, so the strip IS
      // the saved order right now. Snapshot it, form every group, then pin
      // the strip back — addTabSplitView parks each pair where it pleases
      // (usually the strip end), which would otherwise renumber every tab.
      const preStrip = stripSnapshot();
      // Resolve the 1-based saved positions against non-pinned real tabs.
      // A restore re-opens saved tabs in order as unpinned tabs AFTER any
      // pinned tabs left in front, so pinned tabs must not offset the
      // positions (split view never involves pinned tabs).
      const real = realTabs().filter((t: any) => !t.pinned);
      for (const g of groups) {
        const tabs = (g || []).map((i) => real[i - 1]).filter((t: any) => !!t);
        if (tabs.length > 1 && typeof window.gBrowser.addTabSplitView === "function") {
          // Restored tabs are contiguous and in saved order, so the pair can
          // be parked exactly where it already sits instead of the strip end.
          window.gBrowser.addTabSplitView(tabs, splitInsertOpt(tabs));
        }
      }
      repinAfterSplit(preStrip);
      // Refresh the remembered split so a later ;+N with the selected tab
      // outside the split still targets a restored group (the selected tab's
      // own .splitview only covers the case where it sits inside one).
      rememberSplit();
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