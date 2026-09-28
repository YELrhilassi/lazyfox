// Yank mode: a Go-core-driven block cursor over the page's flat text.
//
// The widget's `Y` key opens this. The yank BUFFER lives in the Go core: this
// module flattens the page's text (block boundaries + open shadow roots) into
// one string, YankParse builds the line table, and EVERY cursor motion is
// computed by Go — so the widget and the parsed page cannot drift, and the
// page is re-parsed whenever the DOM mutates. The cursor renders as a block
// caret that scrolls the page to follow it.
//
// `y` opens a visual selection: the anchor -> cursor range is highlighted live
// (with a char count and a text preview) and `y` yanks exactly that range, so
// the user always sees what will be copied before pressing the key. `yy`
// yanks the whole line; Esc steps back, `i` returns to the query.
//
// The reason this is its own module rather than part of the widget: it is a
// different state machine with its own key grammar (an operator-pending state
// the find widget has no concept of), and it needs the Go core where the find
// widget does not. Keeping them together is what made the closure 1000 lines.
//
// The interface below is deliberately narrow. Yank mode READS the find session
// (which match is current, so the cursor can start there) and repaints through
// it (the widget owns rendering both modes). It never writes find state.

import { coreReady, coreSync, type CoreApi } from "../../../shared/core";
import { removeHtmlAttr, setHtmlAttr } from "../../../shared/dom";
import { toast } from "../../../shared/overlay";
import { buildYankText, segAt as segAtSegs, type YankModel } from "./text";
import { flashNodeRange, selOverlay } from "./overlays";
import type { FindPiece } from "./text";

declare const __DEV__: boolean;

export type YankMode = "off" | "idle" | "pendY" | "sel";

export interface YankEls {
  count: HTMLElement;
  keys: HTMLElement;
  range: HTMLElement;
}

export interface YankDeps {
  els: YankEls;
  /** The find session, read-only. currentHit() seeds the cursor at the match
   *  the user walked to, which is the whole reason opening yank mode from a
   *  search feels like continuing it. */
  currentHit(): { pieces: FindPiece[] } | null;
  /** True when the page has changed since the flat text was built. */
  isDirty(): boolean;
  /** Repaint the widget. Yank mode changes what the badge, the hint line and
   *  the html state attributes say, so every state change goes back through
   *  the widget's render rather than painting here. */
  repaint(): void;
  copy(text: string): Promise<boolean>;
  /** Flip the input into command mode, and back to insert when leaving. */
  setInputMode(m: "cmd" | "insert", yank: boolean): void;
}

export interface Yank {
  mode(): YankMode;
  /** Enter yank mode, seeding the cursor at the current match. Returns false
   *  when the core is still initialising, having already told the user. */
  enter(): boolean;
  exit(to: "cmd" | "insert"): void;
  /** Handle a key while yank mode owns the keyboard. Returns true when the
   *  key was consumed — which is every key except a modified one, because in
   *  this mode a modifier belongs to the page, not to the widget. */
  onKey(k: string, e: KeyboardEvent): boolean;
  /** The hint line for the current sub-mode, as trusted HTML (static strings
   *  only, built here, never from page content). */
  hints(): string;
  /** Badge text and preview for the current state. */
  badge(): { count: string; range: string; valid: boolean };
  /** Caret position for the html state attribute, as "line:col". */
  position(): string;
  /** The flat text currently modelled, or "" before the first build. The
   *  dev-only probe mirrors it so a test can assert what the yank buffer
   *  contains without reaching into the module. */
  flatText(): string;
  /** Redraw (or clear) the live selection highlight. The widget calls this
   *  from its render, because the widget owns when a repaint happens — and
   *  because the highlight must be cleared on the same repaint that leaves
   *  selection mode, not on some later one. */
  paintSelection(): void;
  hideCaret(): void;
  close(): void;
}

const tryCore = (): CoreApi | null => {
  try {
    if (coreReady()) return coreSync();
  } catch (e) {
    // core not ready yet
  }
  return null;
};

const isMotion = (k: string): boolean =>
  k === "h" || k === "j" || k === "k" || k === "l" || k === "0" || k === "$" ||
  k === "w" || k === "W" || k === "b" || k === "B" || k === "e" || k === "E" ||
  k === "g" || k === "G";

export function createYank(deps: YankDeps): Yank {
  let model: YankModel | null = null;
  let mode: YankMode = "off";
  let line = 0;
  let col = 0;
  // Where `y` was pressed. The highlighted range runs anchor -> cursor
  // (inclusive), so the user sees exactly what the next `y` will copy.
  let anchor = { line: 0, col: 0 };
  let caretEl: HTMLElement | null = null;

  // Rebuild the flat text + Go line table. False when the core is still
  // initialising; the caller shows a toast and stays put.
  const rebuild = (): boolean => {
    const api = tryCore();
    if (!api) return false;
    const built = buildYankText();
    const parsed = api.yankParse(built.text);
    model = { text: built.text, segs: built.segs, lineStart: parsed.lineStart, lines: parsed.lines };
    if (line >= model.lines) line = model.lines - 1;
    if (line < 0) line = 0;
    return true;
  };

  const segAt = (off: number): { node: Text; nodeOff: number } | null =>
    model ? segAtSegs(model.segs, off) : null;

  const flatOf = (l: number, c: number): number => {
    if (!model) return 0;
    if (l < 0) l = 0;
    if (l >= model.lines) l = model.lines - 1;
    return model.lineStart[l]! + c;
  };

  // Flat offset of the real character under the cursor, never a '\n': a cursor
  // at end-of-line resolves to the line's last character. This is what makes
  // `y` at the end of a line copy a character rather than nothing.
  const charOff = (l: number, c: number): number => {
    if (!model) return 0;
    const ls = model.lineStart;
    if (l < 0) l = 0;
    if (l >= model.lines) l = model.lines - 1;
    const end = l + 1 < ls.length ? ls[l + 1]! - 1 : model.text.length;
    const len = Math.max(0, end - ls[l]!);
    let cc = c;
    if (cc < 0) cc = 0;
    if (cc >= len) cc = Math.max(0, len - 1);
    return ls[l]! + cc;
  };

  // Flat offset of a specific text node offset \u2014 used once, to seed the
  // cursor at the match the user walked to.
  const nodeFlatOffset = (node: Text, off: number): number => {
    if (!model) return 0;
    for (let i = 0; i < model.segs.length; i++) {
      const s = model.segs[i]!;
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

  // Position the block caret on the character under the cursor and scroll the
  // window so it stays visible \u2014 the page follows the cursor like a pager,
  // which is the whole reason this mode is not just find-with-a-copy-key.
  const showCaret = (): void => {
    if (!model) return;
    const off = flatOf(line, col);
    const seg = segAt(off);
    if (!seg) return;
    const len = (seg.node.data || "").length;
    let s = seg.nodeOff;
    let e = Math.min(s + 1, len);
    if (s >= len) {
      s = Math.max(0, len - 1);
      e = len;
    }
    try {
      const range = document.createRange();
      range.setStart(seg.node, s);
      range.setEnd(seg.node, e);
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
      // A range across trees: no caret, but the copy still works.
    }
    hideCaret();
  };

  // One motion through the Go core. Re-parses first when the page changed since
  // the model was built, so a lazy-loading feed yanks current lines rather than
  // the ones that were there when the mode opened.
  const motionTo = (op: string, arg: string): { line: number; col: number } | null => {
    if (!model) return null;
    if (deps.isDirty()) rebuild();
    const api = tryCore();
    if (!api || !model) return null;
    const r = api.yankMotion(op, arg, line, col);
    return { line: r.line, col: r.col };
  };

  const moveTo = (l: number, c: number): void => {
    line = l;
    col = c;
    showCaret();
    deps.repaint();
  };

  // Copy + flash a span of the flat text ([sOff, eOff), unordered).
  const yankSpanOff = (sOff: number, eOff: number): void => {
    if (!model) return;
    let s = sOff;
    let e = eOff;
    if (e < s) {
      const t = s;
      s = e;
      e = t;
    }
    if (s === e) {
      toast("empty yank");
      return;
    }
    const text = model.text.slice(s, e);
    const a = segAt(s);
    const b = segAt(e - 1);
    if (a && b) {
      const bEnd = Math.min(b.nodeOff + 1, (b.node.data || "").length);
      flashNodeRange(a.node, a.nodeOff, b.node, bEnd);
    }
    void deps.copy(text).then((ok) => {
      if (ok) toast("yanked " + text.length + " chars");
      else toast("copy failed");
    });
  };

  // Resolve a text object at the cursor and yank it. op is the Go core's
  // object key: yy / iw / aw / iW / aW / ip / ap / i" / a" / i' / a' / i` / a`
  // / i( / a( / i[ / a[ / i{ / a{ / i< / a<.
  const yankObjectAt = (op: string): void => {
    const api = tryCore();
    if (!api || !model) return;
    const o = api.yankObject(op, line, col);
    if (!o.ok) {
      toast(op === "yy" ? "nothing to yank here" : "no " + op + " here");
      return;
    }
    yankSpanOff(flatOf(o.sl, o.sc), flatOf(o.el, o.ec));
  };

  // Redraw the live selection highlight for the anchor -> cursor range.
  const paintSelection = (): void => {
    if (mode !== "sel" || !model) {
      selOverlay.clear();
      return;
    }
    const s = Math.min(charOff(anchor.line, anchor.col), charOff(line, col));
    const e = Math.max(charOff(anchor.line, anchor.col), charOff(line, col)) + 1;
    if (e <= s) {
      selOverlay.clear();
      return;
    }
    const a = segAt(s);
    const b = segAt(e - 1);
    if (!a || !b) {
      selOverlay.clear();
      return;
    }
    try {
      const range = document.createRange();
      range.setStart(a.node, a.nodeOff);
      const bEnd = Math.min(b.nodeOff + 1, (b.node.data || "").length);
      range.setEnd(b.node, bEnd);
      selOverlay.draw(Array.prototype.slice.call(range.getClientRects()) as DOMRect[]);
    } catch (err) {
      selOverlay.clear();
    }
  };

  // Yank the highlighted anchor -> cursor range (cursor character included)
  // and drop back to idle. What gets copied is exactly what was highlighted
  // while moving, which is the entire contract of a visual selection.
  const yankSelection = (): void => {
    if (!model) return;
    const aOff = charOff(anchor.line, anchor.col);
    const cOff = charOff(line, col);
    const s = Math.min(aOff, cOff);
    const e = Math.max(aOff, cOff) + 1;
    const ch = model.text[s];
    if (e <= s || ch === "\n" || ch === undefined) {
      toast("nothing selected to yank");
      return;
    }
    yankSpanOff(s, e);
    mode = "idle";
    selOverlay.clear();
    deps.repaint();
  };

  const enterSelection = (): void => {
    anchor = { line, col };
    mode = "sel";
    deps.repaint();
  };

  // Idle keys: motions move the cursor through the Go core.
  const idleKey = (k: string): boolean => {
    if (!isMotion(k)) return false;
    const t = motionTo(k === "g" ? "gg" : k, "");
    if (t) moveTo(t.line, t.col);
    return true;
  };

  const badge = (): { count: string; range: string; valid: boolean } => {
    if (mode === "sel" && model) {
      const aOff = charOff(anchor.line, anchor.col);
      const cOff = charOff(line, col);
      const n = Math.abs(cOff - aOff) + 1;
      const s = Math.min(aOff, cOff);
      const e = Math.max(aOff, cOff) + 1;
      const ch = model.text[s];
      const valid = e > s && ch !== "\n" && ch !== undefined;
      let snip = valid ? model.text.slice(s, e).replace(/\s+/g, " ").trim() : "";
      if (snip.length > 46) snip = snip.slice(0, 46) + "\u2026";
      return { count: valid ? n + " chars" : "0 chars", range: snip, valid };
    }
    return { count: line + ":" + col, range: "", valid: true };
  };

  return {
    mode: () => mode,

    enter(): boolean {
      if (!rebuild()) {
        toast("yank: core loading");
        return false;
      }
      mode = "idle";
      // Seed at the current match when there is one, else the top of the page.
      const m = deps.currentHit();
      const first = m && m.pieces[0] ? m.pieces[0] : null;
      if (first && model) {
        const off = nodeFlatOffset(first.node, first.start);
        const ls = model.lineStart;
        let l = 0;
        for (let i = 0; i < ls.length; i++) {
          if (ls[i]! <= off) l = i;
          else break;
        }
        line = l;
        col = Math.max(0, off - ls[l]!);
      } else {
        line = 0;
        col = 0;
      }
      deps.setInputMode("cmd", true);
      showCaret();
      deps.repaint();
      return true;
    },

    exit(to: "cmd" | "insert"): void {
      mode = "off";
      hideCaret();
      selOverlay.clear();
      deps.setInputMode(to, false);
      deps.repaint();
    },

    onKey(k: string, e: KeyboardEvent): boolean {
      // Esc steps back a level rather than closing the widget: sel and
      // operator-pending drop to idle, idle leaves the mode. The widget itself
      // only closes from the find modes, so yank is not a trap.
      if (k === "Escape") {
        e.preventDefault();
        if (mode === "sel" || mode === "pendY") {
          mode = "idle";
          deps.repaint();
        } else {
          this.exit("cmd");
        }
        return true;
      }
      // A modified key belongs to the page, not to the widget. Returning
      // false here would be wrong \u2014 the host would not close the widget on
      // Escape, but it would also mean the key reached the page un-prevented.
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (!k || k.length > 1) return true;
      e.preventDefault();

      if (mode === "pendY") {
        if (k === "y") {
          yankObjectAt("yy");
          mode = "idle";
          deps.repaint();
        } else if (k === "i") {
          this.exit("insert");
        } else if (isMotion(k)) {
          // `y` then a motion starts a selection at the cursor, so the range
          // is visible before it is yanked.
          enterSelection();
          idleKey(k);
        } else {
          mode = "idle";
        }
        return true;
      }

      if (mode === "sel") {
        if (k === "y") yankSelection();
        else if (k === "i") this.exit("insert");
        else idleKey(k); // motions extend the selection
        return true;
      }

      // idle
      if (k === "y") {
        mode = "pendY";
        deps.repaint();
      } else if (k === "i") {
        this.exit("insert");
      } else {
        idleKey(k);
      }
      return true;
    },

    hints(): string {
      if (mode === "sel") {
        return "<b>hjkl w b e 0 $ g G</b> extend &middot; <b>y</b> yank &middot; " +
          "<b>Esc</b> cancel";
      }
      if (mode === "pendY") {
        return "<b>y</b> line &middot; <b>hjkl w b e 0 $ g G</b> select &middot; " +
          "<b>Esc</b> cancel";
      }
      return "<b>hjkl</b> move &middot; <b>w b e</b> word &middot; <b>0 $</b> line &middot; " +
        "<b>g G</b> top/bottom &middot; <b>yy</b> line &middot; <b>y</b> select &middot; " +
        "<b>i</b> edit &middot; <b>Esc</b> back";
    },

    badge,

    position: () => line + ":" + col,
    flatText: () => (model ? model.text : ""),
    paintSelection,

    hideCaret,

    close(): void {
      mode = "off";
      hideCaret();
      selOverlay.clear();
      model = null;
    },
  };
}

// The yank mirror on <html> (data-lf-yank, and the dev-only text probe) is
// written here rather than in the widget because it is a property of yank
// state, and the widget's render has enough to decide already. Kept as a
// function so the widget does not have to know the attribute names at all.
export function mirrorYankState(yst: string, text: string | null): void {
  setHtmlAttr("data-lf-yank", yst);
  if (!__DEV__) return;
  if (document.documentElement.hasAttribute("data-lf-yank-probe")) {
    setHtmlAttr("data-lf-yank-text", text ?? "");
  } else {
    removeHtmlAttr("data-lf-yank-text");
  }
}
