// The which-key overlay's DOM: one persistent closed-shadow host, its body, its
// foot, and the `on` class that means "on screen".
//
// The host is persistent on purpose — it keeps its node across presses and only
// loses its `on` class. Rebuilding it per press was both slower and the reason
// a lost-ownership overlay could outlive the page that justified it. That makes
// the ownership and the visibility two separate facts, which is why this class
// exposes `setShown(false)` rather than a `hide()` that implies teardown.
//
// Nothing here knows about the leader: it is handed the HTML to show and asked
// to show or not show it.

import { WK_CSS, WK_HOST_HTML } from "./leader-css";

export type LeaderHost = HTMLElement & { _sh: ShadowRoot };

export class LeaderPanel {
  private host: LeaderHost | null = null;

  /** The live host, creating and attaching it on first use. */
  ensure(): LeaderHost {
    if (!this.host) {
      const host = document.createElement("div") as unknown as LeaderHost;
      host.id = "lazyfox-leader";
      const sh = host.attachShadow({ mode: "closed" });
      sh.innerHTML = "<style>" + WK_CSS + "</style>" + WK_HOST_HTML;
      host._sh = sh;
      document.documentElement.appendChild(host);
      this.host = host;
    }
    return this.host;
  }

  /** The host, or null when the overlay has never been shown. */
  current(): LeaderHost | null {
    return this.host;
  }

  /**
   * Show or hide the panel. This is only the `on` class: the node stays, so a
   * later press is cheap and nothing can be left over from the previous page.
   */
  setShown(on: boolean): void {
    if (!this.host) return;
    const box = this.host._sh.querySelector(".wk");
    if (box) box.classList.toggle("on", on);
  }

  /** Whether the panel is currently painted. */
  shown(): boolean {
    if (!this.host) return false;
    const box = this.host._sh.querySelector(".wk");
    return !!(box && box.classList.contains("on"));
  }

  /**
   * Fill the body and foot with already-computed HTML, keeping the selected row
   * visible: the overlay shows every binding on one page, so arrow navigation
   * has to scroll the body to follow the highlight.
   *
   * The scrollIntoView is guarded because a range across trees throws, and a
   * throw here would take down the leader that called render.
   */
  fill(bodyHtml: string, footHtml: string): void {
    if (!this.host) return;
    const sh = this.host._sh;
    const body = sh.querySelector(".wk-body");
    if (body) {
      body.innerHTML = bodyHtml;
      try {
        const selEl = body.querySelector(".wk-item.sel");
        if (selEl) selEl.scrollIntoView({ block: "nearest" });
      } catch (e) {
        // ignore
      }
    }
    const foot = sh.querySelector(".wk-foot");
    if (foot) foot.innerHTML = footHtml;
  }

  /** Length of the rendered body, for the dev-only self test. -1 when absent. */
  bodyLength(): number {
    if (!this.host) return -1;
    const body = this.host._sh.querySelector(".wk-body");
    return body ? body.innerHTML.length : -1;
  }
}