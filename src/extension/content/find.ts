// The content script's find-in-page widget, and the window-resize popup.
//
// The widget is a small bottom-right panel rather than a centred modal: it
// never covers the page, so the text around a match stays visible while you
// walk it. The count updates as you type; Enter jumps and switches to command
// mode, where y copies the match with a neovim-style flash and Y opens the
// full yank mode (Go core motions and text objects with a block cursor).
//
// This file is the WIRING. Everything it coordinates lives in ./find:
//
//   find/text     the two flat-text models (find collapses whitespace, yank
//                 appends verbatim), their segment tables, and the offset
//                 arithmetic between them. Pure, and unit-tested without a
//                 browser.
//   find/model    the text model (a cache of the page, refreshed on mutation)
//                 and the hit session (a search over that cache).
//   find/yank     the Go-core block cursor, its key grammar and its caret.
//   find/scroll   where the user was before find took over, and the jump trail.
//   find/overlays the three rect overlays, drawn in closed shadow roots.
//
// It was one 1030-line closure with ~35 mutable locals. The split is along the
// line that matters: what is a CACHE of the page, what is a SEARCH over it,
// what is a MODE with its own grammar, and what is pure arithmetic. Those have
// different invalidation rules, and in one function the two ways they can be
// wrong (a cache a keystroke invalidated, a search that outlived its cache)
// look identical to read.
//
// What this file still owns is the genuinely shared part: the widget's four
// elements, the one render function both modes go through, and the key
// dispatch that decides which of the two state machines owns the keyboard.

import { copyText, removeHtmlAttr, setHtmlAttr } from "../../shared/dom";
import { manualTextKey, type PopupCtl } from "../../shared/overlay";
import { send } from "../../shared/protocol";
import { createSession, createTextModel } from "./find/model";
import { flashOverlay, hitOverlay } from "./find/overlays";
import { createScrollMemory } from "./find/scroll";
import { createYank, mirrorYankState } from "./find/yank";
import type { FindHit } from "./find/text";

declare const __DEV__: boolean;

export interface ContentPopupShell {
  open(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl;
  close(): void;
}

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

export function openFindPopup(
  shell: ContentPopupShell,
  setFindState?: (s: { cur: number; count: number } | null) => void
): void {
  shell.open(FIND_HTML, (root) => {
    const input = root.querySelector(".lf-finput") as HTMLInputElement;
    const countEl = root.querySelector(".lf-fcount") as HTMLElement;
    const keysEl = root.querySelector(".lf-fkeys") as HTMLElement;
    const rangeEl = root.querySelector(".lf-frange") as HTMLElement;

    /* ---------- wiring ---------- */

    const model = createTextModel();
    const scroll = createScrollMemory();

    const session = createSession(model, {
      queryText: () => input.value,
      onCommit: () => {
        // Committed: the query is now a command target, so single letters are
        // commands until the user edits. Blurring the input is what makes the
        // keys land here instead of in the text field.
        session.setMode("cmd");
        input.classList.add("lf-cmd");
        try {
          input.blur();
        } catch (e) {
          // ignore
        }
        scroll.markStart();
        scroll.push();
        scroll.beginJump();
      },
      onRepaint: () => render(),
      onState: (s) => {
        if (setFindState) setFindState(s);
      },
    });

    const yank = createYank({
      els: { count: countEl, keys: keysEl, range: rangeEl },
      currentHit: () => session.currentHit(),
      isDirty: () => model.dirty(),
      repaint: () => render(),
      copy: (t) => copyText(t),
      setInputMode: (m, yanking) => {
        // Yank mode drives the scroll itself (the caret follows the cursor),
        // so the jump trail is told to stop treating scrolls as the user's.
        scroll.ignoreForeignScroll(yanking);
        session.setMode(m);
        if (m === "cmd") input.classList.add("lf-cmd");
        else input.classList.remove("lf-cmd");
        input.classList.toggle("lf-yank", yanking);
        if (m === "insert") {
          try {
            input.focus();
          } catch (e) {
            // ignore
          }
        }
      },
    });

    /*
     * The one render. Both modes paint through here rather than each keeping
     * its own, so the <html> mirrors, the status-bar state and the dev probe
     * are written in one place and cannot describe two different situations.
     */
    function render(): void {
      if (yank.mode() !== "off") {
        hitOverlay.clear();
        // Badge + preview make the yank state obvious: cursor position while
        // idle, and the live character count + text preview of the selection
        // while selecting — so the user always knows what `y` will copy.
        const b = yank.badge();
        countEl.textContent = b.count;
        countEl.classList.toggle("zero", !b.valid);
        countEl.classList.toggle("vis", true);
        rangeEl.textContent = b.range;
        keysEl.innerHTML = yank.hints();
        yank.paintSelection();
        // Mirror the yank state onto <html> (same pattern as data-lf-find) so
        // the host and tests can read it without piercing the closed popup
        // root: idle:<line>:<col> or sel:<N chars>:<preview>.
        mirrorYankState(
          yank.mode() === "sel" ? "sel:" + b.count + ":" + b.range : "idle:" + yank.position(),
          yank.flatText(),
        );
        return;
      }

      mirrorYankState("off", null);
      const hits = session.hits();
      const cur = session.cur();
      const total = hits.length;
      countEl.textContent = total === 0 ? "0" : (cur >= 0 ? cur + 1 : 0) + "/" + total;
      countEl.classList.toggle("zero", total === 0);
      countEl.classList.toggle("vis", total > 0 && cur >= 0);
      // Context-aware hint line: typing and walking each show only their own
      // keys (same pattern as the history popup's footer).
      keysEl.innerHTML =
        session.mode() === "insert"
          ? "<b>Enter</b> next &middot; <b>Shift+Enter</b> prev &middot; <b>Esc</b> close"
          : "<b>n/N</b> walk &middot; <b>y</b> copy &middot; <b>Y</b> yank mode &middot; " +
            "<b>i</b> edit &middot; <b>Esc</b> close";
      rangeEl.textContent = "";
      session.drawHighlight();
      session.reportState();
      setHtmlAttr("data-lf-find", total ? (cur >= 0 ? cur + 1 : 0) + "/" + total : "off");
      // Mirror which match is current (or previewed) so the host and tests can
      // tell WHICH result was walked without piercing the closed popup root:
      // the source text of the match's first piece, trimmed.
      const m = previewed(hits, cur);
      let curTxt = m && m.pieces.length ? (m.pieces[0]!.node.data || "").slice(0, 80).trim() : "";
      if (!curTxt && m) curTxt = m.text;
      if (curTxt) setHtmlAttr("data-lf-cur", curTxt);
      else removeHtmlAttr("data-lf-cur");
    }

    /** The match the user is on, or the one being previewed while typing. */
    function previewed(hits: FindHit[], cur: number): FindHit | null {
      if (!hits.length) return null;
      return cur >= 0 ? hits[cur]! : hits[0]!;
    }

    input.addEventListener("input", () => session.scheduleFind());

    /* ---------- key handling ---------- */

    return {
      onKey: (e): boolean => {
        const k = e.key;
        const noMods = !e.ctrlKey && !e.altKey && !e.metaKey;

        // Yank mode owns the keyboard first, before anything else looks at the
        // key. Esc steps back inside the mode instead of closing the widget —
        // the widget only closes from the find modes, so a user who wandered
        // into yank mode is never trapped in it.
        if (yank.mode() !== "off") {
          if (k === "Escape") {
            yank.onKey(k, e);
            return true;
          }
          if (!noMods) return true; // a modified key belongs to the page
          return yank.onKey(k, e);
        }

        if (k === "Enter") {
          e.preventDefault();
          session.walk(e.shiftKey);
          return true;
        }
        if (k === "o" && e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          // Silent when the stack is empty: there is nothing to undo, and the
          // widget staying open is the whole answer.
          scroll.back();
          return true;
        }
        if (k === "Escape") return false; // host closes the widget

        if (session.mode() === "cmd") {
          if (k === "i" && noMods) {
            e.preventDefault();
            session.setMode("insert");
            input.classList.remove("lf-cmd");
            input.focus();
            render();
            return true;
          }
          if (k === "n" || k === "N") {
            e.preventDefault();
            session.walk(k === "N");
            return true;
          }
          if (k === "y" && noMods) {
            e.preventDefault();
            session.doYank();
            return true;
          }
          if (k === "Y" && noMods) {
            e.preventDefault();
            yank.enter();
            return true;
          }
          if (k === "Backspace") {
            e.preventDefault();
            session.setMode("insert");
            input.classList.remove("lf-cmd");
            input.focus();
            manualTextKey(e, input);
            return true;
          }
          // Any other printable key drops back to insert and types it.
          if (k && k.length === 1 && noMods) {
            e.preventDefault();
            session.setMode("insert");
            input.classList.remove("lf-cmd");
            input.focus();
            manualTextKey(e, input);
            return true;
          }
          return true; // consume stray keys in command mode
        }

        // insert mode
        if (k === "Backspace" || k === "Delete" || (k && k.length === 1 && noMods)) {
          e.preventDefault();
          manualTextKey(e, input);
          return true;
        }
        return false;
      },
      refresh: () => {},
      close: () => {
        // Order matters in three places and each one is a bug if swapped:
        //   session first  — stops the pending debounce from recounting into a
        //                    closed widget;
        //   restoreStart   — BEFORE scroll.close(), which clears the saved
        //                    position, and before yank.close(), because
        //                    restoring scrolls the page and the yank caret
        //                    would fight it;
        //   disconnect     — last, so a repaint racing teardown still has a
        //                    live model to read.
        session.close();
        scroll.restoreStart();
        scroll.close();
        yank.close();
        model.disconnect();
        flashOverlay.clear();
        hitOverlay.clear();
        if (setFindState) setFindState(null);
        removeHtmlAttr("data-lf-find");
        removeHtmlAttr("data-lf-yank");
        if (__DEV__) removeHtmlAttr("data-lf-yank-text");
      },
      focus: () => input.focus(),
    };
  });
}

export function openResizePopup(shell: ContentPopupShell): void {
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
