// The relay TAB: finding it, creating it, keeping exactly one, and navigating it.
//
// Split out of channel.ts. The channel owns MESSAGES (a queue, reply waiters, a
// single URL slot); this owns the TAB those messages ride in. They are separate
// questions with separate failure modes: a message can be queued with no relay
// in the window, and a relay can exist carrying nothing. Folding them together
// is what made channel.ts the largest file in the chrome layer, and it is why
// the tab-identity rules below (by REFERENCE, not by URL) were easy to get wrong
// — they read as one-liners next to unrelated message code.
//
// It holds no message state at all. Its one input is the base-URL resolver,
// which it takes as a function so this module never imports channel.ts (the
// dependency runs one way: channel -> relaytab).

export interface RelayTabCtl {
  // The live <browser> carrying the relay page, or null when the window has
  // none. Re-resolved from the tab every call: the <browser>'s contentWindow
  // object is REPLACED when the page commits, so a value cached at creation
  // time points at the dead initial about:blank window.
  browser(): any;
  // That browser's current URL spec, or "".
  url(): string;
  // Navigate the relay tab. A fragment-only change stays same-document, which is
  // the case that matters (see load).
  load(url: string): void;
  // Same-document navigation back to the bare relay URL, freeing the slot.
  clearHash(): void;
  // Open a relay tab if the window has none. One per window, ever.
  create(): void;
  // Close every relay tab past the first. Session restore recreates the previous
  // relay while the helper is creating one at startup, and a stray second relay
  // means a second hidden page + content process for no benefit.
  dedupe(): void;
  // True when this tab element IS the window's relay, BY REFERENCE as well as by
  // URL — see the implementation for why the URL alone is not enough.
  isKnown(tab: any): boolean;
}

export interface RelayTabDeps {
  // Resolves the extension base URL (moz-extension://<hostname>/); null when
  // the extension is not resolvable, in which case create() does nothing.
  ccBaseUrl(): string | null;
}

export function createRelayTabCtl(deps: RelayTabDeps): RelayTabCtl {
  // The <browser> elements this window has seen carrying a relay page. A Set of
  // REFERENCES rather than of tabs: a relay created a moment ago still reports
  // about:blank until relay.html commits, and during that window it looks
  // exactly like a user tab. Anything that NUMBERS tabs must consult this set,
  // or a tab's number shifts by one for as long as the relay is settling — and
  // `;4` moves the wrong tab.
  const relayBrowsers = new Set<any>();

  // The cached { browser, tab }. Only ever a hint: every use re-resolves.
  let cached: { browser: any; tab: any } | null = null;

  // Any live <browser> in this window whose tab is a relay page — the one true
  // answer to "do we already have a relay?", regardless of which side created
  // it (chrome helper via addTab, or the background via browser.tabs.create).
  // Returns { browser, tab } or null.
  function find(): { browser: any; tab: any } | null {
    try {
      for (const t of window.gBrowser.tabs) {
        const b = t.linkedBrowser;
        if (!b) continue;
        let isRelay = false;
        try {
          isRelay = !!b.currentURI && b.currentURI.spec.indexOf("relay.html") !== -1;
        } catch (e) {
          // ignore
        }
        // A relay tab created a moment ago may still show about:blank; the
        // created-browsers set covers that window.
        if (!isRelay && relayBrowsers.has(b)) isRelay = true;
        if (!isRelay) continue;
        return { browser: b, tab: t };
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  // Resolve + cache the relay tab's { browser, tab }. Prunes a dead cache
  // (tab recreated after a death) and hides the tab natively (cosmetic — never
  // browser.tabs.hide(), which detaches the browsing context and nulls the
  // URL/loadURI path).
  function resolve(): { browser: any; tab: any } | null {
    for (const b of relayBrowsers) {
      try {
        if (!window.gBrowser.tabs.some((t: any) => t.linkedBrowser === b)) relayBrowsers.delete(b);
      } catch (e) {
        relayBrowsers.delete(b);
      }
    }
    const r = find();
    if (!r) return null;
    relayBrowsers.add(r.browser);
    try {
      r.tab.hidden = true; // cosmetic hide only (see above)
    } catch (e) {
      // ignore
    }
    cached = r;
    return r;
  }

  function browser(): any {
    const c = cached;
    if (c && c.browser) {
      try {
        if (window.gBrowser.tabs.some((t: any) => t.linkedBrowser === c.browser)) return c.browser;
      } catch (e) {
        // ignore
      }
    }
    const r = resolve();
    return r ? r.browser : null;
  }

  function url(): string {
    try {
      const b = browser();
      return (b && b.currentURI && b.currentURI.spec) || "";
    } catch (e) {
      return "";
    }
  }

  // Navigate the relay tab. Same-document hash changes (the common case) never
  // reload the page; even a full reload is survivable (the page re-connects its
  // port and re-reads the hash on pageshow). Works for remote
  // (out-of-process) tabs from the chrome side — plain navigation.
  function load(target: string): void {
    const b = browser();
    if (!b) return;
    try {
      // Fragment-only changes must stay same-document (no reload, no content
      // process churn per message): loadURI with an nsIURI preserves the
      // document for a pure fragment change, while fixupAndLoadURIString can
      // fix up a fragment-bearing URL into a FULL RELOAD (verified: the relay
      // page's boot counter incremented on every rq write / hash clear,
      // spinning a content process per message). loadURI accepts an nsIURI,
      // not a bare string.
      const uri = Services.io.newURI(target);
      b.loadURI(uri, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (e) {
      // ignore
    }
  }

  function clearHash(): void {
    if (!browser()) return;
    const base = deps.ccBaseUrl();
    if (!base) return;
    load(base + "relay.html");
  }

  function create(): void {
    // One relay per window, ever: if a relay already exists (helper-created or
    // background-created), never add another. Before this guard, a 500ms poll
    // that ran before the first relay's page committed (currentURI was still
    // about:blank) could spawn a duplicate relay tab every tick — the "tabs
    // flashing open and closed" + one content process per stray tab.
    if (find()) return;
    const base = deps.ccBaseUrl();
    if (!base) return;
    try {
      const tab = window.gBrowser.addTab(base + "relay.html", {
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      if (tab && tab.linkedBrowser) relayBrowsers.add(tab.linkedBrowser);
      cached = tab && tab.linkedBrowser ? { browser: tab.linkedBrowser, tab: tab } : null;
    } catch (e) {
      // ignore
    }
  }

  // Exactly one relay tab per window, ever. Session restore recreates the
  // previous relay tab while the helper is also creating one at startup, and a
  // stray second relay means a second hidden page + content process for no
  // benefit (and the "many processes on htop" the user saw). Called from
  // startRelay's 500ms poll, so any extra is closed within half a second.
  function dedupe(): void {
    try {
      const relays = Array.from(window.gBrowser.tabs).filter((t: any) => {
        try {
          return t.linkedBrowser && t.linkedBrowser.currentURI && t.linkedBrowser.currentURI.spec.indexOf("relay.html") !== -1;
        } catch (e) {
          return false;
        }
      });
      for (const extra of relays.slice(1)) {
        try {
          window.gBrowser.removeTab(extra);
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }

  function isKnown(tab: any): boolean {
    try {
      const b = tab && tab.linkedBrowser;
      if (!b) return false;
      if (relayBrowsers.has(b)) return true;
      const spec = b.currentURI && b.currentURI.spec;
      return !!spec && spec.indexOf("relay.html") !== -1;
    } catch (e) {
      return false;
    }
  }

  return { browser, url, load, clearHash, create, dedupe, isKnown };
}