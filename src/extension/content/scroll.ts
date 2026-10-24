// Scroll-target management for the content script.
//
// Plain `window.scrollBy` only moves the document scroller. Modern apps
// (ChatGPT, dashboards, mail clients, sidebars) put the real content inside a
// fixed page shell whose inner `overflow:auto` pane scrolls while the document
// itself never does — so `j`/`k`/`d`/`u` looked dead. This module picks the
// scroll target, in this order:
//
//   1. the target the user explicitly cycled to with `;F` / `;B`;
//   2. the scrollable region under the mouse pointer, when there is one (move
//      the pointer over a sidebar and the keys drive that sidebar — the mouse
//      is the natural "which pane am I working in" signal);
//   3. the dominant inner scroller when the document itself cannot scroll (the
//      ChatGPT/dashboard case, where there is no window scroller to lose);
//   4. otherwise the document scroller, so ordinary pages behave exactly as
//      before.
//
// An inner target is outlined so the user can see where the keys land; the
// document scroller needs no outline.

import { shadowRootOf, walkElements } from "../../shared/dom";
import { createCoalescer } from "../../shared/coalesce";
import { toast } from "../../shared/overlay";
import { promoteToTopLayer } from "../../shared/toplayer";
import type { ScrollRegionInfo } from "../../shared/types";

interface Target {
  // null = the window/document scroller.
  el: HTMLElement | null;
  label: string;
}

export interface ScrollController {
  // Move by `lines` lines (60px each) — `j`/`k`.
  scrollLines(lines: number): void;
  // Move by half a screen in `dir` — `d`/`u`.
  scrollPage(dir: number): void;
  /**
   * Move the ACTIVE target by `factor` viewports and report its offset either
   * side of the move.
   *
   * This exists for the hint layers' paging (`]`, `[`, Tab). They used to call
   * `window.scrollBy` directly, which is the one scroll path in the product
   * that ignores the target this controller exists to pick: on a shell page
   * whose whole document is pinned and whose content lives in an inner
   * `overflow:auto` pane — ChatGPT, mail, dashboards, every Electron-style web
   * shell — the hint layer scrolled the WINDOW, which cannot move, so paging
   * silently did nothing ("hitting Tab does nothing") or jumped the shell
   * behind the pane the user was reading. The scroll keys already went through
   * here; paging now goes through the same door, so "which region am I looking
   * at" has exactly one answer.
   *
   * The two offsets come back together because the CALLER's question is "is
   * there anything more that way", and only the target that actually moved can
   * answer it — reading `window.scrollY` at an inner-pane page answers about a
   * scroller that never moves, which is how "no more links" was reported on a
   * page with pages of links left below.
   */
  pageBy(dir: number, factor: number): { before: number; after: number };
  toTop(): void;
  toBottom(): void;
  // Move the active target among the page's scroll regions (0 = no change).
  cycle(dir: number): void;
  // Return to automatic target selection (the document scroller on ordinary
  // pages) and drop the outline.
  reset(): void;
  // Whether a non-document target is focused by the user.
  isCustom(): boolean;
  // The scroll regions on the page, largest first — for the diagnostics page.
  regions(): ScrollRegionInfo[];
  // The name of the region the scroll keys would move right now.
  currentLabel(): string;
}

// A container must overflow by more than this many pixels to count as a
// scroller — below it, rounding noise would make every flex pane "scrollable".
const MIN_OVERFLOW = 8;
// Ignore very small scrollers (a 2-line dropdown, a table cell): the user can
// never mean them with the page keys.
const MIN_SIZE = 60;
// Bound the DOM walk on huge framework pages.
const MAX_SCAN = 12000;

export function createScrollController(): ScrollController {
  // The target the user explicitly cycled to (null while on automatic).
  let active: Target | null = null;
  // Cached automatic inner target (recomputed when it stops being scrollable).
  let autoEl: HTMLElement | null = null;
  let outline: HTMLElement | null = null;
  let outlineRaf = 0;
  let lastOutlineAt = 0;
  // Last mouse position, so the keys can follow the pane the pointer is over.
  // Tracked passively; the value is only read when a scroll key fires.
  let pointerX = -1;
  let pointerY = -1;
  let pointerSeen = false;
  // The pane the pointer was last found over, and whether it still needs
  // resolving. Cached because deciding it means an elementFromPoint plus a walk
  // of up to 60 ancestors with a computed-style read each — per scroll keypress,
  // which is a cost the user feels as a sluggish keyboard (see current()).
  let pointerTarget: HTMLElement | null = null;
  let pointerValid = false;
  // The last region scan, with the time it was taken. A page that scrolls its
  // document never needs one at all; a page that does not has to look, and the
  // look is a bounded element walk (up to 12000 nodes) with two computed-style
  // reads per candidate. Repeating that on every `j`/`k`/`d`/`u` is a document
  // scan per keystroke, so the answer is held briefly and dropped when the
  // page's SHAPE changes under it (see onMutations).
  let scanCache: HTMLElement[] | null = null;
  let scanAt = 0;
  // The list has been invalidated since it was taken. A FLAG rather than a
  // dropped cache, because dropping it handed the next keystroke a full-document
  // style scan: a `childList` mutation (every framework insertion, including
  // this extension appending its own overlay host) used to null the list, and
  // the next `j` paid for a re-scan of up to MAX_SCAN elements with two computed
  // style reads each. Attribute churn had already been taken off the keystroke
  // path (§12.2); node churn had not, and it is the more common of the two.
  //
  // So the list is refreshed under ONE of two rate limits, whichever the cause
  // allows (see regionsCached): at most once per SCAN_TTL_MS normally, and at
  // most once per STRUCTURAL_RESCAN_MS when the page itself has changed shape.
  // The page's own keypress rate bounds both from above, and an explicit region
  // request (`;F`, diagnostics) is not rate-limited at all — the user asked.
  let scanStale = false;
  const SCAN_TTL_MS = 1000;
  const STRUCTURAL_RESCAN_MS = 500;
  const observedRoots = new WeakSet<ShadowRoot>();

  function trackPointer(e: PointerEvent): void {
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerSeen = true;
    // The pointer moved: resolve the pane under its NEW coordinates. This is
    // independent of the list of scrollable regions, whose membership and rank
    // did not change just because the pointer did.
    pointerValid = false;
  }

  function invalidateRegions(): void {
    // STRUCTURAL invalidation: a pane may have been inserted or removed, so the
    // list itself (and the ranking inside it) is no longer trustworthy.
    scanStale = true;
    // A newly inserted pane may now outrank the automatic target. Re-evaluate
    // it on demand instead of keeping a still-scrollable but stale `autoEl`
    // forever.
    autoEl = null;
  }

  // PRESENTATIONAL CHURN IS NOT OBSERVED AT ALL, and that is deliberate.
  //
  // A class / style / hidden change cannot put a NEW scroll container into the
  // document — at most it moves the ranking of containers already found — and
  // both cache consumers already re-validate what they use: the chosen target
  // through isScrollable() on every dispatch (autoTarget, pickUnderPointer) and
  // the list through its TTL (regionsCached). So a style change is picked up
  // when it matters, at the next scroll key, without being watched for.
  //
  // Watching for it was expensive, and invisible from here. `attributes: true`
  // WITH `subtree: true` on documentElement makes Gecko queue and deliver a
  // MutationRecord for EVERY class/style write anywhere in the document, for
  // the life of every page. That is thousands of records a second on a
  // framework app (a virtualised list, a chat client, a mail client) — work
  // paid whether or not the user ever presses a scroll key, and work the
  // browser bills to this add-on. It was Lazyfox's largest UNCONDITIONAL
  // per-page cost on a heavy site — paid with the feature idle, for a cache
  // hint that is re-validated on use anyway.

  try {
    // Viewport size changes affect visibility and which pane dominates.
    window.addEventListener("resize", invalidateRegions, { passive: true });
  } catch (e) {
    // ignore — a missing resize listener only costs a stale scan for a moment
  }
  // Region membership is a DOM/CSS fact, not a pointer fact. Invalidate the
  // list when a NODE appears/disappears, then scan lazily at the next region
  // request. MutationObserver callbacks never scan/layout-read, so the observer
  // itself stays cheap — and childList is the only thing it watches.
  let regionObserver: MutationObserver | null = null;
  const scrollObservers: MutationObserver[] = [];

  // What one mutation batch means for the caches: the tree's SHAPE changed, so
  // the list (and the ranking inside it) is no longer trustworthy. Attributes
  // never reach here — they are not observed (see the note above).
  function onMutations(): void {
    invalidateRegions();
  }

  // ---- finding shadow roots is a FULL-DOCUMENT WALK, so it is coalesced ----
  //
  // `watchShadowRoots` walks every node (up to ROOTS_WALK_BUDGET) looking for
  // roots nobody observes yet. It is NOT run when the controller is built, and
  // not on mutation: it runs when a region scan runs (scanRegions), which is to
  // say when a scroll key — or an explicit `;F` / diagnostics request — actually
  // asks which pane to move. A page the user only reads on therefore pays
  // nothing for shadow-root discovery, however much it mutates; and a page the
  // user scrolls pays a coalesced walk at most once a second. Before this, the
  // document observer requested it on every mutation batch, synchronously, on
  // every page for the life of the document.
  //
  // The rule lives in shared/coalesce.ts, where it is unit-tested, because the
  // hint session needs exactly the same rule for exactly the same reason. Roots
  // are therefore found up to a second late, and nothing depends on finding them
  // immediately: a root's own observer only exists to invalidate a cache, and
  // the caches already have a TTL backstop.
  const ROOTS_DISCOVERY_MS = 1000;
  // Elements one discovery pass may visit per walked root. The walk restarts
  // from the document on every pass, so the budget delays finding a root in a
  // very large subtree rather than losing it.
  const ROOTS_WALK_BUDGET = 4000;
  const rootsDiscovery = createCoalescer({
    everyMs: ROOTS_DISCOVERY_MS,
    run: () => watchShadowRoots(document, 0),
  });
  // (requested from scanRegions, never from the mutation observer)

  function watchShadowRoots(root: ParentNode, depth: number): void {
    if (depth >= 6) return;
    // Lazy and budgeted (shared/dom.ts walkElements): the previous version
    // materialized an array of every element in the subtree and only then
    // applied MAX_SCAN to its length, so the cap did not bound the allocation.
    walkElements(root, ROOTS_WALK_BUDGET, (el) => {
      const shadow = shadowRootOf(el);
      if (!shadow || observedRoots.has(shadow)) return;
      observedRoots.add(shadow);
      // A mutation INSIDE an observed root means the same thing a mutation
      // anywhere else does, so it goes through the same handler. The recursion
      // below happens when the root is DISCOVERED (it may contain nested roots),
      // not on every mutation inside it.
      const observer = new MutationObserver(onMutations);
      observer.observe(shadow, { childList: true, subtree: true });
      scrollObservers.push(observer);
      watchShadowRoots(shadow, depth + 1);
    });
  }

  try {
    if (typeof MutationObserver !== "undefined" && document.documentElement) {
      regionObserver = new MutationObserver(onMutations);
      regionObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) {
    regionObserver = null;
  }
  try {
    window.addEventListener("pointermove", trackPointer, { capture: true, passive: true });
    window.addEventListener("pointerdown", trackPointer, { capture: true, passive: true });
  } catch (e) {
    // ignore — without pointer tracking the automatic target still works
  }

  function styleValue(el: Element, prop: string): string {
    try {
      return getComputedStyle(el).getPropertyValue(prop);
    } catch (e) {
      return "";
    }
  }

  function isEditable(el: Element | null): boolean {
    if (!el) return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    try {
      return (el as HTMLElement).isContentEditable;
    } catch (e) {
      return false;
    }
  }

  // Whether `el` is a real scroll container: it overflows, its own overflow
  // style actually allows scrolling, and it is big enough to matter.
  function isScrollable(el: Element | null): el is HTMLElement {
    if (!el || !el.isConnected) return false;
    const he = el as HTMLElement;
    if (!he.scrollHeight || !he.clientHeight) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (he.scrollHeight <= he.clientHeight + MIN_OVERFLOW) return false;
    if (he.clientWidth < MIN_SIZE || he.clientHeight < MIN_SIZE) return false;
    const r = he.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
    const oy = styleValue(el, "overflow-y");
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
    const cs = styleValue(el, "visibility");
    if (cs === "hidden" || styleValue(el, "display") === "none") return false;
    return true;
  }

  // Whether the document itself scrolls.
  function documentScrolls(): boolean {
    const se = (document.scrollingElement || document.documentElement) as HTMLElement;
    if (!se) return false;
    return se.scrollHeight > se.clientHeight + MIN_OVERFLOW;
  }

  // Outer size of a scroller, used both for ranking and for page jumps.
  function viewportHeightOf(el: HTMLElement | null): number {
    if (el) return Math.max(120, el.clientHeight);
    return Math.max(120, window.innerHeight || document.documentElement.clientHeight || 600);
  }

  function visibleArea(el: HTMLElement): number {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return w * h;
  }

  function labelOf(el: HTMLElement): string {
    let name = "";
    try {
      name =
        el.getAttribute("aria-label") ||
        el.getAttribute("data-testid") ||
        el.id ||
        "";
    } catch (e) {
      name = "";
    }
    if (!name) {
      try {
        const cls = el.className;
        if (typeof cls === "string" && cls) name = cls.split(/\s+/)[0] || "";
      } catch (e) {
        name = "";
      }
    }
    const tag = String(el.tagName || "div").toLowerCase();
    if (name && /^[\w-]{2,24}$/.test(name)) return tag + " " + name;
    return tag;
  }

  // Every scrollable element on the page, largest visible area first. Bounded
  // so a giant framework DOM cannot hang an explicit region-list request.
  // The scan is memoised until the DOM/style/viewport changes, with the TTL as
  // a backstop for environmental changes that emit no observable event.
  // Scroll-key dispatch itself does not request a region list when the document
  // scrolls, and pointer movement only invalidates the pointer target — not this
  // expensive list. See scanCache and invalidateRegions.
  function regionsCached(force: boolean = false): HTMLElement[] {
    const now = performance.now();
    if (!force && scanCache) {
      const age = now - scanAt;
      // A cache the page has invalidated may be refreshed sooner, because the
      // reason to refresh it is real (a pane appeared or vanished); a cache
      // nobody has invalidated waits out the TTL, because there is no reason to
      // look again at all. Either way the answer is a cache or ONE scan.
      const budget = scanStale ? STRUCTURAL_RESCAN_MS : SCAN_TTL_MS;
      if (age < budget) return scanCache;
    }
    scanCache = scanRegions();
    scanAt = now;
    scanStale = false;
    return scanCache;
  }

  function scanRegions(): HTMLElement[] {
    const out: HTMLElement[] = [];
    // DISCOVERY IS A SCROLL-TIME COST, not a page-lifetime one: the walk that
    // finds shadow roots exists so this scan can see inside them, and this scan
    // only runs when a scroll key needs an answer. See rootsDiscovery.
    rootsDiscovery.request();
    // LAZY AND BUDGETED (shared/dom.ts walkElements). This used to be
    // `document.querySelectorAll("*")`, which MATERIALIZED every element in the
    // document before MAX_SCAN was applied — on a large app the cap bounded the
    // loop, not the allocation, which is the same mistake the shadow-root walk
    // was already fixed for.
    walkElements(document, MAX_SCAN, (el) => {
      const he = el as HTMLElement;
      // Cheap rejects before touching computed style.
      if (he.clientHeight < MIN_SIZE || he.clientWidth < MIN_SIZE) return;
      if (he.scrollHeight <= he.clientHeight + MIN_OVERFLOW) return;
      if (isEditable(el)) return;
      if (!isScrollable(el)) return;
      if (visibleArea(he) <= 0) return;
      out.push(he);
    });
    out.sort((a, b) => visibleArea(b) - visibleArea(a));
    return out;
  }

  function windowTarget(): Target {
    return { el: null, label: "window" };
  }

  // The topmost element at (x, y), piercing open shadow roots (the document's
  // elementFromPoint only sees the shadow host).
  function deepHit(x: number, y: number): Element | null {
    let el: Element | null = null;
    try {
      el = document.elementFromPoint(x, y);
    } catch (e) {
      return null;
    }
    let depth = 0;
    while (el && depth < 6) {
      // Closed roots included: an app whose scrolling pane lives in one would
      // otherwise never be found under the pointer, so hover-driven scrolling
      // would silently do nothing there (see shadowRootOf).
      const sr = shadowRootOf(el);
      if (!sr) break;
      let inner: Element | null = null;
      try {
        inner = sr.elementFromPoint(x, y);
      } catch (e) {
        inner = null;
      }
      if (!inner || inner === el) break;
      el = inner;
      depth++;
    }
    return el;
  }

  // Walk up from `el` (crossing shadow boundaries) to the nearest scroll
  // container. Returns null when only the document scroller is in the chain —
  // the document is handled separately so ordinary pages are unaffected.
  function scrollableAncestorFrom(el: Element | null): HTMLElement | null {
    let cur: Element | null = el;
    let hops = 0;
    while (cur && hops < 60) {
      hops++;
      if (isScrollable(cur)) return cur;
      if (cur.parentElement) {
        cur = cur.parentElement;
        continue;
      }
      const root = cur.getRootNode ? cur.getRootNode() : null;
      cur = root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null;
    }
    return null;
  }

  // The scroll region under the pointer, if the pointer is over one. The mouse
  // is the "which pane am I working in" signal: hover a sidebar and the keys
  // drive it, hover the main area and they drive the page again.
  function pickUnderPointer(): Target | null {
    if (!pointerSeen) return null;
    if (pointerX < 0 || pointerY < 0) return null;
    if (!pointerValid) {
      pointerTarget = scrollableAncestorFrom(deepHit(pointerX, pointerY));
      pointerValid = true;
    }
    const el = pointerTarget;
    if (!el) return null;
    // The pane can vanish under a stationary pointer (SPA re-render, a sidebar
    // that collapses): drop the cache so the NEXT press resolves it again rather
    // than concluding "the pointer is over nothing" forever.
    if (!el.isConnected || !isScrollable(el)) {
      pointerValid = false;
      pointerTarget = null;
      return null;
    }
    return { el: el, label: labelOf(el) };
  }

  // The target used when the user has not cycled: the dominant inner scroller
  // (bottom-to-top apps whose shell swallows the document scroller).
  function autoTarget(): Target {
    if (documentScrolls()) return windowTarget();
    if (autoEl && isScrollable(autoEl)) {
      // Expensive region ordering is refreshed lazily on an explicit cycle or
      // diagnostics pull, not on a scroll-key dispatch. Keep the current target
      // until an observer/resize invalidates it or it is no longer scrollable.
      return { el: autoEl, label: labelOf(autoEl) };
    }
    autoEl = null;
    const regions = regionsCached();
    if (regions.length) {
      autoEl = regions[0]!;
      return { el: autoEl, label: labelOf(autoEl) };
    }
    return windowTarget();
  }

  function current(): Target {
    if (active) {
      if (active.el === null) return active;
      if (isScrollable(active.el)) return active;
      // The focused region vanished (SPA re-render): fall back to automatic.
      active = null;
      clearOutline();
    }
    // The pointer decides before the fallback heuristics do, so a sidebar can
    // be driven without cycling.
    const under = pickUnderPointer();
    if (under) return under;
    return autoTarget();
  }

  /* ---------------- scrolling ---------------- */

  function scrollLines(lines: number): void {
    const t = current();
    const dy = Math.round(lines * 60);
    if (t.el) t.el.scrollTop += dy;
    else window.scrollBy(0, dy);
  }

  function scrollPage(dir: number): void {
    pageBy(dir, 0.5);
  }

  function pageBy(dir: number, factor: number): { before: number; after: number } {
    const t = current();
    const before = t.el ? t.el.scrollTop : window.scrollY || 0;
    const dy = dir * Math.round(viewportHeightOf(t.el) * factor);
    if (t.el) t.el.scrollTop += dy;
    else window.scrollBy(0, dy);
    const after = t.el ? t.el.scrollTop : window.scrollY || 0;
    return { before, after };
  }

  function toTop(): void {
    const t = current();
    if (t.el) t.el.scrollTop = 0;
    else window.scrollTo(0, 0);
  }

  function toBottom(): void {
    const t = current();
    if (t.el) t.el.scrollTop = t.el.scrollHeight;
    else {
      const se = (document.scrollingElement || document.documentElement) as HTMLElement;
      window.scrollTo(0, se ? se.scrollHeight : document.body.scrollHeight);
    }
  }

  /* ---------------- region cycling ---------------- */

  function cycleTargets(): Target[] {
    const list: Target[] = [];
    // An EXPLICIT request: `;F` is the user asking what can scroll, so it must
    // never answer from a cache the page has invalidated.
    const regions = regionsCached(true);
    // Offer the document scroller first whenever it can actually scroll.
    if (documentScrolls()) list.push(windowTarget());
    for (const el of regions) list.push({ el, label: labelOf(el) });
    return list;
  }

  function cycle(dir: number): void {
    const list = cycleTargets();
    if (!list.length) {
      toast("no scroll area");
      return;
    }
    const cur = current();
    let idx = list.findIndex((t) => (t.el === null ? cur.el === null : t.el === cur.el));
    if (idx < 0) idx = 0;
    idx = (idx + dir + list.length * 2) % list.length;
    const picked = list[idx]!;
    if (picked.el === null) {
      // Sticky window target: even on a page whose automatic choice would be
      // an inner pane, cycling back to the document scroller must stick.
      active = windowTarget();
      clearOutline();
      toast("scroll: window");
      return;
    }
    active = picked;
    showOutline();
    toast("scroll: " + picked.label);
  }

  function isCustom(): boolean {
    return active !== null;
  }

  function reset(): void {
    active = null;
    autoEl = null;
    // AND THE LIST ITSELF, which is the part that used to be missing. `reset`
    // means "the target changed for a reason the observers cannot see" — it is
    // what `;F`/`;B` cancellation and READER MODE call — and the mutation
    // observer's invalidation is RATE LIMITED (`STRUCTURAL_RESCAN_MS`, 500ms),
    // so the cached list is still served inside that window and the next `j`
    // moves a scroll target that no longer exists. Measured in the e2e theme
    // suite: `;R` then `j` immediately after did nothing at all, because the
    // list still said "no inner scroller, use the window" while the article was
    // on screen and the window could no longer scroll. Dropping the cache costs
    // ONE document scan on the next scroll key — after which the TTL and the
    // rate limits take over again — and it is paid on a deliberate user action
    // rather than on a keystroke.
    scanCache = null;
    scanStale = false;
    clearOutline();
  }

  /* ---------------- outline ---------------- */

  function showOutline(): void {
    clearOutline();
    try {
      outline = document.createElement("div");
      outline.id = "lazyfox-scroll-target";
      // `all:initial` FIRST, and the position after it, because the promotion
      // below turns this element into a POPOVER and the UA's own popover styles
      // come with it — `background-color:canvas`, `margin:auto`,
      // `width/height:fit-content`, `overflow:auto`. Without the reset this
      // outline would be an opaque canvas-coloured box covering the element it
      // is meant to point at. See shared/toplayer.ts.
      outline.setAttribute(
        "style",
        "all:initial;position:fixed;pointer-events:none;z-index:2147483645;box-sizing:border-box;" +
          "background:transparent;margin:0;padding:0;overflow:visible;" +
          "border:2px solid #2ac3de;border-radius:4px;box-shadow:0 0 0 1px rgba(0,0,0,.35);" +
          "transition:top .08s linear,left .08s linear,width .08s linear,height .08s linear;"
      );
      document.documentElement.appendChild(outline);
      // The outline is placed at getBoundingClientRect() coordinates — VIEWPORT
      // coordinates — so it has to sit in a host that is measured against the
      // viewport even when the page has made the root the containing block for
      // fixed descendants. Without this, `;j` on such a page draws the box a
      // scroll-height away from the element the user is about to scroll.
      promoteToTopLayer(outline);
    } catch (e) {
      outline = null;
      return;
    }
    outlineRaf = requestAnimationFrame(tickOutline);
  }

  function tickOutline(): void {
    outlineRaf = 0;
    if (!outline || !active || !active.el || !active.el.isConnected) {
      clearOutline();
      return;
    }
    const now = performance.now();
    if (now - lastOutlineAt > 60) {
      lastOutlineAt = now;
      const r = active.el.getBoundingClientRect();
      outline.style.top = r.top + "px";
      outline.style.left = r.left + "px";
      outline.style.width = r.width + "px";
      outline.style.height = r.height + "px";
    }
    outlineRaf = requestAnimationFrame(tickOutline);
  }

  function clearOutline(): void {
    if (outlineRaf) {
      cancelAnimationFrame(outlineRaf);
      outlineRaf = 0;
    }
    if (outline) {
      outline.remove();
      outline = null;
    }
  }

  function regionInfoOf(t: Target): ScrollRegionInfo {
    const el = t.el;
    const se = (document.scrollingElement || document.documentElement) as HTMLElement | null;
    return {
      label: t.label,
      clientHeight: el ? el.clientHeight : se ? se.clientHeight : window.innerHeight || 0,
      scrollHeight: el ? el.scrollHeight : se ? se.scrollHeight : 0,
    };
  }

  function regions(): ScrollRegionInfo[] {
    const out: ScrollRegionInfo[] = [];
    if (documentScrolls()) out.push(regionInfoOf(windowTarget()));
    // Diagnostics ask what is true NOW, so this path never uses the cache.
    for (const el of regionsCached(true)) out.push(regionInfoOf({ el: el, label: labelOf(el) }));
    return out;
  }

  function currentLabel(): string {
    return current().label;
  }

  return {
    scrollLines,
    scrollPage,
    pageBy,
    toTop,
    toBottom,
    cycle,
    reset,
    isCustom,
    regions,
    currentLabel,
  };
}
