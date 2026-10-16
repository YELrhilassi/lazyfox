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
const MAX_RESAMPLES = 24;
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

/** Parse a computed `background-color`, resolving alpha against the ancestors. */
function resolvedBackground(
  el: Element,
  read: (e: Element) => string,
  cache: Map<Element, string>
): string {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const own = read(el);
  const alpha = alphaOf(own);
  let out = own;
  if (alpha <= 0) {
    // Fully transparent: the colour the user actually sees is an ANCESTOR's.
    const parent = el.parentElement;
    out = parent ? resolvedBackground(parent, read, cache) : "rgb(255, 255, 255)";
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
    let all: Element[] = [];
    try {
      all = Array.prototype.slice.call(doc.querySelectorAll("*"), 0, MAX_SCAN);
    } catch {
      return samples;
    }
    const read = (el: Element): string => {
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
      const selector = selectorFor(el);
      if (!selector) continue;
      samples.push({
        selector,
        tag,
        bg: resolvedBackground(el, read, bgCache),
        fg: cs.getPropertyValue("color") || "",
        border: borderWidth > 0 ? cs.getPropertyValue("border-top-color") || undefined : undefined,
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
    clear: () => {
      setSheet("");
      setScheme(null);
    },
    active: () => !!style,
  };
}

/**
 * A bounded resample gate.
 *
 * Returns a function to call on every mutation; it decides whether the page has
 * earned another measurement. Both limits exist because the alternative is a
 * page that mutates at 60Hz dragging a 4000-element style scan behind it.
 */
export function createResampleGate(now: () => number): () => boolean {
  let samples = 0;
  let last = 0;
  return () => {
    const t = now();
    if (samples >= MAX_RESAMPLES) return false;
    if (t - last < RESAMPLE_MIN_MS) return false;
    last = t;
    samples++;
    return true;
  };
}

export const DARK_STYLE_ID = STYLE_ID;
