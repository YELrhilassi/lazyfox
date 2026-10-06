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

/**
 * The overlay's heading.
 *
 * Its whole job is to answer "what am I looking at?" at a glance. At the top
 * level that is the whole keymap; inside a category it is that category.
 * Before this existed the panel had no heading at all, so pressing `;W` left
 * the identical panel on screen and the only cue that a category was open was
 * a few characters in the status bar — which is why a category read as the top
 * level with something subtly wrong about it.
 *
 * The CONTENT of the header, not the header itself. `WK_HOST_HTML` already owns
 * the `.wk-head` element and `fill()` assigns into it, so returning a wrapping
 * div here nested a second `.wk-head` inside the first — and an inner flex item
 * is sized to its content, so the header's bottom border drew only as far as
 * the title text. A rule that stops halfway across the panel reads as a stray
 * line under the title, not as the edge of a header.
 */
export function wkHeadHtml(head: string, title: string): string {
  const chord = head ? "⌘" + esc(head) : "⌘";
  return (
    "<span class='wk-chord'>" + chord + "</span>" +
    "<span class='wk-title'>" + esc(title || "All keys") + "</span>"
  );
}

/**
 * The body for an open category: its sub-keys, one per row, with the label the
 * binding table gives them.
 *
 * One column, not the top level's two, because the labels here are sentences
 * ("Toggle toolbar reveal", "Move tab into split…") and two of those in 360px
 * leaves about 140px of text — readable only if you already know the answer.
 * One column puts the whole label on one line at the same width.
 *
 * Every key in the table is shown. The status bar used to summarise these as
 * "w z e | [ ] +6", which is not a menu: it named six of eleven keys and
 * silently dropped the other five, so the key the user wanted was the one most
 * likely to be the one missing.
 */
export function wkCategoryHtml(keys: string[], labels: Record<string, string>): string {
  let html = "";
  for (const k of keys) {
    const label = labels && labels[k] ? labels[k] : "";
    html +=
      "<div class='wk-item wk-cat'><span class='wk-kbd'>" + esc(k) + "</span>" +
      "<span>" + esc(label) + "</span></div>";
  }
  if (!html) html = "<div class='wk-group'>—</div>";
  return html;
}

export function wkFootHtml(pageNum: number, total: number, isCategory = false): string {
  if (isCategory) {
    // Inside a category the overlay is not a navigable list — there is no
    // cursor to move and no Enter to run — so the foot says only what is true:
    // these keys are live now, and Escape ends it.
    return "<span class='wk-live'>press a key</span><span>Esc cancel</span>";
  }
  // With a single page (every binding visible) there is nothing to flip;
  // only show the Tab hint when paging actually exists.
  const pageHint = total > 1 ? "<span>Tab page</span>" : "";
  return (
    "<span>\u2191/\u2193 move</span>" + pageHint + "<span>Enter run</span><span>Esc cancel</span>" +
    "<span class='wk-page'>" + (pageNum + 1) + "/" + total + "</span>"
  );
}
