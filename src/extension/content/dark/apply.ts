// The dark engine's DOM shell: measure the page, generate selectors, inject one
// sheet. Everything decidable without the DOM lives in color.ts / detect.ts /
// theme.ts and is unit-tested.
//
// COST MODEL (this runs on every page, on the thread the user's keystrokes
// ride): one chunked pass with a hard element budget (MAX_SCAN), two
// computed-style reads per candidate only, and later passes rate-limited and
// capped (RESAMPLE_MIN_MS / MAX_RESAMPLES) — a mapping that chases a mutating
// page forever is a permanent tax on it.
//
// NO per-element inline style writes, deliberately rejected: every framework
// re-render overwrites the `style` attribute and the mapping silently decays,
// while a stylesheet keyed by selector survives a re-render. No `filter` on
// anything but <html> in filter mode.

import { parseColor } from "./color";
import type { PageSample } from "./detect";
import { scanWindow } from "./scan";

export interface ColorResolver {
  /** The colour `css` renders as, in the engine's own syntax, or null. */
  (css: string): string | null;
}

/**
 * THE BROWSER'S OWN ANSWER for a colour `parseColor` cannot read (`oklch()`,
 * `lab()`, `color-mix()` — Tailwind v4, Radix). One 1x1 canvas: assign as
 * `fillStyle`, read the PIXEL back. A refusal is detected, not guessed: if the
 * value is not a colour, `fillStyle` keeps its seed — so two different seeds,
 * and a result equal to the first seed is re-checked against the second.
 *
 * Measured before this existed: tailwindcss.com's own dark theme resolves to
 * `lab(...)`/`oklab(...)` values that parsed as "nothing", so the engine
 * painted a native dark site as if it were light. Cached per colour string —
 * a page has a few dozen distinct values, not one per element.
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

/** Resolve unreadable colour functions inside a gradient value, one function
 * at a time (the whole value is an image, not a colour). Unresolvable stops
 * are left as-is rather than breaking the gradient. */
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

// WINDOW, not ceiling: the walk CONTINUES from where it stopped (the `cursor`
// in createDarkApplier), so a big page is painted progressively and completely
// — a hard stop once left 991 text elements unreadable below the fold on
// Wikipedia's Firefox article.
const MAX_SCAN = 4000;
const CHUNK = 250;
// The smallest element worth a rule. Was 900 (≈30×30): most of the TEXT in a
// real interface (a menu label, a badge, a table corner cell) is smaller, was
// never sampled, and stayed `#111` on a cell we painted near-black. Lowering
// it costs no extra DOM work — the sampler reads style+rect regardless; only
// the area check was discarding them. 24px² still skips invisible specks.
const MIN_AREA = 24;
// Where a site puts its VEILS: ::before/::after are not elements, so they were
// never sampled, and a light veil over a mapped dark surface is the report
// "some gray overlay on some elements" verbatim. Area-gated to bound cost (a
// 24px dot's ::before is not a veil); 1200 measured where a menu item starts.
const PSEUDO_LAYERS = ["::before", "::after"] as const;
const PSEUDO_MIN_AREA = 1200;
const RESAMPLE_MIN_MS = 400;
// A RATE LIMIT, not a lifetime cap: a hard stop at 24 mutations froze pages at
// whatever they looked like on load — a route change / panel open / second
// page of results is a burst minutes later, and its elements were never in the
// sheet. A burst is cheap; after it a changing page still earns a re-measure
// every RESAMPLE_SLOW_MS.
const MAX_RESAMPLES = 24;
const RESAMPLE_SLOW_MS = 2500;
const STYLE_ID = "lazyfox-dark";

export interface SampleOptions {
  /** Measure in ONE task instead of yielding every CHUNK elements. Only the
   * first pass after the placeholder paint asks for it: the placeholder sheet
   * is removed before measuring, so every yield in that window is a frame the
   * user sees the undarkened page. */
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
  /** Drop the record of the page's ORIGINAL colours, so the next pass measures
   * what is on screen. Only correct while NO sheet of ours is installed; used
   * to ask the page for its own dark theme. */
  forget(): void;
  /** Whether a sheet is currently installed. */
  active(): boolean;
  /** Elements the walk has not reached yet (zero once the document is
   * covered): how the controller asks for the next slice of a long page
   * without waiting for a mutation a settled page never produces. */
  pending(): number;
  /** The `class` attributes of a bounded sample of the page's elements —
   * answers "is this page a known utility framework?" (tailwind.ts). A
   * separate walk on purpose: it is about the page's vocabulary, not colours,
   * and detection can fire before anything is painted. */
  classTokens(limit?: number): string[];
}

/**
 * The CSS selector that reaches one element, or "" when none is worth emitting:
 * an id, else tag+classes (survives re-render), else an exact `:nth-of-type`
 * path for elements with neither. A bare tag name is NEVER emitted — `div`
 * matches half the page and the last rule wins, smearing one element's colours
 * across a hundred others.
 */
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Whether `sel` reaches `el` and NOTHING ELSE — the property the mapping
 * rests on. Siblings share class names far more often than not, and a rule
 * that carries `color` onto a different background paints text into the
 * background. Not emitting an element is a missing improvement; painting the
 * wrong one is an artifact. */
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

/** Exact positional path from the root (or nearest id ancestor); reaches this
 * element and nothing else, but is a POSITION — `stablePathFor` is the one
 * written into the sheet. */
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

/** A path naming CLASSES at every step, so it survives a re-render (`div.card
 * > p.lede` names the same thing after a sibling is inserted; a positional
 * path does not). `:nth-of-type` only where the tag alone is ambiguous, and
 * onlyMatches still has the last word. */
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
  // A unique class is already a solo selector; otherwise prefer the stable
  // path (survives re-render) and fall back to the positional path for an
  // element whose classes repeat down the tree.
  let solo = "";
  if (classOk) solo = classSel;
  else {
    const stable = stablePathFor(el);
    solo = stable && onlyMatches(el, stable) ? stable : pathOk ? path : "";
  }
  // A SHARED SELECTOR IS NOT A REASON TO PAINT NOTHING. Requiring uniqueness
  // as a filter left 826 mapped text elements on unpainted white panels
  // (merriam-webster.com) — "some text is not readable". So the name is kept:
  // `entriesFor` in theme.ts decides from every element that wears it — one
  // rule when they agree, one per element against the solo selector when not.
  const shared = classOk ? classSel : pathOk ? path : classSel || path;
  return { shared, solo };
}

export function selectorFor(el: Element): string {
  return selectorsFor(el).shared;
}

// The pixels behind a transparent root, which is NOT always white: `color`
// -scheme` decides (dark alone ⇒ dark canvas; `light dark` ⇒ follows the OS).
// Reporting white regardless made an already-dark page measure as light and get
// recoloured on top of its own theme. Read from the page BEFORE any sheet of
// ours is installed.
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
    // Fully transparent: what the user sees is an ANCESTOR's, or the canvas at
    // the root.
    const parent = el.parentElement;
    out = parent ? resolvedBackground(parent, read, cache, backdrop) : backdrop();
  }
  // PARTIAL alpha left as-is: compositing would invent a colour the page never
  // asked for, and the entry builder skips non-opaque anyway.
  cache.set(el, out);
  return out;
}

function alphaOf(css: string): number {
  // Parsed value first: only reading rgb syntax made every modern (lab etc.)
  // translucent colour look opaque.
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
  // The sheet last WROTE, not the one last COMPUTED. Re-writing identical bytes
  // is not a no-op in a browser: it invalidates styles, repaints the document,
  // and — the observer watching the subtree — buys the next measurement. Two
  // identical passes in a row used to feed each other forever ("it flashes
  // dark and light"). A write that changes nothing now changes nothing.
  let writtenCss = "";

  // The colour behind a transparent root, measured ONCE as the page is before
  // our sheet exists and kept: re-reading later would just measure our own
  // `color-scheme: dark`, declaring every painted page "already dark".
  let backdrop: string | null = null;

  // The browser's own conversion for colours parseColor cannot read (see
  // createColorResolver); everything the sampler records goes through `colour`,
  // so an oklch/lab page is measurable — and its own dark theme recognised as
  // DARK instead of painted over as light.
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

  // THE PAGE'S OWN COLOURS, and the only colours this module is allowed to
  // decide from. Every later pass runs with OUR SHEET INSTALLED, so reading an
  // element back is a measurement of ourselves: a light page read back dark
  // stands the whole feature down, and double-mapped colours drift. So a
  // resample re-measures GEOMETRY only; the colour of a recorded element is
  // never re-read (the same rule Dark Reader follows). Residual: an element
  // painted by a rule generated from ANOTHER element reads our colour back the
  // first time it is seen — one element of one class, cheaper than re-measuring
  // with the sheet suspended (a visible flash on every resample).
  //
  // KEYED BY ELEMENT, not by selector: selector-keying let the first element
  // wearing a class donate its colours to every other — one white card made
  // twenty tinted ones measure as white, and the rule built from that failed.
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

  // The walk is a cursor over the whole document, and this is everything
  // measured so far — the sheet is built from the union, not one slice.
  let cursor = 0;
  let documentElements = 0;
  // Elements WALKED since the last wrap, not elements kept: hidden chrome still
  // has to be walked to the end, and `pending` must fall to zero when it is or
  // the controller asks forever.
  let passed = 0;
  const measured = new Map<Element, PageSample>();
  // THE LAYERS, keyed by the element that owns them and rebuilt whenever that
  // element is walked again (a `::before` exists only while its element does).
  const measuredLayers = new Map<Element, PageSample[]>();
  // The page's ORIGINAL layer colours, for the same reason as `originals`:
  // later passes run with our sheet installed.
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
    // `isConnected` is part of the question: a page that replaces its <head>
    // takes our <style> with it, and returning on cached bytes then leaves the
    // page undarkened for the rest of its life. A detached sheet is not
    // installed.
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
    // One selector per element PER PASS: `selectorFor` is not free and the
    // resolution below consults it per ancestor. Not kept across passes — a
    // page that toggles a class changes its selector, and a stale one would
    // key `originals` to an element that no longer matches it.
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
    // Recorded colour FIRST, live only with no record: see `originals`. The
    // record is the OWN colour, not the resolved one — resolution is a per-pass
    // walk (resolvedBackground), while "did this element paint anything" is a
    // property of the element that survives re-renders.
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
      // A `url()` is a picture and never ours to move; anything else is a
      // gradient — a surface — whose stops are mapped. Read once here so a
      // gradient is not re-read after we paint a mapped copy over the page.
      const imageRaw = resolveInImage(cs.getPropertyValue("background-image") || "", resolveColor);
      const hasBgImage = imageRaw.indexOf("url(") >= 0;
      // textContent/size read only for image-bearing elements: that is the only
      // case the answer changes a decision (hasContent in detect.ts).
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
      // EVERY PAINTED SIDE, not just top: a `border-bottom: 1px solid` row
      // separator has no top width at all, and a ring minus one side came back
      // as three untouchable light edges.
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
      // THE LAYERS this element paints, measured once then read from
      // `layerOriginals`. Only a layer painting something becomes a sample.
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
    // THE UNION, not this pass's slice: an element measured two passes ago is
    // still on the page. Layers come with it.
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
    // Zero once the document has been covered (see scan.ts).
    pending: () => Math.max(0, documentElements - passed),
    clear: () => {
      setSheet("");
      setScheme(null);
      // `originals` deliberately NOT cleared: it records the page, not our
      // paint, so a toggle back ON decides from the page's palette (idempotent).
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

/** Rate-limited resample gate, called on every mutation — the alternative is
 * a page mutating at 60Hz dragging a 4000-element style scan behind it.
 * `reset()` is for a NEW PAGE STATE (an SPA route change), not a mutation: it
 * must not inherit the previous page's exhausted burst. */
export interface ResampleGate {
  (): boolean;
  reset(): void;
}

export function createResampleGate(now: () => number): ResampleGate {
  let samples = 0;
  // -Infinity: "never measured" is not a timestamp, and starting at 0 refuses
  // the FIRST call on any clock younger than the interval.
  let last = -Infinity;
  const gate = () => {
    const t = now();
    // In the burst: the calm-down interval. Out of it: the slow one, which a
    // page that keeps changing keeps earning.
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

/** Whether a mutation batch is OUR OWN write and nothing else. The sheet
 * install itself is a mutation the observer sees; counting it as page activity
 * is the other half of the measurement feedback loop (writes bought
 * measurements to the end of the tab). */
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
