// The session: one `;f` press, from collecting candidates to handling keys.
//
// This used to be 886 lines of closure holding everything at once — the key
// pool, the label DOM, the click machinery, the visibility predicates and the
// diagnostics report — so no part of it could be read, changed or tested on its
// own. Only the genuinely session-scoped state stayed; everything else moved
// next door:
//
//   selectors.ts  what counts as hintable, and the limits
//   probe.ts      is this element visible / reachable, and what is it called
//   collect.ts    walking the page (and open shadow roots) for candidates
//   select.ts     which candidates get a label
//   overlay.ts    the label DOM, and where each badge goes
//   activate.ts   clicking a target, and whether the page reacted
//   life.ts       what counts as "the page did something"
//   diagnose.ts   the "why isn't this hinted" report
import { core } from "../../../shared/core";
import { toast } from "../../../shared/overlay";
import type { HintActivation } from "../../../shared/types";
import {
  DOM_RESYNC_DELAY,
  DOM_RESYNC_MAX_WAIT,
  MAX_HINTS,
  PAGE_GUARD,
  RESYNC_DELAY,
  type HintItem,
} from "./selectors";
import { createHintOverlay } from "./overlay";
import { createActivator } from "./activate";
import { targetKey } from "./select";
import { createHintResolve } from "./hintresolve";
// NOTE: collection is reached through `resolve.refreshPool()` rather than by
// calling `collectHintables` here, so the pool and the visibility pass it is
// selected with are always built together.
import { shadowRootOf, walkElements } from "../../../shared/dom";
import { createCoalescer } from "../../../shared/coalesce";
import { createMotionWatch, type MotionKind, type MotionWatch } from "./motion";
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
  // True between the `;f` keypress and the moment the batch is on screen.
  // start() is async, so this window is real and can be long on a heavy page.
  // Hosts MUST gate their cancel paths on `active || starting`: gating on
  // `active` alone drops the cancel and lets the batch appear after the user
  // has already pressed Escape.
  readonly starting: boolean;
  start(): Promise<void>;
  handleKey(e: KeyboardEvent): boolean;
  exit(): void;
  // What the last activation did (see HintActivation), for the diagnostics page.
  // null when nothing has been activated in this page yet.
  lastActivation(): HintActivation | null;
  // Whether the enter-affordance badge is up, and what it says. The badge only
  // appears in the one state a user cannot otherwise detect (an ambiguous typed
  // prefix), so it is part of the same self-report the diagnostics page reads.
  enterBadge(): { shown: boolean; glyph: string };
  // Explicitly requested geometry for e2e/diagnostics. The live animation sweep
  // never serializes or publishes this data.
  snapshot(): { positions: Array<{ key: string; x: number; y: number }>; boxes: Array<{ key: string; l: number; t: number; r: number; b: number }> };
}

export function createLinkHints(getHintChars: () => string): LinkHints {
  let active = false;
  let pool: Element[] = []; // every hintable element, in document order
  // Which live element does this label belong to, NOW? Split into
  // hintresolve.ts because it is the only part of link hints with no state of
  // its own: give it the pool and it gives back elements, which the key
  // assignment, the render loop and the activator all need answered the same
  // way. `setPool` exists because resolving may find the pool stale and
  // refresh it - which is a mutation of the session's own state, so the
  // session keeps ownership and the module asks.
  const resolve = createHintResolve({
    pool: () => pool,
    setPool: (next) => { pool = next; },
    maxHints: MAX_HINTS,
  });
  let items: HintItem[] = []; // currently hinted items (viewport subset)
  // A prefix-free key sequence generated once per hint session. Keys are drawn
  // from it for the whole session and are NEVER reshuffled by a re-hint, so a
  // control that appears later (an ad's "Skip" button) or is recreated by the
  // framework inherits/keeps its key rather than invalidating what the user is
  // typing. Sized past MAX_HINTS so batch churn never runs the pool dry.
  let keyPool: string[] = [];
  let typed = "";
  // Incremented on every start()/exit(); async continuations (core.makeHints)
  // capture it and bail if a newer session took over (e.g. ESC during the
  // await) so stale state never repopulates after exit.
  let session = 0;
  // True between the `;f` keypress and the moment the batch is actually built.
  // `start()` is async — it walks the whole document and then awaits the core
  // for the key pool — so for a noticeable window on a heavy page the session
  // exists but `active` is still false. Escape during that window used to do
  // nothing at all (the hosts only called exit() once `active` was true), and
  // because nothing bumped `session`, the start completed anyway: the batch
  // appeared AFTER the user had already pressed Escape to cancel it. That is
  // the "hints get stuck and Escape does not work" report — the cancel arrived
  // first and was silently dropped, and the layer that survived it ignored the
  // next Escape for a whole frame of layout work.
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
  // The DOM changed while hints are active (a control appeared, e.g. a video
  // player's "Skip ad" button after hints were already built). Debounced so a
  // burst of mutations produces one re-hint once things settle. Without this
  // the batch was frozen at `;f` time and a late-appearing control had no hint,
  // or a hint whose key did nothing.
  let domDirty = false;
  let domResyncAt = 0;
  let domSyncFirst = 0;
  let domObserver: MutationObserver | null = null;
  let shadowObservers: MutationObserver[] = [];
  let observeRoots: ((root: ParentNode, depth: number) => void) | null = null;
  let observedHintRoots = new WeakSet<ShadowRoot>();
  // How often the full-document walk that FINDS shadow roots may run. Half a
  // second is the difference between "a root created during a re-render is
  // observed almost immediately" and "the walk is the reason the page janks".
  // A root's own observer only schedules the SAME debounced re-hint the document
  // observer already scheduled (DOM_RESYNC_DELAY), so discovery being late by
  // up to 500ms costs the user nothing at all.
  const ROOTS_DISCOVERY_MS = 500;
  // How many elements one discovery pass may visit, per walked root. A root
  // found within the budget has its own observer from then on, and a root beyond
  // it is found by the NEXT pass (the walk starts from the document every time),
  // so the budget delays discovery instead of losing it.
  const SHADOW_WALK_BUDGET = 4000;

  // Shadow-root discovery is COALESCED, and the rule is the shared one
  // (shared/coalesce.ts). It has to be: the walk it wraps is
  // `querySelectorAll("*")` over the whole document, and it ran inside the
  // mutation callback — i.e. once per mutation batch, on a page that is
  // re-rendering, which is the one situation hints are open on a live page. The
  // scroll controller has the same rule for the same reason, which is why it is
  // a module rather than two sets of variables.
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
    // HINTS NEVER MOVE THE PAGE.
    //
    // This used to scroll down until links came into view — up to PAGE_GUARD = 8
    // viewports, each iteration re-running the whole selection pass over the
    // collected pool (a `getBoundingClientRect` plus the probe checks per
    // candidate; see selectHintables). Three separate problems in one loop: the
    // page jumped under the user's hands at the moment they asked for hints, the
    // work was unbounded enough to stall the main thread on a heavy document,
    // and the scroll was invisible in the sense that mattered — by the time the
    // labels appeared the reader had lost the place they were reading.
    //
    // The honest answer for "nothing here is hintable" is to say so. Paging
    // toward other links is what `]` / `[` are for, and those are asked for.
    const vis = resolve.viewportItems();
    if (!vis.length) {
      toast("no hints in view \u2014 ] for the next batch");
      return;
    }
    active = true;
    overlay.mount();
    watchDom();
    watchMotion();
    ensureTick();
    await assign(vis);
    if (session !== mySession) return; // exited (ESC) during the await
    if (!items.length) exit();
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
  // element that was already hinted keeps its key, and when the framework
  // REPLACES a node (a virtual-DOM re-render — YouTube's ad overlay, a React
  // list, a Polymer component rebuilding itself) the replacement inherits the
  // key of the control it took over, matched by screen position and
  // destination. Only genuinely new controls get a fresh key.
  //
  // This is what stops a churning framework page from being unusable: the old
  // code re-keyed the whole batch on every change, so the key the user had just
  // read could be gone (or mean a different control) by the time they typed it,
  // and a late control like an ad's "Skip" button arrived with a key that no
  // longer described it.
  async function assign(list: Element[]): Promise<void> {
    if (!list.length) return;
    const chosen = list.slice(0, MAX_HINTS);
    const prev = items;
    // Identical batch: keep everything (including a half-typed prefix).
    if (
      prev.length === chosen.length &&
      chosen.every((el, i) => prev[i] && prev[i]!.el === el)
    ) {
      render();
      return;
    }
    const taken = new Set<string>();
    const inherited = new Map<Element, string>();
    // 1. The same node object is still there: keep its key verbatim.
    for (const el of chosen) {
      for (const it of prev) {
        if (it.el === el && !taken.has(it.key)) {
          inherited.set(el, it.key);
          taken.add(it.key);
          break;
        }
      }
    }
    // 2. A re-rendered node: the control did not really move, so neither should
    //    its key. Match by destination (an href may survive a small reflow) or
    //    by being in essentially the same place.
    for (const el of chosen) {
      if (inherited.has(el)) continue;
      let box: DOMRect;
      try {
        box = el.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const target = targetKey(el);
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
        inherited.set(el, best.key);
        taken.add(best.key);
      }
    }
    // 3. Genuinely new controls draw the shortest still-free key.
    const nextItems: HintItem[] = [];
    for (const el of chosen) {
      let key = inherited.get(el);
      if (!key) {
        key = takeKey(taken) ?? undefined;
        if (!key) continue; // pool exhausted (more controls than MAX_HINTS)
        taken.add(key);
      }
      nextItems.push({ el: el, key: key, label: null, cx: 0, cy: 0, target: targetKey(el) });
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

  // When the viewport has moved and settled, move the hints to the batch that
  // is now on screen: scrolling to a new section should show ITS links, not the
  // hidden labels of the section left behind. While a prefix is being typed the
  // set is left alone (re-hinting would discard the partial input), and when
  // nothing hintable is in view at all (a blank spacer, a hero image) the
  // current batch is kept so its labels still track a page that shifts under
  // them.
  function syncViewport(): void {
    if (!active || typed !== "" || syncing) return;
    const vis = resolve.viewportItems();
    if (!vis.length) return;
    if (vis.length === items.length && vis.every((el, i) => items[i] && items[i]!.el === el)) {
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
      // MutationObserver does not cross shadow-root boundaries. Watch every
      // extension-visible root in the same bounded tree walk so late controls
      // and framework replacements inside open/closed components also refresh.
      observeRoots = (root: ParentNode, depth: number): void => {
        if (depth >= 6) return;
        // A LAZY, BUDGETED walk (shared/dom.ts walkElements). The old loop built
        // an array of every element in the subtree before applying MAX_SCAN to
        // its length, so the cap bounded the loop and not the allocation — a
        // five-figure-element array per coalesced tick on a large page, for a
        // walk that stops at the budget anyway. Each root is walked with its own
        // budget, so a huge light DOM cannot starve the roots nested in it.
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
    return nextMeasurementDelay({
      now: now,
      moving: !!motion && motion.moving(),
      episodeUntil: episodeUntil,
      resyncAt: resyncAt,
      domResyncAt: domDirty ? domResyncAt : 0,
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
  function page(dir: number): void {
    for (let i = 0; i < PAGE_GUARD; i++) {
      const before = window.scrollY;
      resolve.pageScroll(dir);
      const vis = resolve.viewportItems();
      if (vis.length) {
        void assign(vis);
        return;
      }
      if (window.scrollY === before) break; // at the top/bottom of the page
    }
    toast("no more links");
  }

  // Draw the labels for the current batch and typed prefix. The one place the
  // session talks to the overlay.
  //
  // needEnter is the state the user cannot otherwise see: the next character
  // will not activate anything, and Enter is the only way to take the first
  // match. It has to be derived from EXACTLY the condition typeChar() uses to
  // decide not to activate, or the badge promises an Enter that does nothing.
  //
  // That condition is subtler than "typed is not a complete key". typeChar
  // activates on an exact match only when nothing else starts with it, so an
  // exact match with a longer key extending it is still ambiguous — the user
  // typed "a", one link is "a" and another is "ad", and neither fires until
  // they commit. So: ambiguous means at least one match is longer than `typed`
  // AND there is more than one candidate to choose between.
  // Draw the labels, then decide the badge — in that order, because the badge
  // describes the batch that was just placed: it is up when the typed prefix
  // still matches more than one of the hints the user can actually SEE, so a
  // further character is needed and the first match can only be committed with
  // Enter. `overlay.shownKeys()` is the same predicate typeChar() consults, and
  // it is owned by the placement code, which is the only code that knows whether
  // a label is on screen.
  function render(): boolean {
    const moved = overlay.render(items, typed, resolve.resolve).moved;
    const matches = items.filter(isUsable);
    const longer = matches.some((i) => i.key.length > typed.length);
    // The typed.length guard is not redundant: an empty prefix matches
    // everything, so without it the badge would be up from the moment ;f
    // starts — telling the user to press Enter to choose, when they have not
    // narrowed anything yet and any character is the right next move.
    overlay.setEnterBadge(typed.length > 0 && longer && matches.length > 1);
    return moved;
  }

  // THE visibility predicate. A hint is usable when its label is on screen, and
  // the overlay's placement is the only thing that decides that (it is where the
  // viewport test and the collision walk live). The session used to answer the
  // question independently, with its own rect test — and because the two answers
  // could differ, a hint the overlay had HIDDEN (dragged out of the viewport, or
  // dropped for overlapping another badge) still had a typeable key: pressing it
  // fired at a link the user could not see. Asking the overlay removes the
  // second opinion rather than trying to keep the two in step.
  function isUsable(it: HintItem): boolean {
    return it.key.indexOf(typed) === 0 && overlay.shownKeys().has(it.key);
  }

  async function typeChar(c: string): Promise<void> {
    const nt = typed + c;
    const matches = items.filter((i) => i.key.indexOf(nt) === 0 && overlay.shownKeys().has(i.key));
    if (!matches.length) return; // no candidate for this prefix — ignore
    const exact = matches.find((i) => i.key === nt);
    const isPrefixOfMore = matches.some(
      (i) => i.key !== nt && i.key.indexOf(nt) === 0
    );
    if (exact && !isPrefixOfMore) {
      activate(exact);
      return;
    }
    typed = nt;
    // No scrolling here on purpose. Scrolling a candidate into view (or
    // re-hinting) on a keystroke used to yank the page and destroy the user's
    // scroll position; off-screen candidates are simply not matched above.
    render();
  }

  function handleKey(e: KeyboardEvent): boolean {
    const chars = hintChars();
    // A LAYER WITH NOTHING USABLE ON SCREEN MUST NOT KEEP THE KEYBOARD.
    //
    // The batch and the session can disagree in the one direction that matters:
    // if no label is placed (the placement pass hid them all, the page moved the
    // batch off screen), `typeChar` finds no match and every hint letter is
    // swallowed for nothing — the layer looks up, answers nothing, and the keys
    // it eats are the ones the user needs to get out, including the leader.
    // Tearing the dead layer down and DECLINING the key hands it straight back
    // to the host, where the leader and the scroll keys still work: the reported
    // "hints are stuck, unresponsive, and the leader does nothing" cannot
    // survive this. Safe at `;f` time because `assign()` runs synchronously
    // before control returns to the event loop, so a keydown can never be
    // processed against a batch that has not been assigned yet.
    if (!items.length || overlay.shownKeys().size === 0) {
      exit();
      return false;
    }
    // A MODIFIED keystroke is never a hint key.
    //
    // The hint alphabet is plain letters (`asdfjklgh` by default) and this
    // matched on `e.key` alone, so `Ctrl+G` WAS the letter `g`: the universal
    // cancel — the one keystroke that is supposed to back out of anything — was
    // typed into the hint layer instead, and with a single candidate left on
    // screen the letter `g` ACTIVATES A LINK. The user asked to cancel and got a
    // navigation. Declining hands the key back to the host, which owns the
    // cancel and which lets the page keep its own chords (Ctrl+K and friends).
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
    exit();
    const el = resolve.resolve(it) || it.el;
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

  function exit(): void {
    // Bumping the session is what CANCELS a start that is still in flight, so
    // Escape works even in the window before `active` is set. It is also what
    // makes exit() safe to call when nothing is happening.
    session++;
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
    snapshot: () => overlay.snapshot(items, resolve.resolve),
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
