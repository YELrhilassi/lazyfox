// Everything the engine asks about a single element: is it visible, is it in
// the viewport, what is actually on top of it, what is it called.
//
// These are the predicates that decide whether a control is offered at all, and
// they are the hardest part of the engine to get right: each one encodes a
// browser behaviour that is easy to get subtly wrong (an opacity:0 ANCESTOR is
// invisible but computes to 1; pointer-events IS inherited; a closed shadow
// root is unreachable by construction). Keeping them together, stateless and
// separately readable is what makes them reviewable at all.
import { shadowRootOf } from "../../../shared/dom";
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

function hasHiddenComposedAncestor(el: Element): boolean {
  let current: Element | null = el;
  // Walk the composed ancestor chain, including shadow hosts and assigned
  // slots. Element.closest() stops at a ShadowRoot, so it misses e.g. an
  // aria-hidden custom-element host around a control in a closed root.
  for (let hops = 0; current && hops < 512; hops++) {
    try {
      if (
        current.hasAttribute("hidden") ||
        current.hasAttribute("inert") ||
        (current.getAttribute("aria-hidden") || "").toLowerCase() === "true"
      ) {
        return true;
      }
      const slot: HTMLSlotElement | null =
        (current as Element & { assignedSlot?: HTMLSlotElement | null }).assignedSlot || null;
      if (slot) {
        current = slot;
        continue;
      }
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const root: { host?: Element } | null = current.getRootNode
        ? (current.getRootNode() as { host?: Element })
        : null;
      current = (root && root.host) || null;
    } catch (e) {
      // A hostile node must not prevent the rest of the candidate checks.
      return false;
    }
  }
  return false;
}

export function basicVisible(el: Element): boolean {
  if (!el || !el.isConnected) return false;
  const he = el as HTMLElement;
  try {
    if (he.hasAttribute("disabled")) return false;
    // A hidden / inert / aria-hidden ANCESTOR hides the whole composed subtree,
    // including shadow descendants — menus, modals and off-screen drawers are
    // commonly hidden at their host rather than at each inner control.
    if (hasHiddenComposedAncestor(el)) return false;
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
      // Firefox supports checkVisibility, but older releases ignore the
      // options argument. The explicit composed-ancestor checks below retain
      // opacity/pointer rules even there.
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
  // opacity check is on the node itself). Cross composed ancestors too: CSS
  // opacity on a custom-element host applies to controls in its shadow tree.
  //
  // COST NOTE, because this is the most expensive loop in the whole hints pass:
  // one `getComputedStyle` per composed ancestor per candidate, to the top of
  // the tree. It cannot be skipped (that is the whole reason it exists) and it
  // cannot be answered from the element's own style (opacity does not inherit),
  // so the remaining fix is memoisation ACROSS candidates within one pass — many
  // candidates share ancestors, and today each one re-reads the same chain. It is
  // left explicit here rather than half-done: see ISSUES-FIX-PLAN §12.4b, which
  // owns that change together with the profiler run that has to accompany it.
  // Bounded so a malformed tree cannot spin (a cyclic slot/parent chain).
  let anc: Element | null = el;
  for (let hops = 0; anc && hops < 512; hops++) {
    let op = 1;
    try {
      op = parseFloat(getComputedStyle(anc).opacity);
    } catch (e) {
      op = 1;
    }
    if (op === 0) return false;
    const slot: HTMLSlotElement | null =
      (anc as Element & { assignedSlot?: HTMLSlotElement | null }).assignedSlot || null;
    if (slot) {
      anc = slot;
    } else if (anc.parentElement) {
      anc = anc.parentElement;
    } else {
      const root: { host?: Element } | null = anc.getRootNode
        ? (anc.getRootNode() as { host?: Element })
        : null;
      anc = (root && root.host) || null;
    }
  }
  // checkVisibility does not cover pointer input; an element that opted out of
  // the pointer cannot be clicked. Focusable form controls are the exception:
  // they can still be focused.
  //
  // ONE READ, not an ancestor walk. `pointer-events` is an INHERITED property,
  // so the element's own computed value already reflects every ancestor, and
  // inheritance crosses from a shadow host into its tree — which is why the
  // ancestor walk this replaced could never find anything the single read does
  // not. Measured: the walk was one `getComputedStyle` per composed ancestor per
  // candidate, up to 512 of them, on a pass that already reads the element's own
  // style, and it changed no answer. (The OPACITY walk above is a different
  // matter: opacity does NOT inherit, so a faded-out container is invisible to a
  // single read and has to be walked.)
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
