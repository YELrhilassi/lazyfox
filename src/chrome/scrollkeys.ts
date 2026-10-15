// Vim scroll keys on chrome-owned pages where the content script never runs
// (about:, extension pages): j/k/d/u scroll, gg/G jump to top/bottom. Mirrors
// the content script's web-page handling. Only works when the page is
// reachable from chrome (in-process); cross-process pages fall through
// unconsumed (nothing else can scroll them).

import { createGgArm } from "../shared/gg";
import type { ChromeWindow } from "./env";

export function createScrollKeys(getCfg: () => { scrollKeys?: boolean }) {
  // The shared `gg` arm: the arm press is never consumed, and the window is
  // wide enough for a human double tap (see shared/gg.ts).
  const gg = createGgArm();

  function scroll(win: ChromeWindow, fn: (w: any) => void): boolean {
    try {
      const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
      if (!cw || !cw.document) return false;
      fn(cw);
      return true;
    } catch {
      return false;
    }
  }

  return function handleScrollKeys(win: ChromeWindow, e: { key: string }): boolean {
    if (getCfg().scrollKeys === false) return false;
    const k = e.key;
    if (k === "j") return scroll(win, (w) => w.scrollBy(0, 60));
    if (k === "k") return scroll(win, (w) => w.scrollBy(0, -60));
    if (k === "d") return scroll(win, (w) => w.scrollBy(0, Math.max(120, w.innerHeight * 0.5)));
    if (k === "u") return scroll(win, (w) => w.scrollBy(0, -Math.max(120, w.innerHeight * 0.5)));
    if (k === "G") {
      return scroll(win, (w) =>
        w.scrollTo(0, w.document.documentElement.scrollHeight || w.document.body.scrollHeight || 0)
      );
    }
    if (k === "g") {
      if (gg.press()) return scroll(win, (w) => w.scrollTo(0, 0));
      // Armed, not done: leave the key to the document.
      return false;
    }
    return false;
  };
}
