// The chrome state contract, versioned.
//
// WHY THIS FILE. `#lfc=state` is how the e2e harness sees chrome at all, and
// until now it was an unversioned JSON blob assembled inline in a 200-line
// handler. Unversioned means two things, both of which have already cost time:
// a field that disappears is indistinguishable from a field that is null, and a
// harness that reads `state.realTabs` has no way to notice the product changed
// what it means. The version is the whole point — a reader that does not
// recognise `v` is told so rather than handed a blob it will misread.
//
// The state is also assembled HERE rather than in the handler, so there is one
// answer to "what is chrome's state?" and the handler is a transport. That is
// what makes the contract assertable in Node: a test drives `read()` against a
// fake env and asserts the shape, with no browser and no wire.

import type { ChromeEnv } from "./env";

/**
 * The live-state accessors the snapshot needs, declared HERE rather than
 * imported from `./debug`.
 *
 * Declaring them locally is not duplication for its own sake: the e2e project
 * imports this module for the contract alone, and it is typechecked without the
 * DOM lib. An `import type { DebugState } from "./debug"` would drag debug.ts —
 * and through it `shared/overlay.ts` and `chrome/config.ts` — into a project
 * that cannot type them, so a contract that must be readable from Node would
 * only be readable from the browser. The shapes are structural, so
 * `DebugState` satisfies this without either side importing the other.
 */
export interface ChromeStateSource {
  hasPopup(): boolean;
  leaderActive(): boolean;
  chromeOwnsKeys(): boolean;
  /** Where the keyboard is — see ChromeStateFocusV1. Never a decision input. */
  focus(): ChromeStateFocusV1;
  leaderPending(): boolean;
  lastAction(): string | null;
  /** The leader's table state — see ChromeStateV1.keymap. */
  keymap(): { ready: boolean; buffered: number };
  /** The dispatcher's key trace — see ChromeStateV1.keyTrace. */
  keyTrace(): Array<Record<string, unknown>>;
  /** The live presence records — see ChromeStateV1.presence. */
  presence(): Array<{ i: number; u: string; d: string }>;
  lastMoveDebug(): string | null;
  statusMounted(): boolean;
  statusPosition(): string;
  dlActive(): string[];
  isFullscreen(): boolean;
  activeSplitView(): any;
  realTabs(): any[];
  relay(): any;
}

/** The version of the reply this build speaks. Bump on any breaking change. */
export const CHROME_STATE_VERSION = 1;

/** One row of the product's own tab numbering, as published by `realTabs`. */
export interface ChromeStateTabV1 {
  /** 1-based, the number the user types. See `chromeOwnsKeys` in keystate.ts. */
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
  /**
   * The current value of every popup input, in document order.
   *
   * Added because "the filter did not apply" and "the keys never reached the
   * input" are indistinguishable from `items` alone, and they are the two
   * halves of the question every popup test eventually has to answer. The
   * chrome popup re-creates its `<input>` (Firefox's HTML parser drops form
   * controls in the privileged document), so this also says whether the field
   * being typed into is the one the popup built.
   */
  inputValues: string[];
}

/**
 * Where the browser's OWN keyboard focus is.
 *
 * Added to the readout because "who owns the keys" and "who has the KEYBOARD"
 * are two different questions, and only the second one explains the report
 * these tests exist for: the page is alive, the helper defers to it, and no key
 * arrives — because focus is parked in the browser's own UI. The page can answer
 * that for a content-process document (`document.hasFocus()`); an
 * extension-process page — the command center — cannot answer it at all, so the
 * browser's focus manager is asked, from the realm that owns the keyboard.
 *
 * No decision reads this. It exists so a failure can say WHY the keys went
 * nowhere instead of reporting the absence of an effect.
 */
export interface ChromeStateFocusV1 {
  /** The window is the OS-active one (`Services.focus.activeWindow === win`). */
  activeWindow: boolean;
  /** The element the browser says has the keyboard, as `tag#id`, or null. */
  focused: string | null;
  /** That element is the SELECTED tab's content (its <browser>, or inside it). */
  inSelectedContent: boolean;
  //
  // THE FIELDS BELOW ANSWER "WHY IS `focused` NULL", which is the shape the
  // reported freeze has and the shape that cannot be diagnosed from `focused`
  // alone. A keyboard that exists nowhere is one of:
  //   * another window has it (`focusedWindow`), so nothing here can take it;
  //   * the page's document is out-of-process (`remote`) and cannot be reached
  //     from here at all, so "has the keyboard" is the browser element's
  //     question and not the page's;
  //   * the selected tab's docshell is not the active one (`docShellActive`),
  //     which is worth having beside the rest rather than instead of it: it was
  //     false in BOTH measured shapes of a page that legitimately had the
  //     keyboard (an in-process command center and a remote web page), so it is
  //     a fact about the tab, not a verdict about the keyboard.
  // `chromeActive` (what the chrome document itself thinks is focused) and
  // `pageHasFocus` (the selected page's own answer, or null when it cannot be
  // asked) are what turn the zero into a diagnosis. Measured on the command
  // center, after a tab switch: `focused: null` with `chromeActive: "browser"`
  // and `pageHasFocus: true` — the focus manager has no element to name while
  // the document itself answers that it has the keyboard, so a reader that
  // trusted `focused` alone would call a working page dead.
  /** The selected tab's document runs in another process (`isRemoteBrowser`). */
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

export interface ChromeStateV1 {
  /** The reply's contract version. Always present. */
  v: number;
  /**
   * Whether the snapshot completed. `ok: false` means the fields below are
   * partial or absent — a reader must check this before trusting anything.
   * `error` carries the reason when it is false.
   */
  ok: boolean;
  error?: string;

  // --- identity / environment -------------------------------------------------
  profileLeaf: string;
  restrictedDomains: string;
  relay: any;

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
  chromeOwnsKeys: boolean;
  leaderPending: boolean;
  lastAction: string | null;
  lastMoveDebug: string | null;
  selUrl: string;
  /** Where the keyboard actually is — see ChromeStateFocusV1. */
  focus: ChromeStateFocusV1 | { error: string };
  /**
   * The leader's own table and what it is holding back because of it.
   *
   * Both halves exist because "the leader is armed and nothing ran" and "the
   * leader is armed and its keymap never loaded" look identical from every
   * other field — and they have different fixes (a binding bug versus a core
   * that never booted), so the reply has to name which one it is.
   */
  keymap: { ready: boolean; buffered: number };
  /**
   * The last keystrokes the helper's dispatcher saw, newest last, each with the
   * branch it took (`br`) and whether it was consumed (`c`).
   *
   * Dev-only: a release build records nothing and the list is empty. It exists
   * because "the key did nothing" and "the key never arrived" are opposite
   * diagnoses with opposite fixes, and no other field of this reply can tell
   * them apart.
   */
  keyTrace: Array<Record<string, unknown>>;
  /**
   * The documents that have TOLD this helper they are alive, one row per tab.
   *
   * `i` is the tab's strip index at the moment of the read, `u` the URL the
   * record names (`ext:`-shortened, like `strip`) and `d` its document nonce.
   *
   * It answers the one question `chromeOwnsKeys` cannot explain about itself:
   * ownership is decided by looking for a record ON THE SELECTED TAB, so a wrong
   * answer means either that no record was ever placed for that tab or that one
   * was placed on a neighbour — and from outside, "the helper claimed the keys
   * on a live page" looks identical either way. Two causes, opposite fixes
   * (placement versus reporting), and this is the field that separates them.
   */
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

/** What the reader needs — the same two things the debug handler had. */
export interface StateReaderDeps {
  env: ChromeEnv;
  getState(): ChromeStateSource;
}

export interface StateReader {
  /**
   * Assemble one snapshot.
   *
   * Does NOT throw. Two kinds of failure, reported differently on purpose:
   *
   *   * a FIELD that cannot be read (a torn-down tab, a bar that is gone) is a
   *     degradation — the snapshot completes, the field is listed in
   *     `degraded`, and `ok` stays true.
   *   * a SOURCE that cannot answer AT ALL (the chrome helper is not there) is
   *     not a degradation — the whole read becomes `ok: false` with the error.
   *
   * The second is deliberately fatal rather than filled with a default. These
   * accessors are the product's own verdicts — `chromeOwnsKeys` above all, the
   * gate on every key decision — and a snapshot that defaulted them to `false`
   * would read as "nothing is open, nothing owns the keys": a broken helper
   * would look exactly like a working one. Refusing to answer is the only
   * honest option, and the caller checks `ok`.
   */
  read(): ChromeStateV1;
  /** The version this build speaks. The handler stamps it into every reply. */
  version: number;
}

/**
 * Build the reader the `#lfc=state` handler answers with.
 *
 * Every field is computed defensively, exactly as the inline handler computed
 * it: a torn-down tab must not turn a state read into a failed read. What is
 * NEW here is that the failure is *reported* rather than smuggled — a handler
 * that threw answered `{error}` with no version, and the harness read it as a
 * state with every field missing.
 */
export function createStateReader(deps: StateReaderDeps): StateReader {
  const env = deps.env;
  const doc = env.document as any;
  const win = env.window as any;
  // Outlives a failed readUnsafe() so `read()` can report which accessors died.
  const failed: { unreadable?: string[] } = {};

  function read(): ChromeStateV1 {
    // The contract is that `read()` never throws: a snapshot that could not be
    // taken is reported as `ok: false`, which the consumer refuses. The work
    // itself is in readUnsafe(), which is allowed to throw.
    try {
      return readUnsafe();
    } catch (e) {
      // Carry the detail across the boundary: "the snapshot failed" without
      // naming what could not be read leaves the reader guessing, which is the
      // situation this whole contract exists to end.
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
      // The chrome helper itself is unreachable. There is no honest snapshot to
      // give, so say so rather than answering with an empty one.
      return { v: CHROME_STATE_VERSION, ok: false, error: String(e) } as ChromeStateV1;
    }
    const partial: any = { v: CHROME_STATE_VERSION, ok: true };

    // The product's own verdicts, read through a hard failure.
    //
    // These are deliberately NOT degradable. `chromeOwnsKeys` is the gate on
    // every key decision, and a snapshot that defaulted it to false would read
    // as "chrome owns nothing here" — a dead helper indistinguishable from a
    // healthy idle one. If any of them cannot answer, the reply is marked
    // failed, and the consumer refuses it (see ChromeStateHandle).
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
        // A field that cannot be read is recorded and the snapshot keeps going:
        // the whole reply is worth more than any one field, and `ok` stays true
        // because the snapshot DID complete.
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

    // --- popup ---------------------------------------------------------------
    partial.popup = step("popup", () => {
      const panels = Array.from(doc.querySelectorAll(".lf-panel")) as any[];
      const items = (p: any) => Array.from(p.querySelectorAll(".lf-item")) as any[];
      // Read across the WHOLE document, not per panel: a popup input can be
      // re-created outside its panel, and a stale input left in the document
      // is exactly the thing a test needs to see.
      const inputs = Array.from(doc.querySelectorAll(".lf-input")) as any[];
      return {
        current: st.hasPopup(),
        // Counted from the leader controller's own mirror, NOT from `.wk.on`:
        // the overlay host attaches a CLOSED shadow root, so a querySelectorAll
        // from here cannot see inside it and always answered 0 — an instrument
        // that could not see the thing it existed to detect.
        wkOn: doc.documentElement.getAttribute("data-lf-whichkey") === "1" ? 1 : 0,
        rootInputs: doc.querySelectorAll(".lf-popup .lf-input").length,
        panels: panels.map((p) => ({
          title: (p.querySelector(".lf-title") || {}).textContent || "",
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
    partial.chromeOwnsKeys = verdict("chromeOwnsKeys", () => st.chromeOwnsKeys());
    partial.leaderPending = verdict("leaderPending", () => st.leaderPending());
    partial.lastAction = verdict("lastAction", () => st.lastAction());
    partial.lastMoveDebug = verdict("lastMoveDebug", () => st.lastMoveDebug());
    // A field that cannot be read keeps the rest of the snapshot: it degrades
    // rather than failing the reply, unlike the ownership verdicts above.
    partial.keymap = step("keymap", () => st.keymap(), {
      ready: false,
      buffered: -1,
    } as any);
    partial.keyTrace = step("keyTrace", () => st.keyTrace(), [] as any);
    // Shortened the way `strip` is, so a reader can compare a presence row with
    // a strip row without knowing the extension's UUID.
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
    partial.selUrl = step("selUrl", () => {
      const u = win.gBrowser.selectedBrowser && win.gBrowser.selectedBrowser.currentURI;
      return u ? String(u.spec) : "?";
    }, "err");
    partial.focus = step("focus", () => st.focus(), { error: "focus unavailable" } as any);

    // --- tabs ----------------------------------------------------------------
    partial.mutedCount = step("mutedCount", () => {
      let n = 0;
      for (const t of Array.from(win.gBrowser.tabs) as Array<{ muted?: boolean }>) {
        if (t.muted) n++;
      }
      return n;
    }, 0);

    // The product's OWN numbering, published rather than re-derived by the
    // harness. The harness used to rebuild this list from the strip and got it
    // subtly wrong (it counted the relay tab the product skips), so a correctly
    // typed digit named the wrong tab and the failure surfaced as "the split did
    // not form" — pointing at the feature instead of at the test. There is
    // exactly one numbering and it is here.
    partial.realTabs = step("realTabs", () =>
      st.realTabs().map((t: any, i: number) => {
        let spec = "";
        try {
          spec = t.linkedBrowser && t.linkedBrowser.currentURI ? t.linkedBrowser.currentURI.spec : "";
        } catch (e) {
          // torn down mid-enumeration
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
      return {
        fn: typeof win.gBrowser.addTabSplitView,
        pref: env.services.prefs.getBoolPref("browser.tabs.splitView.enabled", false),
        selSplitview: sv ? { id: sv.splitViewId, tabs: Array.isArray(sv.tabs) ? sv.tabs.length : -1 } : null,
        selHasSplitview: sel ? !!sel.splitview : false,
        selUrl: sel && sel.linkedBrowser && sel.linkedBrowser.currentURI ? sel.linkedBrowser.currentURI.spec : null,
        svMethods: sv ? Object.getOwnPropertyNames(sv).filter((n) => n !== "tabs" && n !== "splitViewId").slice(0, 40) : null,
        svProto: sv
          ? (() => {
              const names: string[] = [];
              let p = Object.getPrototypeOf(sv);
              let depth = 0;
              while (p && depth < 4) {
                for (const n of Object.getOwnPropertyNames(p)) names.push(n);
                p = Object.getPrototypeOf(p);
                depth++;
              }
              return names.slice(0, 60);
            })()
          : null,
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