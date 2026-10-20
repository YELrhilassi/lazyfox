// Re-finding the element a hint belongs to, after the page moved on.
//
// Split out of hints/session.ts. This is the part of link hints that answers
// "which element is this label actually on?", and it is the part with the most
// hard-won rules in it: a framework replaced the node, so the old element is
// disconnected, and returning null there is what used to make a key silently
// do nothing. The three fallbacks, and why each exists, are in resolve().
//
// It is a module rather than three functions inside the session because it is
// the ONLY part of link hints that is not about state: no key has been typed,
// nothing is armed, no overlay is painted. Give it the pool and it gives back
// elements, which is a question the key assignment, the render loop and the
// activator all need answered the same way.

import { collectHintables } from "./collect";
import { selectHintables, targetKey, type SelectResult } from "./select";
import { deepHit } from "./probe";
import { createVisibilityPass, type VisibilityPass } from "./visibility";
import { HINTABLE_SELECTOR, MAX_HINTS, PAGE_FACTOR, type HintItem } from "./selectors";

/**
 * The part of the page's scroll controller this module needs: move the region
 * the user is looking at, and report its offset either side of the move.
 *
 * Structural rather than typed as `ScrollController` for the same reason
 * `maxHints` is a parameter: the paging rule is then testable against a fake
 * with no document at all, which is the only way to pin "paging never touches
 * the window" as a fact instead of an intention.
 */
export interface HintPager {
  pageBy(dir: number, factor: number): { before: number; after: number };
}

export interface HintResolveDeps {
  // The current hintable pool. Read, and REPLACED by resolve() when it has gone
  // stale — the pool is only refreshed on a debounce, so it can lag a
  // just-rendered control.
  pool(): Element[];
  setPool(next: Element[]): void;
  // At most this many hints are ever shown (MAX_HINTS). Taken as a parameter
  // rather than imported so the resolution rules are testable against a
  // different cap without touching the pool.
  maxHints?: number;
  /**
   * A fresh visibility pass. Injected for the tests; the real one is
   * `createVisibilityPass()`.
   */
  newPass?(): VisibilityPass;
  /**
   * The page's scroll controller, when this host has one (content/scroll.ts).
   *
   * A GETTER, not the controller itself: the content script builds the hint
   * engine before the scroll controller exists, and the answer to "which
   * region scrolls" is only meaningful at the moment a key is pressed.
   * Absent in hosts with no controller and in the unit tests, where paging
   * falls back to the plain window scroller — the behaviour every hint layer
   * had before this dependency existed.
   */
  scroll?(): HintPager | null;
}

export interface HintResolve {
  /**
   * The batch the viewport earns right now: the kept candidates (each with the
   * occlusion answer its label is drawn with — a covered control is INCLUDED and
   * flagged, never dropped) plus the counters, including `more`: in view and
   * visible, but left out because the batch was full. Returned as the whole
   * result rather than just the array because "how many did not fit" is part of
   * the answer and the session says it out loud.
   */
  viewportItems(): SelectResult;
  /**
   * Rebuild the pool from the live document, with a fresh visibility pass.
   *
   * This is the ONLY way the pool is rebuilt, because the pool and the pass are
   * a pair: the pass holds what it learned about the document the pool came
   * from, so re-collecting through the old pass would answer about a tree that
   * no longer exists. Callers therefore cannot get this wrong by forgetting to
   * pass a cache — there is nothing to pass.
   */
  refreshPool(): Element[];
  /**
   * Re-find the live element for an item, or null if it is genuinely gone.
   *
   * `refresh` IS OPT-IN, and that is a performance rule rather than a taste one.
   * This function is called for every hinted item on every sweep — up to twenty
   * times a second for as long as hints are open — so anything it does per item
   * is multiplied by the batch and the frame rate. It used to rebuild the pool
   * (a document-wide `querySelectorAll` plus a tree walk, plus a fresh
   * visibility pass) whenever an item's node had been replaced and no neighbour
   * was close enough, and a framework page replaces hinted nodes constantly:
   * that is dozens of full-document collections a second, which is the reported
   * "the hints got stuck and unresponsive, they don't do anything, even
   * exiting" — nothing runs on a main thread doing that, Escape included.
   *
   * So the hot path answers from the batch it already has, and the debounced
   * DOM watcher (session.watchDom → sweep → refreshPool) owns re-collection:
   * the very mutation that replaced the node has already scheduled it. The one
   * caller that passes `refresh: true` is a one-shot ACTIVATION, where paying
   * for a collect once is the user's own keypress and a key that does nothing is
   * worse than a few milliseconds.
   */
  resolve(it: HintItem, opts?: { refresh?: boolean }): Element | null;
  /** The element nearest an item's last screen centre. */
  nearest(it: HintItem, list: Element[]): Element | null;
  /** Scroll the region the user is looking at by `dir` pages (see HintPager). */
  pageScroll(dir: number): { before: number; after: number };
}

export function createHintResolve(deps: HintResolveDeps): HintResolve {
  const makePass = deps.newPass || (() => createVisibilityPass());
  // ONE pass per pool generation, shared by collection and selection. They ask
  // about the same elements (the in-viewport set is a subset of the collected
  // set), so a shared cache means selection does not re-walk the ancestors
  // collection just walked — and because the pass is replaced together with the
  // pool, the cache can never describe a stale document.
  let pass = makePass();

  function refreshPool(): Element[] {
    pass = makePass();
    const next = collectHintables(undefined, pass);
    deps.setPool(next);
    return next;
  }

  // The currently-hintable elements: everything in `pool` that is in the
  // viewport, CSS-visible and not a nested/duplicate target. A covered control
  // is in this list too, carrying the flag its label is drawn with.
  function viewportItems(): SelectResult {
    return selectHintables(deps.pool(), deps.maxHints ?? MAX_HINTS, pass);
  }

  // Paging (`]`, `[`, Tab) moves the region the user is LOOKING AT and reports
  // the target's offset either side of the move — see HintPager for why the
  // window scroller is the wrong answer on the shell pages this exists for.
  function pageScroll(dir: number): { before: number; after: number } {
    const pager = deps.scroll ? deps.scroll() : null;
    if (pager) return pager.pageBy(dir, PAGE_FACTOR);
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    const before = window.scrollY || 0;
    window.scrollBy(0, dir * Math.round(vh * PAGE_FACTOR));
    return { before: before, after: window.scrollY || 0 };
  }

  // The live element nearest an item's last screen centre, preferring the same
  // destination so a small reflow cannot hand the hint to a neighbour.
  //
  // The visibility answer comes from the POOL'S pass, so the composed ancestor
  // chain is walked once per element rather than once per element per call. It
  // used to call `basicVisible(el)`, whose no-pass form builds a whole
  // visibility pass — five WeakMaps and a fresh closure — for EVERY candidate
  // it probed, on a probe that is itself O(pool). That is the same class of
  // mistake as the resolve loop it sits under: per-candidate setup on a hot
  // path, hidden behind a predicate that reads as cheap.
  function nearest(it: HintItem, list: Element[]): Element | null {
    if (!it.cx && !it.cy) return null;
    let best: Element | null = null;
    let bestD = Infinity;
    for (const el of list) {
      if (!el.isConnected || !pass.visible(el)) continue;
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
  // no longer connected. So the re-find stays — but WHERE it happens is now
  // decided per caller (see the `refresh` opt-in on the interface), because the
  // three callers ask the question at wildly different rates: the overlay asks
  // it per item per frame, an activation asks it once, and the batch rebuild
  // asks it about everything at once.
  //
  // The order is unchanged: the node itself, then the nearest match in the
  // batch (same destination preferred), then — only when a caller has asked for
  // a fresh collection — the nearest match in the rebuilt batch, and finally a
  // deep hit at the last recorded position.
  function resolve(it: HintItem, opts?: { refresh?: boolean }): Element | null {
    if (it.el && it.el.isConnected) return it.el;
    let found = nearest(it, deps.pool());
    // Only a one-shot activation may pay for a re-collect (see the interface).
    // The hot path answers from the batch it has: if the replacement is not
    // there yet, the mutation that replaced it has already scheduled the
    // debounced refresh, and the label comes back with its key on that pass.
    if (!found && opts && opts.refresh) {
      refreshPool();
      found = nearest(it, deps.pool());
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

  // There is deliberately no `onScreen` here any more. There used to be, and it
  // was a second answer to a question the overlay's placement already answers —
  // with the consequence that the two could disagree and a hidden hint kept a
  // typeable key. Visibility is now reported by the thing that places the
  // labels (`overlay.shownKeys()`), so there is one answer and it cannot drift.
  return { viewportItems, refreshPool, resolve, nearest, pageScroll };
}

