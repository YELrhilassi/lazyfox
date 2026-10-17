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

import type { PageSample } from "./detect";

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

/** Our own hosts, by id prefix: never sampled, never mapped. */
const OUR_ID_PREFIX = "lazyfox-";

const MAX_SCAN = 4000;
const CHUNK = 250;
const MIN_AREA = 900; // ~30×30: below this a colour is a dot, not a surface
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

export interface DarkApplier {
  /** Measure the page into samples. Chunked; resolves when the pass is done. */
  sample(): Promise<PageSample[]>;
  /** Replace the sheet. `css` empty removes it. */
  setSheet(css: string): void;
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
export function selectorFor(el: Element): string {
  const id = el.id;
  if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) return "#" + id;
  const tag = (el.tagName || "").toLowerCase();
  if (!tag) return "";
  const classes =
    typeof el.classList !== "undefined"
      ? Array.from(el.classList).filter((c) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(c)).slice(0, 3)
      : [];
  if (classes.length) return tag + "." + classes.join(".");
  // No id, no usable classes: an exact path, bounded, anchored on the nearest
  // ancestor with an id when there is one.
  const parts: string[] = [];
  let node: Element | null = el;
  let steps = 0;
  while (node && node.nodeType === 1 && steps < 4) {
    const parent: Element | null = node.parentElement;
    const nodeTag = (node.tagName || "").toLowerCase();
    if (!nodeTag) break;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const nth = sameTag.indexOf(node) + 1;
      parts.unshift(nodeTag + (sameTag.length > 1 ? ":nth-of-type(" + nth + ")" : ""));
      if (parent.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(parent.id)) {
        parts.unshift("#" + parent.id);
        break;
      }
      if ((parent.tagName || "").toLowerCase() === "html") break;
    } else {
      parts.unshift(nodeTag);
    }
    node = parent;
    steps++;
  }
  return parts.join(" > ");
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

  // The colour behind a transparent root, measured ONCE on the page as it is —
  // before our sheet exists — and kept. Re-reading it later would just measure
  // our own `color-scheme: dark`, which would turn every page we had painted into
  // a page that "is already dark". `forget()` drops it along with the originals,
  // because both answer the same question: what did the page look like before us?
  let backdrop: string | null = null;
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
  const originals = new Map<string, { bg?: string; fg?: string; border?: string }>();

  const setSheet = (css: string): void => {
    if (!css) {
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
    try {
      if (!style) {
        style = doc.createElement("style");
        style.id = STYLE_ID;
        // documentElement rather than head: at document_start there may be no
        // head yet, and appending to the root still applies the rules.
        (doc.head || doc.documentElement).appendChild(style);
      }
      style.textContent = css;
    } catch {
      style = null;
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

  const sample = async (): Promise<PageSample[]> => {
    const samples: PageSample[] = [];
    const bgCache = new Map<Element, string>();
    // One selector per element PER PASS. `selectorFor` is not free (classList, an
    // nth-of-type walk) and the colour resolution below consults it for every
    // ancestor it walks through, so it is computed once and shared. Per pass
    // rather than kept across passes on purpose: a page that toggles a class
    // changes the selector, and a stale one would key `originals` to an element
    // that no longer matches it.
    const selCache = new Map<Element, string>();
    const selOf = (el: Element): string => {
      const hit = selCache.get(el);
      if (hit !== undefined) return hit;
      const s = selectorFor(el);
      selCache.set(el, s);
      return s;
    };
    let all: Element[] = [];
    try {
      all = Array.prototype.slice.call(doc.querySelectorAll("*"), 0, MAX_SCAN);
    } catch {
      return samples;
    }
    // The recorded colour FIRST, the live one only when there is no record: see
    // `originals`. Consulted by `resolvedBackground` too, so a transparent
    // element resolves against the colour its ancestor HAD rather than the one
    // this engine painted on it.
    const read = (el: Element): string => {
      const known = originals.get(selOf(el));
      if (known && known.bg) return known.bg;
      try {
        return win.getComputedStyle(el).getPropertyValue("background-color") || "";
      } catch {
        return "";
      }
    };
    let processed = 0;
    for (const el of all) {
      processed++;
      if (processed % CHUNK === 0) {
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
      const hasBgImage = (cs.getPropertyValue("background-image") || "").indexOf("url(") >= 0;
      const borderWidth = parseFloat(cs.getPropertyValue("border-top-width") || "0") || 0;
      const selector = selOf(el);
      if (!selector) continue;
      const known = originals.get(selector);
      const bg = known && known.bg ? known.bg : resolvedBackground(el, read, bgCache, backdropOf);
      const fg = known && known.fg ? known.fg : cs.getPropertyValue("color") || "";
      const border =
        known && known.border
          ? known.border
          : borderWidth > 0
            ? cs.getPropertyValue("border-top-color") || undefined
            : undefined;
      if (!known) originals.set(selector, { bg: bg || undefined, fg: fg || undefined, border });
      samples.push({
        selector,
        tag,
        bg,
        fg,
        border,
        area,
        hasBgImage,
        media,
      });
    }
    return samples;
  };

  return {
    sample,
    setSheet,
    setScheme,
    forget: () => {
      backdrop = null;
      originals.clear();
    },
    clear: () => {
      setSheet("");
      setScheme(null);
      // `originals` is deliberately NOT cleared. It is a record of what the page
      // looks like, not of what we painted, and the page does not change because
      // the user pressed a key. The next pass therefore still decides from the
      // page's own palette — which is what makes a toggle back ON idempotent.
    },
    active: () => !!style,
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
