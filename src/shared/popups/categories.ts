// The leader's two-key categories: `;W` for window/layout, `;Z` for zoom and
// `;K` for links.
//
// SHAPE. Everything about why there are three categories and not nine lives in
// docs/MULTIKEY-DESIGN.md. What lives here is the binding, defined ONCE for
// both contexts: the chrome helper and the content script each register the
// same table into the shared `leaderSequences`, so the two can never drift into
// disagreeing about what `;W |` does — which is the class of bug that made
// `;G`/`;L` advertise a binding that did nothing.
//
// WHY EACH ITEM CARRIES ITS OWN LABEL. The which-key overlay has to show a
// category's contents the moment its head is pressed, and the only table that
// cannot lie about them is the one that decides what they DO. A separate
// hand-written list of labels is a second opinion about the binding table, and
// a second opinion is eventually wrong — silently, because a wrong label looks
// exactly like a right one. So `items` pairs each key with its label, and the
// overlay is built from that.
//
// THE TIMEOUT IS ZERO, DELIBERATELY. A category used to expire after 1.5s on
// the argument that the sub-key is "the next keystroke in a chord". Measured in
// a real browser, that is wrong: pressing `;W` paints eleven sub-keys, and
// choosing one of eleven takes longer than a second and a half every time. The
// capture therefore never expires on its own. The user ends it by pressing a
// sub-key, pressing Escape, releasing the leader, or clicking into a field —
// four explicit ways to change your mind, none of which is "read fast enough".
// A stale-looking armed capture is recoverable; a sub-key that silently went
// nowhere because you looked at the menu for two seconds is not.

import type { PopupCtx } from "./kit";
import { armTabPosition } from "./leader";
import { leaderSequences } from "../leader";

/** One sub-key: what to press, what it says, and what it runs. */
export interface CategoryItem {
  key: string;
  label: string;
  run: () => void;
}

/** `;<head>` → its title and its labelled sub-keys. */
export interface CategoryDef {
  label: string;
  items: CategoryItem[];
}

/** `;<head>` → the category it opens. */
export type LeaderCategories = Record<string, CategoryDef>;

/**
 * How long a category waits for its sub-key. Zero means "do not expire".
 *
 * See the file header for why the number is not a number. A category is
 * something you READ, not something you fly through: the overlay is a menu, and
 * a menu with a stopwatch on it is not a menu. The old 1500ms made the whole
 * two-key grammar feel broken — sub-keys painted, then evaporated, and the key
 * the user pressed next went to the page.
 */
export const CATEGORY_TIMEOUT_MS = 0;

export function leaderCategories(ctx: PopupCtx): LeaderCategories {
  return {
    // Window & layout. The whole split-view family plus the three window-level
    // toggles, because "window and layout" is one idea a user can hold in
    // their head where nine bare punctuation keys are not.
    W: {
      label: "Window & layout",
      items: [
        // The window toggles keep their own keys.
        { key: "w", label: "Resize window", run: () => ctx.ops.openResize() },
        { key: "z", label: "Zen mode", run: () => ctx.ops.zen() },
        { key: "e", label: "Toggle toolbar reveal", run: () => ctx.ops.toggleReveal() },
        // The split family keeps its keys too: { } [ ] , . | already read as
        // left/right and prev/next, so they sit naturally beside a category.
        { key: "|", label: "Split side-by-side", run: () => ctx.ops.splitTab("horizontal") },
        { key: "[", label: "Previous pane", run: () => ctx.ops.switchSplitPane(-1) },
        { key: "]", label: "Next pane", run: () => ctx.ops.switchSplitPane(1) },
        { key: "{", label: "Swap pane left", run: () => ctx.ops.swapSplitPane(-1) },
        { key: "}", label: "Swap pane right", run: () => ctx.ops.swapSplitPane(1) },
        { key: ",", label: "Move tab left", run: () => ctx.ops.moveActiveTab(-1) },
        { key: ".", label: "Move tab right", run: () => ctx.ops.moveActiveTab(1) },
        // The two that do NOT survive the move. A bare backslash is hard to read
        // and easy to fat-finger, and `+` needs Shift and means nothing here —
        // `u` (undo the split) and `m` (move into the split) are words.
        { key: "u", label: "Unsplit", run: () => ctx.ops.unsplitTab() },
        // The move target is a tab POSITION, so it resolves exactly the way `;1`
        // does: one digit when that is a complete answer, two when it is not.
        // It used to take a bare single digit and therefore went unreachable —
        // silently, with no error — the moment a window passed nine tabs.
        {
          key: "m",
          label: "Move tab into split…",
          run: () => armTabPosition(ctx, (n) => ctx.ops.splitAddTabByIndex(n)),
        },
      ],
    },
    // Zoom. Three keys, one concept, smallest category that still clears the
    // bar of earning its own letter.
    Z: {
      label: "Zoom",
      items: [
        { key: "i", label: "Zoom in", run: () => ctx.ops.zoom(0.2) },
        { key: "o", label: "Zoom out", run: () => ctx.ops.zoom(-0.2) },
        { key: "r", label: "Reset zoom", run: () => ctx.ops.zoom(0, 1) },
      ],
    },
    // Links. Deliberately NOT search and NOT opening: `;o`, `;O`, `;s` and `;S`
    // already cover those, and this category is for the link in front of you.
    //
    // `K` rather than `L`: `;L` is a live binding (the forward history stack) in
    // both hosts, and the leader's shadow rule means a plain binding always
    // beats a sequence head — registering `;L` here would produce a category
    // that silently never opens, which is exactly how `;G`/`;L` shipped as
    // advertised-but-dead once already.
    K: {
      label: "Links",
      items: [
        { key: "h", label: "Link hints", run: () => ctx.ops.startHints() },
        { key: "c", label: "Copy link", run: () => ctx.ops.copyLink() },
        { key: "e", label: "Edit link", run: () => ctx.ops.editLink() },
      ],
    },
  };
}

/**
 * The one-line description each category shows in the top-level which-key table.
 *
 * This is a summary for a row that is one line tall, not the category's
 * contents — the overlay shows those itself the moment the head is pressed, so
 * repeating all of them here would only make the top level harder to scan. It
 * is derived from the same table for the same reason the labels are, so the two
 * cannot disagree about what a category contains.
 */
export function categoryHint(def: CategoryDef): { label: string; keys: string } {
  return { label: def.label, keys: def.items.map((i) => i.key).join(" ") };
}

/**
 * Registers every category into the shared `leaderSequences` table.
 *
 * Both hosts call this instead of building the table themselves, because the
 * two registrations were the same loop written twice and a category added to
 * one host only is a category that works on web pages and silently does nothing
 * on the command center — the exact drift this file exists to prevent.
 */
export function registerCategories(ctx: PopupCtx): void {
  for (const [head, def] of Object.entries(leaderCategories(ctx))) {
    const final: Record<string, () => void> = {};
    for (const it of def.items) final[it.key] = it.run;
    leaderSequences[head] = {
      final,
      labels: Object.fromEntries(def.items.map((i) => [i.key, i.label])),
      category: def.label,
      timeoutMs: CATEGORY_TIMEOUT_MS,
    };
  }
}