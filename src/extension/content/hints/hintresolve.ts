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
import { selectHintables, targetKey } from "./select";
import { basicVisible, deepHit } from "./probe";
import { HINTABLE_SELECTOR, MAX_HINTS, PAGE_FACTOR, type HintItem } from "./selectors";

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
}

export interface HintResolve {
  /** The hintable elements currently in the viewport. */
  viewportItems(): Element[];
  /** Re-find the live element for an item, or null if it is genuinely gone. */
  resolve(it: HintItem): Element | null;
  /** Is this element on screen right now? */
  onScreen(it: HintItem): boolean;
  /** The element nearest an item's last screen centre. */
  nearest(it: HintItem, list: Element[]): Element | null;
  /** Scroll the window by `dir` viewports, so a hint set stays in reach. */
  pageScroll(dir: number): void;
}

export function createHintResolve(deps: HintResolveDeps): HintResolve {
  // The currently-hintable elements: everything in `pool` that is in the
  // viewport, CSS-visible, not occluded and not a nested/duplicate target.
  function viewportItems(): Element[] {
    return selectHintables(deps.pool(), deps.maxHints ?? MAX_HINTS).kept;
  }

  function pageScroll(dir: number): void {
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    window.scrollBy(0, dir * Math.round(vh * PAGE_FACTOR));
  }

  // The live element nearest an item's last screen centre, preferring the same
  // destination so a small reflow cannot hand the hint to a neighbour.
  function nearest(it: HintItem, list: Element[]): Element | null {
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
  function resolve(it: HintItem): Element | null {
    if (it.el && it.el.isConnected) return it.el;
    let found = nearest(it, deps.pool());
    if (!found) {
      deps.setPool(collectHintables());
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

  function onScreen(it: HintItem): boolean {
    const el = resolve(it);
    if (!el) return false;
    let r: DOMRect;
    try {
      r = el.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  return { viewportItems, resolve, onScreen, nearest, pageScroll };
}

