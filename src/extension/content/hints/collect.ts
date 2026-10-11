// Walking the document (and open shadow roots) for things worth a hint.
//
// Collection is deliberately separate from selection: this module answers "what
// COULD be hinted", select.ts answers "what SHOULD be". Mixing them is how a
// page ends up with either no hints at all or a wall of them, because a
// filter that is right for one question silently breaks the other.
//
// THREE THINGS THIS PASS DOES NOT DO ANY MORE, each with the cost it removed:
//
//   * it does not materialise the tree. The per-node walk used to be
//     `Array.prototype.slice.call(root.querySelectorAll("*"))` followed by
//     `Math.min(all.length, MAX_SCAN)` — so the cap bounded the LOOP and not the
//     ALLOCATION: a five-figure-element array per root, on a pass that stops
//     after a few thousand nodes anyway. It is a lazy TreeWalker now
//     (`shared/dom.ts walkElements`), so the budget is the only thing that
//     bounds it.
//   * it does not re-derive visibility per element. `basicVisible` was walked for
//     every candidate: the composed ancestor chain, once per node, to answer a
//     question the previous node had usually already answered about the same
//     ancestors. The pass object from hints/visibility.ts caches one answer per
//     ELEMENT, so siblings and their whole ancestry are walked once.
//   * it does not run unbounded. A document can be arbitrarily large and the
//     pass runs inside a keystroke handler, so the per-node work is on a soft
//     DEADLINE: the cheap `querySelectorAll` matches are always collected (they
//     are one query per root and they are the primary candidates), while the
//     cursor:pointer + shadow-root discovery walk stops when the budget runs out
//     and SAYS SO in the stats. Truncation is stated rather than silent — the
//     same rule the chrome-side hint engine follows for its ninth link.
import { HINTABLE_SELECTOR, MAX_SCAN, MEDIA_SELECTOR, SHADOW_DEPTH } from "./selectors";
import { createVisibilityPass, type VisibilityPass } from "./visibility";
import { shadowRootOf, walkElements } from "../../../shared/dom";

export function isOrHasMedia(el: Element): boolean {
  try {
    return el.matches(MEDIA_SELECTOR) || !!el.querySelector(MEDIA_SELECTOR);
  } catch (e) {
    return false;
  }
}

// Framework UIs often build a control out of a bare <div>/<span> with nothing
// but `cursor:pointer` and a click handler (no <a>, no <button>, no ARIA role).
// Such a node is hintable when it is a leaf-ish click target rather than a
// container: few element children, short text, and no hintable descendant. The
// computed-style read is gated behind those cheap checks so a huge page does
// not pay for it on every node.
export function leafClickable(el: Element, pass?: VisibilityPass): boolean {
  if (el === document.body || el === document.documentElement) return false;
  let children = 0;
  try {
    children = el.children.length;
  } catch (e) {
    return false;
  }
  if (children > 3) return false;
  try {
    if (el.querySelector(HINTABLE_SELECTOR)) return false;
  } catch (e) {
    return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  const text = (el.textContent || "").trim();
  if (text.length > 120) return false;
  // A bare cursor:pointer node with no text, no aria-label/title and no role is
  // almost always decorative chrome (icon wrappers, scrims, layout spacers).
  // Hinting those was a large part of the "hints everywhere" flood on framework
  // pages like YouTube, where nearly every wrapper sets cursor:pointer.
  // HOWEVER, a node that is or contains real media (an image / video / canvas
  // thumbnail) IS meaningful even without a text label — dropping those made
  // "pictures and videos" unclickable, so media is exempt from the rule.
  if (
    !text &&
    !el.getAttribute("aria-label") &&
    !el.getAttribute("title") &&
    !el.getAttribute("role") &&
    !isOrHasMedia(el)
  ) {
    return false;
  }
  // The cursor read comes from the pass, so the node's style is read at most
  // once per pass even though the visibility checks asked about it too. A node
  // that is not visible is not clickable, so this is also the cheapest place to
  // drop it.
  const cs = pass ? pass.styleOf(el) : null;
  let cursor = "";
  if (pass) {
    cursor = cs ? cs.cursor : "";
  } else {
    try {
      cursor = getComputedStyle(el).cursor;
    } catch (e) {
      return false;
    }
  }
  return cursor === "pointer";
}

// A generic control that is hintable ONLY because it wraps media: no text, no
// aria-label, no title and no role. Such an element is exempt from the
// "unlabelled means decorative" rule so that pictures and videos stay
// clickable — but it is a wrapper, not a control, and the nesting pass must be
// able to tell the difference.
export function isMediaOnlyWrapper(el: Element): boolean {
  const tag = el.tagName;
  if (tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" || tag === "PICTURE") return false;
  try {
    if (el.getAttribute("role") || el.getAttribute("aria-label") || el.getAttribute("title")) {
      return false;
    }
    if ((el.textContent || "").trim()) return false;
    if (el.hasAttribute("onclick")) return false;
    return isOrHasMedia(el);
  } catch (e) {
    return false;
  }
}

// Counters collected during a sweep, for the diagnostics page (the live hint
// flow passes nothing and pays nothing).
export interface CollectStats {
  shadowRoots: number;
  pointerControls: number;
  /**
   * The per-node discovery walk hit the time budget (or MAX_SCAN) before the
   * document was exhausted. The selector matches are still complete; what may be
   * missing is a control that only the cursor:pointer pass would have found.
   */
  truncated: boolean;
  /** Nodes the discovery walk visited, and the budget it was given. */
  visited: number;
  budgetMs: number;
}

// Elements that are hintable ONLY because they wrap media (see the
// isOrHasMedia exemption in leafClickable). They are legitimate targets — a
// thumbnail with no text is still worth a key — but they must never suppress a
// real control inside them, because on a media-heavy page they are the biggest
// thing on screen. Tagging them here (where the exemption is applied) keeps the
// knowledge in one place instead of re-deriving it in the selection pass.
export const weakHintables = new WeakSet<Element>();

// How specific a candidate is, for the nesting decision. Higher wins.
//
// The order is "how explicitly does this element ask to be clicked":
//   5  a real widget the platform gives semantics (button, summary, form field)
//   4  an explicit ARIA control, or a contenteditable
//   3  a link, or an element with an inline handler
//   2  a named generic control (a div with a label and a click handler)
//   1  an anonymous generic control (a bare cursor:pointer div)
//   0  a media-only container: hintable, but a wrapper, never a target to keep
//      in preference to something inside it
export function specificity(el: Element): number {
  if (weakHintables.has(el)) return 0;
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "SUMMARY") return 5;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return 5;
  if ((el as HTMLElement).isContentEditable) return 4;
  const role = el.getAttribute("role") || "";
  if (
    role === "button" || role === "link" || role === "tab" || role === "option" ||
    role === "menuitem" || role === "menuitemcheckbox" || role === "menuitemradio" ||
    role === "switch" || role === "checkbox" || role === "radio" || role === "combobox"
  ) {
    return 4;
  }
  if (tag === "A" && el.getAttribute("href")) return 3;
  if (el.hasAttribute("onclick")) return 3;
  // A generic control the user can see the meaning of beats an anonymous one:
  // the "Skip ad" div and the empty wrapper around it should not tie.
  let named = false;
  try {
    named = !!(
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      (el.textContent || "").trim()
    );
  } catch (e) {
    named = false;
  }
  return named ? 2 : 1;
}

/**
 * The default per-node discovery budget, in milliseconds.
 *
 * This is the pass that runs inside the keystroke that opened hints, so it is
 * bounded by WALL TIME rather than by node count: a hundred thousand nodes of
 * flat markup and a hundred thousand nodes of nested custom elements are not the
 * same cost, and the previous cap (MAX_SCAN) could not tell them apart. 12ms is
 * about one frame at 80Hz — enough for every document measured in the suite
 * (the largest fixture is a few thousand nodes) and short enough that no single
 * hint pass can own the main thread.
 */
export const COLLECT_BUDGET_MS = 12;

function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (e) {
    // fall through
  }
  return Date.now();
}

/**
 * Collect every hintable element in (approximate) document order, descending
 * into open and extension-visible closed shadow roots so custom elements are
 * covered.
 *
 * The pass is passed IN so collection and selection share one set of cached
 * visibility answers about the same document; given none, one is created here
 * (which is the same cost as before this was cacheable, and leaves nothing
 * behind).
 */
export function collectHintables(stats?: CollectStats, pass?: VisibilityPass): Element[] {
  const vis = pass || createVisibilityPass();
  const out: Element[] = [];
  const seen = new Set<Element>();
  const budgetMs = stats ? stats.budgetMs || COLLECT_BUDGET_MS : COLLECT_BUDGET_MS;
  const deadline = nowMs() + budgetMs;
  let visited = 0;
  let truncated = false;

  function add(el: Element): void {
    if (seen.has(el) || !vis.visible(el)) return;
    seen.add(el);
    out.push(el);
  }

  function walk(root: ParentNode, depth: number): void {
    // The cheap, primary candidates first: ONE query per root for the whole
    // selector list, in document order, before the discovery walk below. This is
    // the order the engine has always produced, and it is load-bearing: keys are
    // handed out in candidate order, so the first link on the page keeps the
    // shortest key.
    let nodes: Element[];
    try {
      nodes = Array.prototype.slice.call(root.querySelectorAll(HINTABLE_SELECTOR));
    } catch (e) {
      nodes = [];
    }
    for (const el of nodes) add(el);
    if (depth >= SHADOW_DEPTH || truncated) return;
    // NOTE: the shadow recursion below happens INSIDE the discovery walk, not
    // after it, because that is the order the engine has always produced: a
    // custom element's inner controls are appended where the host appears, so a
    // host's controls keep the position of the host in the key order.
    // The discovery walk: shadow roots (which the selector query cannot see) and
    // the cursor:pointer pass. Lazily walked, so MAX_SCAN bounds the WORK rather
    // than the allocation.
    const result = walkElements(root, MAX_SCAN, (el) => {
      // Checked every 256 nodes: one clock read per 256 nodes is free next to
      // the per-node work, and stopping MID-root is the whole point of a budget.
      if (visited > 0 && (visited & 255) === 0 && nowMs() > deadline) {
        truncated = true;
        return false;
      }
      visited++;
      // CLOSED ROOTS COUNT, and they are the majority of the ones that matter.
      //
      // This used to read `el.shadowRoot` and require `mode === "open"`, so every
      // control inside a closed root was invisible to hints — YouTube's search
      // box, Reddit's inputs, most component libraries, and anything built with a
      // Shadow-DOM-based design system. The asymmetry was the tell: the TYPING
      // guard (shared/dom.ts) already reaches closed roots through the
      // extension's own door and answers correctly there, while hints claimed
      // there was nothing to hint. Same door, same walk, one place it was
      // forgotten.
      const sr = shadowRootOf(el);
      if (sr) {
        if (stats) stats.shadowRoots++;
        walk(sr, depth + 1);
      }
      // The cursor:pointer pass, on the same walk (one DOM traversal).
      if (!seen.has(el) && leafClickable(el, vis)) {
        if (stats) stats.pointerControls++;
        // leafClickable's media exemption is what makes an unlabelled wrapper
        // hintable at all; record that this candidate qualified on that basis
        // so the nesting pass can prefer a real control inside it.
        if (isMediaOnlyWrapper(el)) weakHintables.add(el);
        add(el);
      }
    });
    if (result.truncated) truncated = true;
  }

  if (stats) {
    stats.truncated = false;
    stats.visited = 0;
    stats.budgetMs = budgetMs;
  }
  walk(document, 0);
  if (stats) {
    stats.truncated = truncated;
    stats.visited = visited;
  }
  return out;
}
