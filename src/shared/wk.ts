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
import { ANY_KEY_EXPECT } from "./leadersignal";
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
//
// ONE ROW SHAPE, three columns: the key, the label, and (for a door) what is
// behind it. The label always carries `.wk-label` and the key cap always carries
// `.wk-kbd`, because the stylesheet aligns labels by a fixed FIRST column and
// ellipsizes only the label — class names a style depends on belong on every row
// that style applies to, not on "the second child".
export function wkBodyHtml(page: WkPage, sel: number): string {
  let html = "";
  let group: string | null = null;
  for (const it of page.items) {
    if (it.group !== group) {
      if (group !== null) html += "</div>";
      html += "<div class='wk-group'>" + esc(it.group) + "</div><div class='wk-grid'>";
      group = it.group;
    }
    if (it.native) {
      html +=
        "<div class='wk-item dim'><span class='wk-kbd'>" + esc(it.key) +
        "</span><span class='wk-label'>" + esc(it.label) + "</span></div>";
      continue;
    }
    // A CATEGORY HEAD IS A MENU, and it says so.
    //
    // It used to be drawn identically to a binding — same row, same key badge —
    // while Enter on it did nothing at all. A row that opens eleven keys has to
    // look like a door: the trailing count is what tells the reader it is worth
    // pressing, and the footer stops promising "Enter run" on it.
    //
    // The row class is `wk-door`, NOT `wk-head`. Reusing the panel header's own
    // class for a row meant the two designs had to be told apart by source order,
    // and the header lost that contest: it rendered with the row's background and
    // left accent bar. `.wk-head` means the panel header, `.wk-door` means a row
    // that opens something.
    if (it.cat) {
      const n = typeof it.subs === "number" && it.subs > 0 ? String(it.subs) : "";
      html +=
        "<div class='wk-item wk-door" + (it.lazyIndex === sel ? " sel" : "") + "'>" +
        "<span class='wk-kbd'>" + esc(it.key) + "</span><span class='wk-label'>" +
        esc(it.label) + "</span>" +
        "<span class='wk-more'>" + esc(n ? n + " \u203a" : "\u203a") + "</span></div>";
      continue;
    }
    html +=
      "<div class='wk-item" + (it.lazyIndex === sel ? " sel" : "") + "'>" +
      "<span class='wk-kbd'>" + esc(it.key) + "</span><span class='wk-label'>" +
      esc(it.label) + "</span></div>";
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
  // The chord badge shows the sequence that got here — `W` inside Window &
  // layout — and NOTHING at the top level.
  //
  // It used to render `⌘` unconditionally: a Mac command glyph, drawn as if it
  // were a key on the user's keyboard, on every platform, in a product whose
  // leader is `;`. A header that shows a key the keymap does not contain is
  // worse than a header with no badge at all, because the reader tries to press
  // it, and it was the first thing in the panel to be wrong.
  const chord = head ? "<span class='wk-chord'>" + esc(head) + "</span>" : "";
  return chord + "<span class='wk-title'>" + esc(title || "All keys") + "</span>";
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
      "<span class='wk-label'>" + esc(label) + "</span></div>";
  }
  if (!html) html = "<div class='wk-group'>—</div>";
  return html;
}

export function wkFootHtml(
  pageNum: number,
  total: number,
  isCategory = false,
  selIsHead = false,
): string {
  if (isCategory) {
    // Inside a category the overlay is not a navigable list — there is no
    // cursor to move and no Enter to run — so the foot says only what is true:
    // these keys are live now, and Escape ends it. The SAME words serve an armed
    // multi-key action, because it is the same state: a capture is collecting.
    return "<span class='wk-live'>press a key</span><span>Esc cancel</span>";
  }
  // With a single page (every binding visible) there is nothing to flip;
  // only show the Tab hint when paging actually exists.
  const pageHint = total > 1 ? "<span>Tab page</span>" : "";
  // THE FOOTER ONLY PROMISES WHAT THE HIGHLIGHTED ROW CAN DO.
  //
  // "Enter run" was printed unconditionally, including on the category heads,
  // where Enter now opens a menu and on which it used to do nothing whatsoever. A
  // keymap that advertises an inert key is the same lie as a menu row for an
  // unbound chord.
  const enter = selIsHead ? "<span>Enter open</span>" : "<span>Enter run</span>";
  // `?` is named here on purpose: this panel lists the LEADER's bindings, and
  // Firefox's own shortcuts are intentionally not among them. Saying where the
  // rest lives is what keeps the two surfaces from looking like they disagree.
  const reference = pageNum + 1 === 1 ? "<span>? all keys</span>" : "";
  // THE TOP LEVEL NAMES FOUR THINGS, NOT SIX.
  //
  // "Esc cancel" was printed here too, and it was the one item that told the
  // reader nothing they had not already learned: Escape is how every surface in
  // this product is left, and it is the ONLY way out of a capture — which is
  // exactly why it is still named in the foot that belongs to a capture (above)
  // and not on the page that is just a list. Four items read as a line of help;
  // five read as a toolbar.
  //
  // The arrows read as one glyph pair, not as prose ("↑/↓ move" was longer and
  // asked the eye to parse a slash for no information), and the page number is
  // the only thing on the line that ends it.
  return (
    "<span>\u2191\u2193 move</span>" + pageHint + enter + reference +
    "<span class='wk-page'>" + (pageNum + 1) + "/" + total + "</span>"
  );
}

/**
 * The heading title for an armed MULTI-KEY ACTION: what the next key can be.
 *
 * The panel is a view of the leader's state, and "a sequence is collecting" is a
 * state — a different one from "the map is up". While a capture is armed the
 * keys it collects belong to the capture, so the top-level map is not available
 * and leaving it on screen is worse than saying nothing: the reader presses a row
 * that cannot fire. This is the panel's own wording for such a state, derived
 * from the armer's expectation (the same string the status bar prints) rather
 * than from a second guess about what a sequence accepts.
 */
export function wkExpectTitle(expect: string): string {
  const t = (expect || "").trim();
  // "" and "any" are the same promise to the reader — nothing is required — and
  // the armer's own word for it is "any" (see ANY_KEY_EXPECT). Mixing the two
  // would print "next any" for one capture and "next key" for an identical one.
  if (!t || t === ANY_KEY_EXPECT) return "any key";
  return "next " + t;
}

/** One panel's worth of markup: the three parts `LeaderPanel.fill` takes. */
export interface WkPanelHtml {
  head: string;
  body: string;
  foot: string;
}

/**
 * The leader state the panel draws, as plain data.
 *
 * `page` is a THUNK because it is core work: the map is the only content that
 * needs a page of rows, and asking the core for one while a category or a
 * sequence is on screen is wasted work on every repaint of the states that
 * repaint most (a sub-key press repaints twice).
 */
export interface WkPanelInput {
  category?: { head: string; title: string; labels: Record<string, string>; keys: string[] } | null;
  pending?: { chord: string; expect: string } | null;
  page: () => Promise<WkPage>;
  sel: number;
  pageNum: number;
  total: () => Promise<number>;
}

/**
 * WHAT THE PANEL SHOWS, as a pure function of the leader's state.
 *
 * The panel has three contents and no more: the map, a category's menu, and a
 * multi-key action in flight. All three are decided here rather than inside the
 * controller's render() because the panel lives in a CLOSED shadow root — its
 * contents cannot be read back from a page, not by the e2e suite and not by the
 * debug snapshot — so a decision made there is a decision nothing can check.
 * Pure, it is assertable directly, and the controller is left with plumbing.
 *
 * THE ORDER OF THE TWO TESTS IS LOAD-BEARING. Opening a category ARMS a capture
 * — that is how its sub-keys are read — so `category` and `pending` are true at
 * the same time for every open menu. Testing `pending` first would render every
 * category as "a sequence is waiting for a key" and the menu the user just
 * opened would never appear. A menu the user can still read wins over a capture
 * that is merely its reader.
 */
export async function wkPanelHtml(s: WkPanelInput): Promise<WkPanelHtml> {
  if (s.category) {
    const c = s.category;
    return {
      head: wkHeadHtml(c.head, c.title),
      body: wkCategoryHtml(c.keys, c.labels),
      // The same foot an armed capture gets, because it is the same state: these
      // keys are live now and Escape is how you leave.
      foot: wkFootHtml(0, 1, true),
    };
  }
  if (s.pending) {
    // The map is deliberately NOT drawn under a sequence in flight. While a
    // capture is armed the keyboard belongs to the capture — `;W m` then `3` is
    // tab 3, not the binding on `3` — so a list of top-level rows would offer
    // keys that cannot fire, which is the same lie as a row for an unbound
    // chord. What is left is the honest part: which sequence is waiting, and
    // what it wants next. It is also the smallest state the panel has.
    return {
      head: wkHeadHtml(s.pending.chord, wkExpectTitle(s.pending.expect)),
      body: "",
      foot: wkFootHtml(0, 1, true),
    };
  }
  const page = await s.page();
  const total = await s.total();
  // The footer is built from what the HIGHLIGHTED row can actually do: a
  // category head opens a menu, an ordinary binding runs, and the panel says
  // which. `sel` is a lazy index, which is exactly what a row carries.
  const selRow = page.items.filter((r) => r.lazyIndex === s.sel)[0];
  return {
    // No chord badge at the top level: there is no committed sequence yet, and
    // inventing one (`⌘`) was a key the keymap does not have.
    head: wkHeadHtml("", ""),
    body: wkBodyHtml(page, s.sel),
    foot: wkFootHtml(s.pageNum, total, false, !!(selRow && selRow.cat)),
  };
}
