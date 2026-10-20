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
// The composed parent is what a click's retargeting follows: a dialog inside a
// shadow root must still be walked out of, or a page that renders its modal in a
// closed root would read as "nothing on top".
import { composedParentOf } from "./visibility";
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

// THE SHARE OF THE VIEWPORT A PANEL MUST COVER to count as a surface of its own
// rather than as an obstruction over this one. A quarter: a dialog, a modal
// sheet, a lightbox and a product popup all clear it; a sticky header, a badge,
// a toast and the scrim band the fixtures use do not.
const SHEET_AREA = 0.25;
// How far up the composed chain a cover is followed. Deep enough for
// panel → backdrop → portal wrapper, short enough to stay a handful of reads.
const SHEET_WALK = 12;

// Is a node one of the surfaces that REPLACES the screen — a dialog, a popup, a
// sheet — rather than an obstruction painted over the page?
function asSheet(node: Element, el: Element, vw: number, vh: number): boolean {
  // The control's own container is not what is on top of it. This is the clause
  // that keeps a fixed app shell (position:fixed; inset:0, holding the whole
  // page) from reading as a modal over its own content.
  try {
    if (node === el || node.contains(el)) return false;
  } catch (e) {
    return false;
  }
  // The document's own roots are the page, not a surface on it. This is not just
  // correctness: it is the end of every walk that found no sheet, so it saves a
  // computed-style read per call on the passes that run during a scroll.
  try {
    const doc = node.ownerDocument;
    if (doc && (node === doc.body || node === doc.documentElement)) return false;
  } catch (e) {
    return false;
  }
  let semantic = false;
  try {
    semantic = node.matches(
      "dialog, [popover], [role='dialog'], [role='alertdialog'], [aria-modal='true']",
    );
  } catch (e) {
    semantic = false;
  }
  let r: DOMRect | null = null;
  try {
    const cs = getComputedStyle(node);
    const positioned = cs.position === "fixed" || cs.position === "absolute" || cs.position === "sticky";
    // A plain static container is the page, whatever its size.
    if (!positioned && !semantic) return false;
    r = node.getBoundingClientRect();
  } catch (e) {
    return false;
  }
  if (!r || r.width <= 0 || r.height <= 0) return false;
  // IT MUST ACTUALLY COVER THE CONTROL. A panel somewhere else on the screen is
  // not the thing over this control (the hit test said the centre is covered by
  // something inside this node, but only the geometry says the node owns it).
  let er: DOMRect | null = null;
  try {
    er = el.getBoundingClientRect();
  } catch (e) {
    return false;
  }
  if (!er) return false;
  if (
    r.left > er.left + 1 ||
    r.top > er.top + 1 ||
    r.right < er.right - 1 ||
    r.bottom < er.bottom - 1
  ) {
    return false;
  }
  if (semantic) return true;
  return r.width * r.height >= SHEET_AREA * vw * vh;
}

/**
 * The surface hiding this control, when it is hidden BEHIND one — a dialog, a
 * popup, a modal sheet — or null when the control is simply obstructed.
 *
 * Why the distinction is not cosmetic: a hint label is drawn in the top layer,
 * above the page's own stacking contexts, at the control's own corner. Over a
 * scrim or a sticky bar that is informative (the dimmed label says "there is a
 * control here, something is painted over it"). Over a DIALOG it is a lie in
 * both directions — the label is drawn on top of the dialog the user is looking
 * at, and the key would fire at a control the dialog is covering. That is the
 * report: "hints leak and show from behind the elements in front of them".
 *
 * The question is answered from what the pointer sees: `reachable()` first (a
 * control the pointer can still reach is on the same surface by definition),
 * then the element on top of it, then the panel that element belongs to. A
 * panel qualifies as another surface when it is POSITIONED (fixed/absolute/
 * sticky — it is not in the page's flow) and covers the control and either
 * covers a quarter of the viewport or is a dialog/popover/modal by role or tag.
 *
 * Bounded and non-throwing: one hit test, at most twelve composed ancestors,
 * computed styles and rects only for positioned nodes, and every read wrapped —
 * a hostile element answers "no" and keeps the ordinary dimmed label.
 */
export function sheetOver(el: Element): Element | null {
  try {
    // A control the pointer can still reach is not behind anything.
    if (reachable(el)) return null;
  } catch (e) {
    return null;
  }
  let vw = 0;
  let vh = 0;
  try {
    vw = window.innerWidth || 0;
    vh = window.innerHeight || 0;
  } catch (e) {
    return null;
  }
  if (vw <= 0 || vh <= 0) return null;
  let cx = 0;
  let cy = 0;
  try {
    const er = el.getBoundingClientRect();
    cx = Math.min(Math.max(er.left + er.width / 2, 0), vw - 1);
    cy = Math.min(Math.max(er.top + er.height / 2, 0), vh - 1);
  } catch (e) {
    return null;
  }
  const hit = deepHit(cx, cy);
  if (!hit) return null;
  try {
    if (hit === el || el.contains(hit) || hit.contains(el)) return null;
  } catch (e) {
    return null;
  }
  let node: Element | null = hit;
  for (let i = 0; node && i < SHEET_WALK; i++) {
    if (asSheet(node, el, vw, vh)) return node;
    let next: Element | null = null;
    try {
      next = composedParentOf(node) as Element | null;
    } catch (e) {
      next = null;
    }
    node = next;
  }
  return null;
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
