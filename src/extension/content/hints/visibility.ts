// "Would a human see this, and could they click it?" — answered for a whole
// PASS, not for one element at a time.
//
// WHY THIS IS A MODULE OF ITS OWN, and why it is not just the two predicates it
// replaces. The predicates are cheap for one element and expensive for a page:
// `basicVisible` walks the composed ancestor chain looking for
// hidden/inert, and `hintVisible` walks it AGAIN looking for an
// `opacity:0` container (opacity is not inherited, so a single read cannot
// answer it) and then reads the element's own computed style up to three times.
// On a document with a few thousand candidates — a video page, a mail list, a
// framework app — that is thousands of walks over a handful of distinct
// ancestors, and every one of those reads forces style resolution.
//
// The fix is not a faster predicate. It is remembering what a pass has already
// learned, which is legitimate because the answer is a property of the TREE and
// of the STYLE at the moment the pass runs:
//
//   * `hiddenByAttribute` and `opacityZero` are ANCESTOR predicates, so they are
//     computed once per element by recursion — a node's answer is its own
//     attribute/style plus its parent's answer. Sharing that across candidates
//     turns "one walk to the top per candidate" into "one walk per distinct
//     element", and for a page whose candidates are mostly siblings (the common
//     case: one card list) that is a difference of orders of magnitude.
//   * the element's own `getComputedStyle` is read ONCE per element per pass and
//     reused by the display/visibility check, the opacity check and the
//     pointer-events check.
//
// The caches are per pass and never outlive it: a page that changes its styles
// invalidates by RE-RUNNING the pass (the session re-collects on mutations and
// on movement), which is the rule the rest of the engine follows. Nothing here
// is global, so there is no staleness to reason about.
//
// It is deliberately injectable — `createVisibilityPass(readStyle)` — because
// the number of style reads is the whole claim, and a claim about cost should be
// countable in a test rather than asserted in a comment.

/** `Element.getComputedStyle`, as the pass needs it. Injectable for the tests. */
export type StyleReader = (el: Element) => CSSStyleDeclaration;

export interface VisibilityPass {
  /**
   * Actually unavailable to a pointer — `inert`, on this element or any composed
   * ancestor.
   *
   * THAT IS THE ONLY ATTRIBUTE THAT QUALIFIES. `hidden` used to be here, and it
   * is a trap: the attribute is the UA's `display:none` default, which ANY
   * author rule overrides (`[hidden] { display: flex }`, or a utility class on
   * the same element). Component libraries set `hidden` to drive their own
   * show/hide styling and end up with a visible control wearing the attribute;
   * the engine then refused it before it ever measured a box, which is exactly
   * the "some important labels just don't show" report on app shells. The box
   * itself is the honest question — a really hidden element has none, or fails
   * `checkVisibility` — so `hidden` is no longer trusted from the attribute.
   *
   * `aria-hidden="true"` is deliberately NOT one of these either. It says "keep
   * this out of the accessibility tree", which is a statement about screen
   * readers, not about the screen: the most common use of it on a real page is a
   * DUPLICATE affordance — YouTube marks the thumbnail link `aria-hidden`
   * because the title link beside it is the accessible one, while the thumbnail
   * is the biggest click target on the page. Treating it as invisibility deleted
   * those targets outright (see docs/HINTS.md §10). What is genuinely off-screen
   * or covered is answered by the checks that can actually see that: the CSS
   * visibility test, `inViewport`, and `reachable`'s hit tests.
   */
  hiddenByAttribute(el: Element): boolean;
  /** `opacity: 0` on this element or any composed ancestor. */
  opacityZero(el: Element): boolean;
  /** The element's own computed style, read once per pass. */
  styleOf(el: Element): CSSStyleDeclaration | null;
  /** Cheap checks only: connected, enabled, not ancestor-hidden, non-empty rect. */
  visible(el: Element): boolean;
  /** Everything `visible` checks, plus the CSS-visible and pointer rules. */
  fullyVisible(el: Element): boolean;
  /** Instrumentation: what this pass actually cost. */
  readonly reads: { style: number; chainVisits: number; memoHits: number };
}

/**
 * The composed parent of `el`, or null at the top of its document.
 *
 * `assignedSlot` comes first because a node distributed into a slot is PAINTED
 * inside the slot, not inside its light-DOM parent: a control slotted into a
 * hidden `<slot>` wrapper is invisible even though its own parent is fine.
 */
export function composedParentOf(el: Element): Element | null {
  try {
    const slot = (el as Element & { assignedSlot?: HTMLSlotElement | null }).assignedSlot || null;
    if (slot) return slot;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode ? (el.getRootNode() as { host?: Element }) : null;
    return (root && root.host) || null;
  } catch (e) {
    return null;
  }
}

/**
 * The depth bound for the composed walk.
 *
 * 512 is the number the predicates it replaces used, and it is kept: a real page
 * is nowhere near it, and the only tree that reaches it is a malformed one (a
 * slot/parent cycle), which is exactly what it is for.
 */
const MAX_COMPOSED_DEPTH = 512;

function defaultStyleReader(el: Element): CSSStyleDeclaration {
  return getComputedStyle(el);
}

/**
 * A pass. Create one per collection/selection run and hand it to both, so the
 * two halves share everything they learn about the same document.
 */
export function createVisibilityPass(readStyle: StyleReader = defaultStyleReader): VisibilityPass {
  const ownHidden = new WeakMap<Element, boolean>();
  const ancestorHidden = new WeakMap<Element, boolean>();
  const ownOpaque = new WeakMap<Element, boolean>();
  const ancestorOpaque = new WeakMap<Element, boolean>();
  const styles = new WeakMap<Element, CSSStyleDeclaration | null>();
  const reads = { style: 0, chainVisits: 0, memoHits: 0 };

  function hiddenByAttribute(el: Element, hops = 0): boolean {
    const cached = ancestorHidden.get(el);
    if (cached !== undefined) {
      reads.memoHits++;
      return cached;
    }
    reads.chainVisits++;
    let own = ownHidden.get(el);
    if (own === undefined) {
      own = false;
      try {
        // `inert` is the one attribute that means "not available to anyone": it
        // makes the subtree neither clickable nor focusable, and no stylesheet
        // can undo that. `hidden` is NOT here — it is only the UA's default
        // display:none, which author CSS overrides routinely (see the interface
        // note above and docs/HINTS.md §10.1). A subtree the UA really is
        // hiding has no box, which `visible()` measures directly.
        //
        // `aria-hidden="true"` is NOT in this list (see hiddenByAttribute in the
        // interface above and docs/HINTS.md §10): it hides a node from assistive
        // technology, and pages put it on elements that are plainly visible and
        // clickable — a thumbnail link duplicated by a title link, an icon inside
        // a labelled button, a decorative overlay. Dropping every aria-hidden
        // candidate is what made YouTube's video thumbnails unhintable.
        own = el.hasAttribute("inert");
      } catch (e) {
        own = false;
      }
      ownHidden.set(el, own);
    }
    const parent = own || hops >= MAX_COMPOSED_DEPTH ? null : composedParentOf(el);
    const answer = own || (parent ? hiddenByAttribute(parent, hops + 1) : false);
    ancestorHidden.set(el, answer);
    return answer;
  }

  function opacityZero(el: Element, hops = 0): boolean {
    const cached = ancestorOpaque.get(el);
    if (cached !== undefined) {
      reads.memoHits++;
      return cached;
    }
    reads.chainVisits++;
    let own = ownOpaque.get(el);
    if (own === undefined) {
      const cs = styleOf(el);
      let op = 1;
      try {
        op = parseFloat(cs ? cs.opacity : "1");
      } catch (e) {
        op = 1;
      }
      own = op === 0;
      ownOpaque.set(el, own);
    }
    const parent = own || hops >= MAX_COMPOSED_DEPTH ? null : composedParentOf(el);
    const answer = own || (parent ? opacityZero(parent, hops + 1) : false);
    ancestorOpaque.set(el, answer);
    return answer;
  }

  function styleOf(el: Element): CSSStyleDeclaration | null {
    const cached = styles.get(el);
    if (cached !== undefined) {
      reads.memoHits++;
      return cached;
    }
    let cs: CSSStyleDeclaration | null = null;
    try {
      cs = readStyle(el);
    } catch (e) {
      cs = null;
    }
    reads.style++;
    styles.set(el, cs);
    return cs;
  }

  function visible(el: Element): boolean {
    if (!el || !el.isConnected) return false;
    try {
      if (el.hasAttribute("disabled")) return false;
      if (hiddenByAttribute(el)) return false;
    } catch (e) {
      // A hostile node must not prevent the rest of the checks.
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function fullyVisible(el: Element): boolean {
    if (!visible(el)) return false;
    // The platform's own "would a human see this?" predicate when available: it
    // accounts for display/visibility/content-visibility AND an opacity:0
    // ANCESTOR, which per-element computed style cannot see.
    const cv = el as unknown as { checkVisibility?: (opts?: object) => boolean };
    if (typeof cv.checkVisibility === "function") {
      let ok = true;
      try {
        ok = cv.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          contentVisibilityAuto: true,
        });
      } catch (e) {
        try {
          ok = cv.checkVisibility();
        } catch (e2) {
          ok = true;
        }
      }
      if (!ok) return false;
    } else {
      // Fallback for older engines: the element's own computed style.
      const cs = styleOf(el);
      if (!cs) return false;
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") {
        return false;
      }
      if (cs.opacity !== "" && parseFloat(cs.opacity) === 0) return false;
    }
    // Ancestor opacity: opacity is NOT inherited, so a child of an `opacity:0`
    // container computes to 1 while being fully invisible (checkVisibility's
    // opacity check is on the node itself). Cross composed ancestors too: CSS
    // opacity on a custom-element host applies to controls in its shadow tree.
    if (opacityZero(el)) return false;
    // checkVisibility does not cover pointer input; an element that opted out of
    // the pointer cannot be clicked. Focusable form controls are the exception.
    //
    // ONE READ, not an ancestor walk: `pointer-events` IS inherited, so the
    // element's own computed value already reflects every ancestor, and
    // inheritance crosses from a shadow host into its tree.
    const cs2 = styleOf(el);
    const pointer = cs2 ? cs2.pointerEvents : "";
    if (pointer === "none") {
      const tag = el.tagName;
      const focusable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
      if (!focusable) return false;
    }
    return true;
  }

  return {
    hiddenByAttribute,
    opacityZero,
    styleOf,
    visible,
    fullyVisible,
    reads,
  };
}

// ---------------------------------------------------------------------------
// The single-element entry points, for the callers that are not a pass.
//
// Called from the cold paths (the diagnostics page's per-row report, activation
// re-resolution) as well as from the hot pass, so they keep their shape: given
// no pass they build a ONE-SHOT one, which is exactly the cost they had before
// this module existed — no better, no worse, and no cache left behind.
// ---------------------------------------------------------------------------

export function basicVisible(el: Element, pass?: VisibilityPass): boolean {
  return (pass || createVisibilityPass()).visible(el);
}

export function hintVisible(el: Element, pass?: VisibilityPass): boolean {
  return (pass || createVisibilityPass()).fullyVisible(el);
}
