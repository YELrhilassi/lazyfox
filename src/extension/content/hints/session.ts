// The session: one `;f` press, from collecting candidates to handling keys.
// Only session-scoped state lives here; the rest lives next door:
//   selectors.ts  what counts as hintable       select.ts   which candidates get a label
//   probe.ts     visibility + naming            overlay.ts  label DOM and placement
//   collect.ts   page walk for candidates       activate.ts clicking/focusing + verdict
//   life.ts      "the page did something"       diagnose.ts the "why isn't this hinted" report
import { core } from "../../../shared/core";
import { toast } from "../../../shared/overlay";
import type { HintActivation } from "../../../shared/types";
import {
  DOM_RESYNC_DELAY,
  DOM_RESYNC_MAX_WAIT,
  MAX_HINTS,
  PAGE_GUARD,
  POOL_RESYNC_MS,
  RESYNC_DELAY,
  type HintItem,
} from "./selectors";
import { createHintOverlay } from "./overlay";
import { createActivator } from "./activate";
import { targetKey, type HintCandidate } from "./select";
import { createHintResolve, type HintPager } from "./hintresolve";
import { sheetOver } from "./probe";
import { shadowRootOf, walkElements } from "../../../shared/dom";
import { createCoalescer } from "../../../shared/coalesce";
import { createMotionWatch, type MotionKind, type MotionWatch } from "./motion";
import { startLifeCounting, stopLifeCounting } from "./life";
import { createFrameCoalescer, nextMeasurementDelay, FAST_EPISODE_MS } from "./frames";

// WHEN A PASS RUNS — the rules, and the tests that pin them, live in frames.ts.
//
// The short version: a motion event REQUESTS a re-anchor, and frames.ts folds
// everything asked for in one frame into one measurement pass (a scroll burst
// raises more events than the display has frames). A timer is kept for movement
// nothing announces — a page animating its own layout from a rAF loop, which
// raises no event we can observe — and frames.ts owns its bounded cadence.
// This file only decides WHAT a pass does (sweep, below).

export interface LinkHints {
  readonly active: boolean;
  // True between the `;f` keypress and the batch being on screen (start() is
  // async). Cancel paths MUST gate on `active || starting`: gating on `active`
  // alone drops the Escape that arrives in that window.
  readonly starting: boolean;
  start(): Promise<void>;
  handleKey(e: KeyboardEvent): boolean;
  exit(): void;
  // What the last activation did (HintActivation), for the diagnostics page.
  lastActivation(): HintActivation | null;
  // Whether the enter-affordance badge is up (an ambiguous typed prefix).
  enterBadge(): { shown: boolean; glyph: string };
  // Explicitly requested geometry for e2e/diagnostics — never published live.
  // `held` rows: labels whose control is momentarily gone but still drawn
  // (overlay.snapshot).
  snapshot(): {
    positions: Array<{ key: string; x: number; y: number; held?: boolean }>;
    boxes: Array<{ key: string; l: number; t: number; r: number; b: number; held?: boolean }>;
  };
}

export function createLinkHints(
  getHintChars: () => string,
  // The page's scroll controller, when the host has one (see HintPager). Absent
  // in the unit tests, where paging falls back to the window scroller.
  getScroll?: () => HintPager | null
): LinkHints {
  let active = false;
  let pool: Element[] = []; // every hintable element, in document order
  // Which live element does this label belong to, NOW? Split out into
  // hintresolve.ts: it is the only stateless part (pool in, elements out) but
  // resolving may refresh the pool — a session-state mutation, so the session
  // keeps ownership via setPool.
  const resolve = createHintResolve({
    pool: () => pool,
    setPool: (next) => { pool = next; },
    maxHints: MAX_HINTS,
    scroll: getScroll,
  });
  let items: HintItem[] = []; // currently hinted items (viewport subset)
  // A prefix-free key sequence generated once per session, drawn from for the
  // whole session and NEVER reshuffled by a re-hint: a control appearing later
  // (an ad's Skip button) or re-created by a framework keeps its key instead
  // of invalidating what the user is typing.
  let keyPool: string[] = [];
  let typed = "";
  // Incremented on every start()/exit(); async continuations capture it and
  // bail when a newer session takes over (ESC during an await).
  let session = 0;
  // True until the batch is actually built. `start()` is async, and Escape in
  // that window used to be dropped: nothing bumped `session`, so the batch
  // appeared AFTER the user had cancelled it — the "hints get stuck, Escape
  // does not work" report.
  let starting = false;
  // Re-anchoring state.
  //   anchorFrames — the one-pass-per-frame coalescer (frames.ts). A motion
  //                  event requests a pass; many events in a frame are one pass.
  //   tickTimer    — the safety net, re-armed whenever its cadence changes.
  //   episodeUntil — the deadline on the fast cadence (FAST_EPISODE_MS).
  const anchorFrames = createFrameCoalescer(
    {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (handle) => cancelAnimationFrame(handle),
    },
    () => {
      if (active) sweep();
    }
  );
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let tickPeriod = 0;
  let episodeUntil = 0;
  let motion: MotionWatch | null = null;
  // Viewport settled and a batch re-hint is due (see syncViewport).
  let resyncAt = 0;
  // A re-hint triggered by scrolling is in flight.
  let syncing = false;
  // The DOM changed while hints are active (a late control needs a hint).
  // Debounced: a mutation burst produces one re-hint once things settle.
  let domDirty = false;
  let domResyncAt = 0;
  let domSyncFirst = 0;
  // Deadline for the slow, mutation-independent pool refresh.
  let poolResyncAt = 0;
  let domObserver: MutationObserver | null = null;
  let shadowObservers: MutationObserver[] = [];
  /** The once-per-`;f` "the page finished loading" re-hint (see watchDom). */
  let loadHook: (() => void) | null = null;
  let observeRoots: ((root: ParentNode, depth: number) => void) | null = null;
  let observedHintRoots = new WeakSet<ShadowRoot>();
  // A root's own observer schedules the same debounced re-hint the
  // document observer already scheduled, so late discovery costs nothing.
  const ROOTS_DISCOVERY_MS = 500;
  // Per-root element budget for one discovery pass; a root beyond it is found
  // by the NEXT pass (delays discovery instead of losing it).
  const SHADOW_WALK_BUDGET = 4000;

  // COALESCED shadow-root discovery — the walk is querySelectorAll("*") over
  // the whole document and used to run once per mutation batch. Same rule as
  // the scroll controller, which is why it is shared/coalesce.ts.
  const rootDiscovery = createCoalescer({
    everyMs: ROOTS_DISCOVERY_MS,
    // Read through the variable, not captured: unwatchDom() nulls it.
    run: () => {
      if (observeRoots) observeRoots(document, 0);
    },
  });
  // The label overlay, and the click + verdict machinery. Injected rather than
  // inlined: the session decides WHAT happens on a keypress; these decide how
  // labels are drawn and whether the page actually reacted.
  const overlay = createHintOverlay();
  const activator = createActivator();

  function hintChars(): string {
    // The leader key (';' by default) must never double as a hint char —
    // strip it even if an older saved config still lists it.
    return (getHintChars() || "asdfjklgh").replace(/;/g, "");
  }

  async function start(): Promise<void> {
    // A start already in flight is a start the user can still cancel. Without
    // this the second `;f` ran a second full collect + core call, and the two
    // raced to install overlapping batches.
    if (active || starting) return;
    const mySession = ++session;
    starting = true;
    try {
      await runStart(mySession);
    } finally {
      if (session === mySession) starting = false;
    }
  }

  // The body of start(), split out so `starting` is cleared on EVERY exit path
  // — including the early returns below — by one finally rather than by a
  // hand-placed `starting = false` on each branch. Miss one and the layer can
  // never be started again on that page: `;f` would return immediately, with
  // no error and nothing on screen.
  async function runStart(mySession: number): Promise<void> {
    // Through the resolve layer, so the pool and the visibility pass it will be
    // selected with are built TOGETHER (see hintresolve.refreshPool).
    pool = resolve.refreshPool();
    // The content script is intentionally top-frame-only today. A visible
    // iframe is a real part of the screen, so silently presenting the top
    // document's partial set as "all hints" is misleading. Say so on each
    // invocation; if the iframe is the ONLY interactive surface, give the more
    // useful no-hints explanation below instead.
    let hasVisibleFrame = false;
    try {
      const frames = document.querySelectorAll("iframe");
      for (let i = 0; i < frames.length; i++) {
        const r = frames[i]!.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
            r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0)) {
          hasVisibleFrame = true;
          break;
        }
      }
    } catch (e) {
      // A hostile page's frame tree must not prevent the local hints from working.
    }
    if (!pool.length) {
      toast(hasVisibleFrame ? "no hints in view — iframe contents aren't included" : "no hints");
      return;
    }
    if (hasVisibleFrame) toast("iframe contents aren't included in link hints");
    // One key sequence for the whole session (see keyPool). Generated up front
    // so a later re-hint never has to await the core mid-flight.
    try {
      keyPool = await core.makeHints(MAX_HINTS + 18, hintChars());
    } catch (e) {
      toast("core unavailable");
      return;
    }
    if (session !== mySession) return; // exited (ESC) during the await
    starting = false;
    // HINTS NEVER MOVE THE PAGE. An old loop scrolled up to PAGE_GUARD
    // viewports hunting links, jumping the page under the user's hands and
    // stalling heavy documents. "Nothing here is hintable" is said outright;
    // `]` / `[` page toward other links.
    const sel = resolve.viewportItems();
    const vis = sel.kept;
    if (!vis.length) {
      toast("no hints in view \u2014 ] for the next batch");
      return;
    }
    active = true;
    // THE AMBIENT WINDOW OPENS WITH THE BATCH. The activation watcher needs
    // "how much does this page mutate on its own" BEFORE the press, or it cannot
    // tell a reaction from a heartbeat — and the difference decides whether a
    // hinted control is pressed once or twice (see hints/life.ts).
    startLifeCounting();
    overlay.mount();
    watchDom();
    watchMotion();
    // First timer refresh is owed this long after the batch was built. Never
    // zeroed earlier: a page already mutating keeps this pushed out by the
    // mutation path, which zeroed it below.
    poolResyncAt = performance.now() + POOL_RESYNC_MS;
    ensureTick();
    await assign(vis);
    if (session !== mySession) return; // exited (ESC) during the await
    if (!items.length) exit();
    // THE CAP IS STATED, NOT SILENT. If more controls were in view than the
    // batch has labels for, the user is told both numbers and the way to the
    // rest — before this, a dense page simply "had no hints" for rows that were
    // plainly there, and nothing on screen explained why (see select.ts).
    if (sel.more > 0) {
      toast(
        items.length + " hints \u2014 " + sel.more + " more in view, ] for the next batch"
      );
    }
  }

  // The shortest key in the pool that this batch has not taken yet. Scanning
  // from the front means the first controls on screen keep the short keys
  // ("a", "s", …) while controls that appear later get the next free one.
  function takeKey(taken: Set<string>): string | null {
    for (let i = 0; i < keyPool.length; i++) {
      const k = keyPool[i]!;
      if (!taken.has(k)) return k;
    }
    return null;
  }

  // Re-hint a batch of elements. Keys are STABLE for the whole session: an
  // already-hinted element keeps its key, and a framework-replaced node
  // (virtual-DOM re-render) inherits the key of the control it took over,
  // matched by destination or screen position. Re-keying the whole batch on
  // every change made the key the user just read go stale on churning pages.
  async function assign(list: HintCandidate[]): Promise<void> {
    if (!list.length) return;
    const chosen = list.slice(0, MAX_HINTS);
    const prev = items;
    // Identical batch: keep everything, including the half-typed prefix. The
    // covered flags are still refreshed — coverage is a fact about the PAGE,
    // not the batch identity (a scrim fades, a sticky header appears).
    if (
      prev.length === chosen.length &&
      chosen.every((c, i) => prev[i] && prev[i]!.el === c.el)
    ) {
      for (let i = 0; i < chosen.length; i++) prev[i]!.covered = chosen[i]!.covered;
      render();
      return;
    }
    const taken = new Set<string>();
    const inherited = new Map<Element, string>();
    // 1. The same node object is still there: keep its key verbatim.
    for (const c of chosen) {
      for (const it of prev) {
        if (it.el === c.el && !taken.has(it.key)) {
          inherited.set(c.el, it.key);
          taken.add(it.key);
          break;
        }
      }
    }
    // 2. A re-rendered node: the control did not really move, so neither should
    //    its key. Match by destination (an href may survive a small reflow) or
    //    by being in essentially the same place.
    for (const c of chosen) {
      if (inherited.has(c.el)) continue;
      let box: DOMRect;
      try {
        box = c.el.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const target = targetKey(c.el);
      let best: HintItem | null = null;
      let bestD = Infinity;
      for (const it of prev) {
        if (taken.has(it.key)) continue;
        const dx = it.cx - cx;
        const dy = it.cy - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const sameTarget = !!target && !!it.target && target === it.target;
        const limit = sameTarget ? 80 : 12;
        if (d <= limit && d < bestD) {
          best = it;
          bestD = d;
        }
      }
      if (best) {
        inherited.set(c.el, best.key);
        taken.add(best.key);
      }
    }
    // 3. Genuinely new controls draw the shortest still-free key.
    const nextItems: HintItem[] = [];
    for (const c of chosen) {
      let key = inherited.get(c.el);
      if (!key) {
        key = takeKey(taken) ?? undefined;
        if (!key) continue; // pool exhausted (more controls than MAX_HINTS)
        taken.add(key);
      }
      nextItems.push({
        el: c.el,
        key: key,
        label: null,
        cx: 0,
        cy: 0,
        target: targetKey(c.el),
        covered: c.covered,
      });
    }
    for (const it of prev) {
      if (it.label) {
        it.label.remove();
        it.label = null;
      }
    }
    items = nextItems;
    // A half-typed prefix survives a re-hint while it still matches something;
    // only a real invalidation clears it.
    if (typed && !items.some((it) => it.key.indexOf(typed) === 0)) typed = "";
    render();
  }

  // A hintable that is still on screen right NOW, judged by what the page
  // itself says: connected, sized, inside the viewport, and not display:none /
  // visibility:hidden / opacity:0 / content-visibility:hidden (checkVisibility
  // answers all of those in one call where it exists, as in hints/visibility.ts).
  // This is deliberately NOT the full `fullyVisible` visibility pass — the point
  // here is the cheap page-side floor a survivor must clear, not a second answer
  // on what deserves a label.
  function stillShowable(it: HintItem): boolean {
    const el = it.el;
    if (!el || !el.isConnected) return false;
    let r: DOMRect | null = null;
    try {
      r = el.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    if (!r || r.width <= 0 || r.height <= 0) return false;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    // A control that a DIALOG or a popup sheet now covers is not a survivor: the
    // page put a surface on top of it, and keeping the label would draw it over
    // that surface. (A scrim or a sticky bar is not this — sheetOver is the
    // question "is a separate surface over it", not "is it obstructed".)
    try {
      if (sheetOver(el)) return false;
    } catch (e) {
      // A hostile element must not keep a label alive either; fall through.
    }
    // An undrawn label is a candidate someone else already accounts for; only
    // the placed ones are at stake here.
    if (!it.label) return false;
    const cv = el as Element & { checkVisibility?: (opts?: object) => boolean };
    if (typeof cv.checkVisibility === "function") {
      try {
        return !!cv.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          contentVisibilityAuto: true,
        });
      } catch (e) {
        // fall through to the computed-style floor
      }
    }
    try {
      const cs = getComputedStyle(el);
      return (
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        cs.visibility !== "collapse" &&
        cs.opacity !== "0"
      );
    } catch (e) {
      return true;
    }
  }

  // A passive refresh (the debounced re-collect after a mutation, the timer
  // refresh, the settled-scroll resync) must be CONSERVATIVE about what it
  // already shows: a re-collection walks the document on a wall-time budget and
  // comes back TRUNCATED on a page that is still loading (collect.ts reports
  // it; the live sweep measured it — github.com mid-load, a `<video>` late in
  // the DOM lost from the pool and its label with it, while the element itself
  // had not moved, still visible and pointer-alive). Truncation loses only the
  // EXPENSIVE tier — cursor-pointer controls and media surfaces — which is
  // exactly the reporting the user's case A made: labels drawn at `;f` that
  // vanish a few seconds later with nothing wrong on the page.
  //
  // So the fresh viewport subset is merged with the currently PLACED items that
  // still clear the page-side floor above. A control that the page genuinely
  // removed, hid, shrank to nothing or scrolled away is dropped with it (the
  // floor answers those); a control the refresh merely failed to see keeps its
  // label and its key, exactly as a re-render keeps them via the inherited-key
  // paths in assign(). Selection order stays document order, so the first
  // controls on the page keep the short keys in a merged batch.
  function mergeWithSurvivors(vis: HintCandidate[]): HintCandidate[] {
    const survivors = items.filter(stillShowable);
    if (!survivors.length) return vis;
    const freshSet = new Set(vis.map((c) => c.el));
    const extra = survivors
      .filter((it) => !freshSet.has(it.el))
      .map((it) => ({ el: it.el, covered: it.covered }));
    if (!extra.length) return vis;
    const all = [...extra, ...vis];
    try {
      all.sort((a, b) => {
        const pos = a.el.compareDocumentPosition(b.el);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
    } catch (e) {
      // An order that cannot be computed (a detached node) is left as-is:
      // assign() matches by identity and position either way.
    }
    return all;
  }

  // When the viewport has moved and settled, swap in the batch now on screen.
  // While a prefix is typed the set is left alone (a re-hint discards input),
  // and with nothing hintable in view the current batch is kept so labels can
  // still track pages that shift under them.
  function syncViewport(): void {
    if (!active || typed !== "" || syncing) return;
    const vis = mergeWithSurvivors(resolve.viewportItems().kept);
    if (!vis.length) return;
    if (vis.length === items.length && vis.every((c, i) => items[i] && items[i]!.el === c.el)) {
      return;
    }
    syncing = true;
    void assign(vis).then(
      () => {
        syncing = false;
      },
      () => {
        syncing = false;
      }
    );
  }

  // Does a mutation record only touch our own overlay host? Adding/removing
  // the host and (later) removing it must not count as page changes. Labels
  // live in a closed shadow root, which these observers never see.
  function touchesOverlay(rec: MutationRecord): boolean {
    if (overlay.isOwnNode(rec.target)) return true;
    for (let i = 0; i < rec.addedNodes.length; i++) {
      if (overlay.isOwnNode(rec.addedNodes[i]!)) return true;
    }
    for (let i = 0; i < rec.removedNodes.length; i++) {
      if (overlay.isOwnNode(rec.removedNodes[i]!)) return true;
    }
    return false;
  }

  // Watch the page while hints are active so a control that appears AFTER the
  // batch was built (a video "Skip ad" button, a lazily-rendered menu, an SPA
  // re-render) still gets a working hint. Only childList is observed (no
  // attributes/characterData), so a progress bar's width updates or a clock's
  // text do not cause churn; only real insertions/removals schedule a re-hint.
  function watchDom(): void {
    if (domObserver || typeof MutationObserver === "undefined") return;
    try {
      const scheduleResync = (): void => {
        if (!active) return;
        const now = performance.now();
        if (!domDirty) {
          domDirty = true;
          domSyncFirst = now;
        }
        domResyncAt = Math.min(now + DOM_RESYNC_DELAY, domSyncFirst + DOM_RESYNC_MAX_WAIT);
        // The timer refresh is subsumed by a real mutation: whatever the
        // debounced re-collect turns up, the timer did not need to run first.
        poolResyncAt = 0;
        // The net may be sitting at a coarser delay than the re-hint now owes
        // (it is a still page, so SAFETY_MS); arm it for the shorter wait so an
        // inserted control gets its key from the mutation that announced it.
        ensureTick();
      };
      domObserver = new MutationObserver((records) => {
        let changed = false;
        for (const rec of records) {
          if (!touchesOverlay(rec)) {
            changed = true;
            break;
          }
        }
        if (!changed) return;
        scheduleResync();
        // New custom elements may have created their shadow roots since the
        // last scan, so a real DOM change is also the moment to look — but
        // COALESCED, because the look is a full-document walk (see
        // rootDiscovery).
        rootDiscovery.request();
      });
      domObserver.observe(document.documentElement, { childList: true, subtree: true });
      // A PAGE THAT FINISHES LOADING GETS ONE MORE PASS — `load` is the page's
      // own statement that it is finished, and it must not be confused with a
      // mutation: elements rejected while their boxes were zero or hidden only
      // become hintable at `load`, and the page often mutates BEFORE that, so
      // the last re-collect can permanently short-change exactly the elements
      // in view. Coalesced like every re-hint (one extra collect per `;f`, not
      // one per image). An already-complete page arms nothing.
      if (document.readyState !== "complete" && !loadHook) {
        loadHook = () => {
          loadHook = null;
          scheduleResync();
          rootDiscovery.request();
        };
        window.addEventListener("load", loadHook, { once: true, capture: true });
      }
      // MutationObserver does not cross shadow-root boundaries. Watch every
      // extension-visible root in the same bounded tree walk so late controls
      // and framework replacements inside open/closed components also refresh.
      observeRoots = (root: ParentNode, depth: number): void => {
        if (depth >= 6) return;
        // A LAZY, BUDGETED walk (shared/dom.ts walkElements): the cap bounds
        // the loop AND the allocation, and each root gets its own budget so a
        // huge light DOM cannot starve roots nested inside it.
        walkElements(root, SHADOW_WALK_BUDGET, (el) => {
          const shadow = shadowRootOf(el);
          if (!shadow || observedHintRoots.has(shadow)) return;
          observedHintRoots.add(shadow);
          // A mutation INSIDE an observed root is a page change like any other:
          // it schedules the re-hint. The recursion below happens once, when the
          // root is discovered, to pick up roots nested inside it.
          const observer = new MutationObserver(() => scheduleResync());
          observer.observe(shadow, { childList: true, subtree: true });
          shadowObservers.push(observer);
          observeRoots!(shadow, depth + 1);
        });
      };
      // The first discovery is immediate: it is the price of opening hints at
      // all, and it is paid once per `;f` rather than once per mutation.
      rootDiscovery.request();
    } catch (e) {
      domObserver = null;
    }
  }

  function unwatchDom(): void {
    rootDiscovery.dispose();
    if (loadHook) {
      try {
        window.removeEventListener("load", loadHook, { capture: true });
      } catch (e) {
        // ignore
      }
      loadHook = null;
    }
    if (domObserver) {
      try {
        domObserver.disconnect();
      } catch (e) {
        // ignore
      }
      domObserver = null;
    }
    for (const observer of shadowObservers) {
      try {
        observer.disconnect();
      } catch (e) {
        // ignore
      }
    }
    shadowObservers = [];
    observedHintRoots = new WeakSet<ShadowRoot>();
    observeRoots = null;
    domDirty = false;
    domResyncAt = 0;
    domSyncFirst = 0;
    poolResyncAt = 0;
  }

  // ONE measurement pass: re-anchor every label, then run any owed re-hint.
  // Everything calls THIS, so "the labels track the page" has exactly one
  // implementation and no second loop that could disagree with it.
  function sweep(): void {
    if (!active) return;
    const now = performance.now();
    render();
    if (resyncAt && now >= resyncAt) {
      resyncAt = 0;
      syncViewport();
    }
    // A control appeared/vanished after the batch was built: RE-COLLECT (the
    // pool is a snapshot from `;f`, so a node inserted later is not in it) and
    // re-hint the viewport, so a late-appearing control gets a working key
    // (e.g. a video player's "Skip ad" button).
    if (domDirty && now >= domResyncAt) {
      domDirty = false;
      domResyncAt = 0;
      pool = resolve.refreshPool();
      // A refresh just happened; the timer's next one is owed this long after
      // it, not after the batch was built.
      poolResyncAt = now + POOL_RESYNC_MS;
      syncViewport();
    }
    // The dormant state a control can be in when the user opens hints: present
    // in the DOM, rejected by both collections because its box is empty (a
    // display:none slot, a player hiding its Skip button until the skip window
    // opens). It becomes presentable by changing an ATTRIBUTE — a class, an
    // inline style — which the childList observer above deliberately does not
    // watch, and which nothing else here announces. The mutation path is the
    // fast channel; this is the slow catch-all that keeps a pool built during
    // one of those dormant windows from being wrong for the rest of the
    // session. One budgeted collect per interval; an identical batch is kept.
    if (poolResyncAt && now >= poolResyncAt) {
      poolResyncAt = now + POOL_RESYNC_MS;
      pool = resolve.refreshPool();
      syncViewport();
    }
  }

  // Re-anchor on the next frame, at most once per frame. Every motion event
  // calls this; while the user is scrolling it is the thing that tracks the
  // labels, and it is why the safety timer is allowed to be slow.
  function anchor(): void {
    if (!active) return;
    anchorFrames.request();
  }

  // The safety net's delay, from now. The policy — a bounded fast episode, and
  // the earliest owed work winning over a coarser safety rate — is frames.ts,
  // where it is tested as a function rather than read off a timer.
  function tickDelay(now: number): number {
    // The EARLIEST owed work wins (frames.ts rule): a due mutation resync and a
    // due timer resync are the same kind of due — whoever is closer is what the
    // net must wait for, and a pending one is not a reason to delay the other.
    const domDue = domDirty ? domResyncAt : 0;
    const due = domDue && poolResyncAt ? Math.min(domDue, poolResyncAt) : domDue || poolResyncAt;
    return nextMeasurementDelay({
      now: now,
      moving: !!motion && motion.moving(),
      episodeUntil: episodeUntil,
      resyncAt: resyncAt,
      domResyncAt: domDue,
      poolResyncAt: due,
    });
  }

  function stopTick(): void {
    if (tickTimer !== null) clearInterval(tickTimer);
    tickTimer = null;
    tickPeriod = 0;
  }

  // (Re-)arm the safety net. Called from everything that can change the
  // cadence — a motion event, a scheduled re-hint, the net's own tick — and
  // idempotent for a delay already in force, so a scroll burst does not rebuild
  // the interval once per event.
  function ensureTick(): void {
    if (!active) return;
    const period = tickDelay(performance.now());
    if (tickTimer !== null && tickPeriod === period) return;
    stopTick();
    tickPeriod = period;
    tickTimer = setInterval(onTick, period);
  }

  function onTick(): void {
    if (!active) {
      stopTick();
      return;
    }
    sweep();
    // The cadence can change under the timer (the fast episode ended, or new
    // motion opened one); re-arming is what applies it.
    ensureTick();
  }

  // A motion event. Scroll and resize mean the batch on screen may be the WRONG
  // batch — the user scrolled to a new section — so they also schedule the
  // debounced re-hint; a transition or an animation is the same batch moving, so
  // it only re-anchors. Both open or refresh the fast episode.
  function noteMotion(kind: MotionKind): void {
    if (!active) return;
    const now = performance.now();
    if (kind !== "animation") {
      // Pushed forward by every event while the page moves, so the re-hint runs
      // once the movement SETTLES rather than mid-flight.
      resyncAt = now + RESYNC_DELAY;
    }
    if (now >= episodeUntil) episodeUntil = now + FAST_EPISODE_MS;
    anchor();
    ensureTick();
  }

  // Start watching for the things that mean "the page moved". Idempotent, and
  // disposed by exit().
  function watchMotion(): void {
    if (motion) return;
    motion = createMotionWatch(noteMotion);
    episodeUntil = performance.now() + FAST_EPISODE_MS;
  }

  // Scroll to the next / previous batch of links and re-hint it. Keeps paging
  // (bounded) when the direction lands on a link-free section.
  //
  // "Did it move" is asked of the REGION THE KEYS MOVE (resolve.pageScroll),
  // not of `window.scrollY`: on a shell page whose content lives in an inner
  // pane the window never moves, so the old check declared the bottom of the
  // page on the first press of `]` and reported "no more links" over a
  // document with pages of them left — and the scroll it had just performed
  // went to the wrong scroller.
  function page(dir: number): void {
    for (let i = 0; i < PAGE_GUARD; i++) {
      const step = resolve.pageScroll(dir);
      const vis = resolve.viewportItems().kept;
      if (vis.length) {
        void assign(vis);
        return;
      }
      if (step.after === step.before) break; // at the top/bottom of the region
    }
    toast("no more links");
  }

  // Draw the labels for the current batch and typed prefix. The one place the
  // session talks to the overlay.
  //
  // The enter badge is the state the user cannot see: the next character will
  // not activate anything and Enter is the only way to take the first match.
  // Ambiguous means at least one SHOWN match is longer than the prefix AND
  // there is more than one to choose between ("a" boxed with "ad" — neither
  // fires until they commit). So render first and decide the badge second:
  // `shownKeys()` is the same predicate typeChar() consults, owned by the
  // placement code that knows what is on screen.
  function render(): boolean {
    const moved = overlay.render(items, typed, resolve.resolve).moved;
    const matches = items.filter(isUsable);
    const longer = matches.some((i) => i.key.length > typed.length);
    // typed.length is not redundant: an empty prefix matches everything, so
    // without it the badge would be up from the moment ;f starts.
    overlay.setEnterBadge(typed.length > 0 && longer && matches.length > 1);
    return moved;
  }

  // THE visibility predicate: a hint is usable only when its label is on
  // screen. Overlay placement is the sole judge (viewport test + collision
  // walk live there); a second rect test here diverged, letting a key fire at
  // a link the user could not see.
  function isUsable(it: HintItem): boolean {
    return it.key.indexOf(typed) === 0 && overlay.shownKeys().has(it.key);
  }

  async function typeChar(c: string): Promise<void> {
    const nt = typed + c;
    const matches = items.filter((i) => i.key.indexOf(nt) === 0 && overlay.shownKeys().has(i.key));
    if (!matches.length) {
      // A KEY THAT NAMES NOTHING VISIBLE IS ANNOUNCED, NOT SWALLOWED. The key
      // was already claimed by the alphabet, so silence meant a consumed
      // keystroke that did nothing — "the hints got stuck". The two miss
      // causes get different messages (same rule as the leader's miss report):
      // a key whose label the placement pass withheld (viewport OR full badge
      // collision — saying "off screen" is exactly the wrong explanation for a
      // control the user can see) versus a key that is simply not a hint.
      const hidden = items.find((i) => i.key.indexOf(nt) === 0);
      toast(
        hidden
          ? "that hint is hidden \u2014 ] for the next batch"
          : "no hint for \u201c" + nt + "\u201d"
      );
      return;
    }
    const exact = matches.find((i) => i.key === nt);
    const isPrefixOfMore = matches.some(
      (i) => i.key !== nt && i.key.indexOf(nt) === 0
    );
    if (exact && !isPrefixOfMore) {
      activate(exact);
      return;
    }
    typed = nt;
    // No scrolling on purpose: off-screen candidates are simply not matched
    // above, and yanking the page on a keystroke destroyed scroll position.
    render();
  }

  function handleKey(e: KeyboardEvent): boolean {
    const chars = hintChars();
    // A LAYER WITH NOTHING USABLE ON SCREEN MUST NOT KEEP THE KEYBOARD: a key
    // it eats is one the user needs to get out (the leader included). Tear it
    // down and DECLINE the key back to the host — "hints are stuck and the
    // leader does nothing" cannot survive this. Safe at `;f` time because
    // assign() runs synchronously before the event loop resumes.
    if (!items.length) {
      exit();
      return false;
    }
    if (overlay.shownKeys().size === 0) {
      // A LAYER THAT LOOKS DEAD IS NOT A DEAD LAYER: heal it first. An empty
      // shownKeys() can be one bad frame (a re-render parking the rows for a
      // frame); tearing down on the next key turned it into "the hints just
      // disappeared". Re-anchor synchronously, then re-collect; decline the
      // key either way so the host still gets it.
      render();
      if (overlay.shownKeys().size === 0) {
        syncViewport();
        return false;
      }
    }
    // A MODIFIED keystroke is never a hint key: matching on e.key alone made
    // Ctrl+G activate a single remaining link instead of cancelling. Declining
    // hands the key to the host, which owns the cancel and the page's chords.
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === "Escape") {
      exit();
      return true;
    }
    if (e.key === "Backspace") {
      typed = typed.slice(0, -1);
      render();
      return true;
    }
    if (e.key === "Enter") {
      const found = items.filter(isUsable);
      if (found.length) activate(found[0]!);
      else exit();
      return true;
    }
    if (e.key === "]" || (e.key === "Tab" && !e.shiftKey)) {
      page(1);
      return true;
    }
    if (e.key === "[" || (e.key === "Tab" && e.shiftKey)) {
      page(-1);
      return true;
    }
    if (e.key.length === 1 && chars.indexOf(e.key.toLowerCase()) !== -1) {
      void typeChar(e.key.toLowerCase());
      return true;
    }
    return false;
  }

  // Activate a hinted item: decide the route (focus vs click) and hand the
  // resolved element to the activator, which does the work and reports whether
  // the page reacted (see docs/HINTS.md for why that report exists).
  function activate(it: HintItem): void {
    // The ambient window survives the teardown: the press is about to be judged
    // against it, and a page's background rate does not stop being true because
    // the labels were removed.
    exit(true);
    // THE ONE PLACE A RE-COLLECT IS ALLOWED (see hintresolve.resolve): a
    // keypress is a one-shot, so paying for a document-wide collection once —
    // to find the node the framework replaced under this badge — is worth it,
    // where doing it from the per-frame sweeps is what froze the page.
    const el = resolve.resolve(it, { refresh: true }) || it.el;
    if (!el || !el.isConnected) return;
    const t = el.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      // FOCUS IS THE ACTIVATOR'S JOB now (activate.ts aims at the editable root
      // and verifies that focus landed, with one retry), and it must stay that
      // way: the focus attempt and the verdict about it are two halves of one
      // question, and splitting them is how a successful focus came to be
      // reported as a failure.
      //
      // Hints are only offered for on-screen elements, so focusing must not
      // move the page: `preventScroll` keeps the user's scroll position exactly
      // (the old `scrollIntoView({block:"center"})` jumped the viewport every
      // time a field was hinted).
      //
      // Selecting the field's text is a convenience the field offers once it
      // HAS focus, and it is deliberately not part of the verdict: a field that
      // refused focus is reported, not papered over by a selection that did
      // nothing.
      activator.activate(el, "focus");
      const anyEl = el as HTMLInputElement;
      if (anyEl.select) {
        try {
          anyEl.select();
        } catch (e) {
          // ignore
        }
      }
      return;
    }
    if ((el as HTMLElement).isContentEditable) {
      // Includes any node INSIDE an editable subtree, which is the ChatGPT
      // composer shape; the activator resolves the editable root itself.
      activator.activate(el, "focus");
      return;
    }
    activator.activate(el, "click");
  }

  function exit(keepAmbient = false): void {
    // Bumping the session is what CANCELS a start that is still in flight, so
    // Escape works even in the window before `active` is set. It is also what
    // makes exit() safe to call when nothing is happening.
    session++;
    // The document-wide mutation observer must not outlive the batch — that is
    // the one cost of keeping it open while hints are up. `keepAmbient` is the
    // activation path, which tears the labels down and then presses.
    if (!keepAmbient) stopLifeCounting();
    active = false;
    starting = false;
    unwatchDom();
    anchorFrames.cancel();
    stopTick();
    if (motion) {
      motion.dispose();
      motion = null;
    }
    episodeUntil = 0;
    overlay.unmount();
    items = [];
    pool = [];
    typed = "";
    resyncAt = 0;
    syncing = false;
  }

  return {
    enterBadge: () => overlay.enterBadge(),
    snapshot: () => {
      const base = overlay.snapshot(items, resolve.resolve);
      base.stats = {
        items: items.length,
        pool: pool.length,
        typed: typed,
        active: active,
        doc: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
      };
      return base;
    },
    get active() {
      return active;
    },
    get starting() {
      return starting;
    },
    start,
    handleKey,
    exit,
    lastActivation: () => activator.lastActivation(),
  };
}
