// The yank block caret: one absolutely-positioned div pinned to the character
// under the cursor, with the page scrolled to follow it.
//
// Its own module because the caret has a lifetime that the yank mode does not
// own — it survives a redraw, it is torn down independently of the mode, and it
// is the only part of yank mode that moves the page. Keeping that together
// meant a redraw and a scroll were edited in the same block as the selection
// rules, and they have nothing to do with each other.

import type { Seg } from "./yankgeometry";

const CARET_CSS =
  "all:initial;position:fixed;z-index:2147483647;pointer-events:none;" +
  "background:rgba(122,162,247,.55);border:1px solid #7aa2f7;border-radius:2px;" +
  "box-shadow:0 0 0 1px rgba(10,12,20,.6);";

export class YankCaret {
  private el: HTMLElement | null = null;

  private ensure(): HTMLElement {
    if (this.el && this.el.isConnected) return this.el;
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.id = "lazyfox-caret";
      this.el.style.cssText = CARET_CSS;
    }
    document.documentElement.appendChild(this.el);
    return this.el;
  }

  hide(): void {
    if (this.el) {
      try {
        this.el.remove();
      } catch (e) {
        // ignore
      }
      this.el = null;
    }
  }

  /**
   * Position the caret on the character at `seg` and scroll the window so it
   * stays visible — the page follows the cursor like a pager, which is the whole
   * reason this mode is not just find-with-a-copy-key.
   *
   * Hides itself when the character has no box: a range across trees measures
   * as zero, and a caret pinned to nothing would sit in the corner pretending.
   */
  show(seg: Seg): void {
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
        const el = this.ensure();
        el.style.left = rect.left + "px";
        el.style.top = rect.top + "px";
        el.style.width = Math.max(2, rect.width) + "px";
        el.style.height = rect.height + "px";
        const vh = window.innerHeight;
        // 90px keeps the caret clear of the status bar at the top; 70px does
        // the same at the bottom.
        if (rect.top < 90) window.scrollBy(0, rect.top - 90);
        else if (rect.bottom > vh - 70) window.scrollBy(0, rect.bottom - vh + 70);
        return;
      }
    } catch (e) {
      // A range across trees: no caret, but the copy still works.
    }
    this.hide();
  }
}