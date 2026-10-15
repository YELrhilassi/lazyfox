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
  // Where the keyboard IS, as opposed to who owns the keys (see
  // stateapi.ChromeStateFocusV1 for why the two are different questions).
  // Declared structurally rather than imported, for the reason at the top of
  // this file: the e2e project typechecks it without the DOM lib.
  focus(): {
    activeWindow: boolean;
    focused: string | null;
    inSelectedContent: boolean;
    remote: boolean;
    docShellActive: boolean;
    focusedWindow: "this" | "other" | null;
    chromeActive: string | null;
    pageHasFocus: boolean | null;
  };
  /**
   * Re-apply the keyboard rule to the selected tab NOW, and report the decision
   * (`"content"`, `"command-center"` or `"none"`).
   *
   * Verification-only, and it exists because the rule is applied on EVENTS
   * (tab selected, document replaced, document loaded) and an event cannot be
   * replayed from a test: a case that finds the keyboard missing an instant
   * later has no way to ask "does the repair itself work, or did it just run at
   * the wrong moment?" — which are opposite diagnoses with opposite fixes. This
   * answers that question by running exactly the same rule the events run.
   */
  giveKeyboard(): string;
  leaderPending(): boolean;
  lastAction(): string | null;
  /**
   * The leader's table, and the keystrokes it is holding because the table has
   * not arrived (see ChromeStateV1.keymap). Without it, an armed leader that
   * cannot run a binding is indistinguishable from one that ran nothing.
   */
  keymap(): { ready: boolean; buffered: number };
  /**
   * The last keystrokes the dispatcher saw, with the branch each took.
   * Dev-only and in memory (see keysdispatch.ts); empty in a release build.
   */
  keyTrace(): Array<Record<string, unknown>>;
  /**
   * The live presence records, one per tab that has reported itself.
   *
   * `chromeOwnsKeys` answers from a record looked up ON THE SELECTED TAB, so
   * when it answers wrongly there are exactly two possibilities — nothing was
   * ever recorded for that tab, or the record is on a neighbour — and they have
   * opposite fixes. This names which, with the strip index each record is on at
   * the moment of the read (see keystate.presenceSnapshot).
   */
  presence(): Array<{ i: number; u: string; d: string }>;
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

  function handleBlur(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: put the KEYBOARD in the browser's own UI — the state a
    // user reaches by moving the mouse to the top of the window (the toolbar
    // reveals on hover) and clicking anything up there, or by any path that
    // leaves focus in the chrome after our own UI hid it again.
    //
    // It exists because that state cannot be produced from the e2e side at all:
    // Lazyfox HIDES the URL bar, so Ctrl+L focuses nothing there, and BiDi can
    // deliver a key to the focused document but cannot choose which chrome
    // element that is. The whole "Lazyfox stops responding until I click the
    // page" class lives in this state, so the harness has to be able to enter it.
    // The toolbox is revealed first (the same attribute `lfc=reveal` toggles): a
    // `display: none` ancestor makes an input unfocusable, so a URL bar that is
    // hidden would refuse the focus and this hook would silently do nothing.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    const how: Record<string, unknown> = {};
    try {
      const tb = doc.getElementById("navigator-toolbox");
      if (tb) tb.setAttribute("lf-debug-reveal", "1");
      how.revealed = !!tb;
    } catch (e) {
      how.revealed = "err:" + String(e);
    }
    try {
      const urlbar = win.gURLBar || (win.document && win.document.getElementById("urlbar"));
      if (urlbar && typeof urlbar.focus === "function") urlbar.focus();
      how.urlbar = !!urlbar;
    } catch (e) {
      how.urlbar = "err:" + String(e);
    }
    try {
      how.focused = String((env.services.focus && env.services.focus.focusedElement && env.services.focus.focusedElement.tagName) || "") || null;
    } catch (e) {
      how.focused = "err";
    }
    setHash(browser, "#lfc=blur." + btoa(JSON.stringify(how)) + "." + nonce);
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

  function handleFocus(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: run the keyboard rule NOW and report what happened to
    // it. See DebugState.giveKeyboard for why the rule has to be runnable on
    // demand: "the repair does not work" and "the repair ran too early" are
    // opposite diagnoses, and a test that can only observe the second one cannot
    // tell them apart.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    // onLocationChange fires again for our own location.replace, and this
    // handler's reply carries the SAME command name as its request — so without
    // this guard it re-answers its own answer, for ever, leaving the tab's URL
    // holding a focus reply that the `#lfc=keys` channel then trips over. The
    // same rule (and the same two-dots test) as handleState.
    try {
      const cur = browser.currentURI ? browser.currentURI.spec : "";
      const after = cur.indexOf("#lfc=focus.") !== -1 ? cur.split("#lfc=focus.")[1] : "";
      if (after && after.split(".").length >= 2) return;
    } catch (e) {
      // an unreadable URL re-answers, which is the old behaviour
    }
    let json = "{}";
    try {
      const decision = deps.getState().giveKeyboard();
      json = btoa(JSON.stringify({ decision, focus: deps.getState().focus() }));
    } catch (e) {
      json = btoa(JSON.stringify({ error: String(e) }));
    }
    setHash(browser, "#lfc=focus." + json + "." + nonce);
  }

  return {
    handle(browser, cmd, rest, setHash) {
      if (cmd === "reveal") handleReveal(browser, rest, setHash);
      else if (cmd === "blur") handleBlur(browser, rest, setHash);
      else if (cmd === "console") handleConsole(browser, rest, setHash);
      else if (cmd === "diag") handleDiag(browser, rest, setHash);
      else if (cmd === "state") handleState(browser, rest, setHash);
      else if (cmd === "focus") handleFocus(browser, rest, setHash);
    },
    toast: (msg) => toast(msg),
  };
}
