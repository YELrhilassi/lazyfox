// The content script's ActionOps implementation: every shared leader action
// and popup data source, backed by background messages (shared/protocol). The
// chrome helper implements the same interface natively; content scripts can
// never touch chrome APIs, so everything goes through the background.

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
// y copies the match / range with a neovim-style flash.
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
  ".lf-fcount{flex:none;font:700 11px ui-monospace,Menlo,Consolas,monospace;color:#7aa2f7;" +
  "background:#16161e;border:1px solid #414868;border-radius:6px;padding:3px 8px;min-width:34px;text-align:center;}" +
  ".lf-fcount.zero{color:#f7768e;border-color:#f7768e;}" +
  ".lf-fcount.vis{background:#292e42;border-color:#2ac3de;color:#2ac3de;}" +
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
    let visual: FindHit | null = null; // range anchor for v / y
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
    // cur/visual (they index into hits; callers clamp after the DOM changes).
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
      visual = null;
      render();
    };

    const scheduleFind = (): void => {
      if (findTimer) clearTimeout(findTimer);
      findTimer = setTimeout(runFind, 40);
    };

    const snippet = (node: Text, s: number, e: number): string => {
      const t = (node.data || "").slice(s, e).replace(/\s+/g, " ").trim();
      return t.length > 24 ? t.slice(0, 24) + "\u2026" : t;
    };

    const render = (): void => {
      const total = hits.length;
      const active = total > 0 && cur >= 0;
      countEl.textContent = total === 0 ? "0" : (cur >= 0 ? cur + 1 : 0) + "/" + total;
      countEl.classList.toggle("zero", total === 0);
      countEl.classList.toggle("vis", active);
      // Context-aware hint line: typing, walking, and range-copy each show
      // only their own keys (same pattern as the history popup's footer).
      if (mode === "insert") {
        keysEl.innerHTML =
          "<b>Enter</b> next &middot; <b>Shift+Enter</b> prev &middot; <b>Esc</b> close";
      } else if (visual) {
        keysEl.innerHTML =
          "<b>n/N</b> walk &middot; <b>y</b> copy range &middot; <b>v</b> cancel &middot; <b>i</b> edit &middot; <b>Esc</b> close";
      } else {
        keysEl.innerHTML =
          "<b>n/N</b> walk &middot; <b>y</b> copy &middot; <b>v</b> range &middot; <b>i</b> edit &middot; <b>Esc</b> close";
      }
      rangeEl.textContent = visual
        ? "range: \u201C" + snippet(visual.node, visual.start, visual.end) + "\u201D \u2192"
        : "";
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
      // Walking commits the query: y/v/n/i are commands until the user edits.
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

    // Amber flash overlay over the copied text, fading out like a yank
    // highlight. Lives in a closed shadow root so page CSS can't break it.
    const flashRange = (a: FindHit, b: FindHit): void => {
      try {
        const range = document.createRange();
        range.setStart(a.node, a.start);
        range.setEnd(b.node, b.end);
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

    // Text from match a to match b inclusive, in document order. Uses the
    // cached node list (refreshed first) so node indices stay in sync.
    const copyRangeText = (a: FindHit, b: FindHit): string => {
      let x = a;
      let y = b;
      if (y.ni < x.ni || (y.ni === x.ni && y.start < x.start)) {
        const t = x;
        x = y;
        y = t;
      }
      const list = collectNodes();
      let out = "";
      for (let i = x.ni; i <= y.ni; i++) {
        const node = list[i];
        if (!node) continue;
        const text = node.data || "";
        if (i === x.ni && i === y.ni) out += text.slice(x.start, y.end);
        else if (i === x.ni) out += text.slice(x.start);
        else if (i === y.ni) out += text.slice(0, y.end);
        else out += text;
      }
      return out;
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
      let text: string;
      let a: FindHit;
      if (visual) {
        a = visual;
        text = copyRangeText(a, m);
      } else {
        a = m;
        text = (m.node.data || "").slice(m.start, m.end);
      }
      void copyText(text).then((ok) => {
        if (ok) toast("copied " + text.length + " chars");
        else toast("copy failed");
      });
      flashRange(a, m);
      render();
    };

    const toggleVisual = (): void => {
      if (visual) {
        visual = null;
        render();
        return;
      }
      if (cur < 0 && hits.length) cur = nextFromViewport();
      const m = currentHit();
      if (!m) {
        toast("no match for range");
        return;
      }
      if (mode !== "cmd") {
        mode = "cmd";
        input.classList.add("lf-cmd");
        try {
          input.blur();
        } catch (e) {
          // ignore
        }
      }
      visual = m;
      inFindScroll = true;
      selectHit(m);
      setTimeout(() => {
        inFindScroll = false;
      }, 60);
      render();
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
          if (k === "v" && noMods) {
            e.preventDefault();
            toggleVisual();
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
        if (setFindState) setFindState(null);
        try {
          document.documentElement.removeAttribute("data-lf-find");
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
