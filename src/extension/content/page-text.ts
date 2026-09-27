// The page-text walk shared by find-in-page and yank mode.
//
// Both features need the same thing: the page's own text, flattened into one
// string, with a map back to the source nodes so a match or a cursor position
// can be turned into real DOM ranges. They differed only in what they did with
// the text they found:
//
//   yank  appends each text node verbatim, breaks lines at block edges
//   find  collapses whitespace runs, uses a sentinel that can never match, and
//         records node offsets so a match spanning several <span>s resolves
//
// Everything else was duplicated, verbatim, in both: the explicit stack (no
// recursion, because framework pages nest 40+ deep and a depth cap silently
// drops real text), the 4MB char budget, the skip-tag set, the visibility
// check, the <br> case, the block set, the open-shadow-root replacement, the
// leave-sentinel that pops after the children, the reversed child push, and the
// per-node try/catch that keeps one bad node from aborting the scan.
//
// That is the walk below: one implementation, with the text handling supplied
// by the caller. Duplicated walkers are worse than duplicated helpers here,
// because the subtle parts (leave-sentinel ordering, reversed pushes) have to
// agree with each other or the two features disagree about where a line is --
// and a disagreement in that area stays invisible until a yank lands one
// character off.

export const FIND_SKIP = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT", "SELECT", "IFRAME", "TITLE",
  "TEMPLATE", "OBJECT", "EMBED",
]);

// Block-level elements: entering or leaving one is a line boundary in the flat
// text, so the Go core's line motions (j/k/gg/G/yy/ip) see a rendered document
// instead of one endless run-on line. Inline elements (span/a/strong/...)
// contribute no breaks, exactly like CSS flow.
export const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
  "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR",
  "UL",
]);

// Components whose text is never page content: nav chrome, mastheads, footers,
// sidebars, form controls, buttons, dialogs -- and anything explicitly marked
// aria-hidden. A visual selection must operate on the content tree, not on
// whatever chrome happens to sit between two cursor positions, or a yank sweeps
// in "Show all" chips and site furniture.
const CHROME_TAGS = new Set([
  "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "BUTTON", "SELECT",
  "TEXTAREA", "INPUT", "MENU", "MENUITEM", "TOOLBAR", "DIALOG",
]);

const CHROME_ROLES = new Set([
  "button", "navigation", "menubar", "menu", "menuitem", "tablist", "tab",
  "search", "banner", "contentinfo", "complementary", "dialog", "toolbar",
  "form",
]);

// Memoized: walking ancestors per element is O(depth), and the full-page scans
// run repeatedly on lazy-loading pages. An element moved from content into
// chrome after being cached would be stale, which is vanishingly rare and
// harmless given the scan is best-effort either way.
const chromeCache = new WeakMap<Element, boolean>();

// True when the element is part of a chrome component: itself, an ancestor tag,
// or a chrome role / aria-hidden on the way up.
export function isChromeNode(el: Element): boolean {
  const hit = chromeCache.get(el);
  if (hit !== undefined) return hit;
  let cur: Element | null = el;
  let res = false;
  while (cur) {
    if (CHROME_TAGS.has(cur.tagName)) {
      res = true;
      break;
    }
    const r = cur.getAttribute ? cur.getAttribute("role") : null;
    if (r && CHROME_ROLES.has(r.toLowerCase())) {
      res = true;
      break;
    }
    const ah = cur.getAttribute ? cur.getAttribute("aria-hidden") : null;
    if (ah === "true") {
      res = true;
      break;
    }
    cur = cur.parentElement;
  }
  chromeCache.set(el, res);
  return res;
}

// Whether an element is rendered at all: display:none and
// content-visibility:hidden subtrees are not real content. checkVisibility
// accounts for CSS overriding the hidden attribute, so a framework that marks a
// container hidden in markup but shows it via CSS still keeps its text.
// content-visibility:auto counts as visible (it renders on scroll).
export const visible = (el: Element): boolean => {
  try {
    const h = el as HTMLElement;
    if (typeof h.checkVisibility === "function") return h.checkVisibility();
    if (h.hidden) return false;
    if (h.style && h.style.display === "none") return false;
    return true;
  } catch (e) {
    // Be conservative: include the text rather than lose it.
    return true;
  }
};

// Whitespace for the find-text collapse: space, tab, LF, CR and nbsp. The query
// cleaner applies the same set, which is why "lazy  fox" and "lazy&nbsp;fox"
// both find "lazy fox" on the page.
export const isWs = (cc: number): boolean =>
  cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 0xa0;// Normalizes a query the same way the find walk normalizes the page, so the two
// are comparable: nbsp becomes a space, any whitespace run collapses to one
// space, and the edges are trimmed.
//
// The first pattern holds a LITERAL U+00A0 rather than the escape. It reads as
// a space in most editors, which is the point -- but it also means a tool that
// "helpfully" normalises whitespace in this file would silently break nbsp
// handling. tests/test-page-text.ts pins the behaviour so that breakage is a
// failing test rather than a subtle search bug.
export function cleanQuery(q: string): string {
  return q.replace(/ /g, " ").replace(/[ \t\r\n]+/g, " ").trim();
}

export interface WalkHooks {
  /** One text node's content, verbatim. The caller decides how to fold it. */
  onText(node: Text, data: string): void;
  /**
   * A line/block boundary: a block element entered or left, or a <br>. Called
   * at both ends of a block, so a caller that only wants a break on entry can
   * ignore the trailing call (and vice versa).
   */
  onEdge(): void;
  /**
   * Drop chrome components (nav, buttons, aria-hidden subtrees). Yank mode
   * wants this; find does not, because a user searching for a button's label
   * should find it.
   */
  excludeChrome?: boolean;
  /**
   * Every open shadow root the walk descends into, so the caller can observe it
   * (find attaches a MutationObserver per root, because a body-level observer
   * cannot see inside one).
   */
  onShadowRoot?(sr: ShadowRoot): void;
}

/**
 * Walk the document's visible text in reading order, reporting text nodes and
 * block boundaries to `hooks`.
 *
 * The traversal is iterative on purpose. A recursion cap looked safer and
 * silently dropped content: Google-style framework pages nest 40+ divs deep,
 * and a word buried that deep simply did not exist as far as search was
 * concerned.
 */
export function walkPageText(hooks: WalkHooks): void {
  const root = document.body || document.documentElement;
  interface St {
    n: Node | null;
    chrome: boolean;
    root: boolean;
  }
  // A char budget for pathological pages.
  const MAX_CHARS = 4 * 1024 * 1024;
  let emitted = 0;

  const stack: St[] = [{ n: root, chrome: false, root: true }];
  while (stack.length) {
    if (emitted > MAX_CHARS) break;
    const st = stack.pop()!;
    try {
      if (st.n === null) {
        // Leaving a block element closes the line.
        hooks.onEdge();
        continue;
      }
      const n = st.n;
      if (n.nodeType === Node.TEXT_NODE) {
        if (st.chrome) continue;
        const p = n.parentElement;
        if (p && FIND_SKIP.has(p.tagName)) continue;
        const data = (n as Text).data || "";
        // A whitespace-only text node is NOT skipped here. The find sink needs
        // it: `<span>foo</span> <span>bar</span>` relies on that lone space
        // becoming the single collapsed separator in the flat text. Yank's sink
        // skips them itself, because it appends verbatim.
        emitted += data.length;
        hooks.onText(n as Text, data);
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) {
        // Document / ShadowRoot: children, with no block semantics of its own.
        const kids = (n as ParentNode).childNodes;
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ n: kids[i]!, chrome: st.chrome, root: false });
        }
        continue;
      }
      const el = n as HTMLElement;
      const tag = el.tagName;
      if (FIND_SKIP.has(tag)) continue;
      let chrome = st.chrome;
      if (!chrome && hooks.excludeChrome) chrome = isChromeNode(el);
      if (chrome) continue; // the whole subtree is chrome
      if (!st.root && !visible(el)) continue;
      if (tag === "BR") {
        hooks.onEdge();
        continue;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) hooks.onEdge();
      // Shadow DOM replaces the light children visually, so walk the shadow
      // tree instead: the flat text then matches what is actually rendered.
      let kids: NodeList;
      const sr = el.shadowRoot;
      if (sr && sr.mode === "open") {
        if (hooks.onShadowRoot) hooks.onShadowRoot(sr);
        kids = sr.childNodes;
      } else {
        kids = el.childNodes;
      }
      // The leave-edge is pushed FIRST so it pops AFTER the children; children
      // are pushed reversed so they pop in document order. Getting either of
      // these backwards turns every block into its mirror image.
      if (block) stack.push({ n: null, chrome: chrome, root: false });
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ n: kids[i]!, chrome: chrome, root: false });
      }
    } catch (e) {
      // One bad node must not abort the scan: skip it and keep walking.
    }
  }
}
