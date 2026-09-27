// Page-cache policy, chrome-helper half.
//
// The extension's background owns the policy and the global scope (Firefox's
// own `browserSettings.cacheEnabled`). What the extension CANNOT do is aim the
// cache at particular tabs, so that half lives here, in privileged code:
//
//   * an `http-on-modify-request` observer adds `Cache-Control: no-cache`
//     (mode "fresh") or `no-store` (mode "off") to the requests of the tabs a
//     tab/session policy covers;
//   * the global "fresh" mode flips `network.http.use-cache`, the one pref that
//     makes Firefox revalidate everything it already has on disk.
//
// Tabs are identified by their stable `browserId`: the background sends raw
// Firefox tab ids in strip order, which line up 1:1 with `gBrowser.tabs`
// (that mapping is already relied on by the tab switcher popup), so a tab id is
// resolved to its browser once, at policy time, and the observer never has to
// guess.

import type { CacheMode } from "../shared/types";

export interface CacheCtl {
  // Global mode: only "fresh" needs a pref here (the extension owns disabling
  // the cache outright).
  setGlobalMode(mode: CacheMode): void;
  // Per-tab policy: mode applies to exactly the tabs at the given strip-aligned
  // Firefox tab ids. An empty/absent set clears the policy.
  setPolicy(mode: CacheMode, tabIds: number[]): void;
  destroy(): void;
}

interface CacheDeps {
  // Raw Firefox tab ids in strip order, as pushed by the background's status
  // snapshot. Index i corresponds to gBrowser.tabs[i].
  getTabIds(): number[];
}

const PREF_USE_CACHE = "network.http.use-cache";

// The Cache-Control value each mode asks for. normal = no request override at
// all (let the policy be cleared).
function cacheControlFor(mode: CacheMode): string | null {
  if (mode === "off") return "no-store, no-cache, must-revalidate";
  if (mode === "fresh") return "no-cache";
  return null;
}

export function createCacheCtl(deps: CacheDeps): CacheCtl {
  // browserIds of the tabs the per-tab/session policy covers.
  let bypass = new Set<number>();
  let bypassMode: CacheMode = "normal";
  let observer: any = null;

  function browserForChannel(chan: any): any {
    try {
      const loadInfo = chan.loadInfo;
      const bc = loadInfo && loadInfo.browsingContext;
      if (!bc) return null;
      const top = bc.top || bc;
      return window.gBrowser.getBrowserForBrowsingContext(top) || null;
    } catch (e) {
      return null;
    }
  }

  function observe(subject: any, topic: string): void {
    if (topic !== "http-on-modify-request") return;
    if (bypassMode === "normal" || bypass.size === 0) return;
    const override = cacheControlFor(bypassMode);
    if (!override) return;
    try {
      const browser = browserForChannel(subject);
      if (!browser) return;
      const bid = browser.browserId;
      if (bid == null || !bypass.has(bid)) return;
      const chan = subject.QueryInterface(Ci.nsIHttpChannel);
      chan.setRequestHeader("Cache-Control", override, false);
      // Belt and braces: some internal channels ignore request headers but
      // honour the load flag.
      try {
        chan.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
      } catch (e) {
        // ignore
      }
    } catch (e) {
      // A single malformed channel must never break the observer.
    }
  }

  function ensureObserver(): void {
    if (observer) return;
    observer = { observe: observe, QueryInterface: () => observer };
    try {
      Services.obs.addObserver(observer, "http-on-modify-request");
    } catch (e) {
      observer = null;
    }
  }

  function setGlobalMode(mode: CacheMode): void {
    try {
      // "fresh" makes Firefox revalidate everything it serves from the disk
      // cache; every other mode leaves the pref at its default.
      Services.prefs.setBoolPref(PREF_USE_CACHE, mode !== "fresh");
    } catch (e) {
      // ignore — a locked pref just means the mode has no global effect
    }
  }

  function setPolicy(mode: CacheMode, tabIds: number[]): void {
    bypassMode = mode;
    const next = new Set<number>();
    if (mode !== "normal" && tabIds.length) {
      const ids = deps.getTabIds();
      const tabs = window.gBrowser.tabs;
      for (const id of tabIds) {
        const i = ids.indexOf(id);
        if (i < 0 || i >= tabs.length) continue;
        try {
          const bid = tabs[i].linkedBrowser && tabs[i].linkedBrowser.browserId;
          if (bid != null) next.add(bid);
        } catch (e) {
          // ignore
        }
      }
    }
    bypass = next;
    if (next.size) ensureObserver();
  }

  function destroy(): void {
    try {
      if (observer) Services.obs.removeObserver(observer, "http-on-modify-request");
    } catch (e) {
      // ignore
    }
    observer = null;
    bypass = new Set<number>();
    setGlobalMode("normal");
  }

  return { setGlobalMode, setPolicy, destroy };
}
