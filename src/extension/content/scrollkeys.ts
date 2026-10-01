// The content script's vim scroll keys: j/k move by line, d/u by page, gg/G
// jump to top/bottom — all routed through the scroll controller's target (the
// document scroller by default, an inner pane when the document cannot
// scroll, or the region the user cycled to with ;F / ;B).

import type { ScrollController } from "./scroll";

export function createScrollKeys(
  scroll: ScrollController,
  getCfg: () => { scrollKeys?: boolean }
) {
  let lastG = false;

  return function handleScrollKeys(e: KeyboardEvent): boolean {
    if (getCfg().scrollKeys === false) return false;
    const k = e.key;
    if (k === "j") { scroll.scrollLines(1); return true; }
    if (k === "k") { scroll.scrollLines(-1); return true; }
    if (k === "d") { scroll.scrollPage(1); return true; }
    if (k === "u") { scroll.scrollPage(-1); return true; }
    if (k === "G") { scroll.toBottom(); return true; }
    if (k === "g") {
      if (lastG) {
        scroll.toTop();
        lastG = false;
      } else {
        lastG = true;
        setTimeout(() => {
          lastG = false;
        }, 600);
      }
      return true;
    }
    return false;
  };
}
