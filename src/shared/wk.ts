// Which-key overlay support shared by the content script and the chrome
// helper. All page math (page count, slicing, clamping, flipping, selection
// navigation) is delegated to the Go core so the two contexts cannot drift;
// this module only owns the tiny amount of per-context state (current page and
// selection) plus the shared HTML builders for the overlay body/footer.
//
// State mutations are serialized through a promise chain so rapid Tab/arrow
// presses stay ordered even before the core has finished initializing. Once
// the core is ready (pre-warmed at startup) the calls resolve synchronously.

import { core, coreReady, coreSync } from "./core";
import { esc } from "./dom";
import type { WkPage } from "./types";

export class WkSession {
  sel = 0;
  page = 0;
  private chain: Promise<void> = Promise.resolve();

  private run(fn: () => void | Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch(() => {});
    return this.chain;
  }

  reset(): void {
    this.sel = 0;
    this.page = 0;
  }

  pageCount(): Promise<number> {
    if (coreReady()) return Promise.resolve(coreSync().wkPageCount());
    return core.wkPageCount();
  }

  // Flips to another page and clamps the selection into that page's runnable
  // range. Resolves when the state has been updated.
  flip(dir: number): Promise<void> {
    return this.run(() => {
      if (coreReady()) {
        const c = coreSync();
        this.page = c.wkFlip(this.page, dir);
        this.sel = c.wkClampSel(this.sel, this.page);
      } else {
        return Promise.all([core.wkFlip(this.page, dir), core.wkClampSel(this.sel, this.page)]).then(
          ([page, sel]) => {
            this.page = page;
            this.sel = sel;
          }
        );
      }
    });
  }

  nav(dir: number): Promise<void> {
    return this.run(() => {
      if (coreReady()) {
        const c = coreSync();
        this.sel = c.wkNav(this.sel, this.page, dir);
      } else {
        return core.wkNav(this.sel, this.page, dir).then((sel) => {
          this.sel = sel;
        });
      }
    });
  }

  slice(): Promise<WkPage> {
    if (coreReady()) return Promise.resolve(coreSync().wkPageSlice(this.page));
    return core.wkPageSlice(this.page);
  }
}

// Builds the overlay body HTML for one page. Lazyfox bindings are selectable
// (highlighted when they carry the current selection); native shortcuts are
// dimmed reference rows.
export function wkBodyHtml(page: WkPage, sel: number): string {
  let html = "";
  let group: string | null = null;
  for (const it of page.items) {
    if (it.group !== group) {
      if (group !== null) html += "</div>";
      html += "<div class='wk-group'>" + esc(it.group) + "</div><div class='wk-grid'>";
      group = it.group;
    }
    if (!it.native) {
      html +=
        "<div class='wk-item" + (it.lazyIndex === sel ? " sel" : "") + "'>" +
        "<span class='wk-kbd'>" + esc(it.key) + "</span><span>" + esc(it.label) +
        "</span></div>";
    } else {
      html +=
        "<div class='wk-item dim'><span class='wk-kbd'>" + esc(it.key) + "</span><span>" +
        esc(it.label) + "</span></div>";
    }
  }
  if (group !== null) html += "</div>";
  if (!html) html = "<div class='wk-group'>\u2014</div>";
  return html;
}

export function wkFootHtml(pageNum: number, total: number): string {
  return (
    "<span>\u2191/\u2193 move</span><span>Tab page</span><span>Enter run</span><span>Esc cancel</span>" +
    "<span class='wk-page'>" + (pageNum + 1) + "/" + total + "</span>"
  );
}
