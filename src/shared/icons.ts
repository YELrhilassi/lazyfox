// The product's icons, as inline SVG.
//
// WHY ONE FILE. The bar used to carry a different glyph per segment, pulled from
// whatever the author had to hand: an emoji speaker, a mathematical triangle, a
// snowman for stealth. At 11px they were three different weights, three
// different heights and — on Windows — three different fonts. One set, one
// stroke weight, one box, sized by CSS.
//
// The paths are Lucide (https://lucide.dev, ISC licence): a flat 24x24 outline
// set, which is what "flat" means here — stroke, no fills, no gradients, no
// second colour. Every icon inherits `currentColor`, so a badge's ink decides
// the icon's colour and nothing has to be themed twice.

export type IconName =
  | "tabs"
  | "stealth"
  | "search"
  | "download"
  | "done"
  | "failed"
  | "muted"
  | "moon"
  | "sun"
  | "split";

const PATHS: Record<IconName, string> = {
  // Stacked sheets — tabs, not layers of anything else.
  tabs:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/>' +
    '<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/>' +
    '<path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  stealth:
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>' +
    '<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>' +
    '<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>' +
    '<path d="m2 2 20 20"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  done: '<path d="M20 6 9 17l-5-5"/>',
  failed: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  muted:
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
    '<line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/>' +
    '<path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>' +
    '<path d="M2 12h2"/><path d="M20 12h2"/>' +
    '<path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  split: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
};

/**
 * The `<svg>` wrapper. The XML namespace is written OUT and it is load-bearing:
 * the status bar mounts in the chrome helper's `browser.xhtml`, where an
 * element's innerHTML setter runs the XML parser (the same reason favicon.ts
 * self-closes its `<img>`). To an XML parser an `<svg>` with no `xmlns` is an
 * unknown element in NO namespace, which paints nothing — so the bar showed
 * "3/12" and "Dark" with blank space where their icons belong. The HTML parser
 * ignores the attribute, so one string is correct in a page and in the chrome
 * document.
 */
function svg(body: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
    'stroke-linejoin="round" focusable="false">' +
    body +
    "</svg>"
  );
}

/**
 * One icon as markup. `className` defaults to `ic`, the span every stylesheet
 * sizes; pass `""` for a bare SVG inside a caller that positions it itself.
 *
 * The only string interpolated is a compile-time constant from PATHS above, so
 * this is safe to assign to innerHTML.
 */
export function iconHtml(name: IconName, className = "ic"): string {
  const span = className ? '<span class="' + className + '" aria-hidden="true">' : "";
  const close = className ? "</span>" : "";
  return span + svg(PATHS[name]) + close;
}

/** Build a node without touching innerHTML of a live element. */
export function iconNode(doc: any, name: IconName): any {
  const span = doc.createElement("span");
  span.className = "ic";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = svg(PATHS[name]);
  return span;
}

/** Replace an existing icon slot's glyph (the dark-mode badge changes state). */
export function setIcon(el: any, name: IconName): void {
  if (!el) return;
  el.innerHTML = iconHtml(name, "");
}
