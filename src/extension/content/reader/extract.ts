// Reader mode's extraction, as a PURE function over a tree of façades.
//
// The walk is the DOM shell's job (index.ts): it hands over
// `{tag, id, classes, text, linkText, depth, role, hidden, children}` and gets
// back an article. That split is the house rule — a module worth testing may not
// name the DOM in its signature — and here it buys something specific: the
// scoring, the penalty table and the block collection are all testable in Node
// with hand-built trees, so "why did it pick the sidebar" is answerable by a
// unit test instead of by opening a browser.
//
// WHAT THIS IS NOT: it is not Readability, and it should not pretend to be. That
// project's algorithm is a decade of site-specific fixes; this is its shape —
// score candidate containers by how much prose they hold and how little of it is
// links, prefer what the page itself calls an article, penalise what it calls a
// sidebar — with the escape hatch that matters: when nothing scores well enough,
// reader mode REPORTS that rather than rendering a mess. A reader that opens on
// the wrong element is worse than one that says it could not find the article.

export interface Node {
  /** Lowercase tag name. */
  tag: string;
  id?: string;
  classes?: string[];
  /** Length of the text this node holds itself (not its descendants'). */
  text: number;
  /** How much of that text sits inside a link. */
  linkText: number;
  depth: number;
  /** `display:none` / `hidden` / `aria-hidden`. */
  hidden?: boolean;
  /** `role` attribute, when it says something useful. */
  role?: string;
  /** Text of the node when it is a leaf block (paragraph, heading, list item). */
  own?: string;
  /** For images: the source and alt text. */
  src?: string;
  alt?: string;
  children: Node[];
}

export interface Block {
  /** p | h | quote | pre | ul | ol | img | rule */
  kind: "p" | "h" | "quote" | "pre" | "ul" | "ol" | "img" | "rule";
  text?: string;
  /** 1-6 for headings. */
  level?: number;
  /** List items, for ul/ol. */
  items?: string[];
  src?: string;
  alt?: string;
}

export interface Article {
  title: string;
  byline: string;
  blocks: Block[];
  /** The winning node's score, exposed so a failure can be explained. */
  score: number;
  words: number;
}

/**
 * How much a tag is *for* prose, and how much it is for chrome.
 *
 * Both tables are deliberately short. A long table of tag weights is how these
 * scorers turn into site-specific fix lists nobody can reason about; the class /
 * id hint tables below do the site-specific work instead, and those are visible
 * and editable in one place.
 */
const TAG_SCORE: Record<string, number> = {
  article: 12,
  main: 9,
  section: 3,
  div: 1,
  blockquote: 4,
  pre: 3,
  td: 1,
  form: -6,
  nav: -30,
  aside: -18,
  header: -14,
  footer: -30,
  menu: -30,
  button: -12,
  select: -12,
};

const POSITIVE_HINT = /(^|[-_ ])(article|content|main|body|post|entry|story|text|read|prose|chapter|item-page)/i;
const NEGATIVE_HINT =
  /(^|[-_ ])(comment|sidebar|footer|footnote|header|nav|menu|promo|share|social|related|recommend|sponsor|advert|ads?|popup|modal|cookie|breadcrumb|pagination|pager|meta|toolbar|subscribe|newsletter|masthead|banner|widget|search)/i;

/** Below this, nothing is rendered: a reader on the wrong element is worse. */
export const MIN_SCORE = 20;
/** A paragraph shorter than this is a caption, a label, or noise. */
const MIN_BLOCK_CHARS = 3;
/** Hard cap on the article, so a pathological page cannot build a huge tree. */
const MAX_BLOCKS = 600;

function hintScore(node: Node): number {
  const hay = (node.id || "") + " " + (node.classes || []).join(" ");
  if (!hay.trim()) return 0;
  let score = 0;
  if (POSITIVE_HINT.test(hay)) score += 20;
  if (NEGATIVE_HINT.test(hay)) score -= 25;
  return score;
}

function linkDensity(node: Node): number {
  if (node.text <= 0) return 0;
  return Math.min(1, node.linkText / node.text);
}

function roleScore(node: Node): number {
  switch (node.role) {
    case "article":
      return 12;
    case "main":
      return 9;
    case "navigation":
    case "menu":
      return -30;
    case "banner":
    case "contentinfo":
      return -25;
    case "complementary":
      return -18;
    case "dialog":
      return -20;
    default:
      return 0;
  }
}

function paragraphCount(node: Node): number {
  return node.children.filter((c) => c.tag === "p").length;
}

/**
 * Score every node bottom-up: `{best, scores}`.
 *
 * Children are folded into their parent at half weight, which is what makes a
 * wrapper `div` around three good paragraphs beat a sidebar that happens to hold
 * a lot of short text — the wrapper inherits its children's evidence while the
 * sidebar's per-node density stays low.
 */
export function scoreTree(root: Node): { best: Node | null; scores: Map<Node, number> } {
  const scores = new Map<Node, number>();
  const visit = (node: Node): number => {
    let score = TAG_SCORE[node.tag] ?? 0;
    score += roleScore(node);
    score += hintScore(node);
    if (node.hidden) {
      // -Infinity, recorded rather than merely returned: a hidden subtree must
      // never win, and a caller asking "why was the sidebar picked" needs the
      // score of the thing that was skipped, not a missing entry.
      scores.set(node, -Infinity);
      return -Infinity;
    }
    let childSum = 0;
    for (const child of node.children) {
      const childScore = visit(child);
      if (childScore !== -Infinity && childScore > 0) childSum += childScore;
    }
    score += childSum / 2;
    const length = node.text;
    if (length > 0) score += Math.min(8, Math.log(length / 40 + 1) * 2.4);
    const paragraphs = paragraphCount(node);
    if (paragraphs > 0) score += Math.min(10, paragraphs * 1.6);
    score -= linkDensity(node) * 22;
    // Deep nodes are penalised a little: the same prose nested twelve divs down
    // is usually a card in a list rather than the article.
    if (node.depth > 8) score -= (node.depth - 8) * 1.5;
    scores.set(node, score);
    return score;
  };
  visit(root);
  let best: Node | null = null;
  let bestScore = -Infinity;
  for (const [node, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return { best: bestScore > 0 ? best : null, scores };
}

/** Trim a page title of the site suffix most sites append. */
export function cleanTitle(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  for (const sep of [" | ", " – ", " — ", " - ", " · ", " :: ", "»"]) {
    const at = t.indexOf(sep);
    if (at > 12) return t.slice(0, at).trim();
  }
  return t;
}

function pushBlocks(node: Node, out: Block[], images: boolean): void {
  if (out.length >= MAX_BLOCKS) return;
  if (node.hidden) return;
  const hay = (node.id || " ") + " " + (node.classes || []).join(" ");
  if (NEGATIVE_HINT.test(hay)) return;
  switch (node.tag) {
    case "p": {
      const text = (node.own || "").trim();
      if (text.length >= MIN_BLOCK_CHARS) out.push({ kind: "p", text });
      return;
    }
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = (node.own || "").trim();
      if (text.length >= MIN_BLOCK_CHARS) {
        out.push({ kind: "h", level: Number(node.tag.slice(1)), text });
      }
      return;
    }
    case "blockquote": {
      const text = (node.own || "").trim();
      if (text.length >= MIN_BLOCK_CHARS) out.push({ kind: "quote", text });
      else for (const child of node.children) pushBlocks(child, out, images);
      return;
    }
    case "pre": {
      const text = (node.own || "").trim();
      if (text) out.push({ kind: "pre", text });
      return;
    }
    case "ul":
    case "ol": {
      const items = node.children
        .filter((c) => c.tag === "li")
        .map((li) => (li.own || "").trim())
        .filter((t) => t.length >= MIN_BLOCK_CHARS);
      if (items.length) out.push({ kind: node.tag === "ol" ? "ol" : "ul", items });
      return;
    }
    case "img": {
      if (!images) return;
      if (node.src && !/^data:/i.test(node.src)) {
        out.push({ kind: "img", src: node.src, alt: (node.alt || "").trim() });
      }
      return;
    }
    case "figure": {
      for (const child of node.children) pushBlocks(child, out, images);
      return;
    }
    case "hr": {
      out.push({ kind: "rule" });
      return;
    }
    default: {
      for (const child of node.children) pushBlocks(child, out, images);
      return;
    }
  }
}

/** A byline, if the article names one. Short, and never invented. */
export function findByline(root: Node, best: Node | null): string {
  if (!best) return "";
  let found = "";
  const walk = (node: Node, depth: number) => {
    if (found || depth > 3) return;
    const hay = (node.id || "") + " " + (node.classes || []).join(" ");
    if (/(byline|author|dateline|posted-by|meta__author)/i.test(hay)) {
      const text = (node.own || "").trim();
      if (text.length > 1 && text.length <= 120) found = text;
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(best, 0);
  if (found) return found;
  // `rel="author"` has no representation in the façade's hint tables, so the
  // owner's own attribute wins when the shell supplied one: a byline is a nice
  // to have, and guessing one from prose is worse than going without.
  void root;
  return "";
}

/** Count words in the collected blocks, for the header line and the mirror. */
export function countWords(blocks: Block[]): number {
  let words = 0;
  for (const b of blocks) {
    if (b.text) words += b.text.split(/\s+/).length;
    if (b.items) for (const it of b.items) words += it.split(/\s+/).length;
  }
  return words;
}

/**
 * The whole extraction: pick the container, collect the blocks, name the piece.
 * Returns null when nothing scored well enough to be worth rendering.
 */
export function extractArticle(root: Node, pageTitle: string, images = true): Article | null {
  const { best, scores } = scoreTree(root);
  if (!best) return null;
  const score = scores.get(best) ?? 0;
  if (score < MIN_SCORE) return null;
  const blocks: Block[] = [];
  pushBlocks(best, blocks, images);
  // A single heading and nothing under it is a menu, not an article.
  const prose = blocks.filter((b) => b.kind === "p" || b.kind === "quote" || b.kind === "pre").length;
  if (prose === 0) return null;
  const words = countWords(blocks);
  if (words < 40) return null;
  let title = cleanTitle(pageTitle);
  const firstHeading = blocks.find((b) => b.kind === "h" && (b.level || 9) <= 2 && b.text);
  if (firstHeading?.text) title = firstHeading.text;
  return { title, byline: findByline(root, best), blocks, score, words };
}
