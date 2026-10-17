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
  /**
   * The split layout moved and the caller has not been told about THIS layout
   * yet. Fired at most once per distinct layout, possibly a beat after the split
   * op that caused it (see watchLayoutChange).
   */
  onLayoutChanged(): void;
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
  addTabToSplitByIndex(n: number, split?: number): boolean;
  /** Take the selected tab out of its split, leaving the rest of the group. */
  pullFromSplit(): boolean;
  /** The window's split groups, in strip order (1-based), for a chooser. */
  splitTargets(): { split: number; active: boolean; panes: { title: string; url: string; active: boolean }[] }[];
  unsplit(): boolean;
  switchPane(dir: number): boolean;
  swapPane(dir: number): boolean;
  restoreSplits(groups: number[][], expect?: number): void;
  activeSplitView(): SplitViewWrapper | null;
  rememberSplit(): void;
  /** The layout as a fingerprint: grouped strip positions, group by group. */
  splitSignature(): string;
  /** True once per distinct layout — what makes a report news instead of noise. */
  takeLayoutChange(): boolean;
  /** Report the layout, once per distinct layout (see watchLayoutChange). */
  watchLayoutChange(): void;
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
    isDeadWrapper,
    splitWrappers,
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

  // The layout as a fingerprint: the grouped strip positions, group by group,
  // in strip order. "" when nothing is split. Positions, not tab elements,
  // because positions are what a saved session records.
  function splitSignature(): string {
    try {
      const strip = realTabs();
      const groups: string[] = [];
      for (const sv of splitWrappers()) {
        let panes: ChromeTab[] = [];
        try {
          if (Array.isArray(sv.tabs)) panes = sv.tabs.filter((p) => !!p && !isDeadWrapper(p));
        } catch (e) {
          panes = [];
        }
        const pos = panes
          .map((p) => strip.indexOf(p))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b);
        if (pos.length > 1) groups.push(pos.join(","));
      }
      return groups.join("|");
    } catch (e) {
      return "";
    }
  }

  // The last fingerprint the caller was told about.
  let announcedLayout = "";

  /**
   * Whether the split layout changed since the last time this was asked.
   *
   * `rememberSplit` runs on every TabSelect — including the selects that only
   * move the selection BETWEEN THE PANES of one split, which change no layout at
   * all. Reporting those would put a relay round-trip on every keystroke that
   * switches panes, and the relay has a single URL slot shared with the key
   * commands themselves, so a page-turn through a split could starve the very
   * command that asked for it. Asking once per distinct layout is the whole
   * point: the notification is news or it is silence.
   */
  function takeLayoutChange(): boolean {
    const sig = splitSignature();
    if (sig === announcedLayout) return false;
    announcedLayout = sig;
    return true;
  }

  /**
   * Tell the caller the layout moved, if it has not already been told about
   * THIS layout.
   *
   * The report is a single read, deliberately. A split's DOM fills in stages,
   * so a read can catch a pair the platform has not finished describing — and
   * the answer to that is NOT to read again here, because each report costs a
   * relay round-trip out of a single URL slot shared with the key commands
   * themselves (measured: reporting per pane switch pushed a switch from 328ms
   * to 6245ms). The background already owns "measure until the platform has
   * finished saying what the layout is", which is a question about `tabs`
   * rather than about this DOM — see scheduleLayoutSnapshot on the extension
   * side. Here the question is only "is this news?".
   */
  function watchLayoutChange(): void {
    if (takeLayoutChange()) deps.onLayoutChanged();
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
    watchLayoutChange();
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
    // Each attempt owns its trail, exactly as each MOVE does (see the note in
    // addTabToSplitByIndex). This op is fire-and-forget from the extension's
    // side — the page that asked is told `ok` before anything here runs — so
    // when the strip shows no pair the only readable account of what happened
    // is the one written here: did Firefox refuse, did the pair appear and then
    // come apart, or did the op not run at all?
    try {
      deps.onMoveReset && deps.onMoveReset();
    } catch (e) {
      /* ignore */
    }
    const sp = (msg: string) => {
      try {
        deps.onMove && deps.onMove(msg);
      } catch (e) {
        /* ignore */
      }
    };
    // Who a tab IS, in the trail: the id the tabs API uses and the URL the
    // reader recognises. "panes=2" alone cannot say WHICH two, and "a split
    // exists that the extension never sees" is unreadable without them.
    const who = (t: ChromeTab | null | undefined): string => {
      try {
        return t ? "#" + idOf(t) + " " + tabUrl(t) : "none";
      } catch (e) {
        return "?";
      }
    };
    // How many panes the native split actually has RIGHT NOW, and which. -1 is
    // "could not be read", which must not be confused with 0 = no split at all.
    const panes = (): number => {
      try {
        const sv = activeSplitView();
        return sv && Array.isArray(sv.tabs) ? sv.tabs.length : 0;
      } catch (e) {
        return -1;
      }
    };
    const svWho = (): string => {
      try {
        const sv = activeSplitView();
        const list = sv && Array.isArray(sv.tabs) ? sv.tabs.map(who).join(", ") : "none";
        return "strip=" + win.gBrowser.tabs.length + " panes=" + panes() + " [" + list + "]";
      } catch (e) {
        return "unreadable";
      }
    };
    try {
      if (!nativeSplitAvailable()) {
        sp("no-native-split");
        return false;
      }
      const active = win.gBrowser.selectedTab;
      if (!active || active.pinned) {
        sp("refused: " + (!active ? "no-selected-tab" : "pinned"));
        return false;
      }
      // ALREADY IN A LIVE SPLIT: change nothing.
      //
      // This used to fall through to the "stale reference" handling below,
      // which DISSOLVED the split the user was already in and formed a new one
      // — so pressing `;|` on a working split threw the layout away, and the
      // dissolve plus re-form added a second round of asynchronous regrouping
      // to wait out. A tab already in a two-pane split has nothing to gain from
      // the operation, so the honest answer is to leave it alone.
      //
      // The `isConnected` test is what separates that from the genuinely stale
      // reference this path exists for: after an unsplit on some builds the tab
      // can still point at a wrapper that is no longer in the document, and that
      // one must be dissolved so `;|` works again.
      const live = active && !isDeadWrapper(active) ? (active as any).splitview : null;
      if (live && !isDeadWrapper(live) && live.isConnected !== false) {
        const n = Array.isArray(live.tabs) ? live.tabs.length : 0;
        if (n >= 2) {
          sp("already in a split view (panes=" + n + "): nothing to do");
          return true;
        }
      }
      // A stale .splitview reference can linger after an unsplit on some
      // builds; dissolve it first so `;|` on the very same tab works again
      // instead of failing with a spurious "needs Firefox 149+" toast.
      const stale = typeof active.splitview?.unsplitTabs === "function";
      if (stale) {
        sp("dissolved stale splitview on the tab");
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
      sp("active=" + who(active) + " panel=" + (blank ? "reused" : "created") + " stale=" + stale);
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
      const attempt = (): string => {
        try {
          // nativeSplitAvailable() already established the method exists; the
          // optional call is so the type reflects the version gate.
          win.gBrowser.addTabSplitView?.([active, blank], splitInsertOpt([active, blank]));
          return "ok";
        } catch (e) {
          return "threw:" + String((e && (e as any).message) || e);
        }
      };
      let first = attempt();
      sp("split=" + first + " " + svWho() + " newPane=" + who(blank));
      if (first !== "ok") {
        // First attempt can fail with stale internal split state; dissolve the
        // active tab's split group and retry once.
        try {
          if (active.splitview && typeof active.splitview.unsplitTabs === "function") {
            active.splitview.unsplitTabs();
          }
        } catch (e2) {
          // ignore
        }
        first = attempt();
        sp("split-retry=" + first + " " + svWho());
      }
      // The strip is the verdict, read again after the platform has had a beat.
      // Firefox creates and (re)parks a split asynchronously, so a pair that is
      // absent NOW may simply be late — but a pair that is still absent later
      // means this call reported success on a split that does not exist, which
      // is exactly the case a bare `return true` cannot tell the user about.
      try {
        env.setTimeout(
          () => sp("after400ms " + svWho() + " newPaneConnected=" + (blank ? !!blank.isConnected : "n/a")),
          400
        );
      } catch (e) {
        /* ignore */
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
  function addTabToSplitByIndex(n: number, split?: number): boolean {
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
      // A WINDOW CAN HOLD SEVERAL SPLITS, and then "the split" is ambiguous.
      //
      // `split` is 1-based among the live groups in strip order — the same order
      // the chooser listed them in, derived on both sides from the strip rather
      // than from a stored id. Asking for a group that is no longer there is
      // refused in the trail instead of silently landing in another one, which
      // is the failure a user would experience as "it moved my tab somewhere I
      // did not pick".
      let sv: SplitViewWrapper | null = null;
      if (split !== undefined && split >= 1) {
        const all = splitWrappers();
        sv = all[split - 1] ?? null;
        if (!sv) {
          mv("refused: no split " + split + " (live-splits=" + all.length + ")");
          return false;
        }
      }
      if (!sv) sv = activeSplitView();
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
      const panesNow = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      const panelPane = panesNow.filter((p) => !!p && !isDeadWrapper(p) && isSplitPanelTab(p))[0];
      // REPLACE OUR OWN PANE, ATOMICALLY, WHEN THERE IS ONE.
      //
      // The panel pane is ours (`;|`'s "move a tab here" list) and it must be
      // REPLACED by the real tab. The order used to be add-then-close, which puts
      // THREE tabs inside the wrapper for as long as the close takes — and native
      // split view is a TWO-pane feature, so that is not a state Firefox renders:
      // one pane shows content and the other is an empty, unusable half, which is
      // the reported "after unsplitting it keeps showing the tab in two halves,
      // one with content and the other with nothing in it". `replaceTab()` does
      // the swap in ONE platform call, so the wrapper never holds three tabs and
      // never falls back to a single pane (which would make its own observer
      // unsplit the view in the middle of the move).
      if (panelPane && typeof (sv as any).replaceTab === "function") {
        try {
          (sv as any).replaceTab(panelPane, tab);
          mv("replaceTab(panel, tab) ok; tab.splitview=" + (tab.splitview ? "yes" : "no"));
        } catch (e) {
          mv("replaceTab threw " + String(e));
          return false;
        }
        readbackSplit(mv, tab);
        repinAfterSplit(coalesceIntoGroupOrder(preStrip, sv, tab));
        rememberSplit();
        return true;
      }
      // A WRAPPER THAT ALREADY HOLDS TWO REAL PANES IS FULL.
      //
      // Adding a third is the same three-tab state by another route, so the move
      // is refused with a reason in the trail rather than performed into a
      // layout the platform cannot draw. Nothing is closed and nothing is
      // dissolved: the user's split is exactly as they left it.
      if (!panelPane && panesNow.length >= 2) {
        mv("refused: the split already has " + panesNow.length + " panes (two max)");
        return false;
      }
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

  /**
   * The window's splits, in strip order, with the panes inside each one.
   *
   * `addTabToSplitByIndex`'s optional `split` is an index into THIS list, and
   * both sides derive it the same way — from the strip — so the number the
   * chooser shows is the number the operation resolves. Nothing is stored, which
   * is the point: a cached list would go stale the moment a split dissolved, and
   * then the number would name a different group than the one on screen.
   */
  function splitTargets(): {
    split: number;
    active: boolean;
    panes: { title: string; url: string; active: boolean }[];
  }[] {
    const out: { split: number; active: boolean; panes: { title: string; url: string; active: boolean }[] }[] = [];
    for (const sv of splitWrappers()) {
      let panes: ChromeTab[] = [];
      try {
        if (Array.isArray(sv.tabs)) panes = sv.tabs.filter((p) => !!p && !isDeadWrapper(p));
      } catch (e) {
        panes = [];
      }
      if (!panes.length) continue;
      out.push({
        split: out.length + 1,
        active: panes.some((p) => p.selected === true),
        panes: panes.map((p) => ({
          title: String(p.label || tabUrl(p) || ""),
          url: String(rawUrl(p) || tabUrl(p) || ""),
          active: p.selected === true,
        })),
      });
    }
    return out;
  }

  /**
   * TAKE ONE PANE OUT OF ITS SPLIT, AND LEAVE THE REST ALONE.
   *
   * `unsplit()` is the "take the whole split apart" op, and the report that
   * asked for this one was explicit that it is not the same thing: "I should be
   * able to move a tab from a split pane while keeping the split panes, not just
   * `;W u`". So this removes exactly one pane from the group — the move the
   * native wrapper offers as `removeTab` — and nothing else in the window
   * changes: the other panes stay in the group, their order is untouched, and
   * the tab that left keeps its place in the strip as an ordinary tab.
   *
   * What happens to the GROUP afterwards is the platform's business: a two-pane
   * split with one pane left has nothing left to be side-by-side with, so the
   * wrapper dissolves and the survivor is an ordinary tab — but that is a
   * consequence, not the operation. With three or more panes (or a future
   * platform that keeps a one-pane group alive) the rest of the group survives,
   * which is the whole difference from `;W u`.
   */
  function pullFromSplit(): boolean {
    const mv = (msg: string): void => {
      try {
        if (deps.onMove) deps.onMove(msg);
      } catch (e) {
        /* diagnosis only */
      }
    };
    try {
      deps.onMoveReset && deps.onMoveReset();
    } catch (e) {
      /* ignore */
    }
    try {
      const selected = win.gBrowser.selectedTab as ChromeTab | null;
      let sv: SplitViewWrapper | null = activeSplitView();
      if (!sv && lastNativeSplit && !isDeadWrapper(lastNativeSplit) && lastNativeSplit.isConnected) {
        sv = lastNativeSplit;
      }
      if (!sv) {
        // The same rule `unsplit` uses: one split in the window and the
        // selection outside it is still the split the user is looking at.
        const all = splitWrappers();
        if (all.length === 1) sv = all[0]!;
      }
      if (!sv) {
        mv("pull: no split view to pull out of");
        return false;
      }
      const panes: ChromeTab[] = Array.isArray(sv.tabs) ? sv.tabs.slice() : [];
      const pane =
        selected && panes.indexOf(selected) >= 0
          ? selected
          : panes.filter((p) => p && p.selected)[0] || null;
      if (!pane) {
        mv("pull: the selected tab is not in that split");
        return false;
      }
      if (panes.length < 2) {
        mv("pull: refusing to empty the split");
        return false;
      }
      if (isDeadWrapper(sv) || typeof sv.removeTab !== "function") {
        // Older builds cannot take one pane out. Dissolving the group is the
        // only move that still leaves the other pane alive and selected.
        mv("pull: wrapper has no removeTab; unsplitting instead");
        try {
          sv.unsplitTabs?.();
        } catch (e) {
          return false;
        }
        rememberSplit();
        return true;
      }
      try {
        sv.removeTab(pane);
        mv("pull: removeTab ok; remaining=" + (panes.length - 1));
      } catch (e) {
        mv("pull: removeTab threw " + String(e));
        return false;
      }
      // The tab that left is the one the user was looking at, so it stays
      // selected — a pull that left the keyboard on some other pane would be a
      // navigation they did not ask for.
      try {
        win.gBrowser.selectedTab = pane;
      } catch (e) {
        /* selection is best-effort */
      }
      rememberSplit();
      return true;
    } catch (e) {
      mv("pull: outer catch " + String(e));
      return false;
    }
  }

  /**
   * Take a split apart and PUT EVERY TAB BACK WHERE IT BELONGS.
   *
   * This is the operation the app was reported to die on: "the unsplit is
   * completely broken ... after unsplitting the panes are not reset properly to
   * their correct locations, the tab keeps showing in two halves with one of them
   * empty and unusable, and then nothing works — `;Number` does nothing, `;t`
   * shows an empty list, the history stops".
   *
   * Three things in the old body produced that, and all three are about ORDER 
   * and about which element is asked:
   *
   *   1. IT ASKED THE WRONG THING. `activeSplitView()` describes the SELECTED
   *      tab (or the last wrapper the platform mentioned). A split whose
   *      selection moved away therefore answered "no split", the caller said
   *      "not in a split view", and the two panes stayed on screen with no way
   *      to take them apart. The strip is asked instead (splitidentity.ts,
   *      splitWrappers) and a lone split in the window is taken as the one the
   *      user means.
   *   2. IT FINISHED BEFORE THE PLATFORM DID. `unsplitTabs()` moves the tabs out
   *      synchronously but leaves the now-empty `<tab-split-view-wrapper>` for
   *      the element's own MutationObserver to remove on a LATER turn, and it
   *      releases its panel state when that element disconnects. Closing our
   *      pane and re-pinning the strip in the same tick therefore ran against a
   *      strip that was still mid-teardown — which is how the strip ended up
   *      rendered as a half-empty pair while `browser.tabs` reported ordinary
   *      tabs in other places (the "disconnect between the tab ids and their
   *      locations"). Everything after the call now waits for the wrapper to
   *      actually leave the document, with a bounded number of tries and a trace
   *      line when it does not.
   *   3. IT COULD BE SILENTLY DESTROYED BY A THROW. The wrapper is a DOM element
   *      Firefox destroys; any property read on a dead one throws "can't access
   *      dead object", and the old `catch` turned that into a plain `false` —
   *      i.e. nothing happened, on a click that visibly did something. A dead
   *      wrapper now means "it is already gone", and the repair (close our pane,
   *      re-pin, keep a live selection) still runs.
   *
   * Returns false only when there is genuinely no split to take apart, because
   * that answer is what the user sees as "not in a split view".
   */
  function unsplit(): boolean {
    // Say so in the trail the split op keeps, BEFORE deciding anything. Every
    // path that takes a split apart — `;W u`, a stale reference being dissolved,
    // the auto-unsplit after a pane closes — ends up here, and a split that was
    // created a moment ago and is then gone is unreadable unless the thing that
    // removed it is on the record.
    // One local writer for the trail, so no line of the reporting below can be
    // the thing that fails the operation.
    const mv = (msg: string): void => {
      try {
        if (deps.onMove) deps.onMove(msg);
      } catch (e) {
        // Diagnosis only.
      }
    };
    const wrappers = splitWrappers();
    const active = activeSplitView();
    mv(
      "unsplit CALLED (active-sv=" +
        (active ? "yes" : "no") +
        " live-splits=" +
        wrappers.length +
        ")"
    );
    try {
      let sv: SplitViewWrapper | null = active;
      if (!sv && lastNativeSplit && !isDeadWrapper(lastNativeSplit) && lastNativeSplit.isConnected) {
        sv = lastNativeSplit;
      }
      // ONE split in the window and the selected tab not in it: that is still
      // the split the user is looking at, and refusing to undo it is what left
      // them with an empty pane and no way out.
      const only = wrappers.length === 1 ? wrappers[0] : undefined;
      if (!sv && only) sv = only;
      if (!sv) {
        mv("unsplit: no split view to take apart");
        return false;
      }
      // The panes are captured BEFORE the call: after it the wrapper is empty and
      // the list is the only record of which tabs were in it (one of them is our
      // panel pane, which is pure UI and must not pile up as a stray tab).
      const panes: ChromeTab[] = [];
      try {
        if (Array.isArray(sv.tabs)) for (const p of sv.tabs) if (p) panes.push(p);
      } catch (e) {
        // A wrapper whose panes cannot be read still has to be taken apart.
      }
      const preStrip = stripSnapshot();
      const dead = isDeadWrapper(sv) || typeof (sv as any).unsplitTabs !== "function";
      if (dead) {
        // Already gone (or not a split view at all): the tabs are out, and the
        // repair below is exactly what is left to do.
        mv("unsplit: wrapper already gone — repairing the strip");
      } else {
        try {
          // The method is version-gated on the wrapper's TYPE (older builds have
          // no unsplit on it at all), and the `dead` test above is what proved it
          // is callable here.
          (sv as any).unsplitTabs();
        } catch (e) {
          mv("unsplit threw " + String(e) + "; live-splits=" + splitWrappers().length);
          return false;
        }
      }

      // OUR OWN PANE GOES NOW, while the strip is provably in the right shape.
      //
      // `unsplitTabs()` releases the tabs into the tab container synchronously,
      // so by this point every pane is an ordinary tab and closing ours is an
      // ordinary tab close. It is NOT deferred with the re-pin below, and the
      // difference matters: a leftover split-panel tab is REUSED as the next
      // `;|`'s pane, so the sooner it is gone the smaller the window in which a
      // close could land on a tab a brand new split has adopted. (That window
      // is real — one e2e run saw "`;W |` produced no pair" with this line in the
      // chrome trail — and the guard inside closeOurPanes is what makes it
      // harmless as well as small.)
      const closeOurPanes = (): void => {
        for (const p of panes) {
          try {
            if (!p || isDeadWrapper(p) || p.closing) continue;
            if (!isSplitPanelTab(p)) continue;
            // A tab that is in a split view RIGHT NOW is not a leftover,
            // whatever it used to be.
            let inASplit = false;
            try {
              inASplit = !!p.splitview;
            } catch (e) {
              inASplit = true; // unreadable state is not a licence to close it
            }
            if (inASplit) continue;
            win.gBrowser.removeTab(p);
          } catch (e) {
            // ignore
          }
        }
      };
      closeOurPanes();

      // ---- from here on: the platform has been told, and we wait for it ----
      const settled = (tries: number) => {
        let stillThere = false;
        try {
          stillThere = !isDeadWrapper(sv) && (sv as any).isConnected !== false;
        } catch (e) {
          stillThere = false; // a dead wrapper is a gone wrapper
        }
        if (stillThere && tries < 10) {
          env.setTimeout(() => settled(tries + 1), 50);
          return;
        }
        if (stillThere) {
          // It did not come apart. Do NOT start moving tabs around a strip whose
          // split still exists — that is the half-empty pair. Say so and stop.
          mv("unsplit: wrapper STILL CONNECTED after 500ms; leaving the strip alone");
          return;
        }
        // The wrapper is gone, so the strip can finally be touched: pin it back
        // so every tab returns to the slot it had and the user's 1-9 mapping is
        // unchanged. This is the part that MUST wait — moving tabs while the
        // empty wrapper is still in the strip is what renders the half-empty
        // pair the report describes.
        repinAfterSplit(preStrip);
        // A split can dissolve out from under the selection (the selected pane
        // was our own panel, which we just closed). Firefox then has no selected
        // tab, and with no selected tab every later action that resolves "the
        // current tab" — `;1`, the tab popup's active row, the history — has
        // nothing to resolve against: the reported "after unsplit I can't
        // navigate anywhere, `;t` shows an empty list though the bar counts 3
        // tabs". Selecting a live tab is the whole fix for that.
        try {
          const sel = win.gBrowser.selectedTab;
          let gone = false;
          try {
            gone = !sel || !!sel.closing || isDeadWrapper(sel);
          } catch (e) {
            gone = true;
          }
          if (gone) {
            // Prefer a tab that was IN the split — that is where the user was
            // looking — and fall back to the first real tab.
            let next: ChromeTab | undefined;
            for (const p of panes) {
              try {
                if (p && !p.closing && !isDeadWrapper(p) && p.isConnected !== false) {
                  next = p;
                  break;
                }
              } catch (e) {
                // skip a pane whose state cannot be read
              }
            }
            if (!next) next = realTabs()[0];
            if (next) {
              win.gBrowser.selectedTab = next;
              mv("unsplit: nothing was selected; re-selected " + idOf(next));
            }
          }
        } catch (e) {
          // ignore
        }
        rememberSplit();
      };
      env.setTimeout(() => settled(0), 0);
      return true;
    } catch (e) {
      mv("unsplit outer catch " + String(e));
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
    pullFromSplit,
    splitTargets,
    unsplit,
    switchPane,
    swapPane,
    restoreSplits,
    activeSplitView,
    rememberSplit,
    splitSignature,
    takeLayoutChange,
    watchLayoutChange,
  };
}
