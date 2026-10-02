// The leader's two-key categories: `;W` for window/layout and `;Z` for zoom.
//
// Everything about the SHAPE of this layout lives in docs/MULTIKEY-DESIGN.md,
// including why there are two categories and not six. What lives here is the
// binding itself, defined ONCE for both contexts: the chrome helper and the
// content script each register the same table into the shared
// `leaderSequences`, so the two can never drift into disagreeing about what
// `;W |` does — which is the class of bug that made `;G`/`;L` advertise a
// binding that did nothing.
//
// The sub-keys are, with three deliberate exceptions, the key the action
// already had. Muscle memory transfers instead of being discarded, so
// `;W |` is `;|` with one step of context and the hand does not have to
// relearn anything.

import type { PopupCtx } from "./kit";
import { armTabPosition } from "./leader";

/** `;<head>` → the sub-keys it accepts. */
export type LeaderCategories = Record<string, Record<string, () => void>>;

/**
 * How long a category waits for its sub-key.
 *
 * Deliberately short. A category is not a mode you sit in: the sub-key is the
 * next keystroke in a two-key chord, and the hand is already moving. Waiting
 * seconds for a key that is already coming just leaves a stale prefix on the
 * status bar if the user changes their mind, and a long timeout means a
 * mistyped sub-key stays armed long enough to eat the next real key.
 */
export const CATEGORY_TIMEOUT_MS = 1500;

export function leaderCategories(ctx: PopupCtx): LeaderCategories {
  return {
    // Window & layout. The whole split-view family plus the three window-level
    // toggles, because "window and layout" is one idea a user can hold in
    // their head where nine bare punctuation keys are not.
    W: {
      // The window toggles keep their own keys.
      w: () => ctx.ops.openResize(),
      z: () => ctx.ops.zen(),
      e: () => ctx.ops.toggleReveal(),
      // The split family keeps its keys too: { } [ ] , . | already read as
      // left/right and prev/next, so they sit naturally beside a category.
      "|": () => ctx.ops.splitTab("horizontal"),
      "[": () => ctx.ops.switchSplitPane(-1),
      "]": () => ctx.ops.switchSplitPane(1),
      "{": () => ctx.ops.swapSplitPane(-1),
      "}": () => ctx.ops.swapSplitPane(1),
      ",": () => ctx.ops.moveActiveTab(-1),
      ".": () => ctx.ops.moveActiveTab(1),
      // The two that do NOT survive the move. A bare backslash is hard to read
      // and easy to fat-finger, and `+` needs Shift and means nothing here —
      // `u` (undo the split) and `m` (move into the split) are words.
      u: () => ctx.ops.unsplitTab(),
      // The move target is a tab POSITION, so it resolves exactly the way `;1`
      // does: one digit when that is a complete answer, two when it is not.
      // It used to take a bare single digit and therefore went unreachable —
      // silently, with no error — the moment a window passed nine tabs.
      m: () => armTabPosition(ctx, (n) => ctx.ops.splitAddTabByIndex(n)),
    },
    // Zoom. Three keys, one concept, smallest category that still clears the
    // bar of earning its own letter.
    Z: {
      i: () => ctx.ops.zoom(0.2),
      o: () => ctx.ops.zoom(-0.2),
      r: () => ctx.ops.zoom(0, 1),
    },
  };
}

/**
 * The sub-keys of a category, as the which-key overlay should show them.
 *
 * The overlay's table comes from the Go core, which knows only top-level
 * bindings; a category's contents have to be described here or the menu would
 * advertise `;W` and then explain nothing about it.
 */
export const CATEGORY_HINTS: Record<string, { label: string; keys: string }> = {
  W: {
    label: "Window & layout",
    keys: "| [ ] { } , . u m w z e",
  },
  Z: {
    label: "Zoom (i/o/r)",
    keys: "i o r",
  },
};