// The content script's ActionOps implementation: every shared leader action
// and popup data source, backed by background messages (shared/protocol). The
// chrome helper implements the same interface natively; content scripts can
// never touch chrome APIs, so everything goes through the background.

import { coreReady, coreSync, type CoreApi } from "../../shared/core";
import { copyText } from "../../shared/dom";
import { toast, type PopupCtl } from "../../shared/overlay";
import type { ActionOps } from "../../shared/ops";
import { send } from "../../shared/protocol";
import type { Config, PopupItem } from "../../shared/types";

export interface ContentPopupShell {
  open(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl;
  close(): void;
}

export interface ContentOpsDeps {
  shell: ContentPopupShell;
  config: () => Config;
  startHints(): void;
  focusFirstInput(): void;
  // Live find-in-page state for the status bar: called on every count/walk
  // change with { cur (1-based, 0 = nothing walked to yet), count }, and
  // with null when the find widget closes. The host feeds its own status bar
  // and relays the state to the chrome helper via send("syncFind").
  setFindState?(s: { cur: number; count: number } | null): void;
}

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

/* ---------- content-native popups (find, resize) ---------- */

// The find widget is a MINI popup pinned to the bottom-right (above the
// status bar) instead of a centered modal: it never covers the page, so the
// text around a match stays visible while you walk it. The full-screen
// wrapper the shared engine creates is made pointer-transparent here (clicks
// fall through to the page); only the small panel captures input. The count
// updates live as you type; Enter jumps and switches to command mode, where
// y copies the match with a neovim-style flash and Y opens the full yank
// mode (Go core motions/text objects with a block cursor).
const FIND_CSS =
  ".lf-popup{inset:auto !important;right:14px !important;bottom:26px !important;" +
  "background:none !important;align-items:flex-end !important;justify-content:flex-end !important;" +
  "pointer-events:none !important;}" +
  ".lf-popup .lf-panel{pointer-events:auto;width:380px;max-width:94vw;max-height:none;}" +
  ".lf-frow{display:flex;align-items:center;gap:8px;padding:8px 12px;}" +
  ".lf-finput{flex:1;min-width:0;background:#16161e;border:1px solid #414868;border-radius:6px;color:#c0caf5;" +
  "font:13px ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;padding:5px 9px;outline:none;}" +
  ".lf-finput:focus{border-color:#7aa2f7;}" +
  ".lf-finput.lf-cmd{color:#565f89;}" +
  ".lf-finput.lf-yank{border-color:#e0af68;}" +
  ".lf-fcount{flex:none;font:700 11px ui-monospace,Menlo,Consolas,monospace;color:#7aa2f7;" +
  "background:#16161e;border:1px solid #414868;border-radius:6px;padding:3px 8px;min-width:34px;text-align:center;}" +
  ".lf-fcount.zero{color:#f7768e;border-color:#f7768e;}" +
  ".lf-fcount.vis{background:#292e42;border-color:#2ac3de;color:#2ac3de;}" +
  ".lf-fcount.sel{background:#292e42;border-color:#e0af68;color:#e0af68;}" +
  ".lf-fhint{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:center;padding:6px 12px 8px;" +
  "font-size:10px;color:#565f89;border-top:1px solid #2a2f45;min-height:20px;}" +
  ".lf-fhint b{color:#7aa2f7;font-weight:700;}" +
  ".lf-frange{flex:1;text-align:right;color:#e0af68;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}";

const FIND_HTML =
  "<style>" + FIND_CSS + "</style>" +
  "<div class='lf-panel'>" +
  "<div class='lf-frow'>" +
  "<input class='lf-finput' placeholder='find in page' spellcheck='false'/>" +
  "<span class='lf-fcount'>0</span>" +
  "</div>" +
  "<div class='lf-fhint'>" +
  "<span class='lf-fkeys'><b>Enter</b> next &middot; <b>Shift+Enter</b> prev &middot; <b>Esc</b> close</span>" +
  "<span class='lf-frange'></span>" +
  "</div>" +
  "</div>";

const RESIZE_CSS =
  ".rz{position:fixed;right:18px;bottom:18px;z-index:2147483647;min-width:320px;" +
  "background:rgba(20,20,30,.98);color:#c0caf5;font:13px/1.5 ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;" +
  "border:1px solid #414868;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);padding:12px 14px}" +
  ".rz-title{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#565f89;" +
  "border-bottom:1px solid #2a2f45;padding-bottom:8px;margin-bottom:8px}" +
  ".rz-size{font-size:16px;color:#7aa2f7;font-weight:600}" +
  ".rz-keys{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:#9aa5ce}" +
  ".rz-k{display:inline-block;background:#16161e;border:1px solid #414868;border-bottom-width:2px;" +
  "border-radius:4px;padding:0 6px;color:#7aa2f7;font-size:11px;margin-right:6px}";

const RESIZE_HTML =
  "<style>" + RESIZE_CSS + "</style>" +
  "<div class='rz'><div class='rz-title'>Resize window</div>" +
  "<div class='rz-size'>\u2014 \u00d7 \u2014</div>" +
  "<div class='rz-keys'>" +
  "<span><span class='rz-k'>\u2190\u2191\u2192\u2193</span> resize</span>" +
  "<span><span class='rz-k'>shift+arrow</span> fine step</span>" +
  "<span><span class='rz-k'>m</span> maximize</span>" +
  "<span><span class='rz-k'>esc</span> done</span>" +
  "</div></div>";

// One find match in the flat search text (see buildFindText below): its
// [sOff, eOff) offsets and the DOM pieces it spans. A match may cross text
// nodes / shadow boundaries (e.g. "lazy" in one <span> and "fox" in the
// next), so pieces carries one {node, start, end} per touched text node for
// highlighting and copying.
interface FindPiece {
  node: Text;
  start: number;
  end: number;
}
interface FindHit {
  sOff: number;
  eOff: number;
  text: string;
  pieces: FindPiece[];
}

const FIND_SKIP = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT", "SELECT", "IFRAME", "TITLE",
  "TEMPLATE", "OBJECT", "EMBED",
]);

// Components whose text is never content: nav chrome, mastheads, footers,
// sidebars, form controls, buttons, dialogs — and anything explicitly marked
// aria-hidden. buildYankText excludes them from the flat text, so a multi-line
// visual selection can never sweep in "Show all"-style chips, site chrome, or
// decorative labels: the yanked text is the page's real content tree, not
// whatever happened to sit between two cursor positions.
const YANK_CHROME = new Set([
  "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "BUTTON", "SELECT",
  "TEXTAREA", "INPUT", "MENU", "MENUITEM", "TOOLBAR", "DIALOG",
]);

const CHROME_ROLES = new Set([
  "button", "navigation", "menubar", "menu", "menuitem", "tablist", "tab",
  "search", "banner", "contentinfo", "complementary", "dialog", "toolbar",
  "form",
]);

// True when the element is part of a chrome component (self, ancestor tag, or
// role/aria-hidden on the way up). Walking ancestors per element is O(depth),
// but the scan is debounced/cached and short-circuits at the first chrome
// ancestor, so it stays cheap even on 50k-node pages.
function isChromeNode(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (YANK_CHROME.has(cur.tagName)) return true;
    const r = cur.getAttribute ? cur.getAttribute("role") : null;
    if (r && CHROME_ROLES.has(r.toLowerCase())) return true;
    const ah = cur.getAttribute ? cur.getAttribute("aria-hidden") : null;
    if (ah === "true") return true;
    cur = cur.parentElement;
  }
  return false;
}

// Whether an element is rendered at all (display:none / content-visibility:
// hidden subtrees are not real content). checkVisibility accounts for CSS
// overrides of the hidden attribute, so a framework page that marks a
// container hidden in markup but shows it via CSS still keeps its text.
// content-visibility:auto content counts as visible (it renders on scroll).
const visible = (el: Element): boolean => {
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

/* ---------- page text model for the Go yank core ---------- */

// Block-level elements: entering or leaving one inserts a synthetic '\n' in
// the flat yank text, so the Go core's line motions (j/k/gg/G/yy/ip) see a
// rendered document instead of one endless run-on line. Inline elements
// (span/a/strong/...) contribute no breaks, exactly like CSS flow.
const YANK_BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
  "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR",
  "UL",
]);

// One flat-text segment: the text node it came from and its [start, end)
// offsets in the flat string (UTF-16 units). Used to map the Go core's
// (line, col) cursor back to a DOM position for the caret and the flash.
interface YankSeg {
  node: Text;
  start: number;
  end: number;
}

// Flattens the page into one string for the Go yank core. Open shadow roots
// are pierced (framework custom elements like Reddit's <faceplate-*> keep
// their rendered text there, so window.find-style DOM walks miss it), and
// synthetic '\n' are inserted at block boundaries so line motions work.
function buildYankText(): { text: string; segs: YankSeg[] } {
  const body = document.body || document.documentElement;
  let text = "";
  const segs: YankSeg[] = [];
  const nl = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  // Iterative walk (explicit stack, no depth cap): framework pages nest
  // content 40+ divs deep (Google's AI Overview, React apps), so a fixed
  // recursion limit silently drops real text — words like "blood" in an AI
  // Overview were invisible to search. Chrome components (nav, buttons,
  // headers/footers, sidebars, aria-hidden) are excluded: selection must
  // operate on the page's content tree, not on whatever chrome sits between
  // two cursor positions. Per-node errors skip one node instead of aborting
  // the whole scan; a char budget bounds pathological pages.
  const MAX_CHARS = 4 * 1024 * 1024;
  interface YkSt {
    n: Node | null;
    chrome: boolean;
    block: boolean;
    root: boolean;
  }
  const stack: YkSt[] = [{ n: body, chrome: false, block: false, root: true }];
  while (stack.length) {
    if (text.length > MAX_CHARS) break;
    const st = stack.pop()!;
    try {
      if (st.n === null) {
        // Leaving a block element: its newline closes the rendered line.
        nl();
        continue;
      }
      const n = st.n;
      if (n.nodeType === Node.TEXT_NODE) {
        if (st.chrome) continue;
        const p = n.parentElement;
        if (p && FIND_SKIP.has(p.tagName)) continue;
        const data = (n as Text).data || "";
        if (!data.trim()) continue;
        segs.push({ node: n as Text, start: text.length, end: text.length + data.length });
        text += data;
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) {
        // Document/ShadowRoot: walk children without block semantics.
        const kids = (n as ParentNode).childNodes;
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ n: kids[i]!, chrome: st.chrome, block: false, root: false });
        }
        continue;
      }
      const el = n as HTMLElement;
      const tag = el.tagName;
      if (FIND_SKIP.has(tag)) continue;
      let chrome = st.chrome;
      if (!chrome) chrome = isChromeNode(el);
      if (chrome) continue; // chrome subtree: skip entirely
      if (!st.root && !visible(el)) continue;
      if (tag === "BR") {
        nl();
        continue;
      }
      const block = YANK_BLOCK.has(tag);
      if (block) nl();
      // Shadow DOM replaces the light children visually: walk the shadow tree
      // instead so the yank text matches what is actually rendered.
      let kids: NodeList;
      const sr = el.shadowRoot;
      if (sr && sr.mode === "open") kids = sr.childNodes;
      else kids = el.childNodes;
      // Leave-sentinel first (it pops AFTER the children), children reversed.
      if (block) stack.push({ n: null, chrome: chrome, block: true, root: false });
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ n: kids[i]!, chrome: chrome, block: false, root: false });
      }
    } catch (e) {
      // One bad node must not abort the scan: skip it and keep walking.
    }
  }
  return { text: text, segs: segs };
}

/* ---------- flat search text + query cleaning ---------- */

// Normalizes a search query the same way buildFindText normalizes the page:
// nbsp -> space, any whitespace run -> one space, edges trimmed. Searching
// "lazy  fox" or "lazy\u00A0fox" therefore finds "lazy fox" on the page.
function cleanQuery(q: string): string {
  return q.replace(/\u00A0/g, " ").replace(/[ \t\r\n]+/g, " ").trim();
}

// One segment of the flat search text: the source text node and which flat
// offsets came from it. noff is the node offset of flat position `start`, so
// a flat offset maps back to (node, nodeOffset) as start - s.start + s.noff.
interface FindSeg {
  node: Text;
  start: number;
  end: number;
  noff: number;
}

// Builds the page's visible text as ONE normalized string, walking open
// shadow roots (Reddit-style custom elements keep their text there). Unlike
// the yank text, whitespace runs — spaces, tabs, newlines, nbsp, even across
// node boundaries — collapse to a single space, so queries match regardless
// of how a framework split the text. Block boundaries (reusing YANK_BLOCK)
// become a \u0001 sentinel that can never match a query, so results never
// span paragraphs. Every flat character maps back to its source (node,
// offset) through segs, letting matches that cross <span>/shadow boundaries
// resolve to real DOM ranges for highlighting and copying.
function buildFindText(
  onShadow?: (sr: ShadowRoot) => void
): { text: string; segs: FindSeg[] } {
  const body = document.body || document.documentElement;
  let text = "";
  const segs: FindSeg[] = [];
  let lastOff = -1;

  const push = (node: Text, off: number, ch: string): void => {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\u00A0") {
      const l = text[text.length - 1];
      if (l === " " || l === "\u0001") return; // collapse a run / drop next to a block edge
      text += " ";
      segs.push({ node: node, start: text.length - 1, end: text.length, noff: off });
      lastOff = off;
      return;
    }
    const s = segs[segs.length - 1];
    if (s && s.node === node && lastOff === off - 1) {
      s.end = text.length + 1; // same text node, contiguous: extend the segment
    } else {
      segs.push({ node: node, start: text.length, end: text.length + 1, noff: off });
    }
    text += ch;
    lastOff = off;
  };

  // Block edge: never matchable, and swallows an adjacent space ("lazy " +
  // <p> + "fox" reads "lazy\u0001fox", not "lazy fox" — no cross-paragraph hits).
  const blockEdge = (): void => {
    if (!text) return;
    if (text[text.length - 1] === "\u0001") return;
    if (text[text.length - 1] === " ") {
      text = text.slice(0, -1);
      segs.pop();
    }
    text += "\u0001";
  };

  // Iterative walk, same robustness as buildYankText: no depth cap (deeply
  // nested framework text must be findable), per-node error isolation, and a
  // char budget for pathological pages.
  const MAX_CHARS = 4 * 1024 * 1024;
  interface FdSt {
    n: Node | null;
    block: boolean;
    root: boolean;
  }
  const stack: FdSt[] = [{ n: body, block: false, root: true }];
  while (stack.length) {
    if (text.length > MAX_CHARS) break;
    const st = stack.pop()!;
    try {
      if (st.n === null) {
        // Leaving a block element: its sentinel terminates the block edge.
        blockEdge();
        continue;
      }
      const n = st.n;
      if (n.nodeType === Node.TEXT_NODE) {
        const p = n.parentElement;
        if (p && FIND_SKIP.has(p.tagName)) continue;
        const data = (n as Text).data || "";
        for (let i = 0; i < data.length; i++) push(n as Text, i, data[i]!);
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) {
        const kids = (n as ParentNode).childNodes;
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ n: kids[i]!, block: false, root: false });
        }
        continue;
      }
      const el = n as HTMLElement;
      const tag = el.tagName;
      if (FIND_SKIP.has(tag)) continue;
      if (!st.root && !visible(el)) continue;
      if (tag === "BR") {
        blockEdge();
        continue;
      }
      const block = YANK_BLOCK.has(tag);
      if (block) blockEdge();
      let kids: NodeList;
      const sr = el.shadowRoot;
      if (sr && sr.mode === "open") {
        if (onShadow) onShadow(sr);
        kids = sr.childNodes;
      } else {
        kids = el.childNodes;
      }
      if (block) stack.push({ n: null, block: true, root: false });
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ n: kids[i]!, block: false, root: false });
      }
    } catch (e) {
      // One bad node must not abort the scan: skip it and keep walking.
    }
  }
  return { text: text, segs: segs };
}

function openFindPopup(
  shell: ContentPopupShell,
  setFindState?: (s: { cur: number; count: number } | null) => void
): void {
  shell.open(FIND_HTML, (root) => {
    const input = root.querySelector(".lf-finput") as HTMLInputElement;
    const countEl = root.querySelector(".lf-fcount") as HTMLElement;
    const keysEl = root.querySelector(".lf-fkeys") as HTMLElement;
    const rangeEl = root.querySelector(".lf-frange") as HTMLElement;

    /* ---------- scroll-position memory (see the stack below) ---------- */

    const MAX_POS = 32;
    const posStack: Array<{ x: number; y: number }> = [];
    let startPos: { x: number; y: number } | null = null;
    let inFindScroll = false; // true while a find jump's scroll is settling

    const samePos = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;

    const pushPos = () => {
      const p = { x: window.scrollX, y: window.scrollY };
      const top = posStack[posStack.length - 1];
      if (!top || !samePos(top, p)) {
        posStack.push(p);
        if (posStack.length > MAX_POS) posStack.shift();
      }
    };

    const jumpTo = (p: { x: number; y: number }) => {
      inFindScroll = true;
      window.scrollTo(p.x, p.y);
      setTimeout(() => {
        inFindScroll = false;
      }, 60);
    };

    // Pop the latest visited position (skipping entries equal to the current
    // spot, e.g. after a manual scroll re-anchored the top to where we are).
    const backOne = (): boolean => {
      const cur = { x: window.scrollX, y: window.scrollY };
      let p = posStack.pop();
      while (p && samePos(p, cur)) p = posStack.pop();
      if (!p) return false;
      jumpTo(p);
      return true;
    };

    const restoreStart = () => {
      if (startPos && !samePos(startPos, { x: window.scrollX, y: window.scrollY })) {
        jumpTo(startPos);
      }
    };

    // A manual scroll (wheel, keys, scrollbar, touch) means the user moved
    // somewhere new: re-anchor the top of the stack so "back" returns to
    // where they actually were, not a stale pre-scroll coordinate.
    const onScroll = () => {
      // In yank mode the caret itself scrolls the window to follow the
      // cursor; that must not pollute the find position stack.
      if (yankMode !== "off") return;
      if (inFindScroll) return;
      if (!posStack.length) return;
      posStack[posStack.length - 1] = { x: window.scrollX, y: window.scrollY };
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    /* ---------- the finder ---------- */

    // The finder searches ONE flat, normalized string of the page's text
    // (buildFindText: open shadow roots pierced, whitespace runs collapsed,
    // block boundaries sentineled). That makes matching reliable on exactly
    // the pages that broke the old per-text-node indexOf walk: framework
    // pages that split words across <span>/shadow boundaries ("lazy" + "fox"),
    // that use nbsp, or that lazy-load new content into shadow roots.
    let findText = "";
    let findLower = "";
    let findSegs: FindSeg[] = [];
    let findBody: HTMLElement | null = null;
    let findAt = 0;
    let dirty = false;
    let hits: FindHit[] = [];
    let cur = -1; // index into hits; -1 = query typed but nothing walked to
    let mode: "insert" | "cmd" = "insert";
    let lastQuery = "";
    let findTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    // DOM-changed marker so the cached flat text stays fresh on lazy-loading
    // pages (infinite feeds) without re-walking the whole document on every
    // keystroke: mutations just set a flag; the next recount rebuilds once.
    // A body-level observer cannot see INTO shadow roots, so buildFindText
    // reports every open shadow root it touches and each gets its own
    // observer — lazy feeds inside Reddit-style custom elements mark dirty.
    let mo: MutationObserver | null = null;
    try {
      mo = new MutationObserver(() => {
        dirty = true;
      });
      mo.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {
      mo = null;
    }
    const observedShadows = new Set<Node>();
    const shadowObs: MutationObserver[] = [];
    const observeShadow = (sr: ShadowRoot): void => {
      if (observedShadows.has(sr)) return;
      observedShadows.add(sr);
      try {
        const o = new MutationObserver(() => {
          dirty = true;
        });
        o.observe(sr, { childList: true, subtree: true });
        shadowObs.push(o);
      } catch (e) {
        // ignore
      }
    };

    const ensureTextModel = (): void => {
      const body = document.body || document.documentElement;
      const now = Date.now();
      if (findBody === body && !dirty && now - findAt < 2000) return;
      dirty = false;
      findBody = body;
      findAt = now;
      const built = buildFindText(observeShadow);
      findText = built.text;
      findLower = built.text.toLowerCase();
      findSegs = built.segs;
    };

    // Flat offset range -> DOM pieces (one per touched text node), merging
    // adjacent pieces on the same node so the highlight is one range.
    const piecesFor = (sOff: number, eOff: number): FindPiece[] => {
      const out: FindPiece[] = [];
      let lo = 0;
      let hi = findSegs.length - 1;
      let i = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (findSegs[mid]!.end > sOff) {
          i = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      if (i < 0) return out;
      for (; i < findSegs.length; i++) {
        const s = findSegs[i]!;
        if (s.start >= eOff) break;
        const a = Math.max(sOff, s.start);
        const b = Math.min(eOff, s.end);
        const na = a - s.start + s.noff;
        const nb = b - s.start + s.noff;
        const last = out[out.length - 1];
        if (last && last.node === s.node && last.end === na) last.end = nb;
        else out.push({ node: s.node, start: na, end: nb });
      }
      return out;
    };

    // Rebuild the hit list from the flat text for the given query. The query
    // is cleaned the same way the page text was (trim, collapse whitespace,
    // nbsp -> space), so the two can never disagree. Keeps cur; callers clamp
    // after the DOM changes. Capped at 1000 hits like native find.
    const countHits = (q: string): void => {
      lastQuery = q;
      const cq = cleanQuery(q);
      ensureTextModel();
      // Remember the current match before the visual re-sort so a walk stays
      // anchored on the same result even when the order changes.
      const curS = cur >= 0 ? (hits[cur] ? hits[cur]!.sOff : -1) : -1;
      hits = [];
      if (cq) {
        const needle = cq.toLowerCase();
        const MAX_HITS = 1000;
        let idx = findLower.indexOf(needle);
        while (idx !== -1 && hits.length < MAX_HITS) {
          hits.push({
            sOff: idx,
            eOff: idx + needle.length,
            text: findText.slice(idx, idx + needle.length),
            pieces: piecesFor(idx, idx + needle.length),
          });
          idx = findLower.indexOf(needle, idx + needle.length);
        }
      }
      sortHitsVisual();
      if (curS >= 0) {
        const ni = hits.findIndex((h) => h.sOff === curS);
        cur = ni >= 0 ? ni : -1;
      }
    };

    // Visual reading-order key of a hit: the on-screen position of its first
    // laid-out rect. Walking must follow what the user SEES — DOM (flat-text)
    // order zigzags on framework pages, because Google reorders SERP blocks
    // (URL, breadcrumb, snippet) with CSS and flex/grid pages reorder columns,
    // so Enter jumping by flat offset bounces up and down. Matches inside
    // content-visibility:auto regions report empty rects until scrolled into
    // view; those sort LAST (in flat order among themselves) so a walk never
    // dives into unrendered content first — and the re-sort after each jump
    // slots them in once the browser lays them out.
    const hitKey = (h: FindHit): { top: number; left: number } => {
      for (const p of h.pieces) {
        try {
          const r = document.createRange();
          r.setStart(p.node, p.start);
          r.setEnd(p.node, p.end);
          const rs = r.getClientRects();
          for (let i = 0; i < rs.length; i++) {
            const rc = rs[i]!;
            if (rc.width > 0 || rc.height > 0) return { top: rc.top, left: rc.left };
          }
        } catch (e) {
          // cross-tree piece: try the next one
        }
      }
      return { top: Number.POSITIVE_INFINITY, left: 0 };
    };

    const sortHitsVisual = (): void => {
      if (hits.length < 2) return;
      const keys = new Map<number, { top: number; left: number }>();
      for (const h of hits) keys.set(h.sOff, hitKey(h));
      hits.sort((a, b) => {
        const ka = keys.get(a.sOff)!;
        const kb = keys.get(b.sOff)!;
        return ka.top - kb.top || ka.left - kb.left || a.sOff - b.sOff;
      });
    };

    const clearPageSelection = (): void => {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) sel.removeAllRanges();
      } catch (e) {
        // ignore
      }
    };

    const runFind = (): void => {
      const q = input.value;
      clearPageSelection();
      countHits(q);
      cur = -1;
      render();
    };

    const scheduleFind = (): void => {
      if (findTimer) clearTimeout(findTimer);
      findTimer = setTimeout(runFind, 40);
    };

    const render = (): void => {
      const total = hits.length;
      const active = total > 0 && cur >= 0;
      // In yank mode the count badge shows the Go cursor position (line:col)
      // and the hint line lists motions/operators; the find count stays on
      // the status bar so the user does not lose track of the search.
      if (yankMode !== "off") {
        clearHit();
        // Badge + preview make the yank state obvious: cursor position while
        // idle, and the live character count + text preview of the selection
        // while selecting — so the user always knows what `y` will copy.
        if (yankMode === "sel" && yankModel) {
          const aOff = yankCharOff(yankSelAnchor.line, yankSelAnchor.col);
          const cOff = yankCharOff(yankLine, yankCol);
          const n = Math.abs(cOff - aOff) + 1;
          const s = Math.min(aOff, cOff);
          const e = Math.max(aOff, cOff) + 1;
          const ch = yankModel.text[s];
          const valid = e > s && ch !== "\n" && ch !== undefined;
          countEl.textContent = valid ? n + " chars" : "0 chars";
          countEl.classList.toggle("zero", !valid);
          countEl.classList.toggle("vis", true);
          let snip = valid ? yankModel.text.slice(s, e).replace(/\s+/g, " ").trim() : "";
          if (snip.length > 46) snip = snip.slice(0, 46) + "\u2026";
          rangeEl.textContent = snip;
        } else {
          countEl.textContent = yankLine + ":" + yankCol;
          countEl.classList.toggle("zero", false);
          countEl.classList.toggle("vis", true);
          rangeEl.textContent = "";
        }
        keysEl.innerHTML = yankHints();
        updateSelHighlight();
        // Mirror the yank state onto <html> (same pattern as data-lf-find)
        // so the host and tests can read it without piercing the closed
        // popup root: idle:<line>:<col> or sel:<N chars>:<preview>.
        const yst =
          yankMode === "sel" && yankModel
            ? "sel:" + countEl.textContent + ":" + rangeEl.textContent
            : "idle:" + yankLine + ":" + yankCol;
        try {
          document.documentElement.setAttribute("data-lf-yank", yst);
        } catch (e) {
          // ignore
        }
        // Dev-only probe: when a test sets data-lf-yank-probe, mirror the flat
        // yank text so tests can assert what the component tree contains
        // (e.g. chrome excluded, deep content included).
        if (__DEV__) {
          try {
            const de = document.documentElement;
            if (de.hasAttribute("data-lf-yank-probe")) {
              de.setAttribute("data-lf-yank-text", yankModel ? yankModel.text : "");
            } else {
              de.removeAttribute("data-lf-yank-text");
            }
          } catch (e2) {
            // ignore
          }
        }
      } else {
        try {
          document.documentElement.setAttribute("data-lf-yank", "off");
        } catch (e) {
          // ignore
        }
        countEl.textContent = total === 0 ? "0" : (cur >= 0 ? cur + 1 : 0) + "/" + total;
        countEl.classList.toggle("zero", total === 0);
        countEl.classList.toggle("vis", active);
        // Context-aware hint line: typing and walking each show only their
        // own keys (same pattern as the history popup's footer).
        if (mode === "insert") {
          keysEl.innerHTML =
            "<b>Enter</b> next &middot; <b>Shift+Enter</b> prev &middot; <b>Esc</b> close";
        } else {
          keysEl.innerHTML =
            "<b>n/N</b> walk &middot; <b>y</b> copy &middot; <b>Y</b> yank mode &middot; <b>i</b> edit &middot; <b>Esc</b> close";
        }
        rangeEl.textContent = "";
        // Live match highlight: after walking, the walked match; while
        // typing, the first match (so results are visible before Enter).
        // Cleared when the query has no matches.
        if (total > 0) drawHit(hitRects(cur >= 0 ? hits[cur]! : hits[0]!));
        else clearHit();
      }
      // Status-bar state: 1-based current match (0 = nothing walked to).
      const st = total > 0 ? { cur: cur >= 0 ? cur + 1 : 0, count: total } : null;
      if (setFindState) setFindState(st);
      try {
        document.documentElement.setAttribute(
          "data-lf-find",
          st ? st.cur + "/" + st.count : "off"
        );
      } catch (e) {
        // ignore
      }
      // Mirror which match is current (or previewed) so the host and tests
      // can tell WHICH result was walked without piercing the closed popup
      // root: the source text of the match's first piece, trimmed.
      try {
        const m = total > 0 ? (cur >= 0 ? hits[cur]! : hits[0]!) : null;
        let curTxt =
          m && m.pieces.length ? (m.pieces[0]!.node.data || "").slice(0, 80).trim() : "";
        if (!curTxt && m) curTxt = m.text;
        if (curTxt) document.documentElement.setAttribute("data-lf-cur", curTxt);
        else document.documentElement.removeAttribute("data-lf-cur");
      } catch (e) {
        // ignore
      }
    };

    /* ---------- walking ---------- */

    /* ---------- match highlight (own overlay, not the page selection) ---------- */

    // The old widget highlighted via window.getSelection().addRange — which
    // throws across shadow boundaries (so Reddit-style pages showed NO
    // highlight) and gets cleared by page scripts/clicks. This overlay draws
    // amber rects over the match in a closed shadow root: it works inside
    // shadow DOM, survives clicks, and page CSS can't touch it.
    let hlHost: (HTMLElement & { _sh?: ShadowRoot }) | null = null;
    const drawHit = (rects: DOMRect[]): void => {
      if (!hlHost) {
        hlHost = document.createElement("div");
        hlHost.id = "lazyfox-hl";
        hlHost.style.cssText =
          "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
        hlHost._sh = hlHost.attachShadow({ mode: "closed" });
        document.documentElement.appendChild(hlHost);
      }
      const sh = hlHost._sh!;
      sh.textContent = "";
      if (!rects.length) return;
      const st = document.createElement("style");
      st.textContent =
        ".h{position:fixed;background:rgba(224,175,104,.38);" +
        "outline:1px solid rgba(224,175,104,.85);border-radius:2px;pointer-events:none;}";
      sh.appendChild(st);
      const n = Math.min(rects.length, 300);
      for (let i = 0; i < n; i++) {
        const r = rects[i]!;
        const d = document.createElement("div");
        d.className = "h";
        d.style.left = r.left + "px";
        d.style.top = r.top + "px";
        d.style.width = r.width + "px";
        d.style.height = r.height + "px";
        sh.appendChild(d);
      }
    };
    const clearHit = (): void => {
      if (hlHost) {
        try {
          hlHost.remove();
        } catch (e) {
          // ignore
        }
        hlHost = null;
      }
    };

    // Viewport rects of a hit (each piece may live in a different tree).
    const hitRects = (m: FindHit): DOMRect[] => {
      const out: DOMRect[] = [];
      for (const p of m.pieces) {
        try {
          const r = document.createRange();
          r.setStart(p.node, p.start);
          r.setEnd(p.node, p.end);
          const rs = r.getClientRects();
          for (let i = 0; i < rs.length; i++) out.push(rs[i]!);
        } catch (e) {
          // ignore
        }
      }
      return out;
    };

    const selectHit = (m: FindHit): void => {
      // Scroll the first piece into view (scrollIntoView on the piece's
      // element also scrolls inner overflow containers, which window.scrollTo
      // would miss on Reddit-style app pages). The highlight itself is drawn
      // by render() from hitRects; no native selection is set, so page
      // scripts and clicks cannot clear it.
      try {
        const el = m.pieces[0]?.node.parentElement;
        if (el) el.scrollIntoView({ block: "center" });
      } catch (e) {
        // ignore
      }
    };

    // With nothing selected yet, Enter picks the first hit at or below the
    // viewport top instead of always jumping to the very first (top) match,
    // so a fresh search never yanks the user away from where they are.
    const nextFromViewport = (): number => {
      const docY = window.scrollY;
      for (let i = 0; i < hits.length; i++) {
        try {
          const r = hitRects(hits[i]!)[0];
          if (r && r.top + docY >= docY - 4) return i;
        } catch (e) {
          // ignore
        }
      }
      return 0;
    };

    const walk = (back: boolean): boolean => {
      // The page may have changed since the last count: refresh the hit list
      // (cheap when the model is fresh) and drop a stale walk index.
      countHits(lastQuery);
      if (cur >= hits.length) cur = -1;
      if (!hits.length) {
        toast("no matches");
        return false;
      }
      const n = hits.length;
      let idx: number;
      if (cur < 0) idx = back ? n - 1 : nextFromViewport();
      else idx = back ? (cur - 1 + n) % n : (cur + 1) % n;
      cur = idx;
      // Walking commits the query: y/Y/n/i are commands until the user edits.
      mode = "cmd";
      input.classList.add("lf-cmd");
      try {
        input.blur();
      } catch (e) {
        // ignore
      }
      if (!startPos) startPos = { x: window.scrollX, y: window.scrollY };
      pushPos();
      inFindScroll = true;
      selectHit(hits[cur]!);
      setTimeout(() => {
        inFindScroll = false;
      }, 60);
      render();
      // content-visibility:auto pages report empty rects right after
      // scrollIntoView; redraw once the browser lays the match out so the
      // highlight actually appears over the walked match.
      setTimeout(() => {
        if (closed) return;
        // The browser may have laid out content-visibility regions only now;
        // re-sort the hits visually (countHits remaps cur by identity) and
        // redraw so the highlight and the walk order reflect the settled page.
        countHits(lastQuery);
        render();
      }, 120);
      return true;
    };

    /* ---------- yank (copy) with neovim-style flash ---------- */

    const currentHit = (): FindHit | null => (cur >= 0 ? hits[cur] || null : null);

    // Amber flash overlay over any text rects, fading out like a yank
    // highlight. Lives in a closed shadow root so page CSS can't break it.
    const flashRects = (rects: DOMRect[]): void => {
      if (!rects || !rects.length) return;
      let host = document.getElementById("lazyfox-flash") as (HTMLElement & { _sh?: ShadowRoot }) | null;
      if (!host) {
        host = document.createElement("div");
        host.id = "lazyfox-flash";
        host.style.cssText =
          "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
        host._sh = host.attachShadow({ mode: "closed" });
        document.documentElement.appendChild(host);
      }
      const sh = host._sh!;
      sh.textContent = "";
      const st = document.createElement("style");
      st.textContent =
        "@keyframes lfYank{from{opacity:.55}to{opacity:0}}" +
        ".y{position:fixed;background:#e0af68;border-radius:2px;pointer-events:none;" +
        "animation:lfYank .38s ease-out forwards;}";
      sh.appendChild(st);
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]!;
        const d = document.createElement("div");
        d.className = "y";
        d.style.left = r.left + "px";
        d.style.top = r.top + "px";
        d.style.width = r.width + "px";
        d.style.height = r.height + "px";
        sh.appendChild(d);
      }
      setTimeout(() => {
        try {
          if (host) host.remove();
        } catch (e) {
          // ignore
        }
      }, 450);
    };

    const flashNodeRange = (aNode: Text, aOff: number, bNode: Text, bOff: number): void => {
      try {
        const range = document.createRange();
        range.setStart(aNode, aOff);
        range.setEnd(bNode, bOff);
        flashRects(Array.prototype.slice.call(range.getClientRects()));
      } catch (e) {
        // range spans trees that cannot be flashed; skip the visual
      }
    };

    const flashPieces = (pieces: FindPiece[]): void => {
      const rects: DOMRect[] = [];
      for (const p of pieces) {
        try {
          const r = document.createRange();
          r.setStart(p.node, p.start);
          r.setEnd(p.node, p.end);
          const rs = r.getClientRects();
          for (let i = 0; i < rs.length; i++) rects.push(rs[i]!);
        } catch (e) {
          // ignore
        }
      }
      flashRects(rects);
    };

    const doYank = (): void => {
      // Re-sync against any DOM changes since the last count so the hits
      // match the current page (and clamp a stale walk index).
      countHits(lastQuery);
      if (cur >= hits.length) cur = hits.length - 1;
      const m = currentHit();
      if (!m) {
        toast("no match to copy");
        return;
      }
      void copyText(m.text).then((ok) => {
        if (ok) toast("copied " + m.text.length + " chars");
        else toast("copy failed");
      });
      flashPieces(m.pieces);
      render();
    };

    /* ---------- full yank mode (Go core motions + visual selection) ---------- */

    // The yank buffer lives in the Go core: this script flattens the page's
    // text (block boundaries + open shadow roots) into one string, YankParse
    // builds the line table, and EVERY cursor motion is computed by Go — so
    // the widget and the parsed page cannot drift, and the page is re-parsed
    // in real time whenever the DOM mutates (dirty). The cursor renders as a
    // block caret that scrolls the page to follow it. y opens a visual
    // selection: the anchor -> cursor range is highlighted live (with a char
    // count + text preview in the widget) and y yanks exactly that range.
    // yy yanks the whole line; Esc steps back, i returns to the query.
    interface YankModel {
      text: string;
      segs: YankSeg[];
      lineStart: number[];
      lines: number;
    }
    let yankModel: YankModel | null = null;
    let yankMode: "off" | "idle" | "pendY" | "sel" = "off";
    let yankLine = 0;
    let yankCol = 0;
    // Visual-selection anchor: where `y` was pressed. The highlighted range
    // runs anchor -> cursor (inclusive), so the user always sees exactly what
    // `y` will copy before pressing it.
    let yankSelAnchor = { line: 0, col: 0 };
    let caretEl: HTMLElement | null = null;
    let selHost: (HTMLElement & { _sh?: ShadowRoot }) | null = null;

    const tryYankApi = (): CoreApi | null => {
      try {
        if (coreReady()) return coreSync();
      } catch (e) {
        // core not ready yet
      }
      return null;
    };

    // Rebuild the flat text + Go line table. Returns false when the core
    // is still initializing (the caller shows a toast and stays put).
    const rebuildYankModel = (): boolean => {
      const api = tryYankApi();
      if (!api) return false;
      const built = buildYankText();
      const parsed = api.yankParse(built.text);
      yankModel = {
        text: built.text,
        segs: built.segs,
        lineStart: parsed.lineStart,
        lines: parsed.lines,
      };
      if (yankLine >= yankModel.lines) yankLine = yankModel.lines - 1;
      if (yankLine < 0) yankLine = 0;
      return true;
    };

    // Flat offset -> (text node, offset within it). Binary search over the
    // segment table; an offset past a segment's end clamps into it.
    const segAt = (off: number): { node: Text; nodeOff: number } | null => {
      if (!yankModel || !yankModel.segs.length) return null;
      const arr = yankModel.segs;
      let lo = 0;
      let hi = arr.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid]!.start <= off) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best < 0) return null;
      const s = arr[best]!;
      const o = off > s.end ? s.end : off;
      return { node: s.node, nodeOff: o - s.start };
    };

    const flatOf = (line: number, col: number): number => {
      if (!yankModel) return 0;
      if (line < 0) line = 0;
      if (line >= yankModel.lines) line = yankModel.lines - 1;
      return yankModel.lineStart[line]! + col;
    };

    // Flat offset of a specific text node offset (seeds the cursor at the
    // current match when yank mode opens).
    const nodeFlatOffset = (node: Text, off: number): number => {
      if (!yankModel) return 0;
      for (let i = 0; i < yankModel.segs.length; i++) {
        const s = yankModel.segs[i]!;
        if (s.node === node) return Math.min(s.start + off, s.end);
      }
      return 0;
    };

    const ensureCaret = (): HTMLElement => {
      if (caretEl && caretEl.isConnected) return caretEl;
      if (!caretEl) {
        caretEl = document.createElement("div");
        caretEl.id = "lazyfox-caret";
        caretEl.style.cssText =
          "all:initial;position:fixed;z-index:2147483647;pointer-events:none;" +
          "background:rgba(122,162,247,.55);border:1px solid #7aa2f7;border-radius:2px;" +
          "box-shadow:0 0 0 1px rgba(10,12,20,.6);";
      }
      document.documentElement.appendChild(caretEl);
      return caretEl;
    };

    const hideCaret = (): void => {
      if (caretEl) {
        try {
          caretEl.remove();
        } catch (e) {
          // ignore
        }
        caretEl = null;
      }
    };

    // Positions the block caret on the character under the Go cursor and
    // scrolls the window so the caret stays visible (the "cursor movement"
    // part of yank mode — the page follows the cursor like a pager).
    const showCaret = (): void => {
      if (!yankModel) return;
      const off = flatOf(yankLine, yankCol);
      const seg = segAt(off);
      if (!seg) return;
      const node = seg.node;
      const len = (node.data || "").length;
      let s = seg.nodeOff;
      let e = Math.min(s + 1, len);
      if (s >= len) {
        s = Math.max(0, len - 1);
        e = len;
      }
      try {
        const range = document.createRange();
        range.setStart(node, s);
        range.setEnd(node, e);
        const rect = range.getBoundingClientRect();
        if (rect && rect.height > 0 && rect.width > 0) {
          const el = ensureCaret();
          el.style.left = rect.left + "px";
          el.style.top = rect.top + "px";
          el.style.width = Math.max(2, rect.width) + "px";
          el.style.height = rect.height + "px";
          const vh = window.innerHeight;
          if (rect.top < 90) window.scrollBy(0, rect.top - 90);
          else if (rect.bottom > vh - 70) window.scrollBy(0, rect.bottom - vh + 70);
          return;
        }
      } catch (e) {
        // range across trees: ignore
      }
      hideCaret();
    };

    const isMotion = (k: string): boolean =>
      k === "h" || k === "j" || k === "k" || k === "l" || k === "0" || k === "$" ||
      k === "w" || k === "W" || k === "b" || k === "B" || k === "e" || k === "E" ||
      k === "g" || k === "G";

    // One motion through the Go core. Re-parses first when the page changed
    // since the model was built, so lazy-loading feeds stay current.
    const yankMotionTo = (op: string, arg: string): { line: number; col: number } | null => {
      if (!yankModel) return null;
      if (dirty) rebuildYankModel();
      const api = tryYankApi();
      if (!api || !yankModel) return null;
      const r = api.yankMotion(op, arg, yankLine, yankCol);
      return { line: r.line, col: r.col };
    };

    const moveTo = (line: number, col: number): void => {
      yankLine = line;
      yankCol = col;
      showCaret();
      render();
    };

    // Copy + flash a span of the flat text ([sOff, eOff), unordered).
    const yankSpanOff = (sOff: number, eOff: number): void => {
      if (!yankModel) return;
      if (eOff < sOff) {
        const t = sOff;
        sOff = eOff;
        eOff = t;
      }
      if (sOff === eOff) {
        toast("empty yank");
        return;
      }
      const text = yankModel.text.slice(sOff, eOff);
      const a = segAt(sOff);
      const b = segAt(eOff - 1);
      if (a && b) {
        const bEnd = Math.min(b.nodeOff + 1, (b.node.data || "").length);
        flashNodeRange(a.node, a.nodeOff, b.node, bEnd);
      }
      void copyText(text).then((ok) => {
        if (ok) toast("yanked " + text.length + " chars");
        else toast("copy failed");
      });
    };

    // Resolve a text object at the cursor and yank it. op is the Go core's
    // object key: yy / iw / aw / iW / aW / ip / ap / i" / a" / i' / a' /
    // i` / a` / i( / a( / i[ / a[ / i{ / a{ / i< / a<.
    const yankObjectAt = (op: string): void => {
      const api = tryYankApi();
      if (!api || !yankModel) return;
      const o = api.yankObject(op, yankLine, yankCol);
      if (!o.ok) {
        toast(op === "yy" ? "nothing to yank here" : "no " + op + " here");
        return;
      }
      yankSpanOff(flatOf(o.sl, o.sc), flatOf(o.el, o.ec));
    };

    const yankEnter = (): void => {
      if (!rebuildYankModel()) {
        toast("yank: core loading");
        return;
      }
      yankMode = "idle";
      // Seed the cursor at the current match when there is one, else top.
      const m = currentHit();
      if (m && m.pieces[0] && yankModel) {
        const off = nodeFlatOffset(m.pieces[0].node, m.pieces[0].start);
        const ls = yankModel.lineStart;
        let line = 0;
        for (let i = 0; i < ls.length; i++) {
          if (ls[i]! <= off) line = i;
          else break;
        }
        yankLine = line;
        yankCol = off - ls[line]!;
        if (yankCol < 0) yankCol = 0;
      } else {
        yankLine = 0;
        yankCol = 0;
      }
      input.classList.add("lf-cmd");
      input.classList.add("lf-yank");
      try {
        input.blur();
      } catch (e) {
        // ignore
      }
      showCaret();
      render();
    };

    const yankExit = (to: "cmd" | "insert"): void => {
      yankMode = "off";
      hideCaret();
      clearSel();
      input.classList.remove("lf-yank");
      if (to === "insert") {
        mode = "insert";
        input.classList.remove("lf-cmd");
        input.focus();
      }
      render();
    };

    // Enter visual selection at the cursor. Every motion from here extends
    // the highlighted range, and y yanks exactly what is highlighted, so the
    // user always sees what will be copied before pressing y.
    const yankEnterSel = (): void => {
      yankSelAnchor = { line: yankLine, col: yankCol };
      yankMode = "sel";
      render();
    };

    // Flat offset of the real character under the cursor (never a '\n': a
    // cursor at end-of-line resolves to the line's last character).
    const yankCharOff = (line: number, col: number): number => {
      if (!yankModel) return 0;
      const ls = yankModel.lineStart;
      if (line < 0) line = 0;
      if (line >= yankModel.lines) line = yankModel.lines - 1;
      const end = line + 1 < ls.length ? ls[line + 1]! - 1 : yankModel.text.length;
      const len = Math.max(0, end - ls[line]!);
      let c = col;
      if (c < 0) c = 0;
      if (c >= len) c = Math.max(0, len - 1);
      return ls[line]! + c;
    };

    // Persistent blue overlay showing the visual selection. Lives in a
    // closed shadow root so page CSS can't break it; rebuilt per motion.
    const drawSel = (rects: DOMRect[]): void => {
      if (!selHost) {
        selHost = document.createElement("div");
        selHost.id = "lazyfox-sel";
        selHost.style.cssText =
          "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
        selHost._sh = selHost.attachShadow({ mode: "closed" });
        document.documentElement.appendChild(selHost);
      }
      const sh = selHost._sh!;
      sh.textContent = "";
      if (!rects.length) return;
      const st = document.createElement("style");
      st.textContent =
        ".s{position:fixed;background:rgba(122,162,247,.30);border-radius:2px;pointer-events:none;}";
      sh.appendChild(st);
      const n = Math.min(rects.length, 250);
      for (let i = 0; i < n; i++) {
        const r = rects[i]!;
        const d = document.createElement("div");
        d.className = "s";
        d.style.left = r.left + "px";
        d.style.top = r.top + "px";
        d.style.width = r.width + "px";
        d.style.height = r.height + "px";
        sh.appendChild(d);
      }
    };

    const clearSel = (): void => {
      if (selHost) {
        try {
          selHost.remove();
        } catch (e) {
          // ignore
        }
        selHost = null;
      }
    };

    // Redraw the selection highlight for the current anchor -> cursor range.
    const updateSelHighlight = (): void => {
      if (yankMode !== "sel" || !yankModel) {
        clearSel();
        return;
      }
      const aOff = yankCharOff(yankSelAnchor.line, yankSelAnchor.col);
      const cOff = yankCharOff(yankLine, yankCol);
      const s = Math.min(aOff, cOff);
      const e = Math.max(aOff, cOff) + 1;
      if (e <= s) {
        clearSel();
        return;
      }
      const a = segAt(s);
      const b = segAt(e - 1);
      if (!a || !b) {
        clearSel();
        return;
      }
      try {
        const range = document.createRange();
        range.setStart(a.node, a.nodeOff);
        const bEnd = Math.min(b.nodeOff + 1, (b.node.data || "").length);
        range.setEnd(b.node, bEnd);
        drawSel(Array.prototype.slice.call(range.getClientRects()));
      } catch (err) {
        clearSel();
      }
    };

    // Yank the highlighted anchor -> cursor range (cursor character included)
    // and leave selection mode. What gets copied is exactly what was
    // highlighted while moving.
    const yankSel = (): void => {
      if (!yankModel) return;
      const aOff = yankCharOff(yankSelAnchor.line, yankSelAnchor.col);
      const cOff = yankCharOff(yankLine, yankCol);
      const s = Math.min(aOff, cOff);
      const e = Math.max(aOff, cOff) + 1;
      const ch = yankModel.text[s];
      if (e <= s || ch === "\n" || ch === undefined) {
        toast("nothing selected to yank");
        return;
      }
      yankSpanOff(s, e);
      yankMode = "idle";
      clearSel();
      render();
    };

    // Idle yank-mode keys: motions move the cursor through the Go core.
    const yankIdleKey = (k: string): boolean => {
      if (isMotion(k)) {
        const t = yankMotionTo(k === "g" ? "gg" : k, "");
        if (t) moveTo(t.line, t.col);
        return true;
      }
      return false;
    };

    const yankHints = (): string => {
      if (yankMode === "sel") {
        return "<b>hjkl w b e 0 $ g G</b> extend &middot; <b>y</b> yank &middot; " +
          "<b>Esc</b> cancel";
      }
      if (yankMode === "pendY") {
        return "<b>y</b> line &middot; <b>hjkl w b e 0 $ g G</b> select &middot; " +
          "<b>Esc</b> cancel";
      }
      return "<b>hjkl</b> move &middot; <b>w b e</b> word &middot; <b>0 $</b> line &middot; " +
        "<b>g G</b> top/bottom &middot; <b>yy</b> line &middot; <b>y</b> select &middot; " +
        "<b>i</b> edit &middot; <b>Esc</b> back";
    };

    const manualInsert = (k: string): void => {
      const s = input.selectionStart == null ? input.value.length : input.selectionStart;
      const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      input.value = input.value.slice(0, s) + k + input.value.slice(en);
      try {
        input.setSelectionRange(s + 1, s + 1);
      } catch (err) {
        // ignore
      }
      scheduleFind();
    };

    input.addEventListener("input", scheduleFind);

    /* ---------- key handling ---------- */

    return {
      onKey: (e): boolean => {
        const k = e.key;
        const noMods = !e.ctrlKey && !e.altKey && !e.metaKey;

        // Full yank mode owns every key: motions move the cursor, y arms the
        // operator, Esc steps back to find command mode. Esc here exits the
        // mode instead of closing the widget (the widget itself only closes
        // from the find modes, below).
        if (yankMode !== "off") {
          if (k === "Escape") {
            e.preventDefault();
            if (yankMode === "sel" || yankMode === "pendY") {
              yankMode = "idle";
              render();
            } else {
              yankExit("cmd");
            }
            return true;
          }
          if (!noMods || !k || k.length > 1) return true;
          e.preventDefault();
          if (yankMode === "pendY") {
            if (k === "y") {
              yankObjectAt("yy");
              yankMode = "idle";
              render();
            } else if (k === "i") {
              yankExit("insert");
            } else if (isMotion(k)) {
              // y then a motion starts a selection at the cursor, so the
              // range is visible before it is yanked.
              yankEnterSel();
              yankIdleKey(k);
            } else {
              yankMode = "idle";
            }
            return true;
          }
          if (yankMode === "sel") {
            if (k === "y") yankSel();
            else if (k === "i") yankExit("insert");
            else yankIdleKey(k); // motions extend the selection
            return true;
          }
          // idle
          if (k === "y") {
            yankMode = "pendY";
            render();
          } else if (k === "i") {
            // i leaves for the find query (neovim: i inserts).
            yankExit("insert");
          } else {
            yankIdleKey(k);
          }
          return true;
        }

        if (k === "Enter") {
          e.preventDefault();
          walk(e.shiftKey);
          return true;
        }
        if (k === "o" && e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          backOne();
          return true;
        }
        if (k === "Escape") return false; // host closes the widget

        if (mode === "cmd") {
          if (k === "i" && noMods) {
            e.preventDefault();
            mode = "insert";
            input.classList.remove("lf-cmd");
            input.focus();
            render();
            return true;
          }
          if (k === "n" || k === "N") {
            e.preventDefault();
            walk(k === "N");
            return true;
          }
          if (k === "y" && noMods) {
            e.preventDefault();
            doYank();
            return true;
          }
          if (k === "Y" && noMods) {
            e.preventDefault();
            yankEnter();
            return true;
          }
          if (k === "Backspace") {
            e.preventDefault();
            mode = "insert";
            input.classList.remove("lf-cmd");
            input.focus();
            input.value = input.value.slice(0, -1);
            scheduleFind();
            return true;
          }
          // Any other printable key drops back to insert and types it.
          if (k && k.length === 1 && noMods) {
            e.preventDefault();
            mode = "insert";
            input.classList.remove("lf-cmd");
            input.focus();
            manualInsert(k);
            return true;
          }
          return true; // consume stray keys in command mode
        }

        // insert mode
        if (k === "Backspace") {
          e.preventDefault();
          input.value = input.value.slice(0, -1);
          scheduleFind();
          return true;
        }
        if (k && k.length === 1 && noMods) {
          e.preventDefault();
          manualInsert(k);
          return true;
        }
        return false;
      },
      refresh: () => {},
      close: () => {
        closed = true;
        window.removeEventListener("scroll", onScroll);
        if (mo) {
          try {
            mo.disconnect();
          } catch (e) {
            // ignore
          }
        }
        for (const o of shadowObs) {
          try {
            o.disconnect();
          } catch (e) {
            // ignore
          }
        }
        shadowObs.length = 0;
        observedShadows.clear();
        if (findTimer) clearTimeout(findTimer);
        yankMode = "off";
        hideCaret();
        clearSel();
        clearHit();
        if (setFindState) setFindState(null);
        try {
          document.documentElement.removeAttribute("data-lf-find");
          document.documentElement.removeAttribute("data-lf-yank");
          if (__DEV__) document.documentElement.removeAttribute("data-lf-yank-text");
        } catch (e) {
          // ignore
        }
        // Leaving find brings the user back to where they started: the first
        // result is often at the top of the page and the jump scrolled away
        // from the spot they were reading.
        restoreStart();
        posStack.length = 0;
        startPos = null;
      },
      focus: () => input.focus(),
    };
  });
}

function openResizePopup(shell: ContentPopupShell): void {
  shell.close();
  shell.open(RESIZE_HTML, (root) => {
    const sizeEl = root.querySelector(".rz-size") as HTMLElement;
    const updateSize = () => {
      void send("windowSize").then((r) => {
        if (r && sizeEl) {
          sizeEl.textContent =
            r.width + " \u00d7 " + r.height + (r.state === "maximized" ? " (maximized)" : "");
        }
      });
    };
    const rzResize = (dx: number, dy: number) => {
      void send("resizeWindow", { dx: dx, dy: dy }).then(updateSize);
    };
    updateSize();
    return {
      onKey: (e) => {
        const k = e.key;
        const fine = e.shiftKey ? 8 : 32;
        if (k === "ArrowLeft") { rzResize(-fine, 0); return true; }
        if (k === "ArrowRight") { rzResize(fine, 0); return true; }
        if (k === "ArrowUp") { rzResize(0, -fine); return true; }
        if (k === "ArrowDown") { rzResize(0, fine); return true; }
        if (k === "m") {
          void send("maximize").then(updateSize);
          return true;
        }
        return false;
      },
      refresh: updateSize,
      close: () => {},
      focus: () => {},
    };
  });
}

/* ---------- the ops object ---------- */

export function createContentOps(deps: ContentOpsDeps): ActionOps {
  // Armed close: when ;x would remove the window's LAST tab, the first press
  // arms a confirmation and a second press within 2.5s actually closes.
  let closeArmed = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  function disarmClose() {
    closeArmed = false;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }
  return {
    searchSuggest: async (q: string) => {
      const r = await send("searchSuggest", { q: q });
      return (r && r.entries) || [];
    },
    urlSuggest: async (q: string) => {
      const r = await send("urlSuggest", { q: q });
      return (r && r.entries) || [];
    },
    listTabs: async (q: string) => {
      const r = await send("tabs");
      let tabs: PopupItem[] = ((r && r.tabs) || []).map((t) => ({
        ...t,
        // The background's id IS the real Firefox tab id; carry it as realId
        // too so the popup can display it (chrome's id is a strip index).
        realId: t.id,
      }));
      const ql = q.trim().toLowerCase();
      if (ql) {
        tabs = tabs.filter(
          (t) =>
            (t.title || "").toLowerCase().indexOf(ql) !== -1 ||
            (t.url || "").toLowerCase().indexOf(ql) !== -1
        );
      }
      return tabs;
    },
    history: async (q: string) => {
      const r = await send("history", { q: q });
      return (r && r.items) || [];
    },
    bookmarks: async (q: string) => {
      const r = await send("bookmarks", { q: q });
      return (r && r.items) || [];
    },
    downloads: async (q: string) => {
      const r = await send("downloads");
      let items: PopupItem[] = (r && r.items) || [];
      const ql = q.trim().toLowerCase();
      if (ql) {
        items = items.filter(
          (d) =>
            (d.filename || "").toLowerCase().indexOf(ql) !== -1 ||
            (d.path || "").toLowerCase().indexOf(ql) !== -1 ||
            (d.url || "").toLowerCase().indexOf(ql) !== -1
        );
      }
      return items;
    },

    openUrl: (url: string, newTab?: boolean) => {
      void send("openUrl", { url: url, newTab: newTab });
    },
    search: (query: string, newTab?: boolean) => {
      void send("search", { query: query, newTab: newTab });
    },
    newTab: () => void send("newTab"),
    closeTab: (id?: number) => {
      if (closeArmed) {
        disarmClose();
        void send("closeTab", { id: id, force: true });
        return;
      }
      void send("closeTab", { id: id }).then((r) => {
        if (r && r.last) {
          closeArmed = true;
          closeTimer = setTimeout(disarmClose, 2500);
          toast("last tab — press ;x again to close the window");
        }
      });
    },
    moveTab: (id: number, dir: number) => void send("moveTab", { id: id, dir: dir }),
    moveActiveTab: (dir: number) => void send("moveActiveTab", { dir: dir }),
    reopenTab: () => void send("reopenTab"),
    duplicateTab: () => void send("duplicateTab"),
    reload: () => void send("reload"),
    back: () => void send("back"),
    forward: () => void send("forward"),
    activateTab: (id: number) => void send("activateTab", { id: id }),
    tabNav: (dir: number) => {
      void send("tabs").then((r) => {
        if (__DEV__) {
          try {
            document.documentElement.setAttribute(
              "data-lf-tabs",
              JSON.stringify(r && r.tabs ? r.tabs.map((t) => ({ id: t.id, a: t.active })) : "NULL")
            );
          } catch (x) {
            // ignore
          }
        }
        const tabs: Array<{ id: number; active: boolean }> = (r && r.tabs) || [];
        if (!tabs.length) return;
        const cur = tabs.findIndex((t) => t.active);
        if (cur < 0) return;
        const next = tabs[(cur + dir + tabs.length) % tabs.length]!;
        void send("activateTab", { id: next.id });
      });
    },
    tabJump: (n: number) => {
      if (n === 9) void send("activateTabAt", { last: true });
      else void send("activateTabAt", { index: n });
    },
    alternateTab: () => {
      void send("alternateTab");
    },
    recentlyClosed: async () => {
      const r = await send("recentlyClosed");
      return (r && r.items) || [];
    },
    restoreClosedTab: (key: string) => {
      void send("restoreClosedTab", { key: key });
    },
    restoreAllClosed: () => {
      void send("restoreAllClosed");
    },
    removeHistory: (url: string) => {
      void send("removeHistory", { url: url });
    },
    clearHistory: () => {
      void send("clearHistory");
    },
    zoom: (delta: number, factor?: number) => void send("zoom", { delta: delta, factor: factor }),
    openDownload: (key: string) => void send("openDownload", { id: key }),
    openDownloadLocation: (key: string) => void send("openDownloadLocation", { id: key }),
    removeDownload: (key: string) => void send("removeDownload", { id: key }),
    stealthOpen: () => {
      void send("stealthOpen").then((r) => {
        if (r && r.ok === true) toast("stealth tab opened");
        else if (r) toast("stealth tab failed: " + (r.error || "unknown"));
        else toast("stealth tab failed: extension not reachable");
      });
    },
    openSetup: () => void send("openSetup"),
    dismissDownload: (_key?: string) => {
      // The content-script bar does not render download progress (the chrome
      // helper's window bar owns that); nothing to dismiss here.
    },
    copyUrl: () => {
      void send("copyUrl").then((r) => {
        if (r && r.url) {
          void copyText(r.url);
          toast("copied URL");
        }
      });
    },
    muteTab: () => {
      void send("mute").then((r) => toast(r && r.muted ? "muted" : "unmuted"));
    },
    zen: () => {
      void send("zen").then((r) => toast(r && r.zen ? "zen mode on" : "zen mode off"));
    },
    toggleReveal: () => {
      const c = deps.config();
      c.hoverReveal = !c.hoverReveal;
      void send("setConfig", { config: c });
      toast("toolbar reveal: " + (c.hoverReveal ? "on" : "off"));
    },
    focusFirstInput: () => deps.focusFirstInput(),
    startHints: () => deps.startHints(),
    listSessions: async (q: string) => {
      const r = await send("sessionList");
      const sessions: PopupItem[] = ((r && r.sessions) || []).map((s) => {
        const splitCount = (s.tabs || []).filter((t: any) => typeof t.splitViewId === "number" && t.splitViewId >= 0).length;
        return {
          kind: "session",
          title: s.name,
          marker: s.marker || 0,
          subtitle:
            (s.marker ? "marker " + s.marker + " \u00b7 " : "") +
            s.tabs.length +
            " tabs" +
            (splitCount ? " \u00b7 " + splitCount + " split" : "") +
            (s.updatedAt ? " \u00b7 " + relTime(s.updatedAt) : ""),
        };
      });
      const ql = q.trim();
      let out = sessions;
      if (ql) {
        out = sessions.filter(
          (s) => (s.title || "").toLowerCase().indexOf(ql.toLowerCase()) !== -1
        );
        if (!sessions.some((s) => (s.title || "").toLowerCase() === ql.toLowerCase())) {
          out.unshift({
            kind: "save",
            title: ql,
            subtitle: "Save current tabs as \u201C" + ql + "\u201D",
          });
        }
      }
      return out;
    },
    listSessionTabs: async (name: string) => {
      const r = await send("listSessionTabs", { name: name });
      return (r && r.items) || [];
    },
    saveSession: (name: string) => {
      void send("sessionSave", { name: name }).then((r) =>
        toast(r && r.ok ? "saved session \u201C" + name + "\u201D" : "could not save session")
      );
    },
    newSession: (name: string) => {
      void send("sessionNew", { name: name }).then((r) =>
        toast(r && r.ok ? "created clean session \u201C" + name + "\u201D" : (r && r.note) || "could not create session")
      );
    },
    restoreSession: (name: string) => {
      void send("sessionRestore", { name: name }).then((r) =>
        toast(r && r.ok ? "switched to \u201C" + name + "\u201D" : "no session \u201C" + name + "\u201D")
      );
    },
    deleteSession: (name: string) => {
      void send("sessionDelete", { name: name }).then(() => toast("deleted \u201C" + name + "\u201D"));
    },
    switchSessionByMarker: (marker: number) => {
      void send("sessionSwitchByMarker", { marker: marker }).then((r) =>
        toast(r && r.ok ? "session \u201C" + r.name + "\u201D" : "no session at marker " + marker)
      );
    },
    assignSessionMarker: (name: string, marker: number) => {
      void send("sessionAssignMarker", { name: name, marker: marker }).then((r) =>
        toast(r && r.ok ? "\u201C" + name + "\u201D \u2192 marker " + marker : (r && r.note) || "could not set marker")
      );
    },
    sessionTabCopy: (from: string, index: number, to: string) => {
      void send("sessionTabCopy", { from: from, index: index, to: to }).then((r) =>
        toast(r && r.ok ? "copied tab \u2192 \u201C" + to + "\u201D" : (r && r.note) || "could not copy tab")
      );
    },
    sessionTabMove: (from: string, index: number, to: string) => {
      void send("sessionTabMove", { from: from, index: index, to: to }).then((r) =>
        toast(r && r.ok ? "moved tab \u2192 \u201C" + to + "\u201D" : (r && r.note) || "could not move tab")
      );
    },
    splitTab: (orientation: "horizontal" | "vertical") => {
      void send("sessionSplit", { orientation: orientation }).then((r) => {
        if (r && r.ok) toast("split side-by-side");
        else toast(r && r.note ? r.note : "could not split");
      });
    },
    unsplitTab: () => {
      void send("sessionUnsplit").then((r) => {
        if (r && r.ok) toast("split view closed");
        else toast(r && r.note ? r.note : "not in a split view");
      });
    },
    switchSplitPane: (dir: number) => {
      void send("sessionSwitchPane", { dir: dir }).then((r) => {
        if (r && r.ok) toast("switched split pane");
        else toast(r && r.note ? r.note : "not in a split view");
      });
    },
    swapSplitPane: (dir: number) => {
      void send("sessionSwapPane", { dir: dir }).then((r) => {
        if (r && r.ok) toast("swapped split panes");
        else toast(r && r.note ? r.note : "not in a split view");
      });
    },
    splitAddTabByIndex: (n: number) => {
      // Moving a tab into a split view is a native-split (chrome helper)
      // capability; the background relays the request to the chrome helper.
      void send("sessionSplitAddTabByIndex", { index: n }).then((r) => {
        if (r && r.ok) toast("moved tab " + n + " into split");
        else toast(r && r.note ? r.note : "could not move tab into split");
      });
    },
    toggleWhichKey: () => {
      void send("toggleWhichKey", {}).then((r) =>
        toast(r && r.whichKey ? "which-key on" : "which-key off")
      );
    },
    quit: () => {
      void send("quit").then((r) => {
        if (!r || r.ok === false) toast("could not quit");
      });
    },
    sessionState: async () => {
      const r = await send("sessionState");
      return (
        r || {
          name: "default",
          marker: 0,
          tabIndex: 1,
          tabCount: 0,
          inSplit: false,
          sessions: [],
        }
      );
    },
    openFind: () => openFindPopup(deps.shell, deps.setFindState),
    openResize: () => openResizePopup(deps.shell),
    openTarget: () => {
      // Chrome-only capability (hotkey about: pages); content never calls it.
    },
  };
}
