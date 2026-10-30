// The chrome state contract, versioned. `#lfc=state` is how the e2e harness
// sees chrome: an unversioned blob cost real time already (a missing field is
// indistinguishable from a null one), so the reader must recognise `v` or
// refuse the reply. Assembly lives here, not in the handler — one answer to
// "what is chrome's state?", assertable in Node against a fake env.
import type { ChromeEnv } from "./env";

// The e2e project imports this module for the contract alone, typechecked
// without the DOM lib — importing `./debug` would drag debug.ts (and through it
// shared/overlay.ts and chrome/config.ts) into a project that cannot type them.
// The shapes are structural, so DebugState satisfies these without either side
// importing the other.

// The relay tab and the LOST-COMMAND COUNTER.
// A presence report travels four fire-and-forget hops and its loss is silent:
// the helper keeps owning a live page's keys. `gaps`/`lastGap` make that a
// number and name the hop — `relayLost` = the relay PAGE discarded them (TTL or
// 64-command cap), `lostBeforeRelay` = the background never handed them over.
// `relayResetSeen` is the honesty flag: a new relay tab restarts at zero, so
// the first gap after that restart is the weaker attribution. The rest is the
// relay's liveness readout.
export interface ChromeStateRelayV1 {
  ready: boolean;
  /** Commands dispatched with a stamp. */
  recv: number;
  /** Jumps forward in the background's sequence: lost commands. */
  gaps: number;
  /** Commands that arrived at or below the highest sequence seen. */
  outOfOrder: number;
  /** The most recent gap, or null. */
  lastGap: {
    at: number;
    from: number;
    to: number;
    missing: number;
    relayLost: number;
    neverReachedRelay: number;
    slot: string;
  } | null;
  lostInRelay: number;
  lostBeforeRelay: number;
  relayResetSeen: boolean;
  urlSlot: string | null;
  pending: number;
  awaiting: number;
  [k: string]: unknown;
}

export interface ChromeStateSource {
  hasPopup(): boolean;
  leaderActive(): boolean;
  /** Is the window painting a SPLIT page's which-key menu? (wkglobal.ts) */
  pageWhichKey(): boolean;
  chromeOwnsKeys(): boolean;
  /** Where the keyboard is — see ChromeStateFocusV1. Never a decision input. */
  focus(): ChromeStateFocusV1;
  /** The keyboard decision and its inputs — see ChromeStateKeyboardV1. */
  keyboard(): ChromeStateKeyboardV1;
  leaderPending(): boolean;
  lastAction(): string | null;
  /** The leader's table state — see ChromeStateV1.keymap. */
  keymap(): { ready: boolean; buffered: number };
  /** The dispatcher's key trace — see ChromeStateV1.keyTrace. */
  keyTrace(): Array<Record<string, unknown>>;
  /** The live presence records — see ChromeStateV1.presence. */
  presence(): Array<{ i: number; u: string; d: string }>;
  /** The expectation window for the selected tab — see ChromeStateV1.expect. */
  expectation(): { open: boolean; ageMs: number; leftMs: number; gapMs: number; gapSamples: number; doc: string };
  lastMoveDebug(): string | null;
  statusMounted(): boolean;
  statusPosition(): string;
  dlActive(): string[];
  isFullscreen(): boolean;
  activeSplitView(): any;
  realTabs(): any[];
  /** The relay's liveness and the lost-command counter — see ChromeStateRelayV1. */
  relay(): ChromeStateRelayV1;
}

/** The version of the reply this build speaks. Bump on any breaking change. */
export const CHROME_STATE_VERSION = 1;

/** One row of the product's own tab numbering, as published by `realTabs`. */
export interface ChromeStateTabV1 {
  /** 1-based, the number the user types. */
  n: number;
  /** URL tail, query stripped, moz-extension rewritten to `ext:`. */
  u: string;
  /** Split-view id, or -1 when the tab is not in a split. */
  sv: number;
  pinned: boolean;
}

/** One raw strip row: what is physically in the tab strip, probe tabs included. */
export interface ChromeStateStripRowV1 {
  /** 0-based strip index. NOT a user-visible number — use `realTabs`. */
  i: number;
  u: string;
  sv: number;
  panel: boolean;
  /** True for a `#lfc=` command tab, which the product treats as transient. */
  req: boolean;
}

export interface ChromeStatePopupV1 {
  current: boolean;
  wkOn: number;
  rootInputs: number;
  panels: Array<{ title: string; hasInput: boolean; status: string }>;
  items: string[];
  selIdx: number[];
  // Every popup input's value, in document order. "The filter did not apply"
  // and "the keys never reached the input" are indistinguishable from `items`
  // alone; the chrome popup re-creates its <input>, so this also says whether
  // the field being typed into is the one the popup built.
  inputValues: string[];
}

// Where the browser's OWN keyboard focus is. "Who owns the keys" and "who has
// the KEYBOARD" are different questions, and only the second explains the
// report this readout exists for: the page is alive, the helper defers to it,
// and no key arrives — because focus sits in the browser's own UI. The fields
// below `focused` answer "why is `focused` null": another window has the
// keyboard, or the selected document is out-of-process. Measured on the
// command center after a tab switch: `focused: null` with `chromeActive:
// "browser"` and `pageHasFocus: true` — trusting `focused` alone would call a
// working page dead. No decision reads any of this.
export interface ChromeStateFocusV1 {
  /** The window is the OS-active one (`Services.focus.activeWindow === win`). */
  activeWindow: boolean;
  /** The element the browser says has the keyboard, as `tag#id`, or null. */
  focused: string | null;
  /** That element is the SELECTED tab's content (its <browser>, or inside it). */
  inSelectedContent: boolean;
  /** The selected tab's document runs in another process. */
  remote: boolean;
  /** The selected tab's docshell is the active one (`docShell.isActive`). */
  docShellActive: boolean;
  /** Whether the keyboard's window is THIS window, another one, or unknown. */
  focusedWindow: "this" | "other" | null;
  /** What the chrome document's own `activeElement` is, as `tag#id`, or null. */
  chromeActive: string | null;
  /** The selected page's own `document.hasFocus()`, or null when unaskable. */
  pageHasFocus: boolean | null;
}

// The keyboard decision, as the facts it is made from. Every other field of
// this reply can be right while the user's keyboard is dead: keys are delivered
// to the FOCUSED document and nowhere else, so `owns` true with `inPage` false
// means every key silently does nothing — `;` and `;r` working while
// `j`/`k`/hints/find are dead.
// `veto` is the other half of the same report: a repair vetoed every time,
// invisibly, looks identical to one that was never wired up.
export interface ChromeStateKeyboardV1 {
  /** The chrome helper answers this page's keys (`keystate.chromeOwnsKeys`). */
  owns: boolean;
  /** The keyboard is in the SELECTED page's content — the same gate the repair asks. */
  inPage: boolean;
  /** Selected tab is a Firefox dev surface: no claim, no repair — CORRECT silence. */
  devtools: boolean;
  // The browser-UI field the caret is in, if any — what a veto would be FOR.
  // `hasUserText` is "holds text the user typed" (not "holds text": the URL bar
  // showing the page's own address must answer no — see chromefield.ts).
  chromeField: { active: string | null; onScreen: boolean; hasUserText: boolean };
  // A repair asked for by a PLAIN key would be refused right now. The leader
  // key is never vetoed, so `true` here means "the next letter key will not fix
  // this state", not "the rescue is broken". With owns !== inPage, this is the
  // reported freeze with its reason attached.
  veto: boolean;
}

export interface ChromeStateV1 {
  /** The reply's contract version. Always present. */
  v: number;
  // Whether the snapshot completed. `ok: false` means the fields below are
  // partial or absent — check this before trusting anything; `error` carries
  // the reason.
  ok: boolean;
  error?: string;

  // --- identity / environment -------------------------------------------------
  profileLeaf: string;
  restrictedDomains: string;
  /** The relay tab, plus the lost-command counter — see ChromeStateRelayV1. */
  relay: ChromeStateRelayV1 | { error: string } | null;

  // --- chrome UI --------------------------------------------------------------
  popup: ChromeStatePopupV1 | { error: string };
  navDisplay: string;
  tabsDisplay: string;
  toolboxDisplay: string;
  toolboxHeight: number;
  hoverReveal: boolean;
  toolboxHover: boolean;

  // --- ownership --------------------------------------------------------------
  leaderActive: boolean;
  // A split pane's which-key menu, painted by the WINDOW because a page's own
  // overlay is clipped to its half. False on every non-split page.
  pageWhichKey: boolean;
  chromeOwnsKeys: boolean;
  leaderPending: boolean;
  lastAction: string | null;
  lastMoveDebug: string | null;
  selUrl: string;
  /** Where the keyboard actually is — see ChromeStateFocusV1. */
  focus: ChromeStateFocusV1 | { error: string };
  /** The keyboard decision and the reasons a repair would not run. */
  keyboard: ChromeStateKeyboardV1 | { error: string };
  // "Armed and nothing ran" versus "armed and the keymap never loaded" look
  // identical from every other field, and have different fixes.
  keymap: { ready: boolean; buffered: number };
  // Last keystrokes the dispatcher saw, newest last, with branch (`br`) and
  // consumed (`c`). Dev-only: a release build records nothing. Separates "the
  // key did nothing" from "the key never arrived".
  keyTrace: Array<Record<string, unknown>>;
  // The NAVIGATION-SCOPED EXPECTATION WINDOW. A declined key is
  // indistinguishable from an unanswered one, so a failure report names the
  // window: `open` + `ageMs` inside the window = the key was handed to a
  // document that had not reported yet. `gapMs` is the window's latency
  // measurement (arming is a navigation notice, closing is the page's boot
  // report); -1 = no window closed early this session. `doc` is the document
  // Firefox reported in the tab when the last arming question was asked — not
  // always the tab's URL (`about:neterror` keeps the requested address and can
  // never report, so the window must not be armed for it).
  expect:
    | { open: boolean; ageMs: number; leftMs: number; gapMs: number; gapSamples: number; doc: string }
    | { error: string };
  // Documents that have TOLD the helper they are alive, one row per tab.
  // Separates "no record was ever placed for this tab" from "one was placed on
  // a neighbour" — two causes of the same misread of chromeOwnsKeys, with
  // opposite fixes (placement versus reporting).
  presence: Array<{ i: number; u: string; d: string }>;

  // --- tabs -------------------------------------------------------------------
  mutedCount: number;
  /** The product's own 1-based numbering. Anything positioning a tab uses this. */
  realTabs: ChromeStateTabV1[] | { error: string };
  /** The raw strip, including `#lfc=` command tabs. */
  strip: ChromeStateStripRowV1[] | { error: string };

  // --- status bar -------------------------------------------------------------
  statusMounted: boolean;
  statusPosition: string;
  /** The rendered strip the status bar mirrors onto the document root. */
  statusAttr: string | null;

  // --- downloads / fullscreen / split ----------------------------------------
  dlCount: number;
  dlActive: string[];
  fullscreen: boolean;
  inDOMFullscreen: boolean;
  browserReserve: { mb: string; mt: string; h: number } | null;
  nativeSplit: any;
}

export interface StateReaderDeps {
  env: ChromeEnv;
  getState(): ChromeStateSource;
}

export interface StateReader {
  // Assemble one snapshot; never throws. A FIELD that cannot be read is a
  // degradation (snapshot completes, listed in `degraded`, `ok` stays true); a
  // SOURCE that cannot answer at all makes the whole read `ok: false`. The
  // ownership verdicts are deliberately fatal, not defaulted: `chromeOwnsKeys`
  // gates every key decision, and defaulting it to false would read a broken
  // helper as a healthy idle one.
  read(): ChromeStateV1;
  /** The version this build speaks. The handler stamps it into every reply. */
  version: number;
}

// Every field is computed defensively, as the inline handler did: a torn-down
// tab must not turn a state read into a failed read. The improvement is that
// the failure is reported, not smuggled — the old handler answered `{error}`
// with no version, which the harness read as a state with every field missing.
export function createStateReader(deps: StateReaderDeps): StateReader {
  const env = deps.env;
  const doc = env.document as any;
  const win = env.window as any;
  // Outlives a failed readUnsafe() so `read()` can report which accessors died.
  const failed: { unreadable?: string[] } = {};

  function read(): ChromeStateV1 {
    try {
      return readUnsafe();
    } catch (e) {
      const unreadable = failed.unreadable || [];
      const error =
        String(e) + (unreadable.length ? ` (unreadable: ${unreadable.join(", ")})` : "");
      return { v: CHROME_STATE_VERSION, ok: false, error, unreadable } as any;
    }
  }

  function readUnsafe(): ChromeStateV1 {
    let st: ChromeStateSource;
    try {
      st = deps.getState();
    } catch (e) {
      // The chrome helper itself is unreachable: no honest empty snapshot.
      return { v: CHROME_STATE_VERSION, ok: false, error: String(e) } as ChromeStateV1;
    }
    const partial: any = { v: CHROME_STATE_VERSION, ok: true };

    // The ownership verdicts — the product's own decision gates — are not
    // degradable: see StateReader for why a default would lie.
    const verdict = <T>(name: string, fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        partial.ok = false;
        partial.error = String(e);
        failed.unreadable = failed.unreadable || [];
        failed.unreadable.push(name);
        throw e;
      }
    };

    const step = <T>(name: string, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (e) {
        // One dead field keeps the rest of the snapshot: the whole reply is
        // worth more than any one field, and the read DID complete.
        partial.degraded = partial.degraded || [];
        partial.degraded.push({ field: name, error: String(e) });
        return fallback;
      }
    };

    // --- identity / environment ---------------------------------------------
    partial.profileLeaf = step(
      "profileLeaf",
      () => {
        const f = env.services.dirsvc.get("ProfD", env.Ci.nsIFile);
        return f ? String(f.leafName || "") : "<null>";
      },
      "<error>"
    );
    partial.restrictedDomains = step(
      "restrictedDomains",
      () => env.services.prefs.getStringPref("extensions.webextensions.restrictedDomains", "<unset>"),
      "<error>"
    );
    partial.relay = step("relay", () => st.relay(), null);
    // The loader's own failure channel: config.js and the window actor report
    // via Services.console.logStringMessage, which only the browser console
    // shows — nobody watches it when a feature silently fails. Carrying the
    // lazyfox lines here turns a missing capability into a diagnostic.
    partial.lfConsole = step(
      "lfConsole",
      () => {
        const svc =
          env.Cc && env.Cc["@mozilla.org/consoleservice;1"]
            ? env.Cc["@mozilla.org/consoleservice;1"].getService(env.Ci.nsIConsoleService)
            : null;
        if (!svc || typeof svc.getMessageArray !== "function") return { available: false };
        const msgs = svc.getMessageArray() as any[];
        return (msgs || [])
          .map((m) => String((m && (m.message || m.errorMessage)) || ""))
          .filter((s) => /lazyfox/i.test(s))
          .slice(-12);
      },
      [] as any
    );

    // --- popup ---------------------------------------------------------------
    partial.popup = step("popup", () => {
      const panels = Array.from(doc.querySelectorAll(".lf-panel")) as any[];
      const items = (p: any) => Array.from(p.querySelectorAll(".lf-item")) as any[];
      // Across the WHOLE document, not per panel: a popup input can be
      // re-created outside its panel.
      const inputs = Array.from(doc.querySelectorAll(".lf-input")) as any[];
      return {
        current: st.hasPopup(),
        // From the document attribute, not `.wk.on`: the overlay host has a
        // CLOSED shadow root we cannot see into (it always answered 0).
        wkOn: doc.documentElement.getAttribute("data-lf-whichkey") === "1" ? 1 : 0,
        rootInputs: doc.querySelectorAll(".lf-popup .lf-input").length,
        panels: panels.map((p) => ({
          // The panel's name is an attribute now (there is no header strip):
          // the caller writes data-lf-title and the mirror reads it too.
          title: (p.querySelector(".lf-panel") || {}).getAttribute?.("data-lf-title") || "",
          hasInput: !!p.querySelector(".lf-input"),
          status: (p.querySelector(".lf-status") || { textContent: "" }).textContent || "",
        })),
        items: panels.map((p) => items(p).map((it) => (it.textContent || "").trim()).slice(0, 40))
          .reduce((a: string[], b: string[]) => a.concat(b), []),
        selIdx: panels.map((p) => items(p).findIndex((it) => it.classList.contains("selected"))),
        inputValues: inputs.map((i) => String(i.value ?? "")),
      } as ChromeStatePopupV1;
    }, { error: "popup unavailable" } as any);

    // --- chrome UI -----------------------------------------------------------
    const el = (id: string) => doc.getElementById(id);
    const stEl = (node: any) => (node ? env.getComputedStyle(node).display : "missing");
    const nav = el("nav-bar");
    const tabs = el("TabsToolbar");
    const toolbox = el("navigator-toolbox");
    partial.navDisplay = step("navDisplay", () => stEl(nav), "missing");
    partial.tabsDisplay = step("tabsDisplay", () => stEl(tabs), "missing");
    partial.toolboxDisplay = step("toolboxDisplay", () => stEl(toolbox), "missing");
    partial.toolboxHeight = step(
      "toolboxHeight",
      () => {
        const br = toolbox ? toolbox.getBoundingClientRect() : null;
        return br ? Math.round(br.height) : -1;
      },
      -1
    );
    partial.hoverReveal = step("hoverReveal", () => env.services.prefs.getBoolPref("lazyfox.hoverReveal", false), false);
    partial.toolboxHover = step("toolboxHover", () => (toolbox ? toolbox.matches(":hover") : false), false);

    // --- ownership -----------------------------------------------------------
    partial.leaderActive = verdict("leaderActive", () => st.leaderActive());
    partial.pageWhichKey = step("pageWhichKey", () => st.pageWhichKey(), false);
    partial.chromeOwnsKeys = verdict("chromeOwnsKeys", () => st.chromeOwnsKeys());
    partial.leaderPending = verdict("leaderPending", () => st.leaderPending());
    partial.lastAction = verdict("lastAction", () => st.lastAction());
    partial.lastMoveDebug = verdict("lastMoveDebug", () => st.lastMoveDebug());
    partial.keymap = step("keymap", () => st.keymap(), { ready: false, buffered: -1 } as any);
    partial.keyTrace = step("keyTrace", () => st.keyTrace(), [] as any);
    // Shortened the way `strip` is, so a presence row compares with a strip row.
    partial.presence = step(
      "presence",
      () =>
        (st.presence() || []).map((r) => ({
          i: r.i,
          u: (String(r.u || "").split("?")[0] || "").replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(-40),
          d: String(r.d || ""),
        })),
      [] as any,
    );
    partial.expect = step("expect", () => st.expectation(), { error: "expectation unavailable" } as any);
    partial.selUrl = step("selUrl", () => {
      const u = win.gBrowser.selectedBrowser && win.gBrowser.selectedBrowser.currentURI;
      return u ? String(u.spec) : "?";
    }, "err");
    partial.focus = step("focus", () => st.focus(), { error: "focus unavailable" } as any);
    partial.keyboard = step("keyboard", () => st.keyboard(), { error: "keyboard unavailable" } as any);

    // --- tabs ----------------------------------------------------------------
    partial.mutedCount = step("mutedCount", () => {
      let n = 0;
      for (const t of Array.from(win.gBrowser.tabs) as Array<{ muted?: boolean }>) {
        if (t.muted) n++;
      }
      return n;
    }, 0);

    // The product's OWN numbering, published rather than re-derived by the
    // harness (which counted the relay tab the product skips, so a correctly
    // typed digit named the wrong tab). One numbering, one answer.
    partial.realTabs = step("realTabs", () =>
      st.realTabs().map((t: any, i: number) => {
        let spec = "";
        try {
          spec = t.linkedBrowser && t.linkedBrowser.currentURI ? t.linkedBrowser.currentURI.spec : "";
        } catch (e) {
          // a tab can be torn down mid-enumeration
        }
        return {
          n: i + 1,
          u: (spec.split("?")[0] || "").replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(-40),
          sv: t.splitview ? t.splitview.splitViewId : (t.splitViewId ?? -1),
          pinned: !!t.pinned,
        } as ChromeStateTabV1;
      }), [] as any) as ChromeStateTabV1[];

    partial.strip = step("strip", () =>
      Array.from(win.gBrowser.tabs).map((t: any, i: number) => {
        let spec = "";
        try {
          spec = t.linkedBrowser && t.linkedBrowser.currentURI ? t.linkedBrowser.currentURI.spec : "";
        } catch (e) {
          // a tab can be torn down mid-enumeration
        }
        return {
          i,
          u: (spec.split("?")[0] || "").replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(-40),
          sv: t.splitview ? t.splitview.splitViewId : (t.splitViewId ?? -1),
          panel: spec.indexOf("splitpanel.html") !== -1,
          req: spec.indexOf("#lfc=") !== -1,
        } as ChromeStateStripRowV1;
      }), [] as any) as ChromeStateStripRowV1[];

    // --- status bar ----------------------------------------------------------
    partial.statusMounted = verdict("statusMounted", () => st.statusMounted());
    partial.statusPosition = verdict("statusPosition", () => st.statusPosition());
    partial.statusAttr = step("statusAttr", () => doc.documentElement.getAttribute("data-lf-status"), null);

    // --- downloads / fullscreen / split --------------------------------------
    const dl = step("dlActive", () => st.dlActive(), [] as string[]);
    partial.dlCount = dl.length;
    partial.dlActive = dl;
    partial.fullscreen = verdict("fullscreen", () => st.isFullscreen());
    partial.inDOMFullscreen = step("inDOMFullscreen", () => doc.documentElement.hasAttribute("inDOMFullscreen"), false);
    partial.browserReserve = step("browserReserve", () => {
      const node = el("browser");
      if (!node) return null;
      const cs = env.getComputedStyle(node);
      return { mb: cs.marginBottom, mt: cs.marginTop, h: Math.round(node.getBoundingClientRect().height) };
    }, null);
    partial.nativeSplit = step("nativeSplit", () => {
      const sv = st.activeSplitView();
      const sel = win.gBrowser.selectedTab;
      const protoNames: string[] | null = (() => {
        if (!sv) return null;
        const names: string[] = [];
        let p = Object.getPrototypeOf(sv);
        let depth = 0;
        while (p && depth < 4) {
          for (const n of Object.getOwnPropertyNames(p)) names.push(n);
          p = Object.getPrototypeOf(p);
          depth++;
        }
        return names.slice(0, 60);
      })();
      return {
        fn: typeof win.gBrowser.addTabSplitView,
        pref: env.services.prefs.getBoolPref("browser.tabs.splitView.enabled", false),
        selSplitview: sv ? { id: sv.splitViewId, tabs: Array.isArray(sv.tabs) ? sv.tabs.length : -1 } : null,
        selHasSplitview: sel ? !!sel.splitview : false,
        selUrl: sel && sel.linkedBrowser && sel.linkedBrowser.currentURI ? sel.linkedBrowser.currentURI.spec : null,
        svMethods: sv ? Object.getOwnPropertyNames(sv).filter((n) => n !== "tabs" && n !== "splitViewId").slice(0, 40) : null,
        svProto: protoNames,
        addTabsType: sv ? typeof sv.addTabs : "no-sv",
        unsplitTabsType: sv ? typeof sv.unsplitTabs : "no-sv",
        reverseTabsType: sv ? typeof sv.reverseTabs : "no-sv",
        addTabsSrc: sv && typeof sv.addTabs === "function" ? String(sv.addTabs).slice(0, 800) : null,
        addTabSplitViewSrc: typeof win.gBrowser.addTabSplitView === "function" ? String(win.gBrowser.addTabSplitView).slice(0, 800) : null,
        gbSplitFns: typeof win.gBrowser.addTabSplitView === "function"
          ? Object.getOwnPropertyNames(Object.getPrototypeOf(win.gBrowser) || {})
              .filter((n) => /split|tab/i.test(n))
              .slice(0, 40)
          : null,
      };
    }, { error: "nativeSplit unavailable" } as any);

    return partial as ChromeStateV1;
  }

  return { read, version: CHROME_STATE_VERSION };
}