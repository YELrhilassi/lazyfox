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
  HINTABLE_SELECTOR,
  MAX_HINTS,
  PAGE_FACTOR,
  PAGE_GUARD,
  RESYNC_DELAY,
  type HintItem,
} from "./selectors";
import { collectHintables } from "./collect";
import { selectHintables, targetKey } from "./select";
import { basicVisible, deepHit } from "./probe";
import { createHintOverlay } from "./overlay";
import { createActivator } from "./activate";

export interface LinkHints {
  readonly active: boolean;
  start(): Promise<void>;
  handleKey(e: KeyboardEvent): boolean;
  exit(): void;
  // What the last activation did (see HintActivation), for the diagnostics page.
  // null when nothing has been activated in this page yet.
  lastActivation(): HintActivation | null;
}

export function createLinkHints(getHintChars: () => string): LinkHints {
  let active = false;
  let pool: Element[] = []; // every hintable element, in document order
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
    let vis = viewportItems();
    let guard = 0;
    while (!vis.length && guard < PAGE_GUARD) {
      pageScroll(1);
      guard++;
      vis = viewportItems();
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

  // The currently-hintable elements: everything in `pool` that is in the
  // viewport, CSS-visible, not occluded and not a nested/duplicate target.
  function viewportItems(): Element[] {
    return selectHintables(pool, MAX_HINTS).kept;
  }

  function pageScroll(dir: number): void {
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    window.scrollBy(0, dir * Math.round(vh * PAGE_FACTOR));
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

  // The live element nearest an item's last screen centre, preferring the same
  // destination so a small reflow cannot hand the hint to a neighbour.
  function nearestHintable(it: HintItem, list: Element[]): Element | null {
    if (!it.cx && !it.cy) return null;
    let best: Element | null = null;
    let bestD = Infinity;
    for (const el of list) {
      if (!el.isConnected || !basicVisible(el)) continue;
      let r: DOMRect;
      try {
        r = el.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      const dx = r.left + r.width / 2 - it.cx;
      const dy = r.top + r.height / 2 - it.cy;
      const d = dx * dx + dy * dy;
      const sameTarget = !!it.target && it.target === targetKey(el);
      const limit = sameTarget ? 80 * 80 : 12 * 12;
      if (d <= limit && d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return best;
  }

  // The element for an item, re-resolved when the node the hint was built from
  // has been replaced (a React/Vue/Polymer re-render). Returning null here is
  // what used to make a key silently "do nothing": the framework swapped the
  // node between the label appearing and the keystroke, and the old element was
  // no longer connected. Instead of giving up we re-find the SAME control —
  // first in the live pool, then in a fresh collection (the pool is only
  // refreshed on a debounce, so it can lag a just-rendered control), then by a
  // deep hit at the recorded position.
  function resolveItem(it: HintItem): Element | null {
    if (it.el && it.el.isConnected) return it.el;
    let found = nearestHintable(it, pool);
    if (!found) {
      pool = collectHintables();
      found = nearestHintable(it, pool);
    }
    if (found) {
      it.el = found;
      return found;
    }
    if (!it.cx && !it.cy) return null;
    const hit = deepHit(it.cx, it.cy);
    if (hit && (hit.matches(HINTABLE_SELECTOR) || hit.closest(HINTABLE_SELECTOR))) {
      const el = hit.matches(HINTABLE_SELECTOR) ? hit : hit.closest(HINTABLE_SELECTOR);
      if (el && el.isConnected) {
        it.el = el;
        return el;
      }
    }
    return null;
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
    const vis = viewportItems();
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
      pageScroll(dir);
      const vis = viewportItems();
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
  function render(): boolean {
    return overlay.render(items, typed, resolveItem);
  }

  // Whether a hint's element is currently within the viewport — the same test
  // the label uses to decide whether to show itself. A hidden hint (its link
  // scrolled away) must not be typeable, or a keystroke would fire at an
  // off-screen element or scroll the page back to it.
  function itemOnScreen(it: HintItem): boolean {
    const el = resolveItem(it);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  async function typeChar(c: string): Promise<void> {
    const nt = typed + c;
    const matches = items.filter((i) => i.key.indexOf(nt) === 0 && itemOnScreen(i));
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
      const found = items.filter((i) => i.key.indexOf(typed) === 0 && itemOnScreen(i));
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
    const el = resolveItem(it) || it.el;
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
    get active() {
      return active;
    },
    start,
    handleKey,
    exit,
    lastActivation: () => activator.lastActivation(),
  };
}
