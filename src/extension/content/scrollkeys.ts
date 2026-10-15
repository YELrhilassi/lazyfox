// The content script's vim scroll keys: j/k move by line, d/u by page, gg/G
// jump to top/bottom — all routed through the scroll controller's target (the
// document scroller by default, an inner pane when the document cannot
// scroll, or the region the user cycled to with ;F / ;B).

import { createGgArm } from "../../shared/gg";
import type { ScrollController } from "./scroll";

export function createScrollKeys(
  scroll: ScrollController,
  getCfg: () => { scrollKeys?: boolean }
) {
  // The `gg` gesture, in the shared arm (see shared/gg.ts): the ARM press is
  // not consumed — a `g` that did nothing must not be a keystroke taken from
  // the page — and the window is generous enough for a human double tap.
  const gg = createGgArm();

  return function handleScrollKeys(e: KeyboardEvent): boolean {
    if (getCfg().scrollKeys === false) return false;
    const k = e.key;
    if (k === "j") { scroll.scrollLines(1); return true; }
    if (k === "k") { scroll.scrollLines(-1); return true; }
    if (k === "d") { scroll.scrollPage(1); return true; }
    if (k === "u") { scroll.scrollPage(-1); return true; }
    if (k === "G") { scroll.toBottom(); return true; }
    if (k === "g") {
      if (gg.press()) {
        scroll.toTop();
        return true;
      }
      // Not consumed while armed: the key continues to the page, so the first
      // press of the gesture can never be a silent no-op.
      return false;
    }
    return false;
  };
}
