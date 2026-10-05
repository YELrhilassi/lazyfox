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
// This file is the state machine and the key grammar. Two collaborators take
// the parts that are not that:
//
//   yankgeometry.ts  (line, col) <-> flat offset, and selection spans
//   yankcaret.ts     the block caret element and the scroll that follows it
//   yanktypes.ts     the contract the find widget programs against

import { coreReady, coreSync, type CoreApi } from "../../../shared/core";
import { removeHtmlAttr, setHtmlAttr } from "../../../shared/dom";
import { toast } from "../../../shared/overlay";
import { buildYankText, segAt as segAtSegs, type YankModel } from "./text";
import { flashNodeRange, selOverlay } from "./overlays";
import {
  flatOf,
  lineOf,
  nodeFlatOffset,
  previewSpan,
  selectionSpan
} from "./yankgeometry";
import { YankCaret } from "./yankcaret";
import type { Yank, YankDeps, YankMode } from "./yanktypes";

declare const __DEV__: boolean;

export type { Yank, YankDeps, YankEls, YankMode } from "./yanktypes";

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
  const caret = new YankCaret();

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

  const segAt = (off: number) => (model ? segAtSegs(model.segs, off) : null);

  const showCaret = (): void => {
    if (!model) return;
    const seg = segAt(flatOf(model, line, col));
    if (!seg) return;
    caret.show(seg);
  };

  const hideCaret = (): void => caret.hide();

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
    yankSpanOff(flatOf(model, o.sl, o.sc), flatOf(model, o.el, o.ec));
  };

  // Redraw the live selection highlight for the anchor -> cursor range.
  const paintSelection = (): void => {
    if (mode !== "sel" || !model) {
      selOverlay.clear();
      return;
    }
    const span = selectionSpan(model, anchor.line, anchor.col, line, col);
    if (!span.valid) {
      selOverlay.clear();
      return;
    }
    const a = segAt(span.s);
    const b = segAt(span.e - 1);
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
    const span = selectionSpan(model, anchor.line, anchor.col, line, col);
    if (!span.valid) {
      toast("nothing selected to yank");
      return;
    }
    yankSpanOff(span.s, span.e);
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
      const span = selectionSpan(model, anchor.line, anchor.col, line, col);
      return {
        count: span.valid ? span.count + " chars" : "0 chars",
        range: span.valid ? previewSpan(model.text, span.s, span.e) : "",
        valid: span.valid
      };
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
        const off = nodeFlatOffset(model, first.node, first.start);
        line = lineOf(model, off);
        col = Math.max(0, off - model.lineStart[line]!);
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
      // false here would be wrong — the host would not close the widget on
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