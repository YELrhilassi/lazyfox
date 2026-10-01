// The three rect overlays the find widget draws, and the flash helpers.
//
// They were three hand-copied implementations inside the find closure before
// they became one shared RectOverlay each, and they are in one module now for
// a second reason: a yank flash is drawn from both the plain `y` (copy the
// current match) and the full yank mode, and the two must not be able to
// disagree about what a flash looks like or how long it lasts.
//
// All three live in closed shadow roots appended to the document, so page CSS
// cannot reach them, and none of them sets a native selection. That is the
// whole reason they exist: the old widget highlighted through
// window.getSelection(), which throws across shadow boundaries (so
// Reddit-style pages showed no highlight at all) and is cleared by any page
// script or click.

import { RectOverlay } from "../../../shared/overlay";
import type { FindPiece } from "./text";

/** The current match's highlight. */
export const hitOverlay = new RectOverlay(
  "lazyfox-hl",
  2147483646,
  ".o{position:fixed;background:rgba(224,175,104,.38);" +
    "outline:1px solid rgba(224,175,104,.85);border-radius:2px;pointer-events:none;}"
);

/** The amber fade over text that was just copied, neovim-style. */
export const flashOverlay = new RectOverlay(
  "lazyfox-flash",
  2147483647,
  "@keyframes lfYank{from{opacity:.55}to{opacity:0}}" +
    ".o{position:fixed;background:#e0af68;border-radius:2px;pointer-events:none;" +
    "animation:lfYank .38s ease-out forwards;}"
);

/** The live anchor-to-cursor range in yank mode, so what `y` will copy is
 *  visible before it is copied. */
export const selOverlay = new RectOverlay(
  "lazyfox-sel",
  2147483646,
  ".o{position:fixed;background:rgba(122,162,247,.30);border-radius:2px;pointer-events:none;}"
);

/** Amber flash over any text rects, fading out. Ignores an empty list rather
 *  than flashing nothing, so callers do not each re-check. */
export function flashRects(rects: DOMRect[] | undefined): void {
  if (!rects || !rects.length) return;
  flashOverlay.flash(rects, 450);
}

/** Flash a range that may span several text nodes — used by yank mode, where
 *  a line motion routinely crosses a node boundary. */
export function flashNodeRange(aNode: Text, aOff: number, bNode: Text, bOff: number): void {
  try {
    const range = document.createRange();
    range.setStart(aNode, aOff);
    range.setEnd(bNode, bOff);
    flashRects(Array.prototype.slice.call(range.getClientRects()) as DOMRect[]);
  } catch (e) {
    // A range that spans trees cannot be flashed. The copy already happened;
    // losing the visual is the right thing to do silently.
  }
}

/** Flash the DOM pieces of a match. Each piece is its own range, so a match
 *  crossing two nodes flashes both rather than failing. */
export function flashPieces(pieces: FindPiece[]): void {
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
}
