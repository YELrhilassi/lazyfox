// Everything the engine asks about a single element: is it visible, is it in
// the viewport, what is actually on top of it, what is it called.
//
// These are the predicates that decide whether a control is offered at all, and
// they are the hardest part of the engine to get right: each one encodes a
// browser behaviour that is easy to get subtly wrong (an opacity:0 ANCESTOR is
// invisible but computes to 1; pointer-events IS inherited; a closed shadow
// root is unreachable by construction). Keeping them together, stateless and
// separately readable is what makes them reviewable at all.
import { SHADOW_DEPTH } from "./selectors";

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

export function basicVisible(el: Element): boolean {
  if (!el || !el.isConnected) return false;
  const he = el as HTMLElement;
  try {
    if (he.hasAttribute("disabled")) return false;
    // A hidden / inert / aria-hidden ANCESTOR hides the whole subtree, not
    // just the node carrying the attribute — menus, modals and off-screen
    // drawers are almost always hidden at the container. Checking only the
    // element's own attributes left every child of a closed menu hintable.
    if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  } catch (e) {
    // ignore
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return true;
}

export function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
}

// The full "is this a live, clickable target right now" check, used for the
// viewport subset (a bounded set, so the computed-style reads are cheap).
// On top of the cheap checks it rejects nodes that are hidden by CSS
// (`display:none`, `visibility:hidden/collapse`, `opacity:0`) or that opt out
// of pointer input. `opacity:0` and `pointer-events:none` nodes still have a
// real rect and still swallow `elementFromPoint`, so without this they were
// hinted and then did nothing on activation — the "labels for nothing" noise.
export function hintVisible(el: Element): boolean {
  if (!basicVisible(el)) return false;
  // The platform's own "would a human see this?" predicate when available: it
  // accounts for display/visibility/content-visibility AND an OPACITY:0
  // ANCESTOR, which per-element computed style cannot see (opacity is not
  // inherited, so a child of a faded-out menu reports opacity 1 while being
  // invisible — every link in a closed fly-out used to be hinted).
  const cv = el as unknown as { checkVisibility?: (opts?: object) => boolean };
  if (typeof cv.checkVisibility === "function") {
    let visible = true;
    try {
      visible = cv.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      });
    } catch (e) {
      try {
        visible = cv.checkVisibility();
      } catch (e2) {
        visible = true;
      }
    }
    if (!visible) return false;
  } else {
    // Fallback for older engines: the element's own computed style.
    let cs: CSSStyleDeclaration;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") {
      return false;
    }
    if (cs.opacity !== "" && parseFloat(cs.opacity) === 0) return false;
  }
  // Ancestor opacity: opacity is NOT inherited, so a child of an `opacity:0`
  // container computes to 1 while being fully invisible (checkVisibility's
  // opacity check is on the node itself). Walk a bounded number of ancestors so
  // links inside a faded-out fly-out are not hinted. pointer-events IS
  // inherited, so the element's own computed value already reflects ancestors.
  let anc: Element | null = el;
  for (let hops = 0; anc && hops < 20; hops++) {
    let op = 1;
    try {
      op = parseFloat(getComputedStyle(anc).opacity);
    } catch (e) {
      op = 1;
    }
    if (op === 0) return false;
    anc = anc.parentElement;
  }
  // checkVisibility does not cover pointer input; an element (or ancestor) that
  // opted out of the pointer cannot be clicked. Focusable form controls are the
  // exception: they can still be focused.
  let pointer = "";
  try {
    pointer = getComputedStyle(el).pointerEvents;
  } catch (e) {
    pointer = "";
  }
  if (pointer === "none") {
    const tag = el.tagName;
    const focusable =
      tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
    if (!focusable) return false;
  }
  return true;
}

// The topmost element at (x, y), piercing open shadow roots (the document's
// elementFromPoint only sees the shadow host).
export function deepHit(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  let depth = 0;
  while (el && depth < SHADOW_DEPTH) {
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
