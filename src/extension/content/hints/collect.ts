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
import {
  COLLECT_DEFERRED_MAX,
  COLLECT_HARD_MS,
  COLLECT_PROBES,
  COLLECT_VIEWPORT_MARGIN,
  HINTABLE_SELECTOR,
  LEAF_MAX_AREA,
  LEAF_MAX_CHILDREN,
  LEAF_TEXT_HARD_MAX,
  LEAF_TEXT_SOFT_MAX,
  MAX_SCAN,
  MEDIA_SELECTOR,
  MEDIA_SURFACE_MIN_AREA,
  MEDIA_SURFACE_MIN_H,
  MEDIA_SURFACE_MIN_W,
  MEDIA_SURFACE_SELECTOR,
  SHADOW_DEPTH,
} from "./selectors";
import { createVisibilityPass, type VisibilityPass } from "./visibility";
import { shadowRootOf, walkElements } from "../../../shared/dom";

// The viewport's area, or 0 where there is no window (the unit tests drive this
// module with plain fakes, and a hostile frame must not turn a predicate into a
// throw).
function viewportArea(): number {
  try {
    return (window.innerWidth || 0) * (window.innerHeight || 0);
  } catch (e) {
    return 0;
  }
}

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
// `rect`, when the caller already measured the node, is the same box the probe
// would have read itself: collection reads it once for the viewport window and
// hands it on, which is what keeps the tier affordable enough to be deterministic
// (see COLLECT_PROBES in selectors.ts).
export function leafClickable(
  el: Element,
  pass?: VisibilityPass,
  rect?: DOMRect | null
): boolean {
  if (el === document.body || el === document.documentElement) return false;
  let children = 0;
  try {
    children = el.children.length;
  } catch (e) {
    return false;
  }
  // A control, not a container. The old bound was 3, which is a fact about a
  // hand-written <button>, not about the row-shaped controls frameworks build:
  // WhatsApp's chat row is avatar + title/preview + timestamp + actions, and the
  // fourth child alone made it un-hintable while its neighbours qualified. The
  // check that actually keeps containers out is the hintable-descendant test just
  // below (a wrapper around real controls is already excluded by it).
  if (children > LEAF_MAX_CHILDREN) return false;
  try {
    if (el.querySelector(HINTABLE_SELECTOR)) return false;
  } catch (e) {
    return false;
  }
  const r = rect || el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  // LONG TEXT IS ONLY A CONTAINER SIGNAL WHEN THE BOX IS BIG.
  //
  // `textContent` is the whole subtree's text, including anything the page
  // ellipsizes. A chat row showing one truncated line reports the entire last
  // message, so a 120-character cap silently removed exactly the rows whose last
  // message happened to be long — the reported "some of these are hinted and the
  // rest are not", on rows that are identical in every way that matters. Size is
  // the honest discriminator: the tall block this rule was written for cannot be
  // small, and a row cannot be big.
  const text = (el.textContent || "").trim();
  if (text.length > LEAF_TEXT_SOFT_MAX) {
    if (text.length > LEAF_TEXT_HARD_MAX) return false;
    const area = r.width * r.height;
    if (viewportArea() > 0 && area > viewportArea() * LEAF_MAX_AREA) return false;
  }
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
  /** Candidates that qualified only as a large media surface (see isLargeMediaSurface). */
  mediaSurfaces: number;
  /**
   * Some candidate was never probed, so the cursor:pointer / media-surface tier
   * is incomplete. The selector matches are still complete (the cheap tier and
   * the shadow recursion always run); `truncatedBy` says which bound was hit and
   * `probes`/`probeCap` say by how much.
   */
  truncated: boolean;
  /**
   * What stopped the expensive tier: `probes` is the normal, deterministic
   * budget; `time` is the emergency wall-clock stop (see COLLECT_HARD_MS) and
   * means this particular set may differ from another machine's; `deferred`
   * means more off-screen nodes were queued than the list may hold.
   */
  truncatedBy: "probes" | "time" | "deferred" | "scan" | null;
  /** Nodes the discovery walk visited, and the emergency stop it was given. */
  visited: number;
  budgetMs: number;
  /** Nodes the expensive tier actually probed, and the budget it was given. */
  probes: number;
  probeCap: number;
  /** Off-screen nodes held for the second phase (see COLLECT_DEFERRED_MAX). */
  deferred: number;
}

// Elements that are hintable ONLY because they wrap media (see the
// isOrHasMedia exemption in leafClickable). They are legitimate targets — a
// thumbnail with no text is still worth a key — but they must never suppress a
// real control inside them, because on a media-heavy page they are the biggest
// thing on screen. Tagging them here (where the exemption is applied) keeps the
// knowledge in one place instead of re-deriving it in the selection pass.
export const weakHintables = new WeakSet<Element>();

// Elements collected because they ARE a large media surface (see
// MEDIA_SURFACE_*): a player's video, whose only clickable behaviour is its own
// click handler and which carries no text, no role and no cursor:pointer to be
// collected by any other rule.
//
// A WeakSet for the same reason as weakHintables: the selection pass has to know
// how a candidate qualified, and re-deriving it there (a second rect read plus a
// second selector match per candidate) is how two answers to one question start
// to disagree.
export const mediaSurfaces = new WeakSet<Element>();

// Is this element a media surface big enough to be a primary part of the screen?
// The thresholds live in selectors.ts with the rest of the engine's limits.
export function isLargeMediaSurface(el: Element, rect?: DOMRect | null): boolean {
  try {
    if (!el.matches(MEDIA_SURFACE_SELECTOR)) return false;
    const r = rect || el.getBoundingClientRect();
    if (r.width < MEDIA_SURFACE_MIN_W || r.height < MEDIA_SURFACE_MIN_H) return false;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (vw <= 0 || vh <= 0) return false;
    return r.width * r.height >= MEDIA_SURFACE_MIN_AREA * vw * vh;
  } catch (e) {
    return false;
  }
}

// Was this candidate collected AS a media surface? Used by the selection pass,
// where it means "this is a different action from a control drawn over it".
export function isMediaSurface(el: Element): boolean {
  return mediaSurfaces.has(el);
}

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
  // A large media surface is a real action (clicking the video toggles it) but
  // it is not a named control, so it sits below any link or ARIA widget that
  // wraps or labels it — a thumbnail LINK must still win over the video inside
  // it, while the surface stays in the batch on its own when nothing does.
  if (mediaSurfaces.has(el)) return 2;
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

// THE TWO BOUNDS ON THE EXPENSIVE TIER, and why the primary one is a count.
//
// It used to be a single wall-clock budget (`COLLECT_BUDGET_MS = 12`): the walk
// probed nodes until twelve milliseconds had passed, then went quiet. That made
// the candidate set a function of the machine — the same page could hint a row
// on one press and lose it on the next, and a slower machine lost a different
// tail than a faster one. The budget is now the NUMBER OF NODES PROBED
// (`COLLECT_PROBES`), so a given page stops at the same node every time; the
// clock survives only as the emergency stop (`COLLECT_HARD_MS`), and when it
// trips the stats say `truncatedBy: "time"` rather than pretending that was the
// budget.
//
// The second bound is the VIEWPORT WINDOW. Probing is spent on what the user can
// see first (plus one viewport of margin), and only then on the off-screen tail,
// so the controls the labels can actually reach are never the ones a long
// document starves. See COLLECT_PROBES and COLLECT_VIEWPORT_MARGIN in
// selectors.ts.

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
 *
 * THE WALK IS TIERED, AND THE EXPENSIVE TIER IS ORDERED BY WHAT IS ON SCREEN.
 *
 * Every node pays the cheap tier: shadow-root discovery and (per root) one
 * HINTABLE_SELECTOR query. Those are what make a custom element's controls
 * findable at all, they cost almost nothing, and they always finish — a spent
 * budget has never meant "the walk is over" since the tiering landed.
 *
 * The expensive tier is the two probes that need real reads: is this a large
 * media surface, is this a bare `cursor:pointer` control. Its bound is the
 * NUMBER OF NODES PROBED, not a wall clock (see COLLECT_PROBES), because a clock
 * makes the candidate set depend on the machine: the same page hinted a row on
 * one press and lost it on the next. On a given page this pass stops at the same
 * node, on every machine, every time.
 *
 * And it spends that budget in VIEWPORT ORDER: nodes inside the viewport (plus
 * one viewport of margin) are probed during the walk, and nodes outside it are
 * deferred to a second phase that runs only with the budget the viewport did not
 * need. Labels can only exist for controls the user can see, so document order
 * was the wrong order to starve — that is how a header nobody was looking at
 * took the keys from the rows on screen.
 *
 * `truncated`/`truncatedBy` report which bound was hit when the tier did not
 * finish: the probe count (normal), the wall-clock emergency (reported, never
 * the budget), an over-full deferral list, or MAX_SCAN on the cheap tier. An
 * identical page therefore produces an identical candidate set, and a pass that
 * is incomplete says so instead of quietly returning less.
 */
export function collectHintables(stats?: CollectStats, pass?: VisibilityPass): Element[] {
  const vis = pass || createVisibilityPass();
  const out: Element[] = [];
  const seen = new Set<Element>();
  const probeCap = stats ? stats.probeCap || COLLECT_PROBES : COLLECT_PROBES;
  const hardMs = stats ? stats.budgetMs || COLLECT_HARD_MS : COLLECT_HARD_MS;
  const hardDeadline = nowMs() + hardMs;
  let visited = 0;
  let probes = 0;
  let truncated = false;
  let truncatedBy: CollectStats["truncatedBy"] = null;
  // The expensive tier is done. The cheap tier — the per-root selector query and
  // shadow-root discovery — keeps running: it is what makes a late custom
  // element's controls findable at all, and it costs one property read per node.
  let expired = false;
  // The cheap tier stopped too, which only the wall-clock EMERGENCY may do: a
  // spent probe budget must not take shadow discovery down with it, because that
  // is how a custom element late in the document lost its controls entirely.
  let halt = false;
  // Off-screen nodes, held for the second phase of this same pass.
  const deferred: Element[] = [];
  let vw = 0;
  let vh = 0;
  try {
    vw = window.innerWidth || 0;
    vh = window.innerHeight || 0;
  } catch (e) {
    vw = 0;
    vh = 0;
  }

  function add(el: Element): void {
    if (seen.has(el) || !vis.visible(el)) return;
    seen.add(el);
    out.push(el);
  }

  // Record the first reason the expensive tier stopped. Later stops are the
  // consequence of the first (the cap is reached, then every later node is
  // refused) and must not overwrite it.
  function stop(why: "probes" | "time" | "deferred" | "scan"): void {
    if (!truncated) {
      truncated = true;
      truncatedBy = why;
    }
    // Only the probe count and the emergency stop end the expensive tier. A full
    // deferral list or a root that hit MAX_SCAN means SOME nodes were not seen;
    // it is not a reason to stop probing the nodes the walk still reaches.
    if (why === "probes" || why === "time") expired = true;
    if (why === "time") halt = true;
  }

  // One probe: the two questions only an expensive read can answer — "is this a
  // large media surface" and "is this a bare cursor:pointer control". `rect` is
  // the box the window test above already measured, so a probe never reads the
  // layout twice.
  function probe(el: Element, rect: DOMRect | null): void {
    if (seen.has(el)) return;
    if (probes >= probeCap) {
      stop("probes");
      return;
    }
    probes++;
    // Added BEFORE the cursor:pointer test so the two can never both claim one
    // element (the order also decides which tag an element wears when it
    // qualifies as both).
    if (isLargeMediaSurface(el, rect)) {
      if (stats) stats.mediaSurfaces++;
      mediaSurfaces.add(el);
      add(el);
    }
    if (!seen.has(el) && leafClickable(el, vis, rect)) {
      if (stats) stats.pointerControls++;
      // leafClickable's media exemption is what makes an unlabelled wrapper
      // hintable at all; record that this candidate qualified on that basis so
      // the nesting pass can prefer a real control inside it.
      if (isMediaOnlyWrapper(el)) weakHintables.add(el);
      add(el);
    }
  }

  // Inside the viewport (plus one viewport of margin): the controls the user can
  // be looking at. Without a measurable viewport — the unit fakes — everything is
  // in the window, which is the behaviour those callers were written against.
  function inWindow(r: DOMRect): boolean {
    if (vw <= 0 || vh <= 0) return true;
    const mx = vw * COLLECT_VIEWPORT_MARGIN;
    const my = vh * COLLECT_VIEWPORT_MARGIN;
    return r.bottom > -my && r.top < vh + my && r.right > -mx && r.left < vw + mx;
  }

  // The rect the gate and the probes share, or null when the node refuses one
  // (a hostile getter must not end the pass).
  function rectOf(el: Element): DOMRect | null {
    try {
      return el.getBoundingClientRect();
    } catch (e) {
      return null;
    }
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
    // NOTE: depth is the only gate left on this branch. `truncated` used to be
    // one too, and it is exactly the failure this structure exists to remove: a
    // page whose budget ran out before the walk reached this root used to
    // return here BEFORE the root's selector query could run, so the buttons
    // inside the root were lost entirely. Depth is the gate that remains;
    // truncation is the expensive tier's condition, and it must not silence a
    // query that costs nothing.
    if (depth >= SHADOW_DEPTH) return;
    // NOTE: the shadow recursion below happens INSIDE the discovery walk, not
    // after it, because that is the order the engine has always produced: a
    // custom element's inner controls are appended where the host appears, so a
    // host's controls keep the position of the host in the key order.
    // The discovery walk: shadow roots (which the selector query cannot see) and
    // the cursor:pointer pass. Lazily walked, so MAX_SCAN bounds the loop rather
    // than the allocation. The walk is tiered: the probe budget (a COUNT — see
    // COLLECT_PROBES) bounds the expensive work, this cap bounds the cheap
    // discovery so a huge light DOM cannot crowd out a late custom element.
    const result = walkElements(root, MAX_SCAN, (el) => {
      // The emergency stop, checked every 1024 nodes. It is the only wall-clock
      // decision left in the pass and it exists for a page whose per-node cost is
      // pathological; when it fires the stats say so (truncatedBy: "time") rather
      // than letting the clock quietly pass for the budget.
      if (!halt && visited > 0 && (visited & 1023) === 0 && nowMs() > hardDeadline) {
        stop("time");
      }
      if (halt) return false;
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
      //
      // The recursion is the CHEAP tier, above the budget: it is what makes
      // `walk(sr, depth + 1)` — and therefore the root's own selector query —
      // run even after the probes are spent.
      const sr = shadowRootOf(el);
      if (sr) {
        if (stats) stats.shadowRoots++;
        walk(sr, depth + 1);
      }
      if (expired || seen.has(el)) return;
      // THE VIEWPORT GATE. A control two screens away is worth a probe only
      // after everything the user can see has had one: labels can only exist for
      // what is on screen, so spending the budget in document order is how the
      // rows in view lost their keys to a header nobody was looking at. Nodes
      // outside the window are remembered for phase 2, in document order, and
      // probed with whatever budget the viewport did not need.
      const r = rectOf(el);
      if (r && !inWindow(r)) {
        if (deferred.length < COLLECT_DEFERRED_MAX) deferred.push(el);
        else stop("deferred");
        return;
      }
      probe(el, r);
    });
    // MAX_SCAN: the cheap tier itself did not reach the end of this root. The
    // selector matches above are what this root had; anything inside an
    // undiscovered shadow root is lost, which is a different bound from the
    // probe budget and is reported as such.
    if (result.truncated) stop("scan");
  }

  if (stats) {
    stats.truncated = false;
    stats.truncatedBy = null;
    stats.visited = 0;
    stats.budgetMs = hardMs;
    stats.probes = 0;
    stats.probeCap = probeCap;
    stats.deferred = 0;
    stats.mediaSurfaces = 0;
    stats.pointerControls = 0;
    stats.shadowRoots = 0;
  }
  walk(document, 0);
  // ---- phase 2: the off-screen tail ---------------------------------------
  // Probed only with the budget the viewport did not spend, and in document
  // order. This is what keeps the pool useful for scrolling: a control that was
  // below the fold at `;f` time is usually already in it, so scrolling to it does
  // not have to wait for the next re-collect.
  for (let i = 0; i < deferred.length && !expired; i++) {
    const el = deferred[i]!;
    if (seen.has(el)) continue;
    probe(el, rectOf(el));
  }
  if (stats) {
    stats.truncated = truncated;
    stats.truncatedBy = truncatedBy;
    stats.visited = visited;
    stats.probes = probes;
    stats.deferred = deferred.length;
  }
  return out;
}
