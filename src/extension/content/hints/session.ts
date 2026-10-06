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
import { collectHintables } from "./collect";
import { targetKey } from "./select";
import { createHintResolve } from "./hintresolve";

export interface LinkHints {
  readonly active: boolean;
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
  // The link this session is currently pointed at: the first on-screen match
  // for the typed prefix, i.e. exactly what Enter would activate right now.
  // null when the layer is not open or nothing matches.
  //
  // This is what lets "copy link" and "edit link" mean the same thing the user
  // can SEE rather than a second, hidden idea of "current link". It is computed
  // from the same predicate Enter uses, deliberately: a copy action that
  // disagreed with what Enter would open is worse than no copy action.
  currentTarget(): { url: string; text: string } | null;
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
  // rAF loop state: pages can shift under the hints at any moment (a carousel
  // auto-slide, a lazy image landing, a layout shift, the user's own wheel
  // scroll), so hints are re-anchored to their elements every frame. Reading
  // rects forces layout, so the loop runs at full speed only while elements
  // are actually moving (or the viewport is) and backs off to ~10 sweeps/s
  // when the page is still.
  let rafId = 0;
  let lastSweep = 0;
  let fastUntil = 0;
  let lastSx = 0,
    lastSy = 0,
    lastW = 0,
    lastH = 0;
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
    if (active) return;
    const mySession = ++session;
    pool = collectHintables();
    if (!pool.length) {
      toast("no hints");
      return;
    }
    // One key sequence for the whole session (see keyPool). Generated up front
    // so a later re-hint never has to await the core mid-flight.
    try {
      keyPool = await core.makeHints(MAX_HINTS + 18, hintChars());
    } catch (e) {
      toast("core unavailable");
      return;
    }
    if (session !== mySession) return; // exited (ESC) during the await
    // If the current viewport has no links (e.g. a blank section), page down
    // until a batch of links comes into view.
    let vis = resolve.viewportItems();
    let guard = 0;
    while (!vis.length && guard < PAGE_GUARD) {
      resolve.pageScroll(1);
      guard++;
      vis = resolve.viewportItems();
    }
    if (!vis.length) {
      toast("no hints");
      return;
    }
    active = true;
    overlay.mount();
    watchDom();
    rafId = requestAnimationFrame(frame);
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
  // live in a closed shadow root, which this observer never sees.
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
      domObserver = new MutationObserver((records) => {
        if (!active) return;
        for (const rec of records) {
          if (touchesOverlay(rec)) continue;
          const now = performance.now();
          if (!domDirty) {
            domDirty = true;
            domSyncFirst = now;
          }
          domResyncAt = Math.min(now + DOM_RESYNC_DELAY, domSyncFirst + DOM_RESYNC_MAX_WAIT);
          return;
        }
      });
      domObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      domObserver = null;
    }
  }

  function unwatchDom(): void {
    if (domObserver) {
      try {
        domObserver.disconnect();
      } catch (e) {
        // ignore
      }
      domObserver = null;
    }
    domDirty = false;
    domResyncAt = 0;
    domSyncFirst = 0;
  }

  // rAF loop: keep the hints glued to their links while the page moves.
  function frame(): void {
    if (!active) {
      rafId = 0;
      return;
    }
    const now = performance.now();
    const sx = window.scrollX,
      sy = window.scrollY;
    const w = window.innerWidth,
      h = window.innerHeight;
    const viewChanged = sx !== lastSx || sy !== lastSy || w !== lastW || h !== lastH;
    lastSx = sx;
    lastSy = sy;
    lastW = w;
    lastH = h;
    if (viewChanged) resyncAt = now + RESYNC_DELAY;
    if (now < fastUntil || viewChanged || now - lastSweep > 100) {
      lastSweep = now;
      // The page is animating (carousel slide, scroll, layout shift): keep
      // tracking every frame for a while so hints glide WITH the links.
      if (render()) fastUntil = now + 1000;
    }
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
      pool = collectHintables();
      syncViewport();
    }
    rafId = requestAnimationFrame(frame);
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
  function render(): boolean {
    const matches = items.filter((i) => i.key.indexOf(typed) === 0 && resolve.onScreen(i));
    const longer = matches.some((i) => i.key.length > typed.length);
    // The typed.length guard is not redundant: an empty prefix matches
    // everything, so without it the badge would be up from the moment ;f
    // starts — telling the user to press Enter to choose, when they have not
    // narrowed anything yet and any character is the right next move.
    return overlay.render(items, typed, resolve.resolve, typed.length > 0 && longer && matches.length > 1);
  }

  // Whether a hint's element is currently within the viewport — the same test
  // the label uses to decide whether to show itself. A hidden hint (its link
  // scrolled away) must not be typeable, or a keystroke would fire at an
  // off-screen element or scroll the page back to it.
  async function typeChar(c: string): Promise<void> {
    const nt = typed + c;
    const matches = items.filter((i) => i.key.indexOf(nt) === 0 && resolve.onScreen(i));
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
      const found = items.filter((i) => i.key.indexOf(typed) === 0 && resolve.onScreen(i));
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
      // Hints are only offered for on-screen elements, so focusing must not
      // move the page: `preventScroll` keeps the user's scroll position exactly
      // (the old `scrollIntoView({block:"center"})` jumped the viewport every
      // time a field was hinted).
      try {
        (el as HTMLElement).focus({ preventScroll: true });
      } catch (e) {
        (el as HTMLElement).focus();
      }
      const anyEl = el as HTMLInputElement;
      if (anyEl.select) {
        try {
          anyEl.select();
        } catch (e) {
          // ignore
        }
      }
      activator.activate(el, "focus");
      return;
    }
    if ((el as HTMLElement).isContentEditable) {
      try {
        (el as HTMLElement).focus({ preventScroll: true });
      } catch (e) {
        (el as HTMLElement).focus();
      }
      activator.activate(el, "focus");
      return;
    }
    activator.activate(el, "click");
  }

  // The link Enter would open right now, resolved to an absolute href and the
  // text that names it. Shares `typed` and the on-screen filter with
  // activate/Enter by construction, so the three can never disagree.
  function currentTarget(): { url: string; text: string } | null {
    if (!active) return null;
    const found = items.filter((i) => i.key.indexOf(typed) === 0 && resolve.onScreen(i));
    const it = found[0];
    if (!it) return null;
    const el = resolve.resolve(it) || it.el;
    if (!el || !el.isConnected) return null;
    const url = targetKey(el);
    if (!url) return null;
    const text = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return { url, text: text.slice(0, 200) };
  }

  function exit(): void {
    session++;
    active = false;
    unwatchDom();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    overlay.unmount();
    items = [];
    pool = [];
    typed = "";
    resyncAt = 0;
    syncing = false;
  }

  return {
    enterBadge: () => overlay.enterBadge(),
    currentTarget,
    get active() {
      return active;
    },
    start,
    handleKey,
    exit,
    lastActivation: () => activator.lastActivation(),
  };
}
