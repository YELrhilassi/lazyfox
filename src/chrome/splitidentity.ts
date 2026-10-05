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

  function activeSplitView(): SplitViewWrapper | null {
    try {
      const tab = win.gBrowser.selectedTab;
      if (tab && tab.splitview) return tab.splitview;
      try {
        if (win.gBrowser.activeSplitView) return win.gBrowser.activeSplitView;
      } catch (e) {
        // not exposed on this build
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
    nativeSplitAvailable,
  };
}
