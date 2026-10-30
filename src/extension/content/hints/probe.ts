// Everything the engine asks about a single element: is it visible, is it in
// the viewport, how much of it is actually on screen, what is it called.
//
// These are the predicates that decide whether a control is offered at all, and
// they are the hardest part of the engine to get right: each one encodes a
// browser behaviour that is easy to get subtly wrong (an opacity:0 ANCESTOR is
// invisible but computes to 1; pointer-events IS inherited; a closed shadow
// root is unreachable by construction).
//
// WHY OCCLUSION IS A SHARE AND NOT A BOOLEAN.
//
// It used to be `reachable()`: five hit tests, and if ONE of them landed on the
// control it counted as visible. That answered the wrong question in both
// directions:
//
//   * a control with one free corner under a dialog counted as visible, so its
//     label was drawn at the control's corner — ON TOP of the dialog, because
//     labels live in the top layer. That is the report "hints show from behind
//     the elements in front of them";
//   * a control with nothing free was kept anyway and drawn at 55% opacity,
//     so a page with two stacked layers of content ("folded on itself") showed
//     a ghost batch of faint labels for the layer underneath. That is the
//     report "I still see faint hints caused by one layer on top of the other".
//
// Neither is a hit-testing bug: both are what a boolean cannot say. A control
// is on the user's surface by a DEGREE, and the degree has two consequences —
// how much of it must be visible for a label to be honest, and WHERE that label
// may be painted. `coverageOf` answers both from one sampled grid: the share of
// the control's own pixels the pointer can reach, the first foreign element
// over the rest, whether the control is the topmost thing at its own centre
// (the duplicate rules need that), and the fraction of the box where the label
// belongs (the overlay needs that).
//
// It is one pass over a 3x3 grid with the control's own top-left as the first
// sample, so a fully visible control keeps the exact placement it has always
// had, and every read is wrapped — a hostile element answers "covered" rather
// than ending the hint pass.
import { shadowRootOf } from "../../../shared/dom";
import { MIN_VISIBLE_SHARE, SHADOW_DEPTH } from "./selectors";
// Composed containment is what a click's retargeting follows, and it is the
// only containment that can see across a shadow boundary (see visibility.ts).
import { composedContains, composedParentOf } from "./visibility";
export {
  basicVisible,
  hintVisible,
  composedContains,
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
// fail the coverage test and `;f` would still act as if those controls did
// not exist. Keep discovery, coverage and activation on the same door.
export function deepHit(x: number, y: number): Element | null {
  let el: Element | null = null;
  try {
    // Native hit testing already excludes pointer-transparent UI, and unlike
    // elementsFromPoint it reports the actual target chosen by the browser.
    // Avoid hiding our popover host: changing display on an open top-layer
    // element can invalidate Firefox's hit-test state for the rest of the pass.
    el = document.elementFromPoint(x, y);
  } catch {
    el = null;
  }
  if (el && isHintOverlayElement(el)) el = null;
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

/**
 * What a control's own surface looks like from the pointer's side.
 *
 * `own` is the number of sampled points that hit the control or a composed
 * descendant of it, `total` how many points could be sampled inside the viewport,
 * and `cover` the first foreign element found. `top` says the control is the
 * topmost thing at its own centre — the question the duplicate rules ask, because
 * a control the pointer can press at its centre is its own click surface even
 * when a bigger clickable box happens to overlap it.
 *
 * `ux`/`uy` are the fraction of the control's box the label should be anchored
 * at: the first sampled point that is the control's own. A fully visible control
 * answers (0, 0), which is exactly the top-left placement the overlay has always
 * used; a control with a sticky header over its top answers a point below the
 * header, so the label is never painted on the thing covering it.
 */
export interface Coverage {
  total: number;
  own: number;
  cover: Element | null;
  top: boolean;
  ux: number;
  uy: number;
}

const NO_COVERAGE: Coverage = { total: 0, own: 0, cover: null, top: false, ux: 0, uy: 0 };

/**
 * Per-`coverageOf` cost counters. Diagnostics only: the dev snapshot reads this
 * to answer "which half of coverage is slow" with numbers instead of a guess.
 * Accumulation, not a reset — the caller that wants a per-pass answer zeroes it
 * first (selectHintables does, only when it drives the real probe).
 */
export const coverageBench = {
  /** Time spent in the composed-ancestor clip walk (style reads + geometry). */
  clipMs: 0,
  /** Time spent hit-testing samples (deepHit + the layer scan). */
  sampleMs: 0,
  /** Sample points evaluated in total. */
  samples: 0,
};

/**
 * Does `hit` belong to `el`'s own surface?
 *
 * A composed descendant is the control painted from inside its shadow root.
 * So is an ANCESTOR hit that is the press target a real click here would bubble
 * to — the pixels are still the candidate's and nothing paints over them. That
 * is why a video inside a clickable player shell keeps its top-left anchor
 * instead of being nudged inward: the corner samples answer the player wrapper,
 * and the wrapper is exactly where those clicks go.
 *
 * The genuine not-own cases keep their decision: a sibling overlay paints over
 * the pixels (the hit is neither descendant nor ancestor), and a clipped point
 * lands outside the drawn control, so the walk reports a container that does not
 * contain `el` — a scroller or the body surface. Ancestors are tested ONLY over
 * the pixels the grid actually samples; a hit elsewhere says nothing about those
 * pixels and stays "not own".
 */
export function ownSurface(el: Element, hit: Element | null): boolean {
  if (!hit) return false;
  try {
    if (hit === el || composedContains(el, hit)) return true;
    return composedContains(hit, el);
  } catch {
    return false;
  }
}

// A small deterministic set avoids pretending sparse point samples are an
// accurate measurement of visible *area*. It probes the center plus inset
// corners; we never use a percentage to admit a target behind another layer.
const GRID = [0.12, 0.5, 0.88];

/**
 * The sample coordinates along one axis: the control's own edge, its middle and
 * its far edge, each clamped into the viewport and inset by a pixel so a point
 * never lands exactly on the boundary (where hit-testing is undefined).
 *
 * Points closer than 1.5px are collapsed: a 14px-tall link would otherwise be
 * sampled nine times at two distinct rows and report the same pixel as "covered"
 * once and "visible" once, which is how a share stops meaning anything.
 */
function axisPoints(start: number, size: number, limit: number): number[] {
  const lo = Math.max(0, start);
  const hi = Math.min(limit - 1, start + size);
  if (!(hi >= lo)) return [];
  const inset = size >= 4 ? 1 : 0;
  const out: number[] = [];
  for (const f of GRID) {
    const v = Math.min(hi, Math.max(lo, start + inset + (size - 2 * inset) * f));
    if (!out.some((q) => Math.abs(q - v) < 1.5)) out.push(v);
  }
  return out;
}

function intersectRect(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
): { left: number; top: number; right: number; bottom: number } | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

// A candidate can have a perfectly good point hit while being entirely clipped
// by an ancestor (overflow:hidden/clip, paint containment, content-visibility).
// Intersect the candidate with every composed ancestor's clipping rectangle
// before sampling; include scrollports and shadow hosts.
function visibleRect(el: Element, viewport: { width: number; height: number }): {
  left: number; top: number; right: number; bottom: number;
} | null {
  const r = el.getBoundingClientRect();
  const out = intersectRect(r, { left: 0, top: 0, right: viewport.width, bottom: viewport.height });
  if (!out) return null;
  let clipped = out;
  // BODY'S OVERFLOW BELONGS TO THE VIEWPORT, NOT TO BODY (CSS overflow spec,
  // propagation): a page may declare `overflow: scroll` on its BODY (YouTube,
  // WhatsApp and many SPA shells do) while leaving BODY height 0 and doing the
  // real layout in absolutely-positioned children. The declared value moves to
  // the viewport, BODY itself establishes NO scroll container — and treating it
  // as one clips every control against a 0px-tall client box. The whole page
  // then answered "behind a dialog or overlay" with coverage 0/0, which is how
  // a working hint engine goes silent exactly on the sites that use this.
  const docEl = document.documentElement;
  let bodyPropagates = document.body !== null;
  try {
    const docStyle = docEl ? styleOf(docEl) : null;
    if (docStyle) {
      const dx = docStyle.overflowX || docStyle.overflow || "visible";
      const dy = docStyle.overflowY || docStyle.overflow || "visible";
      // Propagation happens only while the ROOT does not already claim its own
      // scrolling values.
      bodyPropagates = document.body !== null && dx === "visible" && dy === "visible";
    }
  } catch {
    bodyPropagates = document.body !== null;
  }
  let cur: Element | null = null;
  let hops = 0;
  const clipT0 = nowMs();
  try {
    cur = composedParentOf(el);
    for (; cur && hops < 512; hops++, cur = composedParentOf(cur)) {
    try {
      const cs = styleOf(cur);
      if (!cs) return null;
      // The propagated body: its overflow values are the viewport's and its own
      // clip box is not one — skip it.
      const isPropagatedBody = bodyPropagates && cur === document.body;
      const clipX = !isPropagatedBody && /^(hidden|clip|scroll|auto)$/.test(cs.overflowX || cs.overflow || "visible");
      const clipY = !isPropagatedBody && /^(hidden|clip|scroll|auto)$/.test(cs.overflowY || cs.overflow || "visible");
      const contain = (cs.contain || "").split(/\s+/);
      const paint = contain.includes("paint") || contain.includes("strict") || contain.includes("content");
      if (cs.contentVisibility === "hidden") return null;
      if (clipX || clipY || paint) {
        const cr = cur.getBoundingClientRect();
        const clientLeft = (cur as HTMLElement).clientLeft || 0;
        const clientTop = (cur as HTMLElement).clientTop || 0;
        const clientWidth = (cur as HTMLElement).clientWidth || cr.width;
        const clientHeight = (cur as HTMLElement).clientHeight || cr.height;
        const rect = intersectRect(clipped, {
          left: clipX || paint ? cr.left + clientLeft : clipped.left,
          right: clipX || paint ? cr.left + clientLeft + clientWidth : clipped.right,
          top: clipY || paint ? cr.top + clientTop : clipped.top,
          bottom: clipY || paint ? cr.top + clientTop + clientHeight : clipped.bottom,
        });
        if (!rect) return null;
        clipped = rect;
      }
    } catch {
      return null;
    }
    }
  } finally {
    coverageBench.clipMs += nowMs() - clipT0;
  }
  return clipped;
}

/**
 * One pointer-transparent layer that can genuinely HIDE a control.
 *
 * `area` is the layer's box size, kept because the scan already had to read the
 * rect to size it and the selection pass wants the largest layers first.
 */
interface PointerTransparentLayer {
  el: Element;
  area: number;
  /** The box the scan measured, so candidates check geometry instead of re-reading layout. */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// How long one OCCLUDER SCAN answers for. The scan is the expensive half of the
// coverage probe (one style read per element in the document), while its answer
// — "which pointer-transparent layers paint something opaque" — changes only
// when the page mounts or unmounts an overlay. Most pages have none at all, and
// the ones that do mount them on interaction, which is exactly when the next
// batch re-scans. Long enough that a page full of candidates pays for one scan.
const OCCLUDER_TTL_MS = 750;

// A layer list is bounded because every candidate pays a geometric test against
// it. A page with hundreds of click-through layers is a page with a decorative
// shader, not a page with hundreds of veils; the largest are the ones that can
// hide anything.
const MAX_OCCLUDING_LAYERS = 48;

let pointerTransparentCache: { doc: Document; at: number; layers: PointerTransparentLayer[] } | null = null;

// THE SCAN IS FED BY COLLECT WHEN IT CAN BE.
//
// The full scan walks every element in the document a SECOND time (after
// collect's) to ask which pointer-transparent nodes paint something opaque —
// ~100ms on an article-long page, paid by the first coverage call. Collect's
// walk already visits every element (and reads its rect for the viewport
// gate), so it can answer the same question as a side effect almost for free:
// feedOccluder is called per visited on-screen node, finishOccluderFeed
// records whether the walk was complete, and pointerTransparentLayers uses the
// fed list instead of scanning whenever it is fresh and complete. Callers that
// never feed (the unit tests, the diagnostics page) still get the real scan.
let occluderFeed: { doc: Document; at: number; complete: boolean; pending: PointerTransparentLayer[] } | null = null;

/** Start a fed scan: clears whatever a previous collect left. */
export function beginOccluderFeed(): void {
  occluderFeed = { doc: document, at: nowMs(), complete: false, pending: [] };
}

/**
 * One candidate from a document walk. Skips what the standalone scan skips:
 * empty boxes, off-screen boxes, pointer-bearing nodes, non-painting veils.
 * `cs` is the style the caller already resolved (collect's visibility pass
 * caches them); when absent the feed resolves its own.
 */
export function feedOccluder(el: Element, rect: DOMRect, cs?: CSSStyleDeclaration): void {
  if (!occluderFeed || occluderFeed.doc !== document) return;
  if (!(rect.width > 0) || !(rect.height > 0)) return;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  if (vw > 0 && vh > 0 &&
      (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh)) {
    return;
  }
  let style = cs;
  if (!style) {
    const got = styleOf(el);
    if (!got) return;
    style = got;
  }
  if (style.pointerEvents !== "none") return;
  if (!opaquePaint(style)) return;
  if (!elementDrawn(el)) return;
  if (isHintOverlayElement(el)) return;
  occluderFeed.pending.push({
    el,
    area: rect.width * rect.height,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
}

/** End the fed scan. `complete` is false when the walk was cut short (halt);
 * an incomplete feed is thrown away and the next read falls back to the scan. */
export function finishOccluderFeed(complete: boolean): void {
  if (!occluderFeed || occluderFeed.doc !== document) return;
  occluderFeed.complete = complete;
  occluderFeed.at = nowMs();
}

function nowMs(): number {
  try {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * `getComputedStyle` returns a LIVE declaration, so memoising the OBJECT is
 * always correct — the values are resolved when they are read. It removes one
 * style resolution per element per composed ancestor, which the clip walk and
 * the occluder scan both pay repeatedly.
 */
const liveStyles = new WeakMap<Element, CSSStyleDeclaration>();

function styleOf(el: Element): CSSStyleDeclaration | null {
  const cached = liveStyles.get(el);
  if (cached) return cached;
  let cs: CSSStyleDeclaration | null = null;
  try {
    cs = getComputedStyle(el);
  } catch {
    return null;
  }
  liveStyles.set(el, cs);
  return cs;
}

/**
 * The extension's own surfaces (labels, leader, popups) are painted above the
 * page by design. They must never be read as page occluders — a first batch
 * would otherwise make every later coverage check report the page as covered.
 *
 * `closest` rather than a composed walk: this runs once per element in the
 * document, and the ancestor walk it replaces made the scan O(nodes × depth).
 */
function isHintOverlayElement(el: Element): boolean {
  try {
    return !!el.closest(
      "#lazyfox-hints, #lazyfox-leader, #lazyfox-page-leader, #lazyfox-popup, #lazyfox-toast",
    );
  } catch {
    return false;
  }
}

/**
 * Is this element actually drawn — not display:none, not visibility:hidden, and
 * not inside an opacity:0 subtree?
 *
 * `checkVisibility` answers the opacity question inside the engine. The loop
 * this replaces multiplied `opacity` up the composed ancestor chain with a
 * `getComputedStyle` per hop, FOR EVERY ELEMENT IN THE DOCUMENT: on a
 * framework dashboard that is hundreds of thousands of style resolutions per
 * hint pass, which is the reported slowness.
 */
function elementDrawn(el: Element): boolean {
  const cv = el as Element & { checkVisibility?: (opts?: object) => boolean };
  if (typeof cv.checkVisibility === "function") {
    try {
      return !!cv.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch {
      // Fall through to the property floor.
    }
  }
  const cs = styleOf(el);
  if (!cs) return false;
  if (cs.display === "none" || cs.visibility !== "visible") return false;
  return Number.parseFloat(cs.opacity || "1") !== 0;
}

/**
 * Does this layer paint enough to HIDE what is under it?
 *
 * ONE rule, and it is deliberately about a nearly solid background COLOUR
 * (>= 0.8): that is a veil you see instead of the page, which is the shape this
 * check exists for (a sheet, a scrim, a full-frame panel).
 *
 * Everything else is excluded on purpose:
 *
 *   * a translucent wash (0.3–0.6 white/grey) — a shimmer, a tinted overlay —
 *     still lets the page read through. Counting it as a veil rejected EVERY
 *     control on the page: measured at 200 links, zero labels, and the user's
 *     report is exactly "hints don't show";
 *   * a background IMAGE of any kind. A repeating SVG grain tile, a noise
 *     texture and a decorative pattern are all `url(...)`, and every one of
 *     them used to count as an opaque sheet — a full-viewport texture alone was
 *     enough to silence a whole page. Nothing here can tell a 5%-opacity tile
 *     from a photo, so the rule does not pretend to;
 *   * gradients, whose alpha cannot be read from the computed value at all.
 *
 * A real photo/panel overlay is a normal element with `pointer-events:auto`
 * (an `<img>`, a div with a background image and a click handler), and native
 * hit testing already reports it — this predicate only needs the click-through
 * case, and the click-through case that hides anything is a solid fill.
 */
function opaquePaint(cs: CSSStyleDeclaration): boolean {
  return alphaOf(cs.backgroundColor) >= 0.8;
}

function alphaOf(color: string): number {
  if (!color || color === "transparent") return 0;
  const open = color.indexOf("(");
  const close = color.lastIndexOf(")");
  if (open < 0 || close <= open) return 1;
  const body = color.slice(open + 1, close);
  const parts = body.split(/[\s,\/]+/).filter(Boolean);
  const alphaPart = body.includes("/") ? parts[3] : color.startsWith("rgba") && parts.length === 4 ? parts[3] : null;
  if (alphaPart !== null && alphaPart !== undefined) {
    const alpha = Number.parseFloat(alphaPart) / (alphaPart.endsWith("%") ? 100 : 1);
    return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  }
  return 1;
}

function pointerTransparentLayers(): PointerTransparentLayer[] {
  const at = nowMs();
  if (pointerTransparentCache && pointerTransparentCache.doc === document && at - pointerTransparentCache.at < OCCLUDER_TTL_MS) {
    return pointerTransparentCache.layers;
  }
  // A fresh, completed collect has already walked the whole document: use its
  // side-effect answer instead of walking again. Same cache contract as the
  // scan (document, TTL, largest first, bounded).
  if (occluderFeed && occluderFeed.doc === document && occluderFeed.complete && at - occluderFeed.at < OCCLUDER_TTL_MS) {
    occluderFeed.pending.sort((a, b) => b.area - a.area);
    const bounded =
      occluderFeed.pending.length > MAX_OCCLUDING_LAYERS
        ? occluderFeed.pending.slice(0, MAX_OCCLUDING_LAYERS)
        : occluderFeed.pending;
    pointerTransparentCache = { doc: document, at: occluderFeed.at, layers: bounded };
    return bounded;
  }
  const layers: PointerTransparentLayer[] = [];
  const roots: Array<Document | ShadowRoot> = [document];
  const seenRoots = new Set<Document | ShadowRoot>(roots);
  for (let i = 0; i < roots.length; i++) {
    let all: NodeListOf<Element>;
    try {
      all = roots[i]!.querySelectorAll("*");
    } catch {
      continue;
    }
    // Indexed, not `for…of`: a NodeList is only iterable under DOM.Iterable,
    // and this file is type-checked against the plain DOM lib.
    for (let j = 0; j < all.length; j++) {
      const el = all[j]!;
      try {
        // Ignore the whole extension-owned overlay, including its closed shadow
        // tree. It paints above the page by design and is not an occluder.
        if (isHintOverlayElement(el)) continue;
        const shadow = shadowRootOf(el);
        if (shadow && !seenRoots.has(shadow)) {
          seenRoots.add(shadow);
          roots.push(shadow);
        }
        // CHEAPEST TEST FIRST — and the cheapest is geometry, not style. The
        // scan used to read getComputedStyle for EVERY element in the document
        // to ask "pointer-events: none?": on an article-long page that is a
        // six-figure style resolution count and the reported 110ms one-off on
        // the first coverage call. A rect does not resolve style; everything
        // OFF-SCREEN (or empty) is read first and skipped without a style read,
        // because a veil outside the viewport cannot hide anything the user is
        // looking at. Only on-screen sizes pay the style read, which the bulk of
        // a scrolled page never does.
        let rect: DOMRect;
        try {
          rect = el.getBoundingClientRect();
        } catch {
          continue;
        }
        if (!(rect.width > 0) || !(rect.height > 0)) continue;
        let vw2 = window.innerWidth || 0;
        let vh2 = window.innerHeight || 0;
        if (vw2 > 0 && vh2 > 0 &&
            (rect.right < 0 || rect.bottom < 0 || rect.left > vw2 || rect.top > vh2)) {
          continue;
        }
        // pointer-events is what makes a layer invisible to hit testing at all;
        // almost every element fails here, so this read is the real per-node cost
        // the shrink above is buying.
        const cs = styleOf(el);
        if (!cs) continue;
        if (cs.pointerEvents !== "none") continue;
        const area = rect.width * rect.height;
        if (!opaquePaint(cs)) continue;
        if (!elementDrawn(el)) continue;
        layers.push({ el, area, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      } catch {
        // A hostile node is simply not considered as an occluding layer.
      }
    }
  }
  // Largest first: the ones that can hide a control, and the first the
  // per-candidate pass should spend its single paint-order test on.
  layers.sort((a, b) => b.area - a.area);
  const bounded = layers.length > MAX_OCCLUDING_LAYERS ? layers.slice(0, MAX_OCCLUDING_LAYERS) : layers;
  pointerTransparentCache = { doc: document, at: at, layers: bounded };
  return bounded;
}

/**
 * Is `layer` painted ABOVE `el` at (x, y)?
 *
 * Native hit testing ignores pointer-events:none, so this is the one question
 * it cannot answer: enable the layer's pointer surface, read the real paint
 * order, and restore its exact inline declaration synchronously. Unlike
 * enabling every layer, this cannot promote ancestors or the target itself in
 * the stack and then mistake them for an occluder.
 *
 * ONE call decides the whole candidate — a veil's stacking is a property of the
 * two elements, not of the pixel — which is why this is asked once per layer
 * that geometrically lands on a sample, not once per sample. Asking per sample
 * is what made a veiled page take five seconds to produce nothing (see
 * coverageOf).
 */
function paintsAbove(layer: Element, x: number, y: number): boolean {
  const style = (layer as HTMLElement).style;
  if (!style) return false;
  let topmost: Element | null = null;
  try {
    const value = style.getPropertyValue("pointer-events");
    const priority = style.getPropertyPriority("pointer-events");
    style.setProperty("pointer-events", "auto", "important");
    try {
      // `elementFromPoint`, NOT `elementsFromPoint`: the question is only "is
      // the layer the thing on top here", and the topmost hit is the cheap
      // half of the hit test. Building the whole stack per candidate measured
      // at 10ms on a link-dense page, which is seconds of nothing on a page
      // where the layer hides everything.
      topmost = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    } finally {
      if (value) style.setProperty("pointer-events", value, priority);
      else style.removeProperty("pointer-events");
    }
  } catch {
    // If the style/hit-test surface is hostile, preserve the native answer.
    return false;
  }
  return !!topmost && (topmost === layer || composedContains(layer, topmost));
}

/**
 * How much of `el` is on the page's visible surface, and where its label belongs.
 *
 * Up to 9 hit tests on a fully visible control (fewer on a tiny one, where
 * the grid collapses), and none of them throws: a page that refuses hit-testing
 * answers "covered", which keeps the label off a surface nobody can see rather
 * than painting it blind.
 */
export function coverageOf(el: Element): Coverage {
  let r: DOMRect;
  try {
    r = el.getBoundingClientRect();
  } catch (e) {
    return NO_COVERAGE;
  }
  if (!(r.width > 0) || !(r.height > 0)) return NO_COVERAGE;
  let vw = 0;
  let vh = 0;
  try {
    vw = window.innerWidth || document.documentElement.clientWidth || 0;
    vh = window.innerHeight || document.documentElement.clientHeight || 0;
  } catch (e) {
    vw = 0;
    vh = 0;
  }
  // No measurable viewport (the unit fakes, a hostile frame): there is nothing
  // to be covered BY, so the control is its own surface.
  if (vw <= 0 || vh <= 0) return { total: 1, own: 1, cover: null, top: true, ux: 0, uy: 0 };

  const clipped = visibleRect(el, { width: vw, height: vh });
  if (!clipped) return NO_COVERAGE;
  // Sample the whole in-viewport box, not only its clipped remainder. Otherwise
  // a 2px sliver inside a 40px overflow-hidden crop becomes 100% "visible".
  const sample = intersectRect(r, { left: 0, top: 0, right: vw, bottom: vh });
  if (!sample) return NO_COVERAGE;
  const xs = axisPoints(sample.left, sample.right - sample.left, vw);
  const ys = axisPoints(sample.top, sample.bottom - sample.top, vh);
  if (!xs.length || !ys.length) return NO_COVERAGE;

  const total = xs.length * ys.length;
  const sampleArea = sample.right > sample.left && sample.bottom > sample.top
    ? (sample.right - sample.left) * (sample.bottom - sample.top)
    : 0;
  const clippedArea = (clipped.right - clipped.left) * (clipped.bottom - clipped.top);
  const clipShare = sampleArea > 0 ? Math.max(0, Math.min(1, clippedArea / sampleArea)) : 0;
  let ownHits = 0;
  let cover: Element | null = null;
  let anchorX = -1;
  let anchorY = -1;
  const midX = xs[Math.floor(xs.length / 2)]!;
  const midY = ys[Math.floor(ys.length / 2)]!;
  let top = false;

  // PAINTED-BUT-CLICK-THROUGH LAYERS (`pointer-events:none`). Native hit testing
  // cannot see them, so a scrim would otherwise report every sample as the
  // control's own and a label would be drawn on the scrim. Resolved here, before
  // the sampling loop, and geometrically: the layer's own box says which samples
  // it lands on, and ONE paint-order test says whether it is above the control.
  //
  // This used to be one style flip plus one `elementsFromPoint` PER SAMPLE, per
  // layer: on a page with a viewport-sized click-through wash that is thousands
  // of forced style invalidations, which measured at 5.2s for a single 200-link
  // page and produced no labels at all.
  const hidden = new Uint8Array(total);
  let scrim: Element | null = null;
  const layers = pointerTransparentLayers();
  if (layers.length) {
    for (const layer of layers) {
      const lr = { left: layer.left, top: layer.top, right: layer.right, bottom: layer.bottom };
      // GEOMETRY BEFORE TREE WALKS. The composed tests below are the scan's
      // per-candidate cost on deep pages, and they cannot change the answer
      // when the layer's box does not even overlap the control's: only a layer
      // whose box meets the control's can land on one of the control's grid
      // points. (The layer's rect was measured once by the scan.)
      if (lr.right <= r.left || lr.left >= r.right || lr.bottom <= r.top || lr.top >= r.bottom) continue;
      if (layer.el === el || composedContains(el, layer.el) || composedContains(layer.el, el)) continue;
      // Which grid samples land on this layer's box. Collected first so the
      // paint-order verdict, once obtained, is applied in one place.
      const on: number[] = [];
      for (let iy = 0; iy < ys.length; iy++) {
        const y = ys[iy]!;
        if (y < lr.top || y >= lr.bottom) continue;
        for (let ix = 0; ix < xs.length; ix++) {
          const x = xs[ix]!;
          if (x < lr.left || x >= lr.right) continue;
          on.push(iy * xs.length + ix);
        }
      }
      if (!on.length) continue;
      const first = on[0]!;
      if (!paintsAbove(layer.el, xs[first % xs.length]!, ys[Math.floor(first / xs.length)]!)) continue;
      for (const i of on) hidden[i] = 1;
      if (!scrim) scrim = layer.el;
    }
  }

  const sampleT0 = nowMs();
  const midIy = Math.floor(ys.length / 2);
  const midIx = Math.floor(xs.length / 2);
  // Settled-exit bookkeeping: how many grid points were resolved, whether the
  // centre was one of them (top is only honest once it was), and whether the
  // exit fired so the caller can read a clean share below.
  let processed = 0;
  let haveTop = false;
  let stalled = false;
  outer: for (let iy = 0; iy < ys.length; iy++) {
    const y = ys[iy]!;
    for (let ix = 0; ix < xs.length; ix++) {
      const x = xs[ix]!;
      const i = iy * xs.length + ix;
      if (x < clipped.left || x >= clipped.right || y < clipped.top || y >= clipped.bottom) {
        if (!cover) cover = el;
        processed++;
        if (iy === midIy && ix === midIx) haveTop = true;
        continue;
      }
      const hit = deepHit(x, y);
      const own = ownSurface(el, hit);
      if (own && !hidden[i]) {
        ownHits++;
        if (anchorX < 0) {
          anchorX = x;
          anchorY = y;
        }
        if (x === midX && y === midY) top = true;
      } else if (!cover) {
        cover = hidden[i] ? scrim : hit;
      }
      coverageBench.samples++;
      processed++;
      if (iy === midIy && ix === midIx) haveTop = true;
      // HOPELESS SAMPLES STOP PAYING. Once the samples seen so far cannot reach
      // the keep threshold even if every remaining point hit the control, the
      // rest of the grid answers a question the selection pass has already
      // made: this candidate is behind something and will not be hinted. On a
      // veiled or folded page almost every case lands here after one or two
      // samples instead of the full grid.
      if (ownHits + (total - processed) < MIN_VISIBLE_SHARE * total) {
        break outer;
      }
      // SETTLED KEEPS STOP PAYING TOO. The share can only DROP as sampling
      // continues (already-sampled points never become more own), so once the
      // sampled points already guarantee the keep threshold on the FINAL share
      // — ownHits x clipShare >= threshold x total is exactly that guarantee —
      // and both the anchor and the centre verdict exist, the remaining points
      // refine a diagnostic. Break; the share below stays guaranteed.
      if (anchorX >= 0 && haveTop && ownHits * clipShare >= MIN_VISIBLE_SHARE * total) {
        stalled = true;
        break outer;
      }
    }
  }
  coverageBench.sampleMs += nowMs() - sampleT0;

  // THE ANCHOR'S CORNER. The grid's first own sample sits at the 12% inset —
  // the corner itself is never a grid point — so a large fully visible control
  // (a video surface, a wide panel) answered ux≈0.12 and its label was painted
  // pointing at a spot well inside the box instead of at the control's corner.
  // When nothing foreign was seen on the grid, ONE hit-test at the true corner
  // point says whether the corner is paintable: own means the label belongs at
  // the top-left (the 1px inset maps to 0 through the slack below); foreign
  // means something sits exactly on the corner and the inset anchor stays.
  // Click-through layers are invisible to the hit-test, so the layer scan must
  // answer for them here too.
  if (anchorX >= 0 && cover === null && anchorX - r.left > 1.5) {
    const cx = r.left + 1;
    const cy = r.top + 1;
    if (cx >= clipped.left && cx < clipped.right && cy >= clipped.top && cy < clipped.bottom) {
      const hit = deepHit(cx, cy);
      let cornerOwn = ownSurface(el, hit);
      if (cornerOwn) {
        for (const layer of layers) {
          if (cx >= layer.left && cx < layer.right && cy >= layer.top && cy < layer.bottom && paintsAbove(layer.el, cx, cy)) {
            cornerOwn = false;
            break;
          }
        }
      }
      coverageBench.samples++;
      if (cornerOwn) {
        anchorX = cx;
        anchorY = cy;
      }
    }
  }

  // Grid points decide which pixels are obscured; geometry decides what share
  // survived clipping. Using only the number of grid rows inside a clip promoted
  // a 4px visible strip of a 30px control to "one third visible".
  //
  // A settled exit that has seen NOTHING foreign reports its grid as its own:
  // the untested remainder can only make the share smaller, and the guarantee
  // above says the tested part already clears the floor — but reporting own <
  // total alone would mark the label "covered" on evidence the exit never
  // gathered. The covered flag is the one consumer, so keep the flag honest
  // about what was tested and full about what was guaranteed.
  const own =
    total > 0
      ? stalled && cover === null
        ? total
        : Math.min(total, (ownHits / total) * clipShare * total)
      : 0;
  return {
    total,
    own,
    cover,
    top,
    // The anchor as a FRACTION of the box, so the overlay can apply it to a
    // rect that has since moved (a scroll, a reflow) without a second probe.
    // A sample on the control's own edge means "the top-left is visible", which
    // is the placement every label had before anchors existed. The 1.5px slack is
    // the sample inset (see axisPoints): without it every fully visible control
    // would shift by a pixel for no reason.
    ux:
      anchorX < 0 || anchorX - r.left <= 1.5
        ? 0
        : Math.max(0, Math.min(1, (anchorX - r.left) / r.width)),
    uy:
      anchorY < 0 || anchorY - r.top <= 1.5
        ? 0
        : Math.max(0, Math.min(1, (anchorY - r.top) / r.height)),
  };
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

// The point a click would land on, for the diagnostics checks.
export function rectCenter(el: Element): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}
