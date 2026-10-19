// Everything the engine asks about a single element: is it visible, is it in
// the viewport, what is actually on top of it, what is it called.
//
// These are the predicates that decide whether a control is offered at all, and
// they are the hardest part of the engine to get right: each one encodes a
// browser behaviour that is easy to get subtly wrong (an opacity:0 ANCESTOR is
// invisible but computes to 1; pointer-events IS inherited; a closed shadow
// root is unreachable by construction).
//
// WHAT CHANGED AND WHY THE FILE IS SPLIT. The visibility pair
// (`basicVisible`/`hintVisible`) now lives in hints/visibility.ts, because
// answering it per ELEMENT is what made it expensive: two full composed-ancestor
// walks and up to three computed-style reads per candidate, re-derived for every
// candidate even when they share ancestors. That module answers the same
// question for a whole PASS from memoised per-element answers, and it is
// injected with its style reader so the claim about cost is countable in a test.
// What stays here is the rest of the probe: hit-testing, names and geometry.
import { shadowRootOf } from "../../../shared/dom";
import { SHADOW_DEPTH } from "./selectors";
export {
  basicVisible,
  hintVisible,
  composedParentOf,
  createVisibilityPass,
  type VisibilityPass,
} from "./visibility";

export function describeTarget(el: Element): string {
  let tag = "";
  try {
    tag = String(el.tagName || "?").toLowerCase();
  } catch (e) {
    tag = "?";
  }
  let name = "";
  try {
    name = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      (el.textContent || "")
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  } catch (e) {
    name = "";
  }
  let role = "";
  try {
    role = el.getAttribute("role") || "";
  } catch (e) {
    role = "";
  }
  const kind = role ? tag + "[role=" + role + "]" : tag;
  return name ? kind + " \u201c" + name + "\u201d" : kind;
}

export function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
}

// The topmost element at (x, y), piercing open AND extension-visible closed
// shadow roots (document.elementFromPoint only sees the host). Collection already
// walks closed roots through shadowRootOf(); if hit-testing only pierced open
// roots, every candidate we correctly collected from a closed root would then
// fail the reachability filter and `;f` would still act as if those controls did
// not exist. Keep discovery, reachability and activation on the same door.
export function deepHit(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  let depth = 0;
  while (el && depth < SHADOW_DEPTH) {
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

// Whether `el` is actually clickable somewhere right now — not covered by a
// transparent overlay (cookie walls, ad layers, sticky headers). Elements we
// cannot reach are dropped so their key never fires into nothing.
//
// Several points are sampled, not just the centre: a link whose centre is
// hidden behind a small floating badge is still clickable by its body, and a
// partly-scrolled element has points outside the viewport that must be skipped
// rather than counted as covered.
export function reachable(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const ix = Math.min(4, r.width / 4);
  const iy = Math.min(4, r.height / 4);
  const pts: Array<[number, number]> = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + ix, r.top + iy],
    [r.right - ix, r.top + iy],
    [r.left + ix, r.bottom - iy],
    [r.right - ix, r.bottom - iy],
  ];
  for (const p of pts) {
    const x = p[0];
    const y = p[1];
    if (x < 0 || y < 0 || x > vw || y > vh) continue;
    const hit = deepHit(x, y);
    if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return true;
  }
  return false;
}

// A short, human-readable name for an element, for the diagnostics table.
export function shortName(el: Element): string {
  try {
    const label =
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      ((el as HTMLElement).innerText || el.textContent || "");
    const t = String(label).replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, 60);
  } catch (e) {
    // fall through
  }
  const id = el.id ? "#" + el.id : "";
  return String(el.tagName || "?").toLowerCase() + id;
}

// The point a click would land on, for the occlusion checks.
export function rectCenter(el: Element): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}
