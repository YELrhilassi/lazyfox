// The dark engine's DOM shell: measure the page, generate selectors, inject one
// sheet.
//
// Everything decidable without the DOM lives in color.ts / detect.ts / theme.ts
// and is unit-tested. What is left here is the part that cannot be: reading
// computed styles, generating a selector for an element, and putting a <style>
// in the document.
//
// THE COST MODEL, because this runs on every page the user opens and the page's
// main thread is where their keystrokes are dispatched:
//
//   * one pass, chunked, with a hard element budget (MAX_SCAN). A chunk is
//     finished on a `setTimeout(0)` boundary so the walk can never become a
//     single long task on a big page;
//   * two computed-style reads per candidate and one rectangle read, on
//     candidates only — an element with no area, or one of ours, is skipped
//     before any of that;
//   * later passes are throttled and capped (RESAMPLE_MIN_MS / MAX_RESAMPLES).
//     A page that re-renders continuously gets a *new* mapping at most every
//     RESAMPLE_MIN_MS and then stops being re-mapped at all, because a mapping
//     that chases a page forever is a permanent tax on it. The cap is a
//     deliberate trade: a page mutated 40 times keeps the mapping it had.
//
// WHAT IS NOT HERE: no stylesheet parsing, no per-element inline style writes,
// no `filter` on anything but <html> in filter mode. Inline writes were
// considered and rejected — a page that re-renders (every framework) overwrites
// the `style` attribute, so the mapping would silently decay; a stylesheet keyed
// by selector survives a re-render that keeps the element's identity, which is
// what a re-render usually does.

import { parseColor } from "./color";
import type { PageSample } from "./detect";
import { scanWindow } from "./scan";

export interface ColorResolver {
  /** The colour `css` renders as, in the engine's own syntax, or null. */
  (css: string): string | null;
}

/**
 * THE BROWSER'S OWN ANSWER, for a colour this module cannot read itself.
 *
 * A computed colour is whatever the page wrote, and since 2024 that is often
 * `oklch()`, `lab()` or `color-mix()` — Tailwind v4, Radix, and most design
 * systems. `parseColor` understands the common ones (see the syntax block in
 * color.ts), and this is the net under it: one 1x1 canvas, the colour assigned
 * as `fillStyle`, and the PIXEL read back. Whatever the browser can paint, this
 * resolves, exactly and without a matrix of magic constants — and if the value
 * is not a colour at all, `fillStyle` keeps the seed it was set to, which is how
 * a refusal is detected rather than guessed at (two different seeds, so a
 * candidate that happens to equal the first one is not mistaken for a refusal).
 *
 * MEASURED on tailwindcss.com, before this existed: the page's own dark theme
 * resolves to `lab(27.1134 -0.956401 -12.3224)` and `oklab(1 0 5.96e-8 / 0.1)`,
 * every one of which parsed as "nothing", so 115 text elements sat on surfaces
 * the engine had refused to paint and the page read as LIGHT to the detector —
 * the engine then painted a native dark site on top of its own theme.
 *
 * Cached per colour string for the life of the document: a page has a few dozen
 * distinct values, not one per element.
 */
export function createColorResolver(doc: Document): ColorResolver {
  const cache = new Map<string, string | null>();
  let ctx: CanvasRenderingContext2D | null | undefined;
  const context = (): CanvasRenderingContext2D | null => {
    if (ctx !== undefined) return ctx;
    try {
      const canvas = doc.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
      ctx = null;
    }
    return ctx || null;
  };
  const SEED_A = "rgba(1, 2, 3, 1)";
  const SEED_B = "rgba(4, 5, 6, 1)";
  return (css: string): string | null => {
    const key = String(css || "").trim();
    if (!key) return null;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let out: string | null = null;
    const c = context();
    if (c) {
      const read = (seed: string): string => {
        c.fillStyle = seed;
        c.fillStyle = key;
        c.fillRect(0, 0, 1, 1);
        const d = c.getImageData(0, 0, 1, 1).data;
        return "rgba(" + d[0] + ", " + d[1] + ", " + d[2] + ", " + Math.round((d[3]! / 255) * 1000) / 1000 + ")";
      };
      try {
        const first = read(SEED_A);
        out = first === SEED_A ? (read(SEED_B) === SEED_B ? null : read(SEED_B)) : first;
      } catch {
        out = null;
      }
    }
    cache.set(key, out);
    return out;
  };
}

/**
 * A `background-image` with every unreadable colour function resolved.
 *
 * A gradient's stops are colours, and a modern one is written in the same
 * syntaxes as any other colour: `linear-gradient(oklch(1 0 0), oklch(.9 0 0))`
 * used to survive untouched because the stop-rewriting regex in theme.ts only
 * knows `rgb()`/`hsl()`. The whole value is not resolvable through a canvas
 * (it is an image, not a colour), so each function is resolved on its own and
 * substituted; a value that still contains an unreadable function is left as it
 * is, which is the same behaviour as before rather than a broken gradient.
 */
function resolveInImage(image: string, resolve: ColorResolver): string {
  const css = String(image || "");
  if (!css || css.indexOf("url(") >= 0) return css;
  if (!/\b(oklch|oklab|lab|lch|hwb|color|color-mix|light-dark)\(/i.test(css)) return css;
  return css.replace(
    /\b(oklch|oklab|lab|lch|hwb|color|color-mix|light-dark)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi,
    (whole) => {
      if (parseColor(whole)) return whole;
      return resolve(whole) || whole;
    }
  );
}

/** The elements we never recolour: their colours are content, not chrome. */
const MEDIA_TAGS = new Set([
  "IMG",
  "VIDEO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "PICTURE",
  "SVG",
  "MAP",
  "AUDIO",
  "SOURCE",
  "TRACK",
]);

/** The four border sides, in painting order, for the per-side colour read. */
const SIDES = ["top", "right", "bottom", "left"] as const;

/** Our own hosts, by id prefix: never sampled, never mapped. */
const OUR_ID_PREFIX = "lazyfox-";

// HOW MANY ELEMENTS ONE PASS WALKS.
//
// This is a WINDOW, not a ceiling, and it used to be a ceiling in effect: the
// walk started at the top of the document every time and stopped here, so a page
// with more elements than this was painted only as far as the budget reached.
// MEASURED on en.wikipedia.org/wiki/Firefox: 14 051 elements, 4 000 sampled, and
// the article below the fold kept its own white panels with our mapped-light ink
// on them — 991 unreadable text elements, and the report "issues with content".
//
// The walk therefore CONTINUES from where it stopped (see `cursor` in
// createDarkApplier), and what it has measured so far is what the sheet is built
// from, so a big page is painted progressively and completely instead of
// partially and forever.
const MAX_SCAN = 4000;
const CHUNK = 250;
// The smallest element worth a rule.
//
// This was 900 (≈30×30) and the number was the report "some text is not
// readable": a sudoku digit, a badge, a timestamp, a menu label, a table's
// corner cell — most of the TEXT in a real interface — is smaller than that and
// was therefore never sampled. Their own colours were never mapped, so a `#111`
// label stayed `#111` on a cell that had just been painted near-black.
//
// Lowering it costs no DOM work — the sampler already reads every candidate's
// computed style and rectangle, and only the area check was throwing them away
// — so the only price is a longer sheet. 24px² keeps the genuinely invisible
// specks (a 1px spacer, an empty dot) out.
const MIN_AREA = 24;
// WHICH ELEMENTS' PSEUDO-ELEMENT LAYERS ARE MEASURED.
//
// A `::before`/`::after` is where a site puts its VEILS: a card's frosted
// overlay, a photo's white wash, the sheet that dims a game board. None of them is
// an element, so none of them was ever sampled — and a light veil over a mapped
// dark surface is the report "some gray overlay on some elements", verbatim.
//
// The gate is AREA because that is what makes a layer worth a rule and what keeps
// the cost bounded: two extra computed-style reads per element above this size,
// which on a very dense page is a few hundred elements rather than fourteen
// thousand. A 24px dot's `::before` is not a veil.
//
// 2500 was measured too high on bbc.com/news, where a navigation item paints
// `::before{content:"";position:absolute;background:rgb(230,232,234)}` — a light
// bar on a menu that is a dark panel once the page is themed, i.e. one more
// "gray overlay on some elements". The gate now starts where a menu item does.
const PSEUDO_LAYERS = ["::before", "::after"] as const;
const PSEUDO_MIN_AREA = 1200;
const RESAMPLE_MIN_MS = 400;
// The burst allowance, and — this is the part that was missing — what happens
// after it.
//
// It used to be a hard stop: after 24 mutations the page kept whatever mapping it
// had, for the rest of its life. That is exactly wrong for the pages people
// actually use, because a state switch (a route change, opening a panel, loading
// a second page of results) is a mutation BURST that lands minutes after the
// first one, and the elements it creates were never in the sheet. The verdict the
// user reported was "it doesn't render dark elements properly" — a mapping frozen
// at whatever the page looked like when it first loaded.
//
// So the budget is a RATE LIMIT, not a lifetime cap: a burst is cheap and
// immediate, and after the burst a page still earns a re-measure every
// RESAMPLE_SLOW_MS while it keeps changing. A page that mutates forever still
// costs at most one scan per few seconds, which is the same order as the scroll
// work it is already doing.
const MAX_RESAMPLES = 24;
const RESAMPLE_SLOW_MS = 2500;
const STYLE_ID = "lazyfox-dark";

export interface SampleOptions {
  /**
   * Measure in ONE task instead of yielding every CHUNK elements.
   *
   * Only the first pass after the placeholder paint asks for this, and the reason
   * is the flash rather than speed: the placeholder sheet is removed before the
   * measurement (it would otherwise be measured as the page's own colour), so
   * every yield between the removal and the new sheet is a frame the user sees
   * the undarkened page. A synchronous walk makes that window one task instead of
   * sixteen timeouts.
   */
  sync?: boolean;
}

export interface DarkApplier {
  /** Measure the page into samples. Chunked unless `sync`; resolves when done. */
  sample(opts?: SampleOptions): Promise<PageSample[]>;
  /** Replace the sheet. `css` empty removes it. */
  setSheet(css: string): void;
  /** The CSS currently installed, or "" when there is none. */
  installed(): string;
  /** Set the scheme marker on <html> (drives `[data-lf-scheme]` rules). */
  setScheme(scheme: "dark" | "light" | null): void;
  /** Everything this applier put in the document. */
  clear(): void;
  /**
   * Drop the record of the page's ORIGINAL colours, so the next pass measures
   * what is on screen now rather than what was there when this applier first
   * looked.
   *
   * Only correct while NO sheet of ours is installed — the record is what keeps
   * a re-measure from reading our own paint back as the page's. It exists for
   * the one question that is about the page's CURRENT palette: "if I ask this
   * site for its own dark theme, does it have one?"
   */
  forget(): void;
  /** Whether a sheet is currently installed. */
  active(): boolean;
  /**
   * Elements the walk has not reached yet.
   *
   * Zero for a page that fits in one window. A page that does not (Wikipedia,
   * a long feed, a spreadsheet) is painted in slices, and this is how the
   * controller knows to ask for the next one without waiting for a mutation
   * that a settled page will never produce.
   */
  pending(): number;
  /**
   * The `class` attributes of a bounded sample of the page's elements.
   *
   * Exists for one question — "is this page styled with a known utility
   * framework?" (see tailwind.ts) — and it is a separate walk from `sample()` on
   * purpose: the answer is about the page's vocabulary, not about any element's
   * colours, and a page may be detected as Tailwind before the palette engine
   * has anything to paint. Cheap: one attribute read per element, capped.
   */
  classTokens(limit?: number): string[];
}

/**
 * The CSS selector that reaches one element, or "" when there is none worth
 * emitting.
 *
 * Three shapes, in order of preference: an id (exact, short); the tag plus its
 * classes (survives re-render, the common case); and — only for elements with
 * neither — an `:nth-of-type` path, which is exact but ugly and long. A bare tag
 * name is never emitted: `div` would match half the page and the last rule would
 * win, which is how a remap produces a page with one element's colours applied
 * to a hundred others.
 */
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Whether `sel` reaches `el` and NOTHING ELSE.
 *
 * This is the property the whole mapping rests on. A selector that also
 * matches a sibling with different colours paints that sibling with this
 * element's colours: a mis-coloured panel on a page that uses one class for
 * many cards, and — because the same rule carries `color` — text that becomes
 * the background. On a real site (a search results page, a news front page)
 * class names are shared far more often than they are unique, which is why
 * "artifacts" cluster on exactly those pages.
 *
 * A selector that cannot be made unique is not emitted at all: not painting an
 * element is a missing improvement, painting the wrong one is an artifact.
 */
function onlyMatches(el: Element, sel: string): boolean {
  try {
    const doc = el.ownerDocument;
    if (!doc || !sel) return false;
    const hits = doc.querySelectorAll(sel);
    return hits.length === 1 && hits[0] === el;
  } catch {
    return false;
  }
}

/**
 * An exact path from the root (or from the nearest ancestor with an id).
 *
 * Tags and `:nth-of-type` only. It matches this element and nothing else, which
 * is what makes it usable as a SOLO selector, but it is also a POSITION: insert
 * a sibling and the same path names a different element. `stablePathFor` below
 * is the one written into the sheet.
 */
function pathFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let guard = 0;
  while (node && node.nodeType === 1 && guard++ < 64) {
    const nodeTag = (node.tagName || "").toLowerCase();
    if (!nodeTag) return "";
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(nodeTag);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    const nth = sameTag.indexOf(node) + 1;
    parts.unshift(nodeTag + (sameTag.length > 1 ? ":nth-of-type(" + nth + ")" : ""));
    if (parent.id && SAFE_ID.test(parent.id)) {
      parts.unshift("#" + parent.id);
      break;
    }
    node = parent;
  }
  return parts.join(" > ");
}

/** The class names of one element, in the shape a selector can carry. */
function classesOf(node: Element): string[] {
  try {
    return typeof node.classList !== "undefined"
      ? Array.from(node.classList).filter((c) => SAFE_ID.test(c)).slice(0, 2)
      : [];
  } catch {
    return [];
  }
}

/**
 * A path whose every step names the element's CLASSES, not just its position.
 *
 * This is the selector a disagreeing group's members are painted with, so it
 * has to survive a re-render: `div:nth-of-type(3) > p:nth-of-type(2)` survives
 * nothing, while `div.card > p.lede` still names the same thing after the page
 * inserts a sibling above it. `:nth-of-type` is added only where the tag alone
 * would be ambiguous, and `onlyMatches` still has the last word — a path that
 * does not reach exactly one element is never used.
 */
function stablePathFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let guard = 0;
  while (node && node.nodeType === 1 && guard++ < 32) {
    const nodeTag = (node.tagName || "").toLowerCase();
    if (!nodeTag) return "";
    const classes = classesOf(node);
    const base = nodeTag + (classes.length ? "." + classes.join(".") : "");
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(base);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    const nth = sameTag.indexOf(node) + 1;
    parts.unshift(base + (sameTag.length > 1 ? ":nth-of-type(" + nth + ")" : ""));
    if (parent.id && SAFE_ID.test(parent.id)) {
      parts.unshift("#" + parent.id);
      break;
    }
    node = parent;
  }
  return parts.join(" > ");
}

/** The two selectors one element needs: its name and, if any, its own address. */
export interface ElementSelectors {
  /** The selector a rule is keyed by when the whole group agrees. */
  shared: string;
  /** A selector that reaches this element alone, or "" when there is none. */
  solo: string;
}

export function selectorsFor(el: Element): ElementSelectors {
  const id = el.id;
  if (id && SAFE_ID.test(id)) {
    const s = "#" + id;
    return { shared: s, solo: s };
  }
  const tag = (el.tagName || "").toLowerCase();
  if (!tag) return { shared: "", solo: "" };
  const classes = classesOf(el);
  const classSel = classes.length ? tag + "." + classes.join(".") : "";
  const classOk = !!classSel && onlyMatches(el, classSel);
  const path = pathFor(el);
  const pathOk = !!path && onlyMatches(el, path);
  // THE SOLO SELECTOR. A unique class is already one; otherwise the stable path
  // is asked first (it survives a re-render) and the positional path is the
  // fallback for an element whose classes repeat down the tree.
  let solo = "";
  if (classOk) solo = classSel;
  else {
    const stable = stablePathFor(el);
    solo = stable && onlyMatches(el, stable) ? stable : pathOk ? path : "";
  }
  // A SHARED SELECTOR IS NOT A REASON TO PAINT NOTHING.
  //
  // Requiring uniqueness was the fix for "one rule painted a hundred siblings" —
  // a real artifact — but as a FILTER it threw away most of every real site:
  // measured on merriam-webster.com, 826 text elements got mapped while the
  // white panels they sit on (a class shared by their siblings) were skipped, so
  // the page became light text on an unpainted white panel. That is the report
  // "some text is not readable" and, on a grid, "a gray overlay hides it".
  //
  // The name is kept, and `entriesFor` in theme.ts decides from every element
  // that wears it: one rule when they agree, one rule per element (against the
  // solo selector) when they do not.
  const shared = classOk ? classSel : pathOk ? path : classSel || path;
  return { shared, solo };
}

export function selectorFor(el: Element): string {
  return selectorsFor(el).shared;
}

/**
 * The pixels behind a transparent root — which is NOT always white.
 *
 * A page that paints only `body` leaves `html` transparent, and what shows
 * through is the UA canvas: white in a light scheme, near-black in a dark one.
 * Reporting white regardless is how a page whose own dark theme is already on
 * screen measures as "light page", gets recoloured on top of its own theme, and
 * produces the report "it doesn't render dark elements properly" — the site's
 * dark panels are re-mapped as if they were its light ones.
 *
 * `color-scheme` is what decides it, and it is a fact about the page rather than
 * a guess: `dark` alone forces the dark canvas, `light dark` follows the OS, and
 * anything without `dark` is a light canvas. This is read from the page as it is
 * BEFORE any sheet of ours is installed (see `backdrop` in createDarkApplier).
 */
function rootBackdrop(doc: Document, win: Window): string {
  const LIGHT = "rgb(255, 255, 255)";
  try {
    const root = doc.documentElement;
    if (!root) return LIGHT;
    const scheme = String(win.getComputedStyle(root).colorScheme || "").toLowerCase();
    if (!/\bdark\b/.test(scheme)) return LIGHT;
    // `dark` alone is unconditional; `light dark` is the OS's business.
    if (/\blight\b/.test(scheme)) {
      let prefersDark = false;
      try {
        prefersDark = !!win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches;
      } catch {
        prefersDark = false;
      }
      if (!prefersDark) return LIGHT;
    }
    // The UA's dark canvas (`Canvas` system colour), close enough to be the
    // surface the user is looking at; the exact shade does not change a verdict.
    return "rgb(18, 18, 18)";
  } catch {
    return LIGHT;
  }
}

/** Parse a computed `background-color`, resolving alpha against the ancestors. */
function resolvedBackground(
  el: Element,
  read: (e: Element) => string,
  cache: Map<Element, string>,
  backdrop: () => string
): string {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const own = read(el);
  const alpha = alphaOf(own);
  let out = own;
  if (alpha <= 0) {
    // Fully transparent: the colour the user actually sees is an ANCESTOR's —
    // and at the root, the browser's own canvas.
    const parent = el.parentElement;
    out = parent ? resolvedBackground(parent, read, cache, backdrop) : backdrop();
  }
  // A PARTIAL alpha is left exactly as it is. Compositing it against the
  // ancestor would invent a colour the page never asked for, and the entry
  // builder skips anything that is not opaque — so the element keeps its own
  // appearance instead of getting a fabricated one.
  cache.set(el, out);
  return out;
}

function alphaOf(css: string): number {
  // The parsed value first: a `lab(… / 0.5)` is translucent, and reading only
  // the rgb syntax made every modern translucent colour look opaque.
  const parsed = parseColor(css);
  if (parsed) return parsed.a;
  const m = /rgba?\(([^)]*)\)/.exec(css || "");
  if (!m) return 1;
  const parts = m[1]!.indexOf(",") >= 0 ? m[1]!.split(",") : m[1]!.split(/[\s/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3]!.trim();
  const n = a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
  return Number.isFinite(n) ? n : 1;
}

export function createDarkApplier(doc: Document, win: Window): DarkApplier {
  let style: HTMLStyleElement | null = null;
  // The sheet we last WROTE, which is not the same thing as the sheet we last
  // COMPUTED. Re-writing `textContent` with the bytes it already holds is not a
  // no-op in a browser: it is a style invalidation and a repaint of the whole
  // document, and — because the observer watches the subtree — a mutation that
  // buys the next measurement. Two identical passes in a row therefore used to
  // feed each other forever, which is the reported "it flashes dark and light".
  // A write that changes nothing now changes nothing.
  let writtenCss = "";

  // The colour behind a transparent root, measured ONCE on the page as it is —
  // before our sheet exists — and kept. Re-reading it later would just measure
  // our own `color-scheme: dark`, which would turn every page we had painted into
  // a page that "is already dark". `forget()` drops it along with the originals,
  // because both answer the same question: what did the page look like before us?
  let backdrop: string | null = null;

  // THE BROWSER'S OWN CONVERSION, for a colour this module cannot read: see
  // createColorResolver. Everything the sampler records goes through `colour`,
  // so a page written in `oklch()`/`lab()` is a page this engine can measure —
  // and a page whose own dark theme is written in them is recognised as DARK
  // instead of being painted over as if it were light.
  const resolveColor = createColorResolver(doc);
  const colour = (raw: string): string => {
    const v = String(raw || "").trim();
    if (!v) return v;
    if (parseColor(v)) return v;
    return resolveColor(v) || v;
  };
  const backdropOf = (): string => {
    if (backdrop === null) backdrop = rootBackdrop(doc, win);
    return backdrop;
  };

  // THE PAGE'S OWN COLOURS, per selector — and the only colours this module is
  // ever allowed to decide from.
  //
  // The first read of an element is the page's colour; every later pass runs with
  // THIS ENGINE'S SHEET INSTALLED, so the same element now computes to whatever
  // the mapping painted it. Reading that back is not a measurement of the page, it
  // is a measurement of ourselves, and both failure modes are ugly and were
  // observed in a real browser (the e2e theme suite): a light page read back dark
  // is decided as "the page is already dark" and stands the whole feature down,
  // and a colour fed through the mapping twice drifts away from the palette it
  // was mapped from.
  //
  // So a resample re-measures GEOMETRY and reaches elements the first pass could
  // not have seen; it does not re-read the colour of anything it has already
  // recorded. This is the same rule Dark Reader's own engine follows (it keeps
  // the original computed values per element and never reads a modified one).
  //
  // The residual, named: an element that is painted by a rule generated from
  // ANOTHER element (a `.card` rule mapping twenty cards, one of which was
  // sampled) and is seen for the first time after we painted reads our colour
  // back. It is one element of one class, it can only ever affect that class's
  // rule, and paying for it with a measurement taken with our sheet suspended is
  // a worse trade (that is a visible flash of the undarkened page on every
  // resample).
  //
  // KEYED BY ELEMENT, not by selector. It used to be a Map keyed by the
  // selector, which meant the FIRST element to wear a class donated its colours
  // to every other element with the same class: one white card made twenty
  // tinted ones measure as white, and the rule built from that painted them
  // wrong. An element's own colour is a property of the element.
  let originals = new WeakMap<
    Element,
    {
      ownBg?: string;
      fg?: string;
      border?: string;
      borders?: Array<{ side: "top" | "right" | "bottom" | "left"; color: string }>;
      image?: string;
    }
  >();

  // THE WALK IS A CURSOR OVER THE WHOLE DOCUMENT, and this is everything it has
  // measured so far — the sheet is built from the union, not from one slice of
  // it. Elements that have left the document are dropped on the next pass, so a
  // single-page app that replaces its view does not accumulate the old one.
  let cursor = 0;
  let documentElements = 0;
  // Elements the cursor has walked since the last wrap. It counts every element
  // it PASSED, not every element it kept: a page half full of `display:none`
  // chrome still has to reach the end of the walk, and "pending" must fall to
  // zero when it does or the controller would ask forever.
  let passed = 0;
  const measured = new Map<Element, PageSample>();
  // THE LAYERS, keyed by the element that owns them and rebuilt whenever that
  // element is walked again (a `::before` exists only while its element does).
  const measuredLayers = new Map<Element, PageSample[]>();
  // The page's ORIGINAL layer colours, for the same reason as `originals`: a
  // second pass runs with our sheet installed and would otherwise read our own
  // paint back as the page's veil.
  let layerOriginals = new WeakMap<Element, Partial<Record<(typeof PSEUDO_LAYERS)[number], { ownBg?: string; image?: string }>>>();

  const setSheet = (css: string): void => {
    if (!css) {
      writtenCss = "";
      if (style) {
        try {
          style.remove();
        } catch {
          /* the document may be going away */
        }
        style = null;
      }
      return;
    }
    // `isConnected` is part of the question, not a detail: a page that replaces
    // its <head> (a framework re-render, a full document swap in an SPA) takes
    // our <style> with it, and returning on the cached bytes then leaves the
    // page undarkened for the REST OF ITS LIFE — the report "I have to reload
    // the page to see the content again". A detached sheet is not installed.
    let live = false;
    try {
      live = !!style && style.isConnected;
    } catch {
      live = false;
    }
    if (live && css === writtenCss) return;
    if (!live) style = null;
    try {
      if (!style) {
        style = doc.createElement("style");
        style.id = STYLE_ID;
        // documentElement rather than head: at document_start there may be no
        // head yet, and appending to the root still applies the rules.
        (doc.head || doc.documentElement).appendChild(style);
      }
      style.textContent = css;
      writtenCss = css;
    } catch {
      style = null;
      writtenCss = "";
    }
  };

  const setScheme = (scheme: "dark" | "light" | null): void => {
    try {
      const root = doc.documentElement;
      if (!root) return;
      if (scheme) root.setAttribute("data-lf-scheme", scheme);
      else root.removeAttribute("data-lf-scheme");
    } catch {
      /* ignore */
    }
  };

  const sample = async (opts: SampleOptions = {}): Promise<PageSample[]> => {
    const samples: PageSample[] = [];
    const bgCache = new Map<Element, string>();
    // One selector per element PER PASS. `selectorFor` is not free (classList, an
    // nth-of-type walk) and the colour resolution below consults it for every
    // ancestor it walks through, so it is computed once and shared. Per pass
    // rather than kept across passes on purpose: a page that toggles a class
    // changes the selector, and a stale one would key `originals` to an element
    // that no longer matches it.
    // The viewport, for the panel/backdrop question (see `share`).
    let viewport = 1;
    try {
      viewport = Math.max(1, (win.innerWidth || 0) * (win.innerHeight || 0));
    } catch {
      viewport = 1;
    }
    const selCache = new Map<Element, ElementSelectors>();
    const selOf = (el: Element): ElementSelectors => {
      const hit = selCache.get(el);
      if (hit !== undefined) return hit;
      const s = selectorsFor(el);
      selCache.set(el, s);
      return s;
    };

    // DROP WHAT HAS LEFT THE DOCUMENT first, so an SPA that replaces its view
    // does not keep painting the old one.
    for (const el of Array.from(measured.keys())) {
      if (!el.isConnected) measured.delete(el);
    }
    for (const el of Array.from(measuredLayers.keys())) {
      if (!el.isConnected) measuredLayers.delete(el);
    }
    // The window after the cursor, wrapping at the end: this pass walks the next
    // MAX_SCAN elements, the next pass walks the one after that, and the whole
    // document is covered over several passes without any single task doing all
    // of it. See the note on MAX_SCAN.
    let window: Element[] = [];
    try {
      const all = doc.querySelectorAll("*");
      documentElements = all.length;
      // THE SLICE ARITHMETIC LIVES OUTSIDE THIS FILE (scan.ts), and `passed` is
      // the number it exists for: the controller reads `pending()` after every
      // pass to decide whether the document still has unreached elements. A wrap
      // that reported the whole document as still pending is what made every page
      // walk for ever (see the note there).
      const slice = scanWindow(documentElements, cursor, MAX_SCAN);
      window = Array.prototype.slice.call(all, slice.from, slice.from + slice.take);
      cursor = slice.cursor;
      passed = slice.passed;
    } catch {
      return Array.from(measured.values());
    }
    // The recorded colour FIRST, the live one only when there is no record: see
    // `originals`. Consulted by `resolvedBackground` too, so a transparent
    // element resolves against the colour its ancestor HAD rather than the one
    // this engine painted on it.
    // The element's OWN colour, recorded once. Note that the record is the own
    // colour and NOT the resolved one: resolution is a per-pass walk (see
    // `resolvedBackground`), while "did this element paint anything?" is a
    // property of the element that must survive re-renders.
    const read = (el: Element): string => {
      const known = originals.get(el);
      if (known && known.ownBg) return known.ownBg;
      try {
        return colour(win.getComputedStyle(el).getPropertyValue("background-color") || "");
      } catch {
        return "";
      }
    };
    let processed = 0;
    for (const el of window) {
      processed++;
      if (!opts.sync && processed % CHUNK === 0) {
        // Yield, so the walk is several short tasks rather than one long one.
        await new Promise<void>((resolve) => win.setTimeout(resolve, 0));
      }
      const tag = (el.tagName || "").toUpperCase();
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "LINK" || tag === "META") continue;
      if (el.id && el.id.indexOf(OUR_ID_PREFIX) === 0) continue;
      const media = MEDIA_TAGS.has(tag);
      let area = 0;
      let cs: CSSStyleDeclaration | null = null;
      try {
        cs = win.getComputedStyle(el);
      } catch {
        continue;
      }
      if (!cs) continue;
      if (cs.getPropertyValue("display") === "none" || cs.getPropertyValue("visibility") === "hidden") continue;
      try {
        const r = el.getBoundingClientRect();
        area = Math.max(0, r.width * r.height);
      } catch {
        area = 0;
      }
      if (area < MIN_AREA) continue;
      // A `url()` is a picture and is never ours to move. Anything else in
      // `background-image` is a GRADIENT — a surface — and its stops are mapped
      // (see mapGradient). Reading it here, once, is what keeps a gradient from
      // being re-read after we have painted a mapped copy of it over the page.
      const imageRaw = resolveInImage(cs.getPropertyValue("background-image") || "", resolveColor);
      const hasBgImage = imageRaw.indexOf("url(") >= 0;
      // READ ONLY FOR THE ELEMENTS THAT PAINT ONE, because that is the only case
      // the answer changes a decision (see `hasContent` in detect.ts). One text
      // walk of an image-bearing subtree is cheap next to the two style reads the
      // element has already cost.
      let hasContent: boolean | undefined;
      let bgCovers: boolean | undefined;
      if (hasBgImage) {
        try {
          hasContent = /\S/.test(String(el.textContent || "")) || el.children.length > 0;
        } catch {
          hasContent = undefined;
        }
        try {
          const size = String(cs.getPropertyValue("background-size") || "").toLowerCase();
          bgCovers = /cover\b/.test(size) || /\b100%\s+100%/.test(size);
        } catch {
          bgCovers = undefined;
        }
      }
      const gradientOf = (v: string | undefined): string | undefined =>
        v && v !== "none" && v.indexOf("url(") < 0 ? v : undefined;
      // EVERY PAINTED SIDE, in one pass over the four widths and colours. A
      // `border-bottom: 1px solid` row separator has no top width at all, so a
      // top-only read found no border and left a light hairline on a dark page;
      // and a ring written on three sides (`border: 4px solid rgba(255,255,255,.5)`
      // minus one) came back as three untouchable light edges.
      const paintedSides: Array<{ side: "top" | "right" | "bottom" | "left"; color: string }> = [];
      for (const side of SIDES) {
        const w = parseFloat(cs.getPropertyValue("border-" + side + "-width") || "0") || 0;
        if (w <= 0) continue;
        const c = colour(cs.getPropertyValue("border-" + side + "-color") || "");
        if (c) paintedSides.push({ side, color: c });
      }
      const borderWidth = parseFloat(cs.getPropertyValue("border-top-width") || "0") || 0;
      const sel = selOf(el);
      const selector = sel.shared;
      if (!selector) continue;
      const known = originals.get(el);
      const ownBg = known && known.ownBg ? known.ownBg : read(el);
      const bg = resolvedBackground(el, read, bgCache, backdropOf);
      const fg = known && known.fg ? known.fg : colour(cs.getPropertyValue("color") || "");
      const border =
        known && known.border
          ? known.border
          : borderWidth > 0
            ? colour(cs.getPropertyValue("border-top-color") || "") || undefined
            : paintedSides.length
              ? paintedSides[0]!.color
              : undefined;
      const bgImage = known ? known.image : gradientOf(imageRaw);
      if (!known) {
        originals.set(el, {
          ownBg: ownBg || undefined,
          fg: fg || undefined,
          border,
          borders: paintedSides.length ? paintedSides : undefined,
          image: bgImage
        });
      }
      const one: PageSample = {
        selector,
        solo: sel.solo || undefined,
        share: area / viewport,
        tag,
        bg,
        ownBg,
        fg,
        border,
        borders: (known && known.borders) || paintedSides,
        area,
        hasBgImage,
        hasContent,
        bgCovers,
        bgImage,
        media,
      };
      samples.push(one);
      measured.set(el, one);
      // THE LAYERS THIS ELEMENT PAINTS, measured once and then read from the
      // record (see `layerOriginals`). Only a layer that paints a background at
      // all becomes a sample; the rest would be rules saying nothing.
      if (area >= PSEUDO_MIN_AREA) {
        const kept: PageSample[] = [];
        const knownLayers = layerOriginals.get(el);
        for (const layer of PSEUDO_LAYERS) {
          let ps: CSSStyleDeclaration | null = null;
          try {
            ps = win.getComputedStyle(el, layer);
          } catch {
            ps = null;
          }
          if (!ps) continue;
          // `none` and `normal` mean the layer is not generated; a generated one
          // with empty content still paints (`content:""`).
          const content = ps.getPropertyValue("content");
          if (!content || content === "none" || content === "normal" || content === "-moz-alt-content") continue;
          if (ps.getPropertyValue("display") === "none" || ps.getPropertyValue("visibility") === "hidden") continue;
          const known = knownLayers && knownLayers[layer];
          const ownBg = known && known.ownBg !== undefined ? known.ownBg : colour(ps.getPropertyValue("background-color") || "");
          const imageRaw = resolveInImage(ps.getPropertyValue("background-image") || "", resolveColor);
          const hasImage = imageRaw.indexOf("url(") >= 0;
          const layerImage = known ? known.image : gradientOf(imageRaw);
          if (!known) {
            const rec = knownLayers || {};
            rec[layer] = { ownBg: ownBg || undefined, image: layerImage };
            layerOriginals.set(el, rec);
          }
          // A layer with neither a colour nor a gradient is not a surface.
          const alpha = ownBg ? alphaOf(ownBg) : 0;
          if (alpha <= 0.02 && !layerImage) continue;
          kept.push({
            selector: selector + layer,
            solo: sel.solo ? sel.solo + layer : undefined,
            share: area / viewport,
            tag: tag + layer,
            bg: ownBg,
            ownBg,
            fg: "",
            area,
            hasBgImage: hasImage,
            bgImage: layerImage,
            media: false,
            pseudo: layer,
          });
        }
        if (kept.length) measuredLayers.set(el, kept);
        else measuredLayers.delete(el);
      }
    }
    // THE UNION, not this pass's slice: the sheet describes the page as measured
    // so far, and an element measured two passes ago is still on the page. The
    // layers come with it, keyed by the element whose selector reaches them.
    const all: PageSample[] = Array.from(measured.values());
    for (const layers of measuredLayers.values()) for (const layer of layers) all.push(layer);
    return all;
  };

  return {
    sample,
    setSheet,
    installed: () => writtenCss,
    setScheme,
    forget: () => {
      backdrop = null;
      // A WeakMap has no `clear`; dropping the reference is the same thing.
      originals = new WeakMap();
      layerOriginals = new WeakMap();
      measuredLayers.clear();
    },
    // `passed` is elements walked since the last wrap, so this is zero once the
    // document has been covered — the signal the controller waits for before it
    // stops asking for more (see scan.ts).
    pending: () => Math.max(0, documentElements - passed),
    clear: () => {
      setSheet("");
      setScheme(null);
      // `originals` is deliberately NOT cleared. It is a record of what the page
      // looks like, not of what we painted, and the page does not change because
      // the user pressed a key. The next pass therefore still decides from the
      // page's own palette — which is what makes a toggle back ON idempotent.
    },
    /** Whether a sheet is INSTALLED — a detached <style> is not installed. */
    active: () => {
      try {
        return !!style && style.isConnected;
      } catch {
        return false;
      }
    },
    classTokens: (limit = 1500): string[] => {
      const out: string[] = [];
      try {
        const all = doc.querySelectorAll("*");
        const n = Math.min(all.length, limit);
        for (let i = 0; i < n; i++) {
          const cn = all[i]!.getAttribute("class");
          if (cn) out.push(cn);
        }
      } catch {
        /* a document that is going away has no classes worth reading */
      }
      return out;
    },
  };
}

/**
 * A rate-limited resample gate.
 *
 * Returns a function to call on every mutation; it decides whether the page has
 * earned another measurement. The rate limit exists because the alternative is a
 * page that mutates at 60Hz dragging a 4000-element style scan behind it.
 *
 * `reset()` is for a NEW PAGE STATE rather than a new mutation: a same-document
 * navigation (SPA route change) is a different page as far as the palette is
 * concerned, and it must not inherit the previous one's exhausted burst.
 */
export interface ResampleGate {
  (): boolean;
  reset(): void;
}

export function createResampleGate(now: () => number): ResampleGate {
  let samples = 0;
  // -Infinity rather than 0: "never measured" is not a timestamp, and starting
  // the clock at zero means the FIRST call is refused whenever the clock is
  // younger than the interval (a monotonic clock, or `Date.now()` at the epoch).
  // The first pass is the one that has to happen.
  let last = -Infinity;
  const gate = () => {
    const t = now();
    // In the burst: the ordinary calm-down interval. Out of it: the slow one,
    // which a page that keeps changing keeps earning.
    const wait = samples < MAX_RESAMPLES ? RESAMPLE_MIN_MS : RESAMPLE_SLOW_MS;
    if (t - last < wait) return false;
    last = t;
    samples++;
    return true;
  };
  gate.reset = () => {
    samples = 0;
    last = 0;
  };
  return gate;
}

export const DARK_STYLE_ID = STYLE_ID;

/** The subset of MutationRecord this module reads. */
export interface MutationLike {
  target: unknown;
  addedNodes?: ArrayLike<unknown>;
  removedNodes?: ArrayLike<unknown>;
}

/**
 * Whether a mutation batch is OUR OWN write and nothing else.
 *
 * The observer watches `childList` on the whole subtree, so the act of installing
 * the sheet (`<style>` appended, then its text replaced on every pass) is itself a
 * mutation. Treating that as page activity is the other half of the feedback
 * loop: every sheet write bought another measurement, and on a page with any
 * motion at all the two took turns for as long as the tab was open. A batch that
 * only touches the applier's own `<style>` node is the applier's business, not
 * the page's.
 */
export function touchesOnlyOwnStyle(records: MutationLike[], own: unknown): boolean {
  if (!own || !records.length) return false;
  for (const r of records) {
    if (r.target === own) continue;
    const added = r.addedNodes ? Array.prototype.slice.call(r.addedNodes) : [];
    const removed = r.removedNodes ? Array.prototype.slice.call(r.removedNodes) : [];
    const nodes = added.concat(removed);
    if (nodes.length && nodes.every((n) => n === own)) continue;
    return false;
  }
  return true;
}
