// Who counts as a tab, and what does the strip currently look like.
//
// Split out of splitview.ts because it is a DIFFERENT question from "make a
// split". Everything here is a READ of the browser's own state — realTabs(),
// stripSnapshot(), stripKey(), the url/id accessors — with no side effects at
// all. Splitting it out means:
//
//   - the identity rules (which tabs are hidden from 1-9 numbering, and why a
//     half-committed relay counts) can be read in one screen instead of being
//     interleaved with 300 lines of split plumbing, and
//   - splitview.ts is left holding only the operations.
//
// Every one of these takes its browser through the injected `env` rather than
// a bare global, which is what makes this module constructible in Node against
// the fake env (see src/chrome/env.ts) — the seam the wire and seam test tiers
// exist to exercise.

import { isRelayTabUrl } from "../shared/transient";
import type { ChromeTab, SplitViewWrapper } from "./tabs";
import type { ChromeEnv } from "./env";

export interface TabIdentity {
  /** Firefox destroyed this wrapper mid-collapse; ANY property read throws. */
  isDeadWrapper(o: unknown): boolean;
  /** Stable id in the strip-planning id space ("" when not yet identifiable). */
  idOf(t: ChromeTab | null | undefined): string;
  /** Full strip (transient tabs included), in current order. */
  stripSnapshot(): ChromeTab[];
  /** A comparable fingerprint of the strip's current order. */
  stripKey(): string;
  /** Real (user) tabs in strip order — the stable 1-9 identity space. */
  realTabs(): ChromeTab[];
  /** The split-panel companion pane this module created. */
  markPanelTab(tab: ChromeTab | undefined): void;
  /** Is this the window's own relay tab? (from the channel, which knows it) */
  setRelayTest(fn: (tab: ChromeTab | null | undefined) => boolean): void;
  isSplitPanelTab(tab: ChromeTab | null | undefined): boolean;
  isTransientTab(tab: ChromeTab | null | undefined): boolean;
  /** Short display form of a tab's URL, for the move trail. */
  tabUrl(tab: ChromeTab | null | undefined): string;
  /** The `#lfc=` hash a tab carries, if any. */
  rawUrl(tab: ChromeTab | null | undefined): string;
  /** The currently active split view wrapper, or null. */
  activeSplitView(): SplitViewWrapper | null;
  /** EVERY live split-view wrapper in this window's strip, in strip order. */
  splitWrappers(): SplitViewWrapper[];
  /** Does this Firefox build expose native split view at all? */
  nativeSplitAvailable(): boolean;
}

export function createTabIdentity(env: ChromeEnv): TabIdentity {
  const win = env.window as any;

  // The split-panel companion pane (search/URL + move-a-tab list) is pure UI:
  // it must never accumulate as stray tabs or be offered as a move target.
  // Tabs we created as panels are tracked by REFERENCE because the panel's
  // currentURI is still about:blank for a moment after creation (the
  // splitpanel.html document has not committed yet) — so a URL test would miss
  // it exactly when it matters most.
  const createdPanelTabs = new Set<ChromeTab>();

  // Late-bound: the channel owns this knowledge (it remembers the tabs it
  // created) and is built AFTER this module, so the identity asks rather than
  // re-deriving it.
  let isRelayTab: (tab: ChromeTab | null | undefined) => boolean = () => false;

  // Firefox destroys tab wrappers mid-window-collapse: a tab being removed can
  // still be listed in gBrowser.tabs while its wrapper is already dead, and ANY
  // property access on a dead wrapper throws "can't access dead object". Every
  // tab-iteration path must skip those — the leader's status callback re-renders
  // the bar mid-collapse, so one dead tab throws straight through key dispatch.
  function isDeadWrapper(o: unknown): boolean {
    try {
      return !!(env.Cu && env.Cu.isDeadWrapper(o));
    } catch (e) {
      return false;
    }
  }

  // Stable id for a tab in the strip-planning id space. linkedPanel is unique
  // and stable for a tab's lifetime; browserId is the fallback for a tab whose
  // panel has not attached yet.
  function idOf(t: ChromeTab | null | undefined): string {
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

  function isSplitPanelTab(tab: ChromeTab | null | undefined): boolean {
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

  // Transient tabs (the split panel + the persistent relay) are not user tabs:
  // they are hidden from numbering so a tab's 1-9 identity never changes just
  // because a split/unsplit added or removed a companion pane. A REAL tab
  // carrying a momentary #lfc=keys/state request hash is NOT transient —
  // excluding it is exactly what shifted `;+N` targets mid-request.
  function isTransientTab(tab: ChromeTab | null | undefined): boolean {
    if (isDeadWrapper(tab)) return true;
    if (isSplitPanelTab(tab)) return true;
    // By reference FIRST: a relay that has not committed relay.html yet is
    // about:blank, and the URL test below cannot see it. The channel owns that
    // knowledge, so it is asked before falling back to the URL.
    if (isRelayTab(tab)) return true;
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

  // Real (user) tabs in strip order. Dead wrappers (a tab being torn down
  // mid-collapse) are skipped, never counted.
  function realTabs(): ChromeTab[] {
    const out: ChromeTab[] = [];
    for (const t of win.gBrowser.tabs) {
      if (isDeadWrapper(t)) continue;
      if (t && !isTransientTab(t)) out.push(t);
    }
    return out;
  }

  // Full strip (every tab element, transient or not) in its current order. Used
  // as the "desired order" when re-pinning after a split operation: Firefox's
  // split machinery can regroup pairs (parking them at the end), which shuffles
  // every tab between the pair and the strip tail. Snapshotting BEFORE the
  // operation and pinning back to that order AFTER keeps a tab's 1-9 identity
  // stable across splits, swaps and restores.
  function stripSnapshot(): ChromeTab[] {
    try {
      return Array.prototype.slice.call(win.gBrowser.tabs);
    } catch (e) {
      return [];
    }
  }

  function stripKey(): string {
    return Array.from<unknown>(win.gBrowser.tabs)
      .map((t) => {
        const tab = t as ChromeTab;
        return tab && tab.linkedPanel ? tab.linkedPanel : idOf(tab);
      })
      .join(",");
  }

  // The tab's own URL, for logs. A tab with no readable URL is not a match for
  // anything, but it must still be reportable rather than throw.
  function tabUrl(tab: ChromeTab | null | undefined): string {
    try {
      const spec =
        tab && tab.linkedBrowser && tab.linkedBrowser.currentURI
          ? String(tab.linkedBrowser.currentURI.spec)
          : "";
      return (spec.split("?")[0] || "(no url)")
        .replace(/^moz-extension:\/\/[^/]+\//, "ext:")
        .slice(-40);
    } catch (e) {
      return "(unreadable)";
    }
  }

  // The hash fragment a tab carries, if any. The display form above elides it,
  // so this is what tells "a real command-center tab" apart from "the
  // command-center tab a request is currently riding".
  function rawUrl(tab: ChromeTab | null | undefined): string {
    try {
      const spec =
        tab && tab.linkedBrowser && tab.linkedBrowser.currentURI
          ? String(tab.linkedBrowser.currentURI.spec)
          : "";
      const h = spec.indexOf("#");
      return h === -1 ? "" : "#" + spec.slice(h + 1, h + 14);
    } catch (e) {
      return "";
    }
  }

  /**
   * EVERY live split-view wrapper in this window's strip, in strip order.
   *
   * This is the source of truth for "is there a split", and it is a DOM read on
   * purpose. A native split IS a `<tab-split-view-wrapper>` element in the tab
   * container; the two reference-based answers the operations used to trust
   * describe something narrower — `selectedTab.splitview` describes the SELECTED
   * tab, and `gBrowser.activeSplitView` the last wrapper the platform touched.
   * A split whose selection has moved away therefore reads as "no split at all":
   * `;W u` answers "not in a split view" with two panes on screen and no way to
   * take them apart, which is the reported "the unsplit is completely broken and
   * then nothing in the app works". Asking the strip cannot lie about how many
   * splits are on it.
   *
   * Dead wrappers are skipped, not returned: Firefox destroys a wrapper while
   * cancelling a split, and ANY read on a dead object throws "can't access dead
   * object" straight through a key dispatcher.
   */
  function splitWrappers(): SplitViewWrapper[] {
    const out: SplitViewWrapper[] = [];
    try {
      const container = win.gBrowser && win.gBrowser.tabContainer;
      const found =
        container && typeof container.querySelectorAll === "function"
          ? container.querySelectorAll("tab-split-view-wrapper")
          : null;
      if (found && found.length) {
        for (const el of Array.prototype.slice.call(found) as SplitViewWrapper[]) {
          if (isDeadWrapper(el)) continue;
          out.push(el);
        }
        return out;
      }
    } catch (e) {
      // Fall through to the tab-derived answer below (older builds, and the
      // fake environment the seam tests run against, expose no container).
    }
    try {
      const seen = new Set<SplitViewWrapper>();
      for (const t of win.gBrowser.tabs) {
        if (isDeadWrapper(t)) continue;
        const sv = t && t.splitview;
        if (!sv || seen.has(sv) || isDeadWrapper(sv)) continue;
        seen.add(sv);
        out.push(sv);
      }
    } catch (e) {
      // ignore
    }
    return out;
  }

  function activeSplitView(): SplitViewWrapper | null {
    try {
      const tab = win.gBrowser.selectedTab;
      if (tab && !isDeadWrapper(tab) && tab.splitview) return tab.splitview;
      try {
        const platform = win.gBrowser.activeSplitView;
        // A DEAD ELEMENT IS NEVER THE ANSWER. This getter can hand back a
        // wrapper Firefox has already destroyed, and every property read on one
        // throws "can't access dead object" — straight through a key dispatcher,
        // from a call that only wanted to know where the split is.
        if (platform && !isDeadWrapper(platform)) return platform;
      } catch (e) {
        // not exposed on this build
      }
      // Both references can be silent while a split is on screen (see
      // splitWrappers): the strip still knows, and the honest answer is the
      // wrapper that CONTAINS the selected tab.
      for (const sv of splitWrappers()) {
        try {
          if (Array.isArray(sv.tabs) && sv.tabs.indexOf(tab) !== -1) return sv;
        } catch (e) {
          // A wrapper whose pane list cannot be read is not a match.
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // Whether this build can split at all. The feature flag is not set in a normal
  // profile (only the test profile sets it via user.js), and the chrome helper
  // is privileged, so it enables it rather than reporting a permanent no.
  function nativeSplitAvailable(): boolean {
    try {
      if (typeof win.gBrowser.addTabSplitView !== "function") return false;
      let on = false;
      try {
        on = env.services.prefs.getBoolPref("browser.tabs.splitView.enabled", false);
      } catch (e) {
        on = false;
      }
      if (!on) {
        try {
          env.services.prefs.setBoolPref?.("browser.tabs.splitView.enabled", true);
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

  return {
    isDeadWrapper,
    idOf,
    stripSnapshot,
    stripKey,
    realTabs,
    markPanelTab: (tab) => {
      if (tab) createdPanelTabs.add(tab);
    },
    setRelayTest: (fn) => {
      isRelayTab = fn || (() => false);
    },
    isSplitPanelTab,
    isTransientTab,
    tabUrl,
    rawUrl,
    activeSplitView,
    splitWrappers,
    nativeSplitAvailable,
  };
}
