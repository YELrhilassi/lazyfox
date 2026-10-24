// The dark-mode controller: the one object the leader actions talk to.
//// It owns the whole life of one page's theme — the early paint before anything
// is known, the decision, the sheet, the resample gate, and the four writes a
// user can make from the keyboard. The arithmetic is elsewhere (color/detect/theme)
// and the DOM shell is elsewhere (apply.ts); this file is glue and policy, which
// is why it is the file that reads like prose.
//
// POLICY, stated once:
//
//   mode `auto`   darken the page UNLESS it is already dark. This is the
//                 default, and it is what "smart" means here: on the pages that
//                 already look right, the correct action is none.
//   mode `dark`   darken regardless — the user asked, so the detection is not
//                 consulted. This is what `;Y d` writes, because a user who
//                 toggles a page is overriding an automatic decision rather
//                 than adding a vote to it.
//   mode `light`  the mirror image, for a user who prefers light pages.
//   mode `off`    nothing at all.
//
// A site rule (config.dark.sites) may pin any of those four per host, and may
// pin the engine, which is the escape hatch for a page the dynamic engine reads
// badly. Site rules are ordinary config, which is why they are editable in the
// settings page as well as from the keyboard.

import {
  hostAndPath,
  matchRules,
  parseFixList,
  type DarkRule,
} from "../../../shared/dark-rules";
import type { Config, SiteRule } from "../../../shared/types";
import { nextPalette } from "../../../shared/darkpalettes";
import { createDarkApplier, createResampleGate, DARK_STYLE_ID, touchesOnlyOwnStyle } from "./apply";
import {
  analyze,
  chooseEngine,
  declaresDarkSupport,
  nativeDarkVerdict,
  shouldApply,
  type Analysis,
  type PageSample,
} from "./detect";
import { buildTheme, composeSheet, entriesFor, fallbackSheet, siteRulesFor, type Theme } from "./theme";

export interface DarkState {
  on: boolean;
  /** The mode in force: auto | dark | light | off. */
  mode: string;
  engine: string;
  /** Why the last decision came out the way it did. Never empty. */
  reason: string;
  host: string;
  /** The rule that decided this page, when one did. */
  site: SiteRule | null;
  pageDark: boolean;
  coverage: number;
  corpusBlocks: number;
  corpusErrors: number;
}

export interface DarkController {
  /** Paint the canvas NOW, before anything is known. See the note below. */
  early(): void;
  /** Re-decide and re-apply from the current config. Idempotent. */
  update(config: Config): void;
  /** `;Y d` — dark on/off for this site, writing a site rule. */
  toggleSite(): void;
  /** `;Y g` — cycle the global default. */
  cycleGlobal(): void;
  /** `;Y e` — cycle the engine for this site. */
  toggleEngine(): void;
  /** `;Y p` — the next color scheme: writes the three poles at once. */
  cyclePalette(): void;
  /** `;Y x` — drop this site's rules. */
  resetSite(): void;
  state(): DarkState;
}

export interface DarkDeps {
  doc: Document;
  win: Window;
  url(): string;
  getConfig(): Config;
  setConfig(next: Config): void;
  toast(msg: string): void;
  /**
   * Publish the verdict wherever else it is shown — currently the window status
   * bar, through the background. Called on every `mirror()`, i.e. exactly when
   * the page-level attributes change, so the bar can never describe a state the
   * page has already left.
   */
  report?(state: DarkState): void;
}

/** How long after a refused mutation the tail pass waits for the page to settle. */
const RESAMPLE_TAIL_MS = 400;

type Mode = "auto" | "dark" | "light" | "off";
type EnginePref = "auto" | "dynamic" | "filter";

const MODE_CYCLE: Mode[] = ["auto", "dark", "light", "off"];
const ENGINE_CYCLE: EnginePref[] = ["auto", "dynamic", "filter"];

export function createDarkMode(deps: DarkDeps): DarkController {
  const applier = createDarkApplier(deps.doc, deps.win);
  const gate = createResampleGate(() => Date.now());
  let observer: MutationObserver | null = null;
  let corpusText = "\u0000";
  let corpus: DarkRule[] = [];
  let corpusErrors = 0;
  let state: DarkState = {
    on: false,
    mode: "auto",
    engine: "auto",
    reason: "not decided yet",
    host: hostAndPath(deps.url()).host,
    site: null,
    pageDark: false,
    coverage: 0,
    corpusBlocks: 0,
    corpusErrors: 0,
  };
  let earlySheet = false;
  // The URL the last decision was made for. A same-document navigation is a new
  // page state for every purpose that matters here (a different palette, a
  // different site rule) and it must not inherit the previous state's spent
  // resample burst — see the gate's reset in apply().
  let lastUrl = "";
  // Whether this page's own declaration has been READ — whether or not it
  // declared dark support. One-shot: the ask (setting `color-scheme: dark` on the
  // root) is cheap but not free, and a page that answers "no" must not be asked
  // again on every mutation.
  //
  // This flag also decides whether a pass may touch the page's paint BEFORE
  // measuring it, and that is the difference between a stable page and a
  // flicker: it used to be only ever set by a page that declares dark support, so
  // on every other page it stayed false for the life of the tab, and each pass
  // cleared the live sheet, measured the undarkened page and painted it again. A
  // whole-page flash on every single mutation — the reported "it flashes dark
  // and light".
  let nativeChecked = false;
  // The ask is currently installed on the root (`color-scheme: dark`), so the page
  // renders its own dark theme because of us and must be handed back its scheme
  // when the user turns the site off.
  let nativeHeld = false;
  // The engine last used for this document's palette. The choice is re-measured
  // on every pass, and passing it back in is what keeps the two engines from
  // alternating (see the hysteresis note on `chooseEngine`).
  let liveEngine: "dynamic" | "filter" | null = null;
  // The measurement the LIVE palette was built from. Re-measuring a page that is
  // already wearing our sheet cannot recover the page's own palette — parts of it
  // are ours now — so the second pass measures something slightly different, and
  // a theme rebuilt from that moves every colour on the page at once. That global
  // shift, once per mutation burst, is what "it flashes dark and light" looks
  // like from the outside. The anchors are therefore frozen for as long as this
  // document's theme is the one we painted; new elements still get entries from
  // the fresh samples, against the frozen mapping.
  let liveAnalysis: Analysis | null = null;
  // Whether the page declares its OWN dark scheme, read while the page is
  // unpainted (or while our sheet is still scheme-free, which is the same thing
  // for this question). Cached because the answer must survive the moment our
  // sheet starts declaring a scheme: from then on, "what does the root say?" is
  // a question about US.
  let declaredNative: boolean | null = null;

  function rules(): DarkRule[] {
    const text = deps.getConfig().dark?.fixes ?? "";
    if (text !== corpusText) {
      const parsed = parseFixList(text);
      corpusText = text;
      corpus = parsed.rules;
      corpusErrors = parsed.errors.length;
    }
    return corpus;
  }

  function siteFor(): SiteRule | null {
    const host = hostAndPath(deps.url()).host;
    const hits = siteRulesFor(deps.getConfig().dark?.sites || [], deps.url());
    const last = hits.length ? hits[hits.length - 1]! : null;
    state.host = host;
    return last;
  }

  /**
   * The page's own answer to "do you have a dark theme?".
   *
   * `color-scheme` is read from the root because that is where the declaration
   * lives and because it is the one signal a content script can act on: setting
   * the same property to `dark` makes every `light-dark()` value and every
   * scheme-aware UA style flip to the site's dark palette, with no sheet of ours
   * involved. A `<meta name="color-scheme">` is read as well, since a page may
   * declare it there instead of in CSS.
   */
  function colorSchemeNow(): string {
    try {
      const root = deps.doc.documentElement;
      const declared = root ? deps.win.getComputedStyle(root).colorScheme : "";
      let meta: string | null = null;
      try {
        meta = deps.doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content") || null;
      } catch {
        meta = null;
      }
      return String(declared || "") + " " + String(meta || "");
    } catch {
      return "";
    }
  }

  /**
   * Whether the current mode wants a dark page at all. `light` and `off` are the
   * two answers that make asking pointless — a user who asked for a LIGHT page
   * must not have the site flipped dark behind the remap.
   */
  function wantsDarkScheme(config: Config): boolean {
    const mode = (state.site?.mode ?? config.dark.mode) as Mode;
    return mode !== "off" && mode !== "light";
  }

  // What the root's INLINE color-scheme was before we asked, so a page that
  // answers "no" gets its own declaration back rather than an edited one.
  let inlineSchemeBefore: string | null = null;

  function askForNativeDark(): boolean {
    try {
      const root = deps.doc.documentElement;
      if (!root) return false;
      inlineSchemeBefore = root.style.getPropertyValue("color-scheme") || "";
      quietly(() => root.style.setProperty("color-scheme", "dark"));
      nativeHeld = true;
      return true;
    } catch {
      return false;
    }
  }

  function unaskForNativeDark(): void {
    nativeHeld = false;
    unasked = true;
    try {
      const root = deps.doc.documentElement;
      if (!root) return;
      quietly(() => {
        if (inlineSchemeBefore) root.style.setProperty("color-scheme", inlineSchemeBefore);
        else root.style.removeProperty("color-scheme");
      });
    } catch {
      /* ignore */
    }
  }

  // Whether the ask has ever been taken back on this document. A site that
  // answered "yes" and then stopped honouring the ask must not be asked again in
  // a loop: the ask is a fact-finding step, and once its answer is stale the only
  // honest move is to paint.
  let unasked = false;

  // Our own writes on <html> (`color-scheme`, the scheme marker) match the
  // observer's attribute filter, so they would otherwise buy a measurement of a
  // page WE just changed — one extra pass per toggle, and a needless rewrite.
  // The flag is cleared on a microtask, which is after the observer's batch has
  // been delivered.
  let quiet = 0;
  function quietly(fn: () => void): void {
    quiet++;
    try {
      fn();
    } finally {
      try {
        queueMicrotask(() => {
          quiet = Math.max(0, quiet - 1);
        });
      } catch {
        quiet = Math.max(0, quiet - 1);
      }
    }
  }

  /** The live theme, or null when the page should be left alone. */
  function decide(
    config: Config,
    analysis: Analysis,
    anchors: Analysis,
    previous: "dynamic" | "filter" | null
  ): { theme: Theme | null; direction: Mode; mode: Mode; engine: EnginePref; reason: string } {
    const mode: Mode = state.site?.mode ?? config.dark.mode;
    const enginePref: EnginePref = state.site?.engine ?? config.dark.engine;
    if (mode === "off") return { theme: null, direction: mode, mode, engine: enginePref, reason: "turned off" };
    const direction = mode === "light" ? "lighten" : "darken";
    // `auto` is where the already-dark check applies; an explicit `dark`/`light`
    // is the user overriding detection, so it is not consulted.
    //
    // THE CHECK IS A FIRST-PASS ANSWER, NOT A PER-PASS VOTE. Once a theme of ours
    // is live, the page's colours are partly ours, so asking "is this page already
    // dark?" again measures our own work: the answer drifts with every burst, and
    // a page that flips between "paint" and "already dark" shows the user dark and
    // light by turns. `previous !== null` means a theme is live, and a live theme
    // under `auto` keeps living until the page state changes (a navigation resets
    // `previous`) or the user says otherwise.
    const skip = mode === "auto" && previous === null;
    const decision = shouldApply(direction, analysis, skip);
    if (!decision.on) return { theme: null, direction: mode, mode, engine: enginePref, reason: decision.reason };
    const engine = chooseEngine(enginePref, analysis, previous);
    // The palette is built from the FROZEN anchors while a theme is live (see
    // `liveAnalysis`); the engine choice still follows the fresh coverage.
    const theme = buildTheme(config.dark, direction, engine, anchors);
    return { theme, direction: mode, mode, engine: enginePref, reason: decision.reason + " · " + engine + " engine" };
  }

  // HOW MANY TIMES THIS DOCUMENT HAS BEEN WALKED, published on <html> as
  // `data-lf-dark-passes`.
  //
  // It exists because the OTHER mirrors only move when the VERDICT does: a
  // controller that re-decided a settled page ~22 times a second (see the note in
  // scan.ts) looked, from outside, exactly like one that had gone quiet — same
  // verdict, same attributes, same bar. The counter is what makes "the page
  // stopped being walked" a fact a test can assert in a real browser
  // (scripts/e2e/suites/content/theme.ts) rather than a claim in a comment.
  let passes = 0;

  function mirror(): void {
    try {
      const root = deps.doc.documentElement;
      if (!root) return;
      root.setAttribute("data-lf-dark", state.on ? "on" : "off");
      root.setAttribute("data-lf-dark-mode", state.mode);
      root.setAttribute("data-lf-dark-engine", state.engine);
      root.setAttribute("data-lf-dark-reason", state.reason);
    } catch {
      /* the document may be going away */
    }
    // The bar is a second surface for the same verdict; mirror() is called
    // everywhere state changes, which is the only place that has to know.
    try {
      if (deps.report) deps.report({ ...state });
    } catch {
      /* reporting must never break the theme */
    }
  }

  /**
   * ONE PASS AT A TIME.
   *
   * `apply` is async (the sampling walk yields), so two overlapping runs used to
   * interleave their sheets and mirrors: the later pass measured a page the
   * earlier one had already half-painted and wrote a verdict computed from it.
   * Requests are therefore serialised — a request that arrives mid-pass is
   * remembered and run once, after it, against the config of the moment.
   */
  let running: Promise<void> | null = null;
  let queued = false;
  // WHAT ARRIVED WHILE A PASS WAS RUNNING: the nodes those mutations added. The
  // next pass measures THEM, not the document — see SampleOptions.added. Bounded,
  // because a page can add nodes faster than a pass can paint them, and an
  // unbounded list would be its own leak; past the bound the flag asks for one
  // ordinary pass instead.
  const ADDED_QUEUE_MAX = 600;
  let queuedAdded: Element[] = [];
  let queuedFull = false;
  let tailTimer: number | null = null;

  function rememberAdded(added: Element[]): void {
    if (!added.length) return;
    if (queuedAdded.length + added.length > ADDED_QUEUE_MAX) {
      queuedAdded = [];
      queuedFull = true;
      return;
    }
    for (const el of added) queuedAdded.push(el);
  }

  function requestApply(config: Config, added?: Element[]): void {
    rememberAdded(added || []);
    if (running) {
      queued = true;
      return;
    }
    // A full pass is asked for by the coverage walk, a user action and the
    // overflow case; everything the observer reports is served from the queue.
    const target = queuedFull ? undefined : queuedAdded.length ? queuedAdded : undefined;
    queuedAdded = [];
    queuedFull = false;
    running = apply(config, target)
      .catch(() => undefined)
      .then(() => {
        running = null;
        if (queued) {
          queued = false;
          requestApply(deps.getConfig());
        }
      });
  }

  /**
   * THE NEXT SLICE OF A PAGE THAT IS BIGGER THAN ONE PASS.
   *
   * `sample()` walks a window of the document per pass and this asks for the
   * next one, with no gate in the way: the gate exists to stop a page that
   * mutates continuously from dragging a scan behind it, and this is the engine
   * finishing a walk it has already started on a page that is NOT moving. The
   * delay is one task, so the slices are separate tasks (the walk yields inside
   * itself as well) and the browser keeps its frame budget.
   *
   * MEASURED: en.wikipedia.org/wiki/Firefox has 14 051 elements. Before this,
   * the walk stopped at the first 4 000 and the article below the fold kept its
   * white panels under our mapped-light ink — 991 unreadable text elements. A
   * settled page produces no mutations, so nothing else would have asked.
   */
  // A page that keeps GROWING never reports zero pending: an infinite feed adds
  // elements as fast as a slice walks them, so "cover the rest of the page" is a
  // walk that never ends — one more pass every 60ms for the life of the tab. The
  // ceiling makes the coverage walk finite; past it, new content is painted by
  // the incremental resamples, which cost what the new nodes cost.
  const MAX_CONTINUATIONS = 16;
  let continuations = 0;

  function scheduleContinuation(): void {
    if (continuations >= MAX_CONTINUATIONS) return;
    if (tailTimer !== null) return;
    try {
      tailTimer = deps.win.setTimeout(() => {
        tailTimer = null;
        if (!state.on || applier.pending() <= 0) return;
        continuations++;
        requestApply(deps.getConfig());
      }, 60);
    } catch {
      tailTimer = null;
    }
  }

  /**
   * THE TAIL OF A MUTATION BURST.
   *
   * A rate-limited gate drops the mutations that arrive too soon after a pass —
   * and a state switch is exactly a burst whose LAST mutation is the one that
   * matters: the view is torn down, and 250ms later the new one is mounted. The
   * pass the teardown earned measured a nearly empty document, the mount was
   * refused for being too close to it, and nothing else ever happened — so the
   * new view kept its light colours while the sheet described the old one. That
   * is the reported "blank overlay, dark elements not rendered properly".
   *
   * So a refused mutation arms a short timer instead of vanishing: when the page
   * settles, exactly one more pass measures what it settled INTO. The timer is
   * absorbed by the same gate, so a page that mutates forever still gets at most
   * one pass per interval.
   */
  function scheduleTail(): void {
    if (tailTimer !== null) return;
    try {
      tailTimer = deps.win.setTimeout(() => {
        tailTimer = null;
        if (!state.on) return;
        if (!gate()) {
          scheduleTail();
          return;
        }
        requestApply(deps.getConfig());
      }, RESAMPLE_TAIL_MS);
    } catch {
      tailTimer = null;
    }
  }

  /**
   * THE SECOND CHANCE TO ASK.
   *
   * A quiet page produces no mutations, so nothing would ever re-open the
   * native-theme question once the page has its stylesheet. Two document events do:
   * `DOMContentLoaded` (the head has been parsed and its CSS applied, and the
   * render-blocking part of a real page's theme is in place) and `load` (everything
   * else). Each is ONE extra measurement, and only while the answer is still open.
   */
  let nativeChecksScheduled = false;
  function scheduleNativeChecks(): void {
    if (nativeChecksScheduled) return;
    nativeChecksScheduled = true;
    const run = (): void => {
      if (nativeChecked || unasked) return;
      requestApply(deps.getConfig());
    };
    try {
      const state = deps.doc.readyState || "loading";
      if (state === "loading") deps.doc.addEventListener("DOMContentLoaded", run, { once: true });
      if (state !== "complete") deps.win.addEventListener("load", run, { once: true });
    } catch {
      /* a document that is going away has no events left to schedule */
    }
  }

  /**
   * Ask for one more pass once the document has its styles.
   *
   * Used when the only thing on the page yet is the placeholder's own paint: the
   * palette arrives with the page's CSS, and `DOMContentLoaded` is the earliest
   * moment it is guaranteed to be there. One-shot; a document that never fires it
   * (it always does) simply keeps the placeholder, which is still dark.
   */
  let readyRerun = false;
  function scheduleReadyRerun(): void {
    if (readyRerun) return;
    readyRerun = true;
    const run = (): void => {
      readyRerun = false;
      requestApply(deps.getConfig());
    };
    try {
      if ((deps.doc.readyState || "loading") === "loading") {
        deps.doc.addEventListener("DOMContentLoaded", run, { once: true });
      } else {
        deps.win.setTimeout(run, 0);
      }
    } catch {
      readyRerun = false;
    }
  }

  /**
   * The elements a batch ADDED — the only thing a pass can act on.
   *
   * A CLASS OR STYLE CHANGE CANNOT MOVE A COLOUR THIS ENGINE KNOWS. Every
   * element's own colours were recorded the first time it was measured
   * (`originals`) and are never re-read — deliberately, because a later pass runs
   * with our sheet installed and would read our own paint back. So attribute
   * churn can only change GEOMETRY, and geometry is re-read for the elements a
   * pass actually visits. `attributes: true, subtree: true` was therefore buying
   * a pass per 400ms on every framework app — a virtualised list, a chat client,
   * a mail client — for an answer that cannot change. Measured on the harness's
   * app fixture: 1 600 attribute writes a frame, and the add-on pinned the main
   * thread for 600-800ms of every frame. That is the reported freeze.
   *
   * Toggling a theme is a class change on <html> or <body>, and that one IS
   * watched — without `subtree` (see `rootObserver`).
   */
  function addedElements(records: MutationRecord[]): Element[] {
    const out: Element[] = [];
    for (const rec of records) {
      const nodes = rec.addedNodes;
      const n = nodes ? nodes.length : 0;
      for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (!node) continue;
        if (node.nodeType === 1) out.push(node as Element);
        else if (node.nodeType === 3) {
          const parent = (node as Text).parentElement;
          if (parent) out.push(parent);
        }
        if (out.length >= ADDED_QUEUE_MAX) return out;
      }
    }
    return out;
  }

  let rootObserver: MutationObserver | null = null;

  function ensureObserver(): void {
    if (observer) return;
    try {
      observer = new MutationObserver((records) => {
        if (!state.on) return;
        // Our own write on <html>: not page activity.
        if (quiet > 0) return;
        // THE SHEET IS NOT PAGE ACTIVITY. Installing it and replacing its text is
        // a mutation in the subtree the observer watches; reading that as "the
        // page changed" made every write buy the next measurement, and the next
        // measurement could write again. Excluding our own node from the batch is
        // what bounds that loop to the page's own changes.
        try {
          if (touchesOnlyOwnStyle(records, deps.doc.getElementById(DARK_STYLE_ID))) return;
        } catch {
          /* the document may be going away; treat the batch as the page's */
        }
        const added = addedElements(records);
        if (!added.length) return;
        rememberAdded(added);
        if (gate()) {
          requestApply(deps.getConfig());
          return;
        }
        scheduleTail();
      });
      // CHILD LIST ONLY: new nodes are the only thing that can need painting.
      observer.observe(deps.doc.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch {
      observer = null;
    }
    // THE ROOT'S OWN ATTRIBUTES, without subtree: `class="dark"` on <html> or
    // <body> is how a site switches its palette, and that answer can change. One
    // element each, so the cost is nothing — unlike the subtree version, which
    // charged a record per class write anywhere in the document.
    if (rootObserver) return;
    try {
      rootObserver = new MutationObserver(() => {
        if (!state.on) return;
        if (quiet > 0) return;
        if (!gate()) {
          scheduleTail();
          return;
        }
        requestApply(deps.getConfig());
      });
      const opts = { attributes: true, attributeFilter: ["class", "style"] };
      if (deps.doc.documentElement) rootObserver.observe(deps.doc.documentElement, opts);
      if (deps.doc.body) rootObserver.observe(deps.doc.body, opts);
    } catch {
      rootObserver = null;
    }
  }

  /**
   * The placeholder paint is over: it was never a decision, and both the marker
   * and the flag must go the moment a real verdict exists — including on the two
   * paths that decide to paint NOTHING, because a marker left behind on <html>
   * reads from outside as "dark mode is still starting" forever.
   */
  function finishEarlySheet(): void {
    if (!earlySheet) return;
    try {
      deps.doc.documentElement?.removeAttribute("data-lf-dark-pending");
    } catch {
      /* ignore */
    }
    earlySheet = false;
  }

  async function apply(config: Config, added?: Element[]): Promise<void> {
    passes++;
    try {
      deps.doc.documentElement?.setAttribute("data-lf-dark-passes", String(passes));
    } catch {
      /* the document may be going away */
    }
    scheduleNativeChecks();
    const url = deps.url();
    state.site = siteFor();
    // THE PENDING PAINT IS NOT PART OF THE MEASUREMENT — see the placeholder
    // block below, which keeps it installed while the page loads and measures
    // only after it is off. Measuring through it reads our own canvas back as
    // the page's, and a white page then measures as "already dark".
    if (url !== lastUrl) {
      // A new page state in the same document (an SPA route change, a hash
      // navigation): it starts with a fresh measurement budget, because its
      // palette is a different palette and the old one's burst allowance has
      // nothing to say about it. THE BUDGET IS ALL THAT IS RESET.
      //
      // The anchors and the engine USED to be forgotten here, and that was a
      // flash on every SPA route change: the next pass rebuilt the palette from
      // a re-measurement of a page that is partly wearing our sheet, so every
      // colour on screen moved at once (and the engine could flip dynamic ↔
      // filter, which is an even bigger jump). A route change is a new VIEW of
      // the same site against the same canvas: new elements still get entries
      // from the fresh samples, against the mapping the user is already looking
      // at.
      lastUrl = url;
      gate.reset();
      continuations = 0;
    }
    // A MODE THAT NO LONGER WANTS DARK HANDS THE PAGE ITS OWN SCHEME BACK.
    // The ask writes `color-scheme: dark` on the root and leaves it there for as
    // long as the page is dark; switching the site off has to take it back, or the
    // page keeps the site's dark theme under a rule that says "off".
    if (nativeHeld && !wantsDarkScheme(config)) {
      unaskForNativeDark();
      if (state.engine === "native") state.engine = "auto";
    }

    // THE PAGE'S OWN DECLARATION IS READ WHILE OUR SHEET IS NOT IN THE WAY.
    // While the native question is still open our sheet declares no scheme, so
    // the root's computed value is the PAGE's; once the answer is in, the cached
    // value is the only honest source (see `declaredNative`).
    if (!applier.active() || !nativeChecked) {
      declaredNative = declaresDarkSupport(colorSchemeNow());
    }
    // THE PLACEHOLDER COVERS THE PAGE UNTIL THE DOCUMENT HAS ITS STYLES.
    //
    // The placeholder exists so the first frame is dark; taking it off early
    // enough to measure put the undarkened page on screen for as long as a style
    // walk takes — the white flash people report. It cannot be measured THROUGH
    // either: everything it paints is our colour, inherited even by elements that
    // set no background, so a white page would read as "already dark" and the
    // feature would stand down. So the placeholder is left alone while the page
    // is still loading, and the real pass runs at DOMContentLoaded — in one task,
    // so the swap from placeholder to sheet happens between two paints.
    const ready = (deps.doc.readyState || "loading") !== "loading";
    if (!ready) {
      if (!wantsDarkScheme(config)) {
        // The stored config (or a site rule) says this page is not ours, so the
        // placeholder `early()` guessed must not outlive it.
        if (earlySheet) {
          finishEarlySheet();
          applier.clear();
        }
        state.reason = "turned off";
        state.on = false;
        mirror();
        return;
      }
      // THE CONFIG CAN BE THE FIRST THING THAT KNOWS. `early()` runs before the
      // stored config has loaded and therefore falls back to the OS preference;
      // on a light-OS machine this is where the placeholder is installed — as
      // soon as the real mode is known, which is normally still before the first
      // paint.
      if (!earlySheet && !state.on && !applier.active()) paintPlaceholder(config);
      state.reason = earlySheet ? "waiting for the page (early canvas)" : "waiting for the page";
      mirror();
      scheduleReadyRerun();
      return;
    }
    if (earlySheet) applier.clear();

    // ASK FOR THE SITE'S OWN THEME FIRST — BEFORE the measurement, and this
    // ordering is the whole fix rather than a detail.
    //
    // A page that ships both schemes resolves `light-dark()` (and every
    // `@media (prefers-color-scheme)` block) from the scheme it is being rendered
    // in. Asking it for dark AFTER measuring therefore changes the page UNDER a
    // mapping that was computed from the light colours — the page's own panels
    // turn dark, our sheet paints them as if they were light, and the result is
    // exactly the report: "it doesn't render dark elements properly". Asking
    // first means the mapping is built from the colours the page will actually
    // have while our sheet is installed.
    //
    // It also means the answer is free when the page HAS a dark theme: there is
    // nothing left for us to paint, so we stand down and leave the site's own
    // design on screen.
    //
    // WHEN THE ANSWER CAN BE READ — and it is usually NOT on the first pass.
    //
    // At `document_start` the page's head has not been parsed, so its stylesheet
    // does not exist yet and the computed `color-scheme` is the UA default on
    // every site that declares its theme in CSS. Our first pass runs as soon as
    // the config arrives, which is normally before the head is parsed. Reading the
    // declaration exactly once, there, is why native dark mode so rarely got found:
    // the page was asked "do you have a dark theme?" before it could answer.
    //
    // So the question stays open until the document has its styles, and is asked
    // again at DOMContentLoaded and at `load` (see `scheduleNativeChecks`). Our
    // sheet no longer touches `color-scheme` at all (see `varsBlock`), so the
    // declaration can be READ with our paint installed; only the VERIFICATION
    // needs the page unpainted, and that is the one place a pass takes its own
    // paint off.
    let repaintSync = earlySheet;
    if (!nativeChecked && !unasked && wantsDarkScheme(config) && ready) {
      if (declaresDarkSupport(colorSchemeNow())) {
        nativeChecked = true;
        // Our own sheet would be measured as the page, and so would its record of
        // the page's earlier colours. Both come off: the question is about what
        // the page renders for the ask, not about what it looked like before.
        applier.clear();
        applier.forget();
        repaintSync = true;
        if (askForNativeDark()) {
          const asked = analyze(await applier.sample({ sync: true }));
          const verdict = nativeDarkVerdict(true, true, asked);
          if (verdict.native) {
            finishEarlySheet();
            applier.clear();
            state.on = false;
            state.engine = "native";
            state.reason = verdict.reason;
            state.coverage = asked.coverage;
            state.pageDark = true;
            mirror();
            // NO OBSERVER HERE. The handle returns immediately while no theme of
            // ours is live (`if (!state.on) return`), and a page that paints its
            // own dark design has nothing for us to repaint: every record would
            // be work queued for a callback that does nothing with it. On a
            // natively-dark app (YouTube, GitHub, X) that is a permanent tax
            // paid for a feature doing no work. The observer is attached where it
            // matters — when a sheet is actually applied (see below).
            return;
          }
          // It declared a dark theme and did not honour the ask (a declaration
          // the page ignores): put the root back exactly as it was, because
          // everything below measures and paints the page as it really is.
          unaskForNativeDark();
          applier.forget();
        }
      } else if (deps.doc.readyState === "complete") {
        // The document is finished loading and declares nothing: the answer is
        // final, and no more checks are needed on this document.
        nativeChecked = true;
      }
    }

    // The first pass after a placeholder paint still measures in ONE task: a
    // yield there is a frame of half-dressed page, even with the placeholder up.
    let samples: PageSample[] = await applier.sample({
      sync: repaintSync,
      added: added && added.length ? added : undefined,
    });
    let analysis = analyze(samples);

    // ONCE THE SITE'S THEME IS THE ANSWER, IT STAYS THE ANSWER.
    //
    // The ask above leaves `color-scheme: dark` on the root, which is what makes
    // the page render its own dark design. Every later pass would then measure a
    // dark page, decide "the page is already dark" and relabel a native theme as
    // a stand-down — a new reason, a different engine, and on a `light` page the
    // sheet would come back. The verdict is therefore sticky while the page it
    // was made for is still dark.
    // A MISSED SAMPLE IS NOT A BROKEN THEME. The verdict used to require a fresh
    // measurement to still say "dark", which fails during every state switch (the
    // document is briefly empty) — so a native page dropped back to light, and
    // because the declaration is only read once it never came back. The verdict
    // is kept unless a real measurement of a real page says otherwise.
    if (state.engine === "native" && (analysis.pageDark || !analysis.sampled)) {
      finishEarlySheet();
      applier.clear();
      state.on = false;
      state.reason = "the site's own dark theme";
      state.coverage = analysis.coverage;
      state.pageDark = true;
      mirror();
      // NO OBSERVER: see the same note in the native-verdict branch above. This
      // path means "the site paints its own dark theme, we paint nothing", so
      // there is nothing for a mutation callback to do.
      return;
    }
    // The page was the site's own theme and is not any more (the site dropped it,
    // or the user turned this site off): the inline `color-scheme` we wrote is
    // ours to take back, because leaving it behind keeps a page dark that nobody
    // asked to be dark — the reported "turning dark mode off does nothing on
    // sites with their own theme".
    if (nativeHeld) unaskForNativeDark();

    // A TRANSIENT EMPTY PAGE IS NOT A VERDICT.
    //
    // State switches unmount before they mount: for a few frames the document is
    // empty, so the sampler finds no surface at all. That measurement used to
    // travel the whole path — no samples → filter engine → a page-wide inversion
    // of a blank document — and the user sees it as the reported "blank dark
    // overlay" while the site is still building its next view. When a theme is
    // already live on this page, the honest answer is to keep it and let the next
    // gated mutation re-measure.
    // AND ONLY WHILE THE THEME IS ACTUALLY ON SCREEN (`applier.active()`). The
    // flag alone is not enough, and the gap between the two was a real state:
    // a user toggle clears the sheet and then re-applies, and if that pass
    // measured a page mid-transition the early return kept `state.on` true over
    // a DELETED sheet. The page then had dark mode "on" with nothing painted and
    // nothing scheduled to fix it — the report "it shows a blank overlay and I
    // have to reload the page to see the content again".
    if (!analysis.sampled && state.on && applier.active()) {
      finishEarlySheet();
      state.reason = "page mid-transition; keeping the theme";
      mirror();
      return;
    }

    const decision = decide(config, analysis, liveAnalysis ?? analysis, liveEngine);
    const rulesForPage = matchRules(rules(), url);
    state.coverage = analysis.coverage;
    state.pageDark = analysis.pageDark;
    state.corpusBlocks = corpus.length;
    state.corpusErrors = corpusErrors;
    state.mode = decision.mode;
    state.engine = decision.theme ? decision.theme.engine : decision.engine;
    state.reason = decision.reason;
    // The real decision has landed; the placeholder paint is no longer needed
    // and must never outlive the sheet that replaces it.
    finishEarlySheet();
    if (!decision.theme) {
      applier.clear();
      state.on = false;
      // No theme of ours is live, so the next pass that paints one starts from
      // the page's own palette again rather than from a record of a palette that
      // is no longer on screen.
      liveAnalysis = null;
      liveEngine = null;
      mirror();
      return;
    }
    const theme = decision.theme;
    liveEngine = theme.engine;
    liveAnalysis = liveAnalysis ?? analysis;
    const entries = theme.engine === "dynamic" ? entriesFor(samples, theme) : [];
    // The UA's own furniture (scrollbars, inputs, the select dropdown) is drawn
    // from `color-scheme`, and without it a dark page keeps white scrollbars and
    // white form controls — artifacts the mapping cannot reach because the UA
    // paints them, not the page. It is only written for a page that declares NO
    // dark support of its own: on a page that does, it would flip every
    // `light-dark()` value after the mapping was measured from the other side.
    const scheme =
      nativeChecked && declaredNative === false ? (theme.direction === "darken" ? "dark" : "light") : null;
    applier.setSheet(
      composeSheet({ theme, entries, rules: rulesForPage, userCss: config.dark.userCss || "", scheme })
    );
    applier.setScheme(theme.direction === "darken" ? "dark" : "light");
    state.on = true;
    mirror();
    ensureObserver();
    // A page with more elements than one pass walks is not finished being
    // measured, and nothing else is coming for it: ask for the next slice.
    if (applier.pending() > 0) scheduleContinuation();
  }

  function write(next: Config): void {
    deps.setConfig(next);
    // A user action re-opens the coverage budget: turning the theme on is the
    // moment a fresh walk is wanted.
    continuations = 0;
    // A user action re-opens the native-theme question: turning a site off and on
    // again should give the site's own theme back rather than a recolouring of
    // its light palette. Answering it needs the page unpainted, so our paint comes
    // off here — which is only ever a user-initiated path, never a resample.
    nativeChecked = false;
    unasked = false;
    liveAnalysis = null;
    liveEngine = null;
    // THE PAINT IS GONE, SO THE STATE SAYS SO. `state.on` used to stay true
    // across the clear, which is the one thing that can make "dark mode is on"
    // and "there is no sheet" both true at once if the pass that follows finds
    // an unsampled page.
    state.on = false;
    applier.clear();
    applier.forget();
    // Apply the local copy immediately so the toast and the sheet agree with
    // what the user just pressed; the storage broadcast will confirm it.
    requestApply(next);
  }

  function upsertSite(host: string, patch: Partial<SiteRule>): Config {
    const config = deps.getConfig();
    const sites = (config.dark.sites || []).slice();
    const at = sites.findIndex((r) => r.match === host);
    const next: SiteRule = at >= 0 ? { ...sites[at]!, ...patch } : { match: host, ...patch };
    // An entry with nothing left to say is removed rather than kept as noise:
    // an empty rule reads like a setting and behaves like nothing.
    const meaningful = next.mode !== undefined || next.engine !== undefined || !!next.css;
    if (at >= 0) {
      if (meaningful) sites[at] = next;
      else sites.splice(at, 1);
    } else if (meaningful) {
      sites.push(next);
    }
    return { ...config, dark: { ...config.dark, sites } };
  }

  /**
   * Paint the canvas before anything is known about the page.
   *
   * Two writes: a marker on the root (the sheet's own selector is gated on it, so
   * the paint can never outlive the state that installed it) and the fallback
   * sheet. The colours come from the config that is in hand — the shipped theme
   * at `document_start`, the stored one a few milliseconds later, which is why
   * this is a function rather than a block in `early()`.
   */
  function paintPlaceholder(config: Config): void {
    const mode = (state.site?.mode ?? config.dark.mode) as Mode;
    if (mode === "off" || mode === "light") return;
    const theme = buildTheme(config.dark, "darken", "dynamic", {
      canvas: { r: 255, g: 255, b: 255, a: 1 },
      text: { r: 0, g: 0, b: 0, a: 1 },
      canvasKey: "",
      textKey: "",
      pageDark: false,
      coverage: 0,
      sampled: false,
      distinct: 0,
    });
    try {
      deps.doc.documentElement?.setAttribute("data-lf-dark-pending", "1");
    } catch {
      /* ignore */
    }
    applier.setSheet(fallbackSheet(theme));
    earlySheet = true;
    state.mode = mode;
    state.reason = "waiting for the page (early canvas)";
  }

  return {
    early(): void {
      // THE WHITE FLASH. This runs before the page has painted, and it paints the
      // canvas the theme is about to use so the first frame is dark instead of
      // white.
      //
      // It can only guess, because the stored config is still loading and a site
      // rule cannot be known yet. The guess is the OS preference applied to the
      // config in hand — which, before storage answers, is the SHIPPED default.
      // That default is `off`, so a fresh profile paints nothing here and the
      // real config installs the placeholder in `apply` the moment it lands
      // (normally still before first paint). Guessing dark on a dark-OS machine
      // before the config says so is what a page nobody asked to recolour must
      // not see, so the guess follows the config rather than the desktop.
      let prefersDark = false;
      try {
        prefersDark = !!deps.win.matchMedia && deps.win.matchMedia("(prefers-color-scheme: dark)").matches;
      } catch {
        prefersDark = false;
      }
      const config = deps.getConfig();
      state.site = siteFor();
      if (!prefersDark) return;
      paintPlaceholder(config);
      mirror();
    },

    update(config: Config): void {
      requestApply(config);
    },

    toggleSite(): void {
      const host = hostAndPath(deps.url()).host;
      if (!host) {
        deps.toast("dark mode: this page has no host");
        return;
      }
      // A page showing the SITE's own theme counts as on. It used to read as off,
      // because `state.on` means "we painted something" — so the first `;Y d` on
      // such a site wrote mode `dark` (recolouring the theme the user was trying
      // to leave alone) instead of turning it off.
      const on = state.on || state.engine === "native" || nativeHeld;
      // Turning it back on hands the page to the site's own theme when it has
      // one, rather than recolouring a page that did not need recolouring. The
      // DECLARATION IS THE CACHED ONE (`declaredNative`), not a live read: once a
      // theme of ours is painting, the root's computed `color-scheme` may be ours
      // too (§8), and asking it then would answer "dark" about our own sheet.
      const mode: Mode = on ? "off" : declaredNative ? "auto" : "dark";
      deps.toast("dark mode: " + (on ? "off" : "on") + " for " + host);
      write(upsertSite(host, { mode }));
    },

    cycleGlobal(): void {
      const config = deps.getConfig();
      const at = MODE_CYCLE.indexOf(config.dark.mode);
      const mode = MODE_CYCLE[(at + 1) % MODE_CYCLE.length]!;
      deps.toast("dark mode default: " + mode);
      write({ ...config, dark: { ...config.dark, mode } });
    },

    toggleEngine(): void {
      const host = hostAndPath(deps.url()).host;
      const config = deps.getConfig();
      const site = (config.dark.sites || []).find((r) => r.match === host);
      const current: EnginePref = site?.engine ?? config.dark.engine;
      const at = ENGINE_CYCLE.indexOf(current);
      const engine = ENGINE_CYCLE[(at + 1) % ENGINE_CYCLE.length]!;
      deps.toast("dark engine: " + engine + (host ? " for " + host : ""));
      write(upsertSite(host, { engine }));
    },

    resetSite(): void {
      const host = hostAndPath(deps.url()).host;
      const config = deps.getConfig();
      const sites = (config.dark.sites || []).filter((r) => r.match !== host);
      deps.toast(sites.length === (config.dark.sites || []).length ? "dark mode: no rules for " + host : "dark mode: rules for " + host + " cleared");
      write({ ...config, dark: { ...config.dark, sites } });
    },

    cyclePalette(): void {
      // THE PICKER, not a second palette store (shared/darkpalettes.ts): the
      // next preset WRITES the three poles, exactly as choosing it in settings
      // does, so the engine's single source of truth stays what it always was
      // and the toast says the NAME the user just landed on.
      const config = deps.getConfig();
      const palette = nextPalette(config.dark.palette);
      deps.toast("color scheme: " + palette.name);
      write({
        ...config,
        dark: {
          ...config.dark,
          palette: palette.id,
          background: palette.bg,
          foreground: palette.fg,
          accent: palette.accent,
        },
      });
    },

    state: () => ({ ...state }),
  };
}
