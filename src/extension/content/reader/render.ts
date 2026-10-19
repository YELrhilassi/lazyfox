// The reader overlay: the DOM half of reader mode.
//
// Three decisions are made here, and they are the reason this file exists
// separately from the extractor:
//
// 1. **The overlay is a SIBLING of <body>, not a child.** Reader mode hides the
//    page by hiding `body`, so an overlay inside the body would hide itself. It
//    lives on `documentElement` instead, which also means a page that re-renders
//    its body cannot take the article down with it.
//
// 2. **The article is the page's only scroller.** The overlay is
//    `position:fixed; inset:0; overflow:auto`, and while it is up `html` is
//    locked (`overflow:hidden`) and `body` is hidden. That is what makes the
//    existing scroll controller drive the ARTICLE with no new code path: the
//    controller prefers the document scroller, falls back to the largest inner
//    region when the document cannot scroll (the ChatGPT-shell case it was
//    written for), and here the only region left is the article. `j`/`k`,
//    `d`/`u`, `;F`/`;B` region cycling and the hint layer's paging all follow
//    from that one fact rather than from reader-specific key handling.
//
// 3. **The document text is real document text.** The article is ordinary
//    elements with ordinary text, so find-in-page finds it, the yank modes can
//    yank it, and hints work on its links. A canvas- or iframe-rendered reader
//    would have been easier and would have thrown all of that away.
//
// The palette is deliberately smaller than the page theme's: three looks
// (`dark`, `light`, `sepia`) and no user-supplied colours, because the point of
// a reader is to stop the page's design from making the decision.

import { esc } from "../../../shared/dom";
import { promoteToTopLayer } from "../../../shared/toplayer";
import type { ReaderConfig, ReaderTheme } from "../../../shared/types";
import type { Article, Block } from "./extract";

export interface Palette {
  bg: string;
  fg: string;
  dim: string;
  rule: string;
  accent: string;
}

export const READER_HOST_ID = "lazyfox-reader";
const PAGE_STYLE_ID = "lazyfox-reader-page";

export function paletteFor(theme: ReaderTheme, accent: string): Palette {
  if (theme === "light") {
    return { bg: "#f5f5f7", fg: "#1a1a1f", dim: "#5b5b66", rule: "#d6d6de", accent: accent || "#2f5fd0" };
  }
  if (theme === "sepia") {
    return { bg: "#f4ecd8", fg: "#3a3226", dim: "#6b5f4a", rule: "#ddd2b8", accent: "#8a5a1f" };
  }
  return { bg: "#16161e", fg: "#c0caf5", dim: "#8b93b8", rule: "#2a2f45", accent: accent || "#7aa2f7" };
}

export interface ReaderView {
  host: HTMLElement;
  scrollEl: HTMLElement;
  close(): void;
}

/**
 * The stylesheet that BELONGS TO THE PAGE (not the shadow root): hiding the body
 * and locking the document scroller are facts about the document, and a shadow
 * root cannot express them.
 */
function pageCss(): string {
  return (
    "html[data-lf-reader]{overflow:hidden !important}" +
    "html[data-lf-reader] body{display:none !important}"
  );
}

/**
 * The article's font stack: the user's own family when they set one.
 *
 * Shared by the host's box (which carries the font so the SHADOW's text inherits
 * it) and by nothing else — the shadow stylesheet no longer declares it, because
 * the scroller is the host now.
 */
function fontStack(cfg: ReaderConfig): string {
  return cfg.font && cfg.font.trim() ? cfg.font : "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
}

function viewCss(cfg: ReaderConfig, p: Palette): string {
  const mono = "ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace";
  return (
    ":host{all:initial}" +
    // NOT the scroller, and not the box: both live on the host element (see
    // renderReader). The wrap is only the content block inside it.
    ".wrap{min-height:100%}" +
    ".col{max-width:" +
    cfg.width +
    "ch;margin:0 auto;padding:56px 24px 30vh;}" +
    "h1{font-size:1.7em;line-height:1.25;margin:0 0 .35em;font-weight:650;letter-spacing:-.01em}" +
    ".meta{color:" +
    p.dim +
    ";font-size:.78em;letter-spacing:.02em;border-bottom:1px solid " +
    p.rule +
    ";padding-bottom:14px;margin-bottom:26px;display:flex;gap:10px;flex-wrap:wrap}" +
    "p{margin:0 0 1.05em;text-wrap:pretty}" +
    "h2,h3,h4,h5,h6{margin:1.6em 0 .5em;line-height:1.3;font-weight:640}" +
    "h2{font-size:1.32em}h3{font-size:1.14em}h4{font-size:1em}" +
    "a{color:" +
    p.accent +
    "}" +
    "blockquote{margin:0 0 1.05em;padding:.2em 0 .2em 1.1em;border-left:3px solid " +
    p.rule +
    ";color:" +
    p.dim +
    "}" +
    "pre{background:" +
    p.rule +
    ";padding:12px 14px;border-radius:8px;overflow:auto;font:" +
    cfg.fontSize * 0.86 +
    "px/" +
    "1.5 " +
    mono +
    ";margin:0 0 1.05em}" +
    "ul,ol{margin:0 0 1.05em;padding-left:1.4em}li{margin:.25em 0}" +
    "img{max-width:100%;height:auto;border-radius:8px;display:block;margin:0 0 1.05em}" +
    "hr{border:0;border-top:1px solid " +
    p.rule +
    ";margin:1.6em 0}" +
    ".hint{position:fixed;right:14px;bottom:12px;color:" +
    p.dim +
    ";font:11px " +
    mono +
    ";background:" +
    p.bg +
    ";opacity:.82;padding:3px 7px;border-radius:6px}"
  );
}

function blockElement(doc: Document, block: Block): HTMLElement | null {
  switch (block.kind) {
    case "p": {
      const el = doc.createElement("p");
      el.textContent = block.text || "";
      return el;
    }
    case "h": {
      const level = Math.min(6, Math.max(2, block.level || 2));
      const el = doc.createElement("h" + level);
      el.textContent = block.text || "";
      return el;
    }
    case "quote": {
      const el = doc.createElement("blockquote");
      el.textContent = block.text || "";
      return el;
    }
    case "pre": {
      const el = doc.createElement("pre");
      el.textContent = block.text || "";
      return el;
    }
    case "ul":
    case "ol": {
      const el = doc.createElement(block.kind);
      for (const item of block.items || []) {
        const li = doc.createElement("li");
        li.textContent = item;
        el.appendChild(li);
      }
      return el;
    }
    case "img": {
      const el = doc.createElement("img");
      el.setAttribute("src", block.src || "");
      el.setAttribute("alt", block.alt || "");
      el.setAttribute("referrerpolicy", "no-referrer");
      return el;
    }
    case "rule":
      return doc.createElement("hr");
    default:
      return null;
  }
}

/**
 * Build the overlay. The caller owns the lifecycle decisions (when to enter,
 * when to leave); this function only draws and returns a handle that undoes
 * itself.
 */
export function renderReader(deps: {
  doc: Document;
  article: Article;
  config: ReaderConfig;
  theme: ReaderTheme;
  accent: string;
  onClose(): void;
}): ReaderView {
  const { doc, article, config, theme } = deps;
  const palette = paletteFor(theme, deps.accent);

  const pageStyle = doc.createElement("style");
  pageStyle.id = PAGE_STYLE_ID;
  pageStyle.textContent = pageCss();

  const host = doc.createElement("div");
  host.id = READER_HOST_ID;
  // THE HOST IS THE SCROLLER, AND THAT IS THE WHOLE KEYBOARD INTEGRATION.
  //
  // It used to be the wrapper INSIDE this host that carried
  // `position:fixed;inset:0;overflow:auto` — and the shadow root is CLOSED, so
  // the scroll controller could never find it: `scanRegions` walks
  // `document.querySelectorAll("*")`, which stops at a closed root's host, and
  // the host itself had no overflow. Measured consequence: entering reader mode
  // left `j`/`k`/`d`/`u` moving NOTHING (the document cannot scroll either, since
  // `html` is locked while the reader is up), so the article was readable only
  // with the mouse wheel. The pane has to be an element the page's own DOM can
  // see, and the only such element is the host.
  //
  // `all:initial` FIRST, and the box after it: the host is promoted to the top
  // layer (popover attribute), and the UA's popover styles are
  // `position:fixed;inset:0;margin:auto;width:fit-content;height:fit-content;
  // border:solid;padding:.25em;background:canvas;color:canvastext`. Without the
  // reset the reader would be a centred canvas-coloured box the size of its own
  // content instead of a full-viewport pane — the same trap the scroll-target
  // outline documents in content/scroll.ts.
  host.setAttribute(
    "style",
    "all:initial;position:fixed;inset:0;display:block;overflow:auto;overscroll-behavior:contain;" +
      "background:" +
      palette.bg +
      ";color:" +
      palette.fg +
      ";font:" +
      config.fontSize +
      "px/" +
      config.lineHeight +
      " " +
      fontStack(config)
  );
  const shadow = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = viewCss(config, palette);
  shadow.appendChild(style);

  const wrap = doc.createElement("div");
  wrap.className = "wrap";
  const col = doc.createElement("div");
  col.className = "col";
  wrap.appendChild(col);

  const head = doc.createElement("header");
  const h1 = doc.createElement("h1");
  h1.textContent = article.title || "Reader";
  head.appendChild(h1);
  const meta = doc.createElement("div");
  meta.className = "meta";
  const bits: string[] = [];
  if (article.byline) bits.push(article.byline);
  bits.push(article.words.toLocaleString() + " words");
  bits.push(article.blocks.length + " blocks");
  meta.innerHTML = bits.map((b) => "<span>" + esc(b) + "</span>").join("<span>·</span>");
  head.appendChild(meta);
  col.appendChild(head);

  for (const block of article.blocks) {
    const el = blockElement(doc, block);
    if (el) col.appendChild(el);
  }

  const hint = doc.createElement("div");
  hint.className = "hint";
  hint.textContent = "Esc exit · ; leader";
  wrap.appendChild(hint);
  shadow.appendChild(wrap);

  // WHICH ELEMENT HAD THE CARET, so leaving the article can hand it back (see
  // close()). Read before the overlay exists, because after it the answer is the
  // overlay itself.
  let prevFocus: HTMLElement | null = null;
  try {
    prevFocus = (doc.activeElement as HTMLElement) || null;
  } catch (e) {
    prevFocus = null;
  }

  (doc.documentElement || doc.body).appendChild(host);
  // After the append, never before: showPopover() throws on a detached element,
  // and a page that transforms `<html>` would otherwise position the article
  // against the document box instead of the viewport. The fallback is the plain
  // child-of-<html> host, which is what a browser without the top layer gets.
  promoteToTopLayer(host);
  // THE HOST TAKES THE CARET. This is not polish; it is what keeps the keyboard in
  // the page at all.
  //
  // `body { display: none }` (pageCss, above) takes away every element the user
  // could have been focused on, and the browser then moves the focus out of the
  // DOCUMENT. Measured in the e2e theme suite: with the article up, every key —
  // `j`, Escape, even the leader key — was delivered to the browser window
  // instead of the page. The article could not be scrolled, could not be left
  // with Escape, and the leader could not open over it: a live article with a
  // dead keyboard, which is the one thing a keyboard-first reader cannot be.
  //
  // `tabindex="-1"` is the right shape for a pane the user is reading: focusable,
  // so it can hold the caret, and never in the page's tab order.
  try {
    host.setAttribute("tabindex", "-1");
    host.focus({ preventScroll: true });
  } catch (e) {
    // A browser that refuses the focus still renders the article; the keys are
    // then whatever they were before, which is the behaviour this fix replaces.
  }
  if (doc.documentElement) doc.documentElement.appendChild(pageStyle);
  doc.documentElement?.setAttribute("data-lf-reader", "1");
  doc.documentElement?.setAttribute("data-lf-reader-blocks", String(article.blocks.length));
  doc.documentElement?.setAttribute("data-lf-reader-words", String(article.words));
  doc.documentElement?.setAttribute("data-lf-reader-theme", theme);

  let closed = false;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    close();
  };
  doc.addEventListener("keydown", onKey, true);

  function close(): void {
    if (closed) return;
    closed = true;
    doc.removeEventListener("keydown", onKey, true);
    try {
      // THE CARET GOES BACK WHERE IT WAS, for the same reason it was taken: an
      // element that is removed while focused leaves the document without one,
      // and the page behind the article would then be deaf to its own keys. Best
      // effort — a page that removed its own focused element, or one that was
      // never focused to begin with, has nothing to hand back.
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") {
        prevFocus.focus({ preventScroll: true });
      } else {
        host.blur();
      }
      host.remove();
      pageStyle.remove();
      const root = doc.documentElement;
      root?.removeAttribute("data-lf-reader");
      root?.removeAttribute("data-lf-reader-blocks");
      root?.removeAttribute("data-lf-reader-words");
      root?.removeAttribute("data-lf-reader-theme");
    } catch {
      /* the document may be going away */
    }
    deps.onClose();
  }

  return { host, scrollEl: host, close };
}
