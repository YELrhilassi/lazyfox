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

import { toast } from "../../shared/overlay";
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

  function trackPointer(e: PointerEvent): void {
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerSeen = true;
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
  // so a giant framework DOM cannot hang a keypress.
  function scanRegions(): HTMLElement[] {
    const out: HTMLElement[] = [];
    let all: NodeListOf<Element>;
    try {
      all = document.querySelectorAll("*");
    } catch (e) {
      return out;
    }
    const n = Math.min(all.length, MAX_SCAN);
    for (let i = 0; i < n; i++) {
      const el = all[i] as HTMLElement;
      if (!el || el.nodeType !== 1) continue;
      // Cheap rejects before touching computed style.
      if (el.clientHeight < MIN_SIZE || el.clientWidth < MIN_SIZE) continue;
      if (el.scrollHeight <= el.clientHeight + MIN_OVERFLOW) continue;
      if (isEditable(el)) continue;
      if (!isScrollable(el)) continue;
      if (visibleArea(el) <= 0) continue;
      out.push(el);
    }
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
      const sr = (el as HTMLElement).shadowRoot;
      if (!sr || sr.mode !== "open") break;
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
    const el = scrollableAncestorFrom(deepHit(pointerX, pointerY));
    if (!el) return null;
    return { el: el, label: labelOf(el) };
  }

  // The target used when the user has not cycled: the dominant inner scroller
  // (bottom-to-top apps whose shell swallows the document scroller).
  function autoTarget(): Target {
    if (documentScrolls()) return windowTarget();
    if (autoEl && isScrollable(autoEl)) return { el: autoEl, label: labelOf(autoEl) };
    autoEl = null;
    const regions = scanRegions();
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
    const t = current();
    const dy = dir * Math.round(viewportHeightOf(t.el) * 0.5);
    if (t.el) t.el.scrollTop += dy;
    else window.scrollBy(0, dy);
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
    const regions = scanRegions();
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
    clearOutline();
  }

  /* ---------------- outline ---------------- */

  function showOutline(): void {
    clearOutline();
    try {
      outline = document.createElement("div");
      outline.id = "lazyfox-scroll-target";
      outline.setAttribute(
        "style",
        "position:fixed;pointer-events:none;z-index:2147483645;box-sizing:border-box;" +
          "border:2px solid #2ac3de;border-radius:4px;box-shadow:0 0 0 1px rgba(0,0,0,.35);" +
          "transition:top .08s linear,left .08s linear,width .08s linear,height .08s linear;"
      );
      document.documentElement.appendChild(outline);
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
    for (const el of scanRegions()) out.push(regionInfoOf({ el: el, label: labelOf(el) }));
    return out;
  }

  function currentLabel(): string {
    return current().label;
  }

  return {
    scrollLines,
    scrollPage,
    toTop,
    toBottom,
    cycle,
    reset,
    isCustom,
    regions,
    currentLabel,
  };
}
