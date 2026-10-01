// The leader binding table and runner, shared by every context. Only the
// ActionOps implementation differs per context.
import type { PopupCtx } from "./kit";
import type { PopupItem } from "../types";
import { openSearchPopup, openUrlPopup, openTabsPopup } from "./search-url-tabs";
import { openHistoryPopup } from "./history";
import { openRecentlyClosedPopup } from "./recovery";
import { openBookmarksPopup } from "./bookmarks";
import { openDownloadsPopup } from "./downloads";
import { openSessionsPopup } from "./sessions";
import { openHelpPopup } from "./help";
import { openTabChooser } from "./tabjump";
import { planTabJump, tabCandidates } from "../tabjump";

export function runLeaderAction(
  actions: Record<string, () => void>,
  key: string
): void {
  const fn = actions[key];
  if (fn) fn();
}

// `;` + a digit addresses a tab by its 1-based position. Below ten tabs the
// digit is a complete answer and this jumps immediately with no UI, exactly
// as it always was. Past nine it becomes a PREFIX: `;11` is tab 11, and the
// only time anything is shown is when the digits so far name more than one
// tab, which is the only time the keystroke is genuinely ambiguous.
//
// The count and the rows are fetched lazily inside the branch that needs
// them, so the common case never pays for either.
export function tabDigit(ctx: PopupCtx, digit: number): void {
  const prefix = String(digit);
  void (async () => {
    let count: number;
    try {
      count = await ctx.ops.tabCount();
    } catch {
      count = 0;
    }
    const plan = planTabJump(count, prefix, digit);
    if (plan.kind === "jump") {
      ctx.ops.tabJump(plan.n);
      return;
    }
    if (plan.kind === "none") {
      // No tab carries this number at all. The old behaviour clamped to the
      // end of the strip, which is a usable answer for `;9` in a four-tab
      // window; keep it rather than turning a live key into a dead one.
      ctx.ops.tabJump(digit);
      return;
    }
    // Ambiguous. The rows are only fetched here, on the branch that needs
    // them, so the common single-digit jump never pays for a tab listing.
    const wanted = new Set(tabCandidates(count, plan.prefix));
    let rows: PopupItem[] = [];
    try {
      const all = await ctx.ops.listTabs("");
      rows = all.filter((t) => t.number != null && wanted.has(t.number));
    } catch {
      rows = [];
    }
    if (!wanted.size) {
      // The window changed under us (tabs closed between the count and here).
      // Fall back to the old clamp rather than opening an empty list.
      ctx.ops.tabJump(digit);
      return;
    }
    openTabChooser(ctx, plan.prefix, count, rows);
  })();
}

// The single leader binding table. Both contexts map the same key to the same
// action; only the ActionOps implementation differs per context.
export function makeLeaderActions(ctx: PopupCtx): Record<string, () => void> {
  return {
    f: () => ctx.ops.startHints(),
    s: () => openSearchPopup(ctx),
    S: () => openSearchPopup(ctx, true),
    o: () => openUrlPopup(ctx),
    O: () => openUrlPopup(ctx, true),
    t: () => openTabsPopup(ctx),
    w: () => ctx.ops.openResize(),
    h: () => openHistoryPopup(ctx),
    b: () => openBookmarksPopup(ctx),
    d: () => openDownloadsPopup(ctx),
    D: () => ctx.ops.dismissDownload(),
    N: () => ctx.ops.stealthOpen(),
    p: () => openSessionsPopup(ctx),
    "'": () => openSessionsPopup(ctx),
    Q: () => ctx.ops.quit(),
    "|": () => ctx.ops.splitTab("horizontal"),
    "[": () => ctx.ops.switchSplitPane(-1),
    "]": () => ctx.ops.switchSplitPane(1),
    "{": () => ctx.ops.swapSplitPane(-1),
    "}": () => ctx.ops.swapSplitPane(1),
    ",": () => ctx.ops.moveActiveTab(-1),
    ".": () => ctx.ops.moveActiveTab(1),
    "\\": () => ctx.ops.unsplitTab(),
    // `;+1-9` (move a specific tab into the split) needs the leader's one-shot
    // digit capture, so it is wired by each context after makeLeaderActions.
    i: () => ctx.ops.focusFirstInput(),
    I: () => ctx.ops.openSetup(),
    T: () => ctx.ops.openDiagnostics(),
    n: () => ctx.ops.newTab(),
    x: () => ctx.ops.closeTab(),
    v: () => ctx.ops.reopenTab(),
    V: () => openRecentlyClosedPopup(ctx),
    c: () => ctx.ops.duplicateTab(),
    r: () => ctx.ops.reload(),
    g: () => ctx.ops.back(),
    l: () => ctx.ops.forward(),
    j: () => ctx.ops.tabNav(1),
    k: () => ctx.ops.tabNav(-1),
    a: () => ctx.ops.alternateTab(),
    y: () => ctx.ops.copyUrl(),
    m: () => ctx.ops.muteTab(),
    // Every digit means its own position; `;9` is tab 9 like the rest, and
    // past nine tabs a digit becomes the prefix of a longer number.
    "1": () => tabDigit(ctx, 1),
    "2": () => tabDigit(ctx, 2),
    "3": () => tabDigit(ctx, 3),
    "4": () => tabDigit(ctx, 4),
    "5": () => tabDigit(ctx, 5),
    "6": () => tabDigit(ctx, 6),
    "7": () => tabDigit(ctx, 7),
    "8": () => tabDigit(ctx, 8),
    "9": () => tabDigit(ctx, 9),
    // Last tab gets its own key. It used to ride on ;9, which made ;9 behave
    // unlike every other digit once a window passed nine tabs — the kind of
    // special case that makes a keymap feel arbitrary. `$` is the vim end-of-
    // line mnemonic, is free at top level, and is a single keystroke.
    "$": () => ctx.ops.tabJump(0),
    "=": () => ctx.ops.zoom(0.2),
    "-": () => ctx.ops.zoom(-0.2),
    "0": () => ctx.ops.zoom(0, 1),
    "/": () => ctx.ops.openFind(),
    z: () => ctx.ops.zen(),
    "?": () => openHelpPopup(ctx),
    e: () => ctx.ops.toggleReveal(),
    q: () => ctx.ops.toggleWhichKey(),
  };
}
