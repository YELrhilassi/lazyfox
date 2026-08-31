// The leader binding table and runner, shared by every context. Only the
// ActionOps implementation differs per context.
import type { PopupCtx } from "./kit";
import { openSearchPopup, openUrlPopup, openTabsPopup } from "./search-url-tabs";
import { openHistoryPopup } from "./history";
import { openRecentlyClosedPopup } from "./recovery";
import { openBookmarksPopup } from "./bookmarks";
import { openDownloadsPopup } from "./downloads";
import { openSessionsPopup } from "./sessions";
import { openHelpPopup } from "./help";

export function runLeaderAction(
  actions: Record<string, () => void>,
  key: string
): void {
  const fn = actions[key];
  if (fn) fn();
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
    "1": () => ctx.ops.tabJump(1),
    "2": () => ctx.ops.tabJump(2),
    "3": () => ctx.ops.tabJump(3),
    "4": () => ctx.ops.tabJump(4),
    "5": () => ctx.ops.tabJump(5),
    "6": () => ctx.ops.tabJump(6),
    "7": () => ctx.ops.tabJump(7),
    "8": () => ctx.ops.tabJump(8),
    "9": () => ctx.ops.tabJump(9),
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
