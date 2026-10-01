// Vim scroll keys on chrome-owned pages where the content script never runs
// (about:, extension pages): j/k/d/u scroll, gg/G jump to top/bottom. Mirrors
// the content script's web-page handling. Only works when the page is
// reachable from chrome (in-process); cross-process pages fall through
// unconsumed (nothing else can scroll them).

export function createScrollKeys(getCfg: () => { scrollKeys?: boolean }) {
  let lastG = false;

  function scroll(win: Window, fn: (w: any) => void): boolean {
    try {
      const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
      if (!cw || !cw.document) return false;
      fn(cw);
      return true;
    } catch {
      return false;
    }
  }

  return function handleScrollKeys(win: Window, e: { key: string }): boolean {
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
      if (lastG) {
        lastG = false;
        return scroll(win, (w) => w.scrollTo(0, 0));
      }
      lastG = true;
      setTimeout(() => {
        lastG = false;
      }, 600);
      return true;
    }
    return false;
  };
}
