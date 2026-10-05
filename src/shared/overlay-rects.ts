// Fixed-position rect overlays, one absolutely-positioned div per viewport rect
// inside a closed shadow root, so page CSS can't touch it and page scripts
// can't read it.
//
// The find highlight, the yank flash and the visual selection highlight each
// used a hand-copied version of this (its own host + style + rect divs); this is
// the single implementation, and it is its own module because nothing about it
// is popup-shaped — no input, no list, no keyboard.

export class RectOverlay {
  private host: (HTMLElement & { _sh?: ShadowRoot }) | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  // Declared as plain fields rather than constructor parameter properties:
  // parameter properties are a compile-time-only construct that Node's
  // type-stripping loader (used by the unit tests) cannot erase, so a single
  // one anywhere in the import graph would make the module untestable.
  private readonly id: string;
  private readonly zIndex: number;
  private readonly rectCss: string;

  constructor(id: string, zIndex: number, rectCss: string) {
    this.id = id;
    this.zIndex = zIndex;
    this.rectCss = rectCss;
  }

  // Draws the given viewport rects (`.o` elements) into the overlay host,
  // replacing whatever was there. Empty rects clears the overlay.
  draw(rects: DOMRect[], maxRects = 300): void {
    if (!this.host) {
      this.host = document.createElement("div");
      this.host.id = this.id;
      this.host.style.cssText =
        "all:initial;position:fixed;inset:0;pointer-events:none;z-index:" + this.zIndex + ";";
      this.host._sh = this.host.attachShadow({ mode: "closed" });
      document.documentElement.appendChild(this.host);
    }
    const sh = this.host._sh!;
    sh.textContent = "";
    if (!rects.length) return;
    const st = document.createElement("style");
    st.textContent = this.rectCss;
    sh.appendChild(st);
    const n = Math.min(rects.length, maxRects);
    for (let i = 0; i < n; i++) {
      const r = rects[i]!;
      const d = document.createElement("div");
      d.className = "o";
      d.style.left = r.left + "px";
      d.style.top = r.top + "px";
      d.style.width = r.width + "px";
      d.style.height = r.height + "px";
      sh.appendChild(d);
    }
  }

  // Draws a transient overlay that removes itself after ttlMs (the yank
  // flash's fade-out is part of the rectCss animation).
  flash(rects: DOMRect[], ttlMs: number): void {
    this.draw(rects);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => this.clear(), ttlMs);
  }

  clear(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
    if (this.host) {
      try {
        this.host.remove();
      } catch (e) {
        // ignore
      }
      this.host = null;
    }
  }
}