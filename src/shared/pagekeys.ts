// Vim keys for Lazyfox's own pages.
//
// The chrome helper cannot see keys typed into an extension page (extension
// pages run out of process, and the content script is not injected there), so
// each of Lazyfox's own pages installs the small keyboard surface it needs
// itself. Keeping that in one place means the setup page, the diagnostics page
// and anything added later behave identically instead of drifting apart — the
// same reason the leader table lives in one file.
//
// The surface is deliberately minimal: j/k/d/u scroll, gg/G jump to the ends,
// Esc leaves a field (or steps back when nothing is focused), and a one-key `;`
// leader whose bindings the page supplies. A page that wants nothing more than
// the scroll keys just calls installPageKeys().

export interface PageKeysOptions {
  // Extra `;`-bindings for this page, by key. `g` (back) is always available.
  leader?: Record<string, () => void>;
  // Scroll step in pixels for j/k (default 60).
  step?: number;
}

const GG_WINDOW_MS = 600;

export function installPageKeys(opts: PageKeysOptions = {}): void {
  const step = opts.step && opts.step > 0 ? opts.step : 60;
  let leaderPending = false;
  let gArmed = false;

  const isField = (el: Element | null): boolean => {
    if (!el) return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    const he = el as HTMLElement;
    return !!(
      he.isContentEditable ||
      (el.getAttribute && el.getAttribute("contenteditable") === "true")
    );
  };

  const pageScroll = (dy: number): void => window.scrollBy(0, dy);
  const toBottom = (): void =>
    window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (leaderPending) {
        e.preventDefault();
        leaderPending = false;
        if (e.key === "Escape") return;
        const fn = opts.leader && opts.leader[e.key];
        if (fn) {
          fn();
          return;
        }
        if (e.key === "g" || e.key === "G") {
          if (window.history.length > 1) window.history.back();
        }
        return;
      }
      const ae = document.activeElement as HTMLElement | null;
      if (e.key === "Escape") {
        if (isField(ae)) {
          e.preventDefault();
          ae!.blur();
        } else if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
        return;
      }
      if (isField(ae) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === ";") {
        e.preventDefault();
        leaderPending = true;
        return;
      }
      if (e.key === "j") {
        e.preventDefault();
        pageScroll(step);
        return;
      }
      if (e.key === "k") {
        e.preventDefault();
        pageScroll(-step);
        return;
      }
      if (e.key === "d") {
        e.preventDefault();
        pageScroll(Math.max(120, window.innerHeight * 0.5));
        return;
      }
      if (e.key === "u") {
        e.preventDefault();
        pageScroll(-Math.max(120, window.innerHeight * 0.5));
        return;
      }
      if (e.key === "G") {
        e.preventDefault();
        toBottom();
        return;
      }
      if (e.key === "g") {
        e.preventDefault();
        if (gArmed) {
          gArmed = false;
          window.scrollTo(0, 0);
        } else {
          gArmed = true;
          setTimeout(() => {
            gArmed = false;
          }, GG_WINDOW_MS);
        }
      }
    },
    true
  );
}
