// Chrome-window primitives shared by the op domains: tab identity, native
// URL loading, the armed close confirmation, and the native Firefox data
// sources (search suggestions, Places history, search submission).
//
// WHY A FACTORY. This module used to be a bag of module-level functions reading
// `window`, `Services`, `Ci` and `ChromeUtils` off the globals, with the
// relay-tab predicate and the armed-close flag in module scope. That shape is
// untestable twice over: it cannot be constructed in Node (the globals are not
// there), and two tests in one process would share the armed-close flag and the
// relay predicate. `createPrimitives(env)` gives each composition one instance
// with its own state, over an injected environment — see src/chrome/env.ts.

import { isRelayTabUrl } from "../../shared/transient";
import { toast } from "../../shared/overlay";
import type { Config, PopupItem } from "../../shared/types";
import type { ChromeEnv } from "../env";

export interface Primitives {
  sysPrincipal(): any;
  openUrlNative(url: string): boolean;
  realTabs(): any[];
  loadUrl(url: string, newTab: boolean | undefined): void;
  closeCurrentTabWithConfirm(): void;
  suggestSearch(q: string): Promise<PopupItem[]>;
  histItems(text: string, maxResults: number): Array<{ title: string; url: string; time: number }>;
  doSearch(query: string, replace?: boolean): void;
  /** Whether a tab element is the window's relay (asked, never re-derived). */
  setRelayTabTest(fn: (tab: any) => boolean): void;
}

export function createPrimitives(env: ChromeEnv): Primitives {
  const win = env.window as any;
  const console = env.console;

  function sysPrincipal(): any {
    return env.services.scriptSecurityManager.getSystemPrincipal();
  }

  // Open an arbitrary URL natively (switchToTabHavingURI / addTab). This is the
  // ONLY path that can load about: pages — the tabs API rejects them with
  // "Illegal URL".
  function openUrlNative(url: string): boolean {
    try {
      if (typeof win.switchToTabHavingURI === "function") {
        win.switchToTabHavingURI(url, true, {});
      } else {
        const tab = win.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
        win.gBrowser.selectedTab = tab;
      }
      win.focus();
      return true;
    } catch {
      return false;
    }
  }

  // Whether a tab element is the window's relay, asked by the channel (which
  // knows the tab it created) rather than re-derived from the URL.
  //
  // A relay that has not committed relay.html yet reports about:blank, so the
  // URL test cannot see it — and a tab the numbering counts that is not there
  // shifts every number after it. This is the same question splitview's
  // numbering asks, and the two MUST get the same answer: the count that
  // decides whether a typed digit is ambiguous and the index that digit selects
  // have to come from one list, or `;W m N` moves the wrong tab.
  let relayTabTest: (tab: any) => boolean = () => false;
  function setRelayTabTest(fn: (tab: any) => boolean): void {
    relayTabTest = fn || (() => false);
  }

  // Real (user) tabs in strip order: skip the split-panel companion and the
  // persistent relay so tab numbers stay stable across splits/unsplits. A real
  // tab carrying a momentary #lfc=keys/state hash is NOT transient — it must
  // keep its number (a shared predicate guarantees the chrome and the extension
  // agree). Dead wrappers (a tab torn down mid-collapse) are skipped, never
  // counted: any property access on them throws "can't access dead object".
  function realTabs(): any[] {
    const out: any[] = [];
    for (const t of win.gBrowser.tabs) {
      try {
        if (env.Cu && env.Cu.isDeadWrapper(t)) continue;
        if (relayTabTest(t)) continue;
        const spec =
          t && t.linkedBrowser && t.linkedBrowser.currentURI
            ? t.linkedBrowser.currentURI.spec
            : "";
        if (isRelayTabUrl(spec)) continue;
        out.push(t);
      } catch {
        // a half-torn-down tab is not a user tab
      }
    }
    return out;
  }

  // Mirrors the Go core's NormalizeUrl (scheme-less input gets https://). Any
  // caller can hand loadUrl raw user text (the URL popup's onEnter fallback, a
  // history item, etc.); a scheme-less string would otherwise make addTab/loadURI
  // fail, leaving a blank tab that never navigates.
  function loadableUrl(url: string): string {
    const t = (url || "").trim();
    if (!t) return t;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t;
    return "https://" + t;
  }

  function loadUrl(url: string, newTab: boolean | undefined): void {
    url = loadableUrl(url);
    if (!url) return;
    const openInNewTab = () => {
      try {
        const p = JSON.parse(env.services.prefs.getStringPref("lazyfox.chrome.config", "{}"));
        return (p as Config).openInNewTab !== false;
      } catch {
        return true;
      }
    };
    // newTab === true forces a new tab, newTab === false forces the current tab
    // (replace it), undefined defers to the openInNewTab config.
    const forceNew = newTab === undefined ? openInNewTab() : newTab;
    const browser = win.gBrowser.selectedBrowser;
    // The command center (home page) and blank/home tabs navigate in place: an
    // open there should reuse the tab instead of stacking up extra ones. This
    // matches the background's openUrl, which replaces the home page in place.
    let onHome = false;
    try {
      const u = browser && browser.currentURI ? browser.currentURI.spec : "";
      onHome = u.indexOf("commandcenter.html") !== -1 || /^about:(home|newtab|blank)$/i.test(u);
    } catch {
      onHome = false;
    }
    if (onHome || forceNew === false) {
      // fixupAndLoadURIString is the supported string-loading path (gBrowser
      // loadURI takes an nsIURI now, and passing a string throws); it is a no-op
      // fixup for our already-normalized URLs.
      const navInPlace = (): boolean => {
        try {
          if (typeof browser.fixupAndLoadURIString === "function") {
            browser.fixupAndLoadURIString(url, { triggeringPrincipal: sysPrincipal() });
            return true;
          }
          const uri = env.services.io.newURI(url);
          browser.loadURI(uri, { triggeringPrincipal: sysPrincipal() });
          return true;
        } catch (e) {
          console.error("lazyfox in-place load failed", e);
          return false;
        }
      };
      if (navInPlace()) {
        win.focus();
        return;
      }
    }
    win.gBrowser.selectedTab = win.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
    win.focus();
  }

  // Armed close: when ;x would remove the window's LAST tab (closing the whole
  // window), the first press arms a confirmation and a second press within 2.5s
  // actually closes.
  let closeArmed = false;
  let closeTimer: any = null;
  function disarmClose(): void {
    closeArmed = false;
    if (closeTimer) {
      env.clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function closeCurrentTabWithConfirm(): void {
    if (realTabs().length <= 1) {
      if (closeArmed) {
        disarmClose();
        win.gBrowser.removeCurrentTab();
        return;
      }
      closeArmed = true;
      closeTimer = env.setTimeout(disarmClose, 2500);
      toast("last tab — press ;x again to close the window");
      return;
    }
    win.gBrowser.removeCurrentTab();
  }

  /* ---------- native data sources ---------- */

  // Search suggestions from the default engine.
  function suggestSearch(q: string): Promise<PopupItem[]> {
    return new Promise<PopupItem[]>((resolve) => {
      const text = (q || "").trim();
      const entries: PopupItem[] = [];
      if (!text) {
        resolve(entries);
        return;
      }
      entries.push({
        kind: "search",
        title: "Search the web for \u201C" + text + "\u201D",
        query: text,
      });
      try {
        const SC = env.ChromeUtils!.importESModule(
          "resource://gre/modules/SearchSuggestionController.sys.mjs"
        ).SearchSuggestionController;
        env.services.search.getDefault().then((engine: any) => {
          const c = new SC();
          c.maxLocalResults = 5;
          c.maxRemoteResults = 4;
          c.fetch(text, false, engine)
            .then((res: any) => {
              const out: string[] = [];
              for (const s of (res && res.remote) || []) out.push(s);
              for (const s of (res && res.local) || []) {
                if (out.indexOf(s) === -1) out.push(s);
              }
              for (const s of out.slice(0, 9)) {
                entries.push({ kind: "search", title: "Search \u201C" + s + "\u201D", query: s });
              }
              resolve(entries);
            })
            .catch(() => resolve(entries));
        }).catch(() => resolve(entries));
      } catch {
        resolve(entries);
      }
    });
  }

  function histItems(text: string, maxResults: number): Array<{ title: string; url: string; time: number }> {
    const PlacesUtils = env.ChromeUtils!.importESModule(
      "resource://gre/modules/PlacesUtils.sys.mjs"
    ).PlacesUtils;
    const query = PlacesUtils.history.getNewQuery();
    if (text) query.searchTerms = text;
    const opts = PlacesUtils.history.getNewQueryOptions();
    opts.maxResults = maxResults;
    opts.queryType = opts.QUERY_TYPE_HISTORY;
    opts.sortingMode = env.Ci.nsINavHistoryQueryOptions.SORT_BY_DATE_DESCENDING;
    const root = PlacesUtils.history.executeQuery(query, opts).root;
    root.containerOpen = true;
    const out: Array<{ title: string; url: string; time: number }> = [];
    for (let i = 0; i < root.childCount; i++) {
      const n = root.getChild(i);
      if (n.type !== n.RESULT_TYPE_URI || !n.uri) continue;
      out.push({ title: n.title || n.uri, url: n.uri, time: n.time || 0 });
    }
    root.containerOpen = false;
    return out;
  }

  function doSearch(query: string, replace = false): void {
    const q = (query || "").trim();
    if (!q) return;
    // ;S (replace) opens the results in the current tab; ;s defers to config.
    const open = (url: string) => loadUrl(url, replace ? false : undefined);
    try {
      env.services.search.getDefault().then((engine: any) => {
        const sub = engine.getSubmission(q);
        open(sub.uri.spec);
      }).catch(() => {
        open("https://www.google.com/search?q=" + encodeURIComponent(q));
      });
    } catch {
      open("https://www.google.com/search?q=" + encodeURIComponent(q));
    }
  }

  return {
    sysPrincipal,
    openUrlNative,
    realTabs,
    loadUrl,
    closeCurrentTabWithConfirm,
    suggestSearch,
    histItems,
    doSearch,
    setRelayTabTest,
  };
}
