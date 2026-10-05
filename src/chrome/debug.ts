// Debug/verification commands for the #lfc= channel. These are dev-only
// paths (the test harness drives them through transient commandcenter tabs)
// that report the browser's live state so install problems and UI regressions
// are visible instead of silent. They are kept out of channel.ts so the
// router stays focused on the real commands.
//
// Each handler answers by navigating the request tab to a reply hash
// (`#lfc=<cmd>.<b64>.<nonce>`). The `state` command is the big one: it
// snapshots the chrome UI (toolbar display, popup, leader, status bar,
// split state) for end-to-end assertions.

import { toast } from "../shared/overlay";
import type { ChromeCfg } from "./config";
import type { ChromeEnv } from "./env";
import { createStateReader } from "./stateapi";

export interface DebugState {
  hasPopup(): boolean;
  leaderActive(): boolean;
  // The helper's own verdict on whether it owns the selected tab. Exposed
  // because ownership is the gate on every surface decision (keys AND pixels),
  // and a disagreement between what the helper believes and what it paints is
  // otherwise invisible from outside: the symptom is a ghost overlay with
  // nothing in the state explaining why it stayed.
  chromeOwnsKeys(): boolean;
  leaderPending(): boolean;
  lastAction(): string | null;
  lastMoveDebug(): string | null;
  statusMounted(): boolean;
  statusPosition(): string;
  dlActive(): string[];
  isFullscreen(): boolean;
  activeSplitView(): any;
  // The real (user) tab list, in the order the product numbers them.
  realTabs(): any[];
  cfg(): ChromeCfg;
  // The persistent relay's helper-side state (relayDebug from channel.ts).
  relay(): any;
}

export interface DebugDeps {
  // The chrome document as a parameter, not a global. Without it these four
  // handlers cannot be constructed in Node at all, which is exactly what this
  // dep buys: a test can drive the `#lfc=state` reply against a fake document
  // and assert the shape of the thing the e2e harness reads. See
  // src/chrome/env.ts.
  env: ChromeEnv;
  getState(): DebugState;
}

export interface DebugHandlers {
  handle(browser: any, cmd: string, rest: string, setHash: (browser: any, hash: string) => void): void;
  toast(msg: string): void;
}

const EXT_ID = "lazyfox@lazyfox.dev";

export function createDebug(deps: DebugDeps): DebugHandlers {
  const env = deps.env;
  const win = env.window as any;
  const doc = env.document as any;
  // The wire's own base64, not a global: the reply hash is the contract this
  // module has with the harness, so a test replays it through the same encoder.
  const btoa = (v: string): string => env.btoa(v);
  // The state contract lives in stateapi.ts; the handler below is transport.
  const reader = createStateReader({ env, getState: () => deps.getState() });

  function handleReveal(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Dev/verification: force the toolbar visible so tests can hover real
    // chrome buttons.
    try {
      const tb = doc.getElementById("navigator-toolbox");
      if (tb) {
        if (tb.hasAttribute("lf-debug-reveal")) tb.removeAttribute("lf-debug-reveal");
        else tb.setAttribute("lf-debug-reveal", "1");
      }
      setHash(browser, "#lfc=reveal." + rest);
    } catch (e) {
      // ignore
    }
  }

  function handleConsole(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: dump recent internal-console messages so
    // content-script exceptions are visible instead of silent.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    let json = "{}";
    try {
      const msgs: Array<{ t: string; m: string }> = [];
      const c = env.services.console;
      if (c && typeof c.getMessageCount === "function") {
        const n = c.getMessageCount();
        for (let i = Math.max(0, n - 60); i < n; i++) {
          try {
            const m = c.getMessageAt(i);
            const text = m && (m.message || m.errorMessage || "");
            const flag = m && m.flags;
            if (text) {
              const s = String(text);
              if (/lazyfox|content\.js|moz-extension|error|exception|referenceerror|typeerror|cannot|undefined/i.test(s)) {
                msgs.push({ t: String(flag || ""), m: s.slice(0, 400) });
              }
            }
          } catch (e) {
            // skip
          }
        }
      }
      json = btoa(JSON.stringify({ count: msgs.length, msgs: msgs.slice(0, 25) }));
    } catch (e) {
      json = btoa(JSON.stringify({ error: String(e) }));
    }
    setHash(browser, "#lfc=console." + json + "." + nonce);
  }

  function handleDiag(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: report the extension's live state inside the
    // browser — loaded policy, background context, content-script
    // registration — so install problems are visible instead of silent.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    let json = "{}";
    try {
      const p = env.WebExtensionPolicy.getByID(EXT_ID);
      let cs = null;
      try {
        if (p && p.contentScripts) {
          const arr = Array.from(p.contentScripts as Iterable<any>);
          cs = {
            count: arr.length,
            matches: arr.map((c: any) => (c.matches ? Array.from(c.matches) : [])),
            js: arr.map((c: any) => (c.jsPaths ? Array.from(c.jsPaths) : [])),
            props: arr.map((c: any) => Object.getOwnPropertyNames(c).slice(0, 30)),
            matchesType: arr.map((c: any) => (c.matches ? typeof c.matches + "/" + String(c.matches && c.matches.constructor && c.matches.constructor.name) : "none")),
            // Does the registered MatchPatternSet actually match web pages?
            matchesHttp: arr.map((c: any) => {
              try {
                if (!c.matches) return "no-matches";
                const urls = [
                  "http://127.0.0.1/x",
                  "http://example.com/x",
                  "https://example.com/x",
                  "file:///C:/x.html",
                ];
                const r: Record<string, unknown> = {};
                for (const u of urls) {
                  if (typeof c.matches.matches === "function") r[u] = c.matches.matches(u);
                  else r[u] = "no-matches-fn";
                }
                return r;
              } catch (e) {
                return { error: String(e) };
              }
            }),
            manifest: (p.extension && p.extension.manifest && p.extension.manifest.content_scripts) || null,
          };
        }
      } catch (e) {
        cs = { error: String(e) };
      }
      let bg = null;
      try {
        bg = p && p.backgroundContext ? true : false;
      } catch (e) {
        bg = String(e);
      }
      let e10s = null;
      try {
        e10s = env.services.appinfo.browserTabsRemoteAutostart;
      } catch (e) {
        e10s = String(e);
      }
      // The restricted-domain pref: Firefox blocks content scripts on
      // addons.mozilla.org / accounts.firefox.com etc unless it is emptied —
      // reported so install problems on those pages are visible instead of
      // silent (the shipped user.js sets it to "").
      let restrictedDomains = null;
      try {
        restrictedDomains = env.services.prefs.getStringPref("extensions.webextensions.restrictedDomains", "<unset>");
      } catch (e) {
        restrictedDomains = "<error: " + e + ">";
      }
      let perTab = null;
      try {
        const tab = win.gBrowser && win.gBrowser.selectedTab;
        const lb = tab && tab.linkedBrowser;
        perTab = lb ? { remote: lb.isRemoteBrowser, currentURI: lb.currentURI && lb.currentURI.spec } : null;
      } catch (e) {
        perTab = String(e);
      }
      json = btoa(JSON.stringify({
        exists: !!p,
        active: p ? p.active : false,
        bg: bg,
        e10s: e10s,
        restrictedDomains: restrictedDomains,
        perTab: perTab,
        contentScripts: cs,
        extUrl: p ? p.getURL("") : null,
      }));
    } catch (e) {
      json = btoa(JSON.stringify({ error: String(e) }));
    }
    setHash(browser, "#lfc=diag." + json + "." + nonce);
  }

  function handleState(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: report the actual chrome UI state. The URL
    // toolbar and tab strip are display:none unless the hover-reveal strip
    // shows them, so tests can assert the vanilla UI is really gone.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    // onLocationChange fires again for our own location.replace: dont
    // re-answer an already-answered query. The reply is
    // state.<base64>.<nonce> (two dots); the request state.<nonce> (one).
    try {
      const cur = browser.currentURI ? browser.currentURI.spec : "";
      const after = cur.indexOf("#lfc=state.") !== -1 ? cur.split("#lfc=state.")[1] : "";
      if (after && after.split(".").length >= 2) return;
    } catch (e) {
      // ignore
    }
    // The snapshot itself lives in stateapi.ts; this function is transport.
    // That split is what lets the contract be asserted in Node, with no wire.
    let payload: any;
    try {
      payload = reader.read();
    } catch (e) {
      // The reader is written not to throw. If it ever does, say so WITH a
      // version: an unversioned {error} blob is indistinguishable from a
      // state whose fields are all missing, which is how a broken reply once
      // read as a passing test.
      payload = { v: reader.version, ok: false, error: String(e) };
    }
    setHash(browser, "#lfc=state." + btoa(JSON.stringify(payload)) + "." + nonce);
  }

  return {
    handle(browser, cmd, rest, setHash) {
      if (cmd === "reveal") handleReveal(browser, rest, setHash);
      else if (cmd === "console") handleConsole(browser, rest, setHash);
      else if (cmd === "diag") handleDiag(browser, rest, setHash);
      else if (cmd === "state") handleState(browser, rest, setHash);
    },
    toast: (msg) => toast(msg),
  };
}
