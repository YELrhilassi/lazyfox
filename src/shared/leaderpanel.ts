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
import { uiCss } from "./theme";
import { promoteToTopLayer } from "./toplayer";

export type LeaderHost = HTMLElement & { _sh: ShadowRoot };

export class LeaderPanel {
  private host: LeaderHost | null = null;
  // The host's element id. Configurable because a window can hold TWO panels
  // of this class at once: the chrome helper's own leader and the mirror it
  // paints for a SPLIT page's leader (the page cannot draw across its pane, so
  // the helper paints its menu in the window and this is the second host).
  private readonly id: string;

  constructor(id = "lazyfox-leader") {
    this.id = id;
  }

  /** The live host, creating it on first use and RE-attaching it if the page
   * detached it. */
  ensure(): LeaderHost {
    if (!this.host) {
      // A LAYER FROM A DEAD INSTANCE IS NOT A LAYER OF THIS ONE. An extension
      // update leaves the old host — and its last painted menu — in the
      // document, in the top layer, with nothing alive to hide it. The ids are
      // per-owner (the chrome leader and the split-page mirror use different
      // ones), so removing this class's own id cannot touch a sibling host.
      try {
        const stale = document.getElementById(this.id);
        if (stale) stale.remove();
      } catch (e) {
        // A document that refuses the read falls through to the fresh host.
      }
      const host = document.createElement("div") as unknown as LeaderHost;
      host.id = this.id;
      // A viewport-sized box that ignores the pointer: the panel inside it is
      // the only interactive part (see leader-css.ts), and the host exists so
      // that the panel is measured against the VIEWPORT rather than against
      // the page's document box — see the promotion below.
      host.style.cssText =
        "all:initial;position:fixed;inset:0;display:block;pointer-events:none;";
      const sh = host.attachShadow({ mode: "closed" });
      sh.innerHTML = "<style>" + uiCss(WK_CSS) + "</style>" + WK_HOST_HTML;
      host._sh = sh;
      document.documentElement.appendChild(host);
      // ABOVE THE PAGE, NOT MERELY ABOVE ITS z-index.
      //
      // `.wk` is `position:fixed;right:24px;bottom:30px`, which is the corner of
      // the VIEWPORT only while no ancestor is a containing block for it. A page
      // that transforms <html> (a drawer, a scroll-lock, a GPU hint) makes the
      // root one, so the panel resolves against the document box and is drawn
      // below the fold on any page taller than the screen: pressing the leader
      // key then shows nothing at all. The top layer is laid out against the
      // initial containing block, so the corner stays the corner.
      promoteToTopLayer(host);
      this.host = host;
      return this.host;
    }
    // A PAGE CAN TAKE THE HOST AWAY WHILE THE OVERLAY IS UP.
    //
    // The host is a child of <html>, and a page that re-renders the root — a
    // framework hydration swap, a `documentElement.replaceChildren()`, a
    // document-write-style shell — removes it without ever telling us. The
    // overlay then keeps its state (armed, with a which-key that is painted
    // into a node nobody can see) while the SHADOW ROOT still answers, so
    // `shown()` is true and every keystroke is dispatched as a `;x` binding
    // against an invisible menu: the reported "the leader key and the which-key
    // stay active and then nothing responds". Re-attaching is what makes the
    // state and the pixels agree again, and it costs one isConnected read.
    if (!this.host.isConnected) {
      try {
        document.documentElement.appendChild(this.host);
        // Removing an element from the document closes its popover, so a host
        // the page detached is not merely re-attached here: it is promoted
        // again, or it comes back as a plain child of <html> that the page can
        // move out of the viewport.
        promoteToTopLayer(this.host);
      } catch (e) {
        // A page that refuses the append must not break the leader; the next
        // press tries again.
      }
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
  fill(headHtml: string, bodyHtml: string, footHtml: string): void {
    if (!this.host) return;
    const sh = this.host._sh;
    const head = sh.querySelector(".wk-head");
    if (head) head.innerHTML = headHtml;
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