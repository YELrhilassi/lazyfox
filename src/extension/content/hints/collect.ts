// Walking the document (and open shadow roots) for things worth a hint.
//
// Collection is deliberately separate from selection: this module answers "what
// COULD be hinted", select.ts answers "what SHOULD be". Mixing them is how a
// page ends up with either no hints at all or a wall of them, because a
// filter that is right for one question silently breaks the other.
import { HINTABLE_SELECTOR, MAX_SCAN, MEDIA_SELECTOR, SHADOW_DEPTH } from "./selectors";
import { basicVisible } from "./probe";

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
export function leafClickable(el: Element): boolean {
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
  let cursor = "";
  try {
    cursor = getComputedStyle(el).cursor;
  } catch (e) {
    return false;
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

// Collect every hintable element in (approximate) document order, descending
// into open shadow roots so custom elements are covered.
export function collectHintables(stats?: CollectStats): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();

  function add(el: Element): void {
    if (seen.has(el) || !basicVisible(el)) return;
    seen.add(el);
    out.push(el);
  }

  function walk(root: ParentNode, depth: number): void {
    let nodes: Element[];
    try {
      nodes = Array.prototype.slice.call(root.querySelectorAll(HINTABLE_SELECTOR));
    } catch (e) {
      return;
    }
    for (const el of nodes) add(el);
    if (depth >= SHADOW_DEPTH) return;
    let all: Element[];
    try {
      all = Array.prototype.slice.call(root.querySelectorAll("*"));
    } catch (e) {
      return;
    }
    const n = Math.min(all.length, MAX_SCAN);
    for (let i = 0; i < n; i++) {
      const el = all[i]!;
      const sr = (el as HTMLElement).shadowRoot;
      if (sr && sr.mode === "open") {
        if (stats) stats.shadowRoots++;
        walk(sr, depth + 1);
      }
      // The cursor:pointer pass, on the same walk (one DOM sweep).
      if (!seen.has(el) && leafClickable(el)) {
        if (stats) stats.pointerControls++;
        // leafClickable's media exemption is what makes an unlabelled wrapper
        // hintable at all; record that this candidate qualified on that basis
        // so the nesting pass can prefer a real control inside it.
        if (isMediaOnlyWrapper(el)) weakHintables.add(el);
        add(el);
      }
    }
  }

  walk(document, 0);
  return out;
}

