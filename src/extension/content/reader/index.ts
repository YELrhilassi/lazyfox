// Reader mode's controller: walk the document into façades, ask the extractor,
// and own the enter/exit lifecycle.
//
// The walk is bounded on purpose (MAX_NODES / MAX_DEPTH). Extraction is a
// one-shot user action rather than a hot path, but the page it runs on can be
// enormous, and a reader key that freezes a tab for a second is a key the user
// stops pressing. When the budget runs out the walk stops and the extractor
// decides on what it has — which is the honest failure mode: a partial article,
// not a hung tab.
//
// The façade is where the DOM knowledge stays. Note what the façade DOESN'T
// carry: styles, layout, event state, our own hosts. It carries the four things
// the scorer needs — the tag, the hints the page gave it (id, class, role), how
// much text it holds, and how much of that text is inside a link — and the
// extractor's unit tests build the same structure by hand.

import { dbg } from "../../../shared/dev";
import type { Config, ReaderTheme } from "../../../shared/types";
import { extractArticle, type Node as FacadeNode } from "./extract";
import { renderReader, type ReaderView } from "./render";

export interface ReaderController {
  /** `;R` — open the article, or close it if it is already open. */
  toggle(): void;
  close(): void;
  active(): boolean;
}

export interface ReaderDeps {
  doc: Document;
  win: Window;
  getConfig(): Config;
  toast(msg: string): void;
  /** Drop any cycled scroll target, so the article becomes the target. */
  resetScroll(): void;
  /** Extract the page's accent, so the article's links match the theme. */
  accent(): string;
}

/** Tags that can never hold prose. */
const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "link",
  "meta",
  "head",
  "iframe",
  "canvas",
  "svg",
  "video",
  "audio",
  "select",
  "textarea",
  "input",
  "button",
]);

/** Tags whose text is theirs: a paragraph's prose is not its parent's. */
const OWN_TEXT_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "figcaption",
  "td",
  "th",
  "dt",
  "dd",
]);

const MAX_NODES = 12000;
const MAX_DEPTH = 30;

function isHidden(el: Element): boolean {
  try {
    if (el.hasAttribute("hidden")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const style = (el as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Turn one element (and its subtree) into a façade node. Returns the node, plus
 * the subtree's text and link-text lengths — computed on the way UP, so the
 * whole document costs one traverse rather than one `textContent` read per node.
 */
function walk(
  el: Element,
  depth: number,
  budget: { left: number }
): { node: FacadeNode; text: number; linkText: number } | null {
  if (budget.left <= 0 || depth > MAX_DEPTH) return null;
  const tag = (el.tagName || "").toLowerCase();
  if (!tag || SKIP_TAGS.has(tag)) return null;
  if (el.id && el.id.indexOf("lazyfox-") === 0) return null;
  budget.left--;

  const children: FacadeNode[] = [];
  let childText = 0;
  let childLink = 0;
  let elementChildren: Element[] = [];
  try {
    elementChildren = Array.from(el.children);
  } catch {
    elementChildren = [];
  }
  for (const child of elementChildren) {
    const built = walk(child, depth + 1, budget);
    if (!built) continue;
    children.push(built.node);
    childText += built.text;
    childLink += built.linkText;
  }

  const own = OWN_TEXT_TAGS.has(tag) ? (el.textContent || "").trim() : "";
  const hidden = isHidden(el);
  const node: FacadeNode = {
    tag,
    id: el.id || undefined,
    classes: el.classList ? Array.from(el.classList) : undefined,
    text: own.length + childText,
    linkText: tag === "a" ? own.length + childText + childLink : childLink,
    depth,
    hidden,
    role: el.getAttribute("role") || undefined,
    own,
    children,
  };
  if (tag === "img") {
    node.src = el.getAttribute("src") || undefined;
    node.alt = el.getAttribute("alt") || undefined;
  }
  return { node, text: node.text, linkText: node.linkText };
}

function resolveTheme(config: Config, doc: Document): ReaderTheme {
  const pref = config.reader.theme;
  if (pref && pref !== "auto") return pref;
  // `auto` follows the dark engine's own decision for this page: a reader inside
  // a page that was darkened should not flash a white column at the user.
  try {
    return doc.documentElement?.getAttribute("data-lf-scheme") === "dark" ? "dark" : "light";
  } catch {
    return "dark";
  }
}

export function createReader(deps: ReaderDeps): ReaderController {
  let view: ReaderView | null = null;

  function close(): void {
    if (!view) return;
    const v = view;
    view = null;
    v.close();
  }

  return {
    active: () => !!view,
    close,

    toggle(): void {
      if (view) {
        close();
        return;
      }
      const doc = deps.doc;
      const root = doc.body || doc.documentElement;
      if (!root) {
        deps.toast("reader: nothing to read here");
        return;
      }
      const config = deps.getConfig();
      let article = null;
      try {
        const built = walk(root, 0, { left: MAX_NODES });
        article = built ? extractArticle(built.node, doc.title || "", config.reader.images !== false) : null;
      } catch (e) {
        // A broken page must not take the key with it: report and stay out.
        if (__DEV__) dbg("reader: extraction threw", (e && (e as Error).message) || String(e));
        article = null;
      }
      if (!article) {
        deps.toast("reader: could not find an article on this page");
        return;
      }
      const theme = resolveTheme(config, doc);
      let created: ReaderView;
      try {
        created = renderReader({
          doc,
          article,
          config: config.reader,
          theme,
          accent: deps.accent(),
          onClose: () => {
            view = null;
          },
        });
      } catch (e) {
        view = null;
        if (__DEV__) dbg("reader: render threw", (e && (e as Error).message) || String(e));
        deps.toast("reader: could not draw the article");
        return;
      }
      view = created;
      // The article is now the page's only scroller; drop any region the user
      // had cycled to, so `j`/`k` address the thing they are looking at.
      deps.resetScroll();
      try {
        created.scrollEl.scrollTop = 0;
      } catch {
        /* ignore */
      }
    },
  };
}
