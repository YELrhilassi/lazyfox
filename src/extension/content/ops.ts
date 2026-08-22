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

// One find match: the text node it lives in (plus its index in the cached
// node list) and the character offsets. gs is the match's global start
// offset across the whole document, used to order range copies.
interface FindHit {
  node: Text;
  ni: number;
  start: number;
  end: number;
  gs: number;
}

const FIND_SKIP = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT", "SELECT", "IFRAME", "TITLE",
]);

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
  const walk = (n: Node, depth: number): void => {
    if (depth > 40) return;
    if (n.nodeType === Node.TEXT_NODE) {
      const p = n.parentElement;
      if (p && FIND_SKIP.has(p.tagName)) return;
      const data = (n as Text).data || "";
      if (!data.trim()) return;
      segs.push({ node: n as Text, start: text.length, end: text.length + data.length });
      text += data;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) {
      // Document/ShadowRoot: walk children without block semantics.
      const kids = (n as ParentNode).childNodes;
      for (let i = 0; i < kids.length; i++) walk(kids[i]!, depth + 1);
      return;
    }
    const el = n as HTMLElement;
    const tag = el.tagName;
    if (FIND_SKIP.has(tag) || el.hidden) return;
    if (tag === "BR") {
      nl();
      return;
    }
    const block = YANK_BLOCK.has(tag);
    if (block) nl();
    const sr = el.shadowRoot;
    if (sr && sr.mode === "open") {
      // Shadow DOM replaces the light children visually: walk the shadow
      // tree instead so the yank text matches what is actually rendered.
      walk(sr, depth + 1);
    } else {
      const kids = el.childNodes;
      for (let i = 0; i < kids.length; i++) walk(kids[i]!, depth + 1);
    }
    if (block) nl();
  };
  try {
    walk(body, 0);
  } catch (e) {
    // ignore
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

    // The finder walks text nodes in document order, PIERCING open shadow
    // roots (Reddit's <faceplate-*> custom elements keep their text in
    // shadow DOM, which window.find cannot see — the old widget therefore
    // found "nothing" on exactly the pages this tool targets). Script/style/
    // textarea/iframe subtrees are skipped.
    let nodes: Text[] = [];
    let nodesBody: HTMLElement | null = null;
    let nodesAt = 0;
    let dirty = false;
    let hits: FindHit[] = [];
    let cur = -1; // index into hits; -1 = query typed but nothing walked to
    let mode: "insert" | "cmd" = "insert";
    let lastQuery = "";
    let findTimer: ReturnType<typeof setTimeout> | null = null;

    // DOM-changed marker so the cached node list stays fresh on lazy-loading
    // pages (infinite feeds) without re-walking the whole document on every
    // keystroke: mutations just set a flag; the next recount rebuilds once.
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

    const collectNodes = (): Text[] => {
      const body = document.body || document.documentElement;
      const now = Date.now();
      if (nodesBody === body && !dirty && now - nodesAt < 2000) return nodes;
      dirty = false;
      nodesBody = body;
      nodesAt = now;
      const out: Text[] = [];
      const walk = (n: Node, depth: number): void => {
        if (depth > 40) return;
        if (n.nodeType === Node.TEXT_NODE) {
          const p = n.parentElement;
          if (p && FIND_SKIP.has(p.tagName)) return;
          out.push(n as Text);
          return;
        }
        if (n.nodeType === Node.ELEMENT_NODE) {
          const el = n as Element;
          const tag = el.tagName;
          if (FIND_SKIP.has(tag)) return;
          const sr = (el as HTMLElement).shadowRoot;
          if (sr && sr.mode === "open") walk(sr, depth + 1);
        }
        // Element children, plus Document/ShadowRoot (fragment) children.
        const kids = (n as ParentNode).childNodes;
        for (let i = 0; i < kids.length; i++) walk(kids[i]!, depth + 1);
      };
      try {
        walk(body, 0);
      } catch (e) {
        // ignore
      }
      nodes = out;
      return out;
    };

    // Rebuild the hit list from the cached nodes for the given query. Keeps
    // cur (it indexes into hits; callers clamp after the DOM changes).
    const countHits = (q: string): void => {
      lastQuery = q;
      const list = collectNodes();
      hits = [];
      if (q) {
        const needle = q.toLowerCase();
        let gs = 0;
        for (let ni = 0; ni < list.length; ni++) {
          const node = list[ni]!;
          const text = node.data || "";
          const lower = text.toLowerCase();
          let idx = lower.indexOf(needle);
          while (idx !== -1) {
            hits.push({ node: node, ni: ni, start: idx, end: idx + needle.length, gs: gs + idx });
            idx = lower.indexOf(needle, idx + needle.length);
          }
          gs += text.length;
        }
      }
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
    };

    /* ---------- walking ---------- */

    const selectHit = (m: FindHit): void => {
      try {
        const range = document.createRange();
        range.setStart(m.node, m.start);
        range.setEnd(m.node, m.end);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (e) {
        // Selecting across shadow boundaries can throw; the scroll still works.
      }
      try {
        const el = m.node.parentElement;
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
          const el = hits[i]!.node.parentElement as HTMLElement | null;
          if (el) {
            const top = el.getBoundingClientRect().top + docY;
            if (top >= docY - 4) return i;
          }
        } catch (e) {
          // ignore
        }
      }
      return 0;
    };

    const walk = (back: boolean): boolean => {
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
      return true;
    };

    /* ---------- yank (copy) with neovim-style flash ---------- */

    const currentHit = (): FindHit | null => (cur >= 0 ? hits[cur] || null : null);

    // Amber flash overlay over any text span, fading out like a yank
    // highlight. Lives in a closed shadow root so page CSS can't break it.
    const flashNodeRange = (aNode: Text, aOff: number, bNode: Text, bOff: number): void => {
      try {
        const range = document.createRange();
        range.setStart(aNode, aOff);
        range.setEnd(bNode, bOff);
        const rects = range.getClientRects();
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
      } catch (e) {
        // range spans trees that cannot be flashed; skip the visual
      }
    };

    const doYank = (): void => {
      // Re-sync against any DOM changes since the last count so the node
      // indices below match the current page (and clamp a stale walk index).
      countHits(lastQuery);
      if (cur >= hits.length) cur = hits.length - 1;
      const m = currentHit();
      if (!m) {
        toast("no match to copy");
        return;
      }
      const text = (m.node.data || "").slice(m.start, m.end);
      void copyText(text).then((ok) => {
        if (ok) toast("copied " + text.length + " chars");
        else toast("copy failed");
      });
      flashNodeRange(m.node, m.start, m.node, m.end);
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
      if (m && yankModel) {
        const off = nodeFlatOffset(m.node, m.start);
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
        window.removeEventListener("scroll", onScroll);
        if (mo) {
          try {
            mo.disconnect();
          } catch (e) {
            // ignore
          }
        }
        if (findTimer) clearTimeout(findTimer);
        yankMode = "off";
        hideCaret();
        clearSel();
        if (setFindState) setFindState(null);
        try {
          document.documentElement.removeAttribute("data-lf-find");
          document.documentElement.removeAttribute("data-lf-yank");
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
