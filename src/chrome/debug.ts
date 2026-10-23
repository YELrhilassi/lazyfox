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
  /** Is the window painting a SPLIT page's which-key menu? (wkglobal.ts) */
  pageWhichKey(): boolean;
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
   * THE KEYBOARD DECISION, and the reasons a repair would be refused: the one
   * field that answers the freeze report (see stateapi.ChromeStateKeyboardV1).
   *
   * Declared structurally, like `focus` above and for the same reason.
   */
  keyboard(): {
    owns: boolean;
    inPage: boolean;
    devtools: boolean;
    chromeField: { active: string | null; onScreen: boolean; hasUserText: boolean };
    veto: boolean;
  };
  /**
   * Dev/verification: drop the selected tab's presence record, and report what
   * it named. See keystate.dropPresenceForSelectedTab for why the state has to be
   * produced this way rather than by any user input.
   */
  forgetPresence(): { had: boolean; url: string };
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
  // The navigation-scoped expectation window and how long the last one lasted —
  // the one ownership fact that is a TIMER, and so the one a failure report
  // cannot infer from presence records or URLs (see stateapi's ChromeStateV1).
  expectation(): { open: boolean; ageMs: number; leftMs: number; gapMs: number; gapSamples: number; doc: string };
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

  /**
   * Has `cmd` ALREADY been answered in this tab's URL?
   *
   * A command whose reply hash carries the SAME command name as its request is
   * re-entered by its own reply: the reply is a `#lfc=` hash on a moz-extension
   * URL, so onLocationChange routes it straight back to this handler. Each
   * handler therefore has to recognise its own answer ("a reply has two dots, a
   * request has one") or it answers for ever.
   *
   * It is a named function because THREE handlers now need it (`state`,
   * `focus`, `blur`) and the trap is silent: a handler without the guard still
   * looks like it works — it writes a correct-looking reply hash — while the
   * loop it starts overwrites that reply with a new one on every tick, so the
   * reader it was written for never sees the nonce it is waiting on. Measured
   * this way: `#lfc=blur` never answered at all, and the browser was rewritten
   * dozens of times per second under a harness that had given up.
   */
  function alreadyAnswered(browser: any, cmd: string): boolean {
    try {
      const cur = browser.currentURI ? browser.currentURI.spec : "";
      const marker = "#lfc=" + cmd + ".";
      const at = cur.indexOf(marker);
      if (at < 0) return false;
      return cur.slice(at + marker.length).split(".").length >= 2;
    } catch (e) {
      // An unreadable URL re-answers, which is the old behaviour.
      return false;
    }
  }

  function handleBlur(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // The reply carries this command's own name, so the reply re-enters here —
    // see alreadyAnswered.
    if (alreadyAnswered(browser, "blur")) return;
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
    // WHAT THE URL BAR ITSELF SAYS about the text it is holding.
    //
    // The repair this state exists to test has to distinguish "a chrome field the
    // user is composing in" (the caret is theirs) from "the URL bar showing the
    // page's own address" (which is not a composition, and must not veto
    // anything) — and the field's VALUE cannot tell those apart, because the page
    // address is text too. Reported here so the distinction is measured rather
    // than assumed: `usertyping` is Firefox's own "the user typed this" flag, and
    // the selection says whether the address is still the selected-all default.
    try {
      const ub: any = win.gURLBar || null;
      const input: any = (ub && (ub.inputField || doc.getElementById("urlbar-input"))) || null;
      how.urlbarValue = input ? String(input.value || "").slice(0, 48) : null;
      how.urlbarSel = input && typeof input.selectionStart === "number" ? [input.selectionStart, input.selectionEnd] : null;
      how.usertyping = ub && typeof ub.getAttribute === "function" ? ub.getAttribute("usertyping") : null;
      how.inputUsertyping = input && typeof input.getAttribute === "function" ? input.getAttribute("usertyping") : null;
      how.userTypedValue = ub ? String(ub.userTypedValue === null || ub.userTypedValue === undefined ? "<none>" : ub.userTypedValue) : null;
      how.valueIsTyped = ub ? String(ub.valueIsTyped) : null;
    } catch (e) {
      how.urlbarState = "err:" + String(e);
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
    if (alreadyAnswered(browser, "state")) return;
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

  function handleForget(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Dev/verification: forget the SELECTED tab's presence record, so the harness
    // can be in the state the field report describes — the helper answering a live
    // page's keys — without waiting for the rare real-world paths into it (see
    // keystate.dropPresenceForSelectedTab). The reply carries this command's own
    // name, so the guard is required: see alreadyAnswered.
    if (alreadyAnswered(browser, "forget")) return;
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    let json = "{}";
    try {
      json = btoa(JSON.stringify(deps.getState().forgetPresence()));
    } catch (e) {
      json = btoa(JSON.stringify({ error: String(e) }));
    }
    setHash(browser, "#lfc=forget." + json + "." + nonce);
  }

  /**
   * Debug/verification: put TEXT in the URL bar, mark it the way Firefox marks a
   * field the user typed into, and show or hide the toolbar.
   *
   * THE STATE THIS PRODUCES IS THE REPORTED FREEZE, and it cannot be produced any
   * other way. Lazyfox's chrome CSS renders the URL bar with `display:none` (it is
   * a hover overlay); Firefox still parks the keyboard in it on a fresh tab, and a
   * stray keystroke from a frozen page lands in it. That single character makes
   * the URL bar report "the user is typing here" (`usertyping`,
   * `valueIsTyped`) — and before chrome/chromefield.ts, that report vetoed EVERY
   * rescue on every key, invisibly, for the life of the window, which is why the
   * user's only repair was a click. `handleBlur` cannot reach this state: it
   * reveals the toolbar first, because a `display:none` element refuses focus.
   *
   * The arguments are `{ text?, show?, focus?, typed? }` as base64 JSON, and
   * they ride the request as `<args>~<nonce>`: a `#lfc=` request may carry ONE
   * dot after the command name (a reply carries two — see alreadyAnswered), and
   * every other command's payload is the nonce itself. A separate separator is
   * what keeps this one's request from looking like its own answer.
   *   * `show: true` reveals the toolbar (the product's own `lf-debug-reveal`),
   *     `show: false` hides it again — after the focus, so the field keeps the
   *     keyboard while being unrenderable, which is the reported state;
   *   * `text` is written into the field (and onto the URL bar element, which is
   *     where Firefox keeps the value it is displaying);
   *   * `typed` sets the two signals Firefox itself sets while a user types — the
   *     `usertyping` ATTRIBUTE (the same string the browser writes) and the URL
   *     bar's own `_valueIsTyped` — and the reply reports WHICH of them took,
   *     because a test that asserts behaviour in this state must first assert
   *     that the state is real.
   *
   * The reply also measures the field's box, so "the toolbar is hidden" is a fact
   * about the running window rather than a claim about the stylesheet.
   */
  function handleUrlText(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    if (alreadyAnswered(browser, "urltext")) return;
    const tilde = rest.indexOf("~");
    const nonce = tilde < 0 ? rest : rest.slice(tilde + 1);
    let want: any = {};
    try {
      want = JSON.parse(atob(tilde < 0 ? "" : rest.slice(0, tilde)));
    } catch (e) {
      want = {};
    }
    const how: Record<string, unknown> = {}
    try {
      const ub: any = win.gURLBar || null;
      const input: any = (ub && (ub.inputField || doc.getElementById("urlbar-input"))) || null;
      const tb: any = doc.getElementById("navigator-toolbox");
      // 1. THE TEXT. Written to both, because the element is what Firefox keeps
      //    its own value on and the input is what a key would land in.
      if (typeof want.text === "string") {
        try {
          if (input) input.value = want.text;
        } catch (e) {
          how.textOnInput = "err";
        }
        try {
          if (ub) ub.value = want.text;
        } catch (e) {
          how.textOnUrlbar = "err";
        }
      }
      // 2. THE FOCUS, while the field is still renderable if it is about to be
      //    hidden: `display:none` refuses a focus call outright, and the state
      //    under test is a field that HOLDS the keyboard while it cannot be seen.
      if (want.show === true || (want.show !== false && want.focus === true)) {
        try {
          if (tb) tb.setAttribute("lf-debug-reveal", "1");
        } catch (e) {
          how.reveal = "err";
        }
      }
      if (want.focus === true) {
        try {
          if (ub && typeof ub.focus === "function") ub.focus();
          else if (input && typeof input.focus === "function") input.focus();
        } catch (e) {
          how.focus = "err:" + String(e);
        }
      }
      // 3. THE USER-TYPING SIGNALS, through Firefox's own carriers. `usertyping`
      //    is the attribute the URL bar sets on itself while the user edits it;
      //    the private flag is what `valueIsTyped` reads on builds that expose
      //    it. Setting them is exactly what typing would do, and the reply says
      //    whether each one is now REPORTED by the element.
      if (want.typed === true) {
        try {
          if (input && typeof input.setAttribute === "function") input.setAttribute("usertyping", "true");
        } catch (e) {
          how.usertyping = "err";
        }
        try {
          if (ub) ub._valueIsTyped = true;
        } catch (e) {
          how.privateFlag = "err";
        }
      }
      // 4. THE HIDING, LAST — so the field keeps what it was given.
      if (want.show === false) {
        try {
          if (tb) tb.removeAttribute("lf-debug-reveal");
        } catch (e) {
          how.hide = "err";
        }
      }
      // 5. WHAT IS TRUE NOW, measured.
      try {
        how.text = ub ? String(ub.value || "").slice(0, 64) : null;
        how.inputText = input ? String(input.value || "").slice(0, 64) : null;
        how.usertypingAttr = input && typeof input.getAttribute === "function" ? input.getAttribute("usertyping") : null;
        how.valueIsTyped = ub ? String(ub.valueIsTyped) : null;
      } catch (e) {
        how.readback = "err";
      }
      try {
        const nav = doc.getElementById("nav-bar");
        const r = nav && typeof nav.getBoundingClientRect === "function" ? nav.getBoundingClientRect() : null;
        how.navDisplay = nav ? String(env.window.getComputedStyle(nav).display) : null;
        how.navRect = r ? [Math.round(r.width), Math.round(r.height)] : null;
        const ir = input && typeof input.getBoundingClientRect === "function" ? input.getBoundingClientRect() : null;
        how.inputRect = ir ? [Math.round(ir.width), Math.round(ir.height)] : null;
        how.fieldOnScreen = !!input && typeof input.checkVisibility === "function" ? input.checkVisibility() : null;
      } catch (e) {
        how.boxes = "err:" + String(e);
      }
      try {
        how.focusedTag = String((env.services.focus && env.services.focus.focusedElement && env.services.focus.focusedElement.tagName) || "") || null;
        how.isUrlBarFocus = !!(env.services.focus && env.services.focus.focusedElement && input && env.services.focus.focusedElement === input);
      } catch (e) {
        how.focused = "err";
      }
      how.toolbox = tb ? (tb.hasAttribute("lf-debug-reveal") ? "revealed" : "hidden") : null;
    } catch (e) {
      // An unreadable window reports why rather than nothing.
      how.error = String(e);
    }
    setHash(browser, "#lfc=urltext." + btoa(JSON.stringify(how)) + "." + nonce);
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
    if (alreadyAnswered(browser, "focus")) return;
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
      else if (cmd === "urltext") handleUrlText(browser, rest, setHash);
      else if (cmd === "forget") handleForget(browser, rest, setHash);
      else if (cmd === "console") handleConsole(browser, rest, setHash);
      else if (cmd === "diag") handleDiag(browser, rest, setHash);
      else if (cmd === "state") handleState(browser, rest, setHash);
      else if (cmd === "focus") handleFocus(browser, rest, setHash);
    },
    toast: (msg) => toast(msg),
  };
}
