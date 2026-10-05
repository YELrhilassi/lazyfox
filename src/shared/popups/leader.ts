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
import { planTabJump, tabCandidates, tabDigitHint } from "../tabjump";

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

// Arm a digit capture whose digits name a tab POSITION, resolved by the same
// planner `;1` uses — one digit when that is a complete answer, a prefix that
// waits for one more when it is not.
//
// `;1` resolves a position in one shot (the whole chord is already typed); this
// is the same rule for a sub-key that asks for a position afterwards, so the
// two can never disagree about what a number means. The split-move is why it
// exists: `;W m` used to take a bare single digit and therefore went
// unreachable — silently, with no error — the moment a window passed nine tabs.
// Sharing the planner means both grow a second digit at the same time.
//
// The capture is STATEFUL and handles every digit synchronously once the tab
// count is known. That is not an optimisation, it is a correctness requirement:
// an earlier version resolved the first digit asynchronously and opened the
// chooser for the ambiguous case, which meant a fast second digit arrived
// BEFORE anything was listening for it and fell through to the leader as an
// unrelated binding. Typing "10" must never fire whatever `;0` would have.
//
// The count is fetched once when the capture arms (it is the same strip the
// digits are resolved against, so it cannot meaningfully change mid-typing).
export function armTabPosition(
  ctx: PopupCtx,
  apply: (n: number) => void
): void {
  let count = -1;
  let prefix = "";
  // Re-arm the capture with the digits that are actually legal next, so the
  // status bar can say so. The label comes from the same candidate set the
  // planner and the chooser use, so it cannot promise a digit that does
  // nothing — which is the one thing a "press this next" hint must never do.
  const rearm = (ms: number) =>
    ctx.armDigits(handler, ms, tabDigitHint(count < 0 ? 0 : count, prefix));
  // The host's capture is one-shot: it disarms after the key it consumes. A
  // position can need two digits, so an ambiguous prefix re-arms the SAME
  // handler rather than relying on the caller to press the leader again.
  const handler = (k: string): boolean => {
    if (!/^[0-9]$/.test(k)) {
      // Not a digit: drop the position and let the key through untouched.
      // Swallowing it would make the keystroke after `;W m` unpredictable.
      prefix = "";
      return false;
    }
    // A leading zero cannot start a position, and must not be swallowed.
    if (!prefix && k === "0") return false;
    prefix += k;
    const resolved = (n: number) => {
      const plan = planTabJump(n, prefix, Number(prefix));
      if (plan.kind === "jump") {
        prefix = "";
        apply(plan.n);
        return;
      }
      if (plan.kind === "none") {
        // The window is too short for this number: fall back to the digits
        // typed so far rather than turning a live key into a dead one.
        const typed = Number(prefix);
        prefix = "";
        apply(typed);
        return;
      }
      // Ambiguous — more than one tab carries this prefix. Stay armed for the
      // next digit, and say which ones.
      rearm(1500);
    };
    if (count >= 0) {
      resolved(count);
    } else {
      void ctx.ops
        .tabCount()
        .then((n) => {
          count = n;
          resolved(n);
        })
        .catch(() => {
          count = 0;
          resolved(0);
        });
    }
    return true;
  };
  // Nothing typed yet, so every first digit is legal; `tabDigitHint` says so
  // without needing the count, which is why this can arm synchronously.
  rearm(3000);
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
    h: () => openHistoryPopup(ctx),
    b: () => openBookmarksPopup(ctx),
    d: () => openDownloadsPopup(ctx),
    D: () => ctx.ops.dismissDownload(),
    N: () => ctx.ops.stealthOpen(),
    p: () => openSessionsPopup(ctx),
    "'": () => openSessionsPopup(ctx),
    Q: () => ctx.ops.quit(),
    // The split family, the window toggles and zoom now live under `;W` and `;Z`
    // (see shared/popups/categories.ts). They used to sit at top level, where
    // the split family alone cost nine punctuation keys for something used in
    // short deliberate bursts, and zoom cost three more for a set nobody
    // invents independently. Everything hot — tabs, navigation, opening,
    // sessions — stays exactly where it was.
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
    // Zoom is `;Z i` / `;Z o` / `;Z r`; zen is `;W z`; the toolbar toggle is
    // `;W e`. Leaving the old top-level spellings in place would defeat the
    // point: the whole reason to move them is that `;W` and `;Z` exist, and a
    // duplicate binding is one more thing to remember rather than one fewer.
    "/": () => ctx.ops.openFind(),
    "?": () => openHelpPopup(ctx),
    q: () => ctx.ops.toggleWhichKey(),
  };
}
