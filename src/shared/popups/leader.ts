// The leader ACTION table, shared by every context. Only the ActionOps
// implementation differs per context.
//
// This file used to hold the KEYMAP — a table keyed by the chord itself — which
// meant the chord-to-action mapping was written down twice (here, and again in
// the menu's own table) and the two drifted. The keymap now lives in
// core/keymap.go and arrives as data; see the note above makeLeaderActions.
import type { PopupCtx } from "./kit";
import type { PopupItem } from "../types";
import type { KeyLike } from "../keymap";
import { KEEP_ARMED, type CaptureResult } from "../leadercapture";
import { openEditUrlPopup, openSearchPopup, openUrlPopup, openTabsPopup } from "./search-url-tabs";
import { openHistoryPopup } from "./history";
import { openRecentlyClosedPopup } from "./recovery";
import { openBookmarksPopup } from "./bookmarks";
import { openDownloadsPopup } from "./downloads";
import { openSessionsPopup } from "./sessions";
import { openHelpPopup } from "./help";
import { openSplitChooser, openTabChooser } from "./tabjump";
import { planTabJump, tabCandidates, tabDigitHint } from "../tabjump";

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
  let full = 0; // the tab count the planner uses (0 until the ops answer)

  let handle: ReturnType<PopupCtx["armDigits"]> | null = null;
  let bufferedDigits = "";
  const say = () => handle?.retarget(tabDigitHint(full, prefix));

  // Resolve what has been typed against a known count. Returns whether the
  // sequence is FINISHED; a false answer means "more digits are legal".
  const settle = (n: number): boolean => {
    const plan = planTabJump(n, prefix, Number(prefix));
    if (plan.kind === "jump") {
      prefix = "";
      apply(plan.n);
      return true;
    }
    if (plan.kind === "none") {
      // The window is too short for this number: fall back to the digits typed
      // so far rather than turning a live key into a dead one.
      const typed = Number(prefix);
      prefix = "";
      apply(typed);
      return true;
    }
    // Ambiguous — more than one tab carries this prefix. The bar has to say
    // which digits are legal now, because they changed with the first one.
    say();
    return false;
  };

  // THE HANDLER IS SYNCHRONOUS AND STATEFUL, AND THE CAPTURE STAYS ARMED.
  //
  // Both halves matter, and they are the fix for the sequence that only worked
  // if typed slowly. The old version resolved the FIRST digit through an await on
  // the tab count, and the capture disarmed before the handler ran, so between
  // the first key and the count arriving nothing owned the keyboard: a second
  // digit typed in that window was dispatched by the leader as an unrelated
  // binding ("10" fired whatever `;0` would), and when the count finally landed
  // the code re-armed a capture the user had already moved past — an armed
  // capture with no menu on screen, swallowing the next keystroke silently. That
  // is the reported "keys get stuck in limbo and things happen without me
  // expecting it".
  //
  // Now the digit is consumed and remembered immediately (KEEP_ARMED), so the
  // next digit of the same position always arrives here, and the count is only
  // needed to decide whether to finish or keep collecting.
  const handleTimeout = (): void => {
    // The count is still unresolved; don't act on a stale buffered prefix.
    // Put the user-visible leader back in an idle state rather than leaving a
    // silent capture after its three-second lease expires.
    bufferedDigits = "";
    prefix = "";
    ctx.toast("tab position timed out");
  };
  const handler = (e: KeyLike): CaptureResult => {
    const k = e.key;
    // A MODIFIED key is not a digit of a position.
    //
    // `Ctrl+1-9` is the session-marker hot-swap one layer out, and `Alt+1` is
    // the browser's own tab switch, so answering either as "tab position 1"
    // consumes a keystroke the user aimed at something else — which is exactly
    // what the `return false` below promises not to do. Declining is the honest
    // answer, and the host now lets a declined key continue (see the hosts'
    // `handlePending` branches).
    if (e.ctrlKey || e.altKey || e.metaKey) {
      prefix = "";
      return false;
    }
    if (!/^[0-9]$/.test(k)) {
      // Not a digit: drop the position and let the key through untouched.
      // Swallowing it would make the keystroke after `;W m` unpredictable.
      prefix = "";
      return false;
    }
    // A leading zero cannot start a position, and must not be swallowed.
    if (!prefix && k === "0") return false;
    prefix += k;
    if (count < 0) {
      bufferedDigits = prefix;
      return KEEP_ARMED; // the count is still in flight
    }
    return settle(count) ? true : KEEP_ARMED;
  };
  // Armed FIRST and synchronously, so a digit pressed while the count is in
  // flight lands here and not in the keymap.
  handle = ctx.armDigits(handler, 3000, tabDigitHint(0, prefix), handleTimeout);
  // Keep the timeout semantics honest even while tabCount is pending. The
  // previous KEEP_ARMED path restarted the lease on each key but the async
  // continuation could still settle/cancel after a timeout, potentially acting
  // on a prefix whose user had already abandoned it.
  const lease = handle;
  const capturedGenerationIsLive = () => lease.isActive();
  void ctx.ops
    .tabCount()
    .then((n) => {
      if (!capturedGenerationIsLive()) return;
      count = n;
      full = n;
      if (!bufferedDigits) return;
      prefix = bufferedDigits;
      if (settle(n)) lease.cancel();
    })
    .catch(() => {
      if (!capturedGenerationIsLive()) return;
      count = 0;
      full = 0;
      if (!bufferedDigits) return;
      prefix = bufferedDigits;
      if (settle(0)) lease.cancel();
    });
}
// The single leader ACTION table.
//
// KEYED BY ACTION ID, NOT BY KEY. That split is the whole point of the
// redesign: the keymap (core/keymap.go) decides which chord means which action
// and is a validated table; this table decides what each action DOES and is a
// bag of functions. Neither has to repeat the other, so a new key cannot
// collide with an existing one (that is a `go test` failure now, not a silent
// shadow) and a new action cannot be half-bound (that is a TypeScript failure
// in the coverage test in scripts/test/keymap.test.ts).
//
// The old table was keyed by key, which meant every one of these facts was
// written twice — once here and once in the menu's own table — and the two
// drifted until the menu advertised `y`, `F`, `B` and `'` that nothing could
// run.
//
// `runLeaderAction` therefore looks up an ACTION ID. It reports a miss instead
// of returning quietly, because an action id with no implementation is a bug
// that would otherwise show up as a key that does nothing.
export function runLeaderAction(
  actions: Record<string, () => void>,
  action: string
): void {
  const fn = actions[action];
  if (fn) {
    fn();
    return;
  }
  console.warn("lazyfox: no implementation for leader action " + action);
}

export function makeLeaderActions(ctx: PopupCtx): Record<string, () => void> {
  return {
    // ---- Tabs ----
    newTab: () => ctx.ops.newTab(),
    closeTab: () => ctx.ops.closeTab(),
    reopenTab: () => ctx.ops.reopenTab(),
    recentlyClosed: () => openRecentlyClosedPopup(ctx),
    duplicateTab: () => ctx.ops.duplicateTab(),
    tabNext: () => ctx.ops.tabNav(1),
    tabPrev: () => ctx.ops.tabNav(-1),
    alternateTab: () => ctx.ops.alternateTab(),
    tabDigit1: () => tabDigit(ctx, 1),
    tabDigit2: () => tabDigit(ctx, 2),
    tabDigit3: () => tabDigit(ctx, 3),
    tabDigit4: () => tabDigit(ctx, 4),
    tabDigit5: () => tabDigit(ctx, 5),
    tabDigit6: () => tabDigit(ctx, 6),
    tabDigit7: () => tabDigit(ctx, 7),
    tabDigit8: () => tabDigit(ctx, 8),
    tabDigit9: () => tabDigit(ctx, 9),
    // Last tab gets its own key. It used to ride on `;9`, which made `;9`
    // behave unlike every other digit once a window passed nine tabs — the kind
    // of special case that makes a keymap feel arbitrary. `$` is the vim
    // end-of-line mnemonic and is a single keystroke.
    tabLast: () => ctx.ops.tabJump(0),

    // ---- Navigation ----
    reload: () => ctx.ops.reload(),
    back: () => ctx.ops.back(),
    forward: () => ctx.ops.forward(),
    muteTab: () => ctx.ops.muteTab(),
    // `backStack` / `forwardStack` are added by each host: the navigation-stack
    // popup needs the host's own history, which no shared table can reach.
    // They are NAMED here because the coverage test has to know they are a
    // host responsibility rather than a missing implementation.

    // ---- Open ----
    openUrl: () => openUrlPopup(ctx),
    openUrlHere: () => openUrlPopup(ctx, true),
    openTabs: () => openTabsPopup(ctx),
    search: () => openSearchPopup(ctx),
    // `;S` = the same search, in THIS tab. It is the search popup with its
    // replace flag, so the two spellings cannot drift into two popups. The
    // popup ALSO takes Ctrl+Enter for the same destination — that is the one
    // you reach for when you are already typing in it, this is the one you
    // reach for from a cold keyboard.
    searchHere: () => openSearchPopup(ctx, true),
    history: () => openHistoryPopup(ctx),
    bookmarks: () => openBookmarksPopup(ctx),
    downloads: () => openDownloadsPopup(ctx),
    focusFirstInput: () => ctx.ops.focusFirstInput(),

    // ---- Tools ----
    startHints: () => ctx.ops.startHints(),
    // `scrollRegionNext` / `scrollRegionPrev` belong to the host's scroll
    // controller for the same reason the history stacks do.
    diagnostics: () => ctx.ops.openDiagnostics(),
    find: () => ctx.ops.openFind(),
    help: () => openHelpPopup(ctx),
    toggleWhichKey: () => ctx.ops.toggleWhichKey(),
    dismissDownload: () => ctx.ops.dismissDownload(),
    stealthOpen: () => ctx.ops.stealthOpen(),
    // NOTE: no `openSetup` here. The setup page lost its chord (`;I`) because it
    // is a one-time install step rather than a command — it is reached from the
    // home page instead. Keeping the entry would make the keymap-coverage test
    // fail the other way round: an action nobody routes to is dead code that
    // reads like a binding. The ACTION still exists (`ops.openSetup`), and the
    // chrome helper, the home page and the install banner use it directly.

    // ---- Sessions ----
    //
    // ONE key, ONE action. The family used to be `;p` for the list AND `;P`
    // for a menu of eleven rows, nine of which were nine spellings of "switch
    // to session N" — so the two keys did the same thing and the menu spent
    // nine lines restating it. Now `;P` opens the popup and every member of the
    // family is a key inside it, next to the markers it acts on: `1-9` switch,
    // `Ctrl+1-9` assign, `n` new, `x x` delete. Two keystrokes at most, and no
    // menu row that exists only to say "session 4".
    sessions: () => openSessionsPopup(ctx),
    quit: () => ctx.ops.quit(),

    // ---- `;W` Window & layout ----
    resizeWindow: () => ctx.ops.openResize(),
    zen: () => ctx.ops.zen(),
    screenshotFullPage: () => ctx.ops.screenshot("full"),
    screenshotVisible: () => ctx.ops.screenshot("visible"),
    toggleReveal: () => ctx.ops.toggleReveal(),
    splitTab: () => ctx.ops.splitTab("horizontal"),
    // PANES ARE ADDRESSED, NOT CYCLED. `h` / `l` name the pane (left, right)
    // instead of stepping through a pair, and `s` swaps it — a swap has no
    // direction to choose, which is why the two directional swap keys the menu
    // used to carry were one action wearing two hats.
    splitPanePrev: () => ctx.ops.switchSplitPane(-1),
    splitPaneNext: () => ctx.ops.switchSplitPane(1),
    swapPanes: () => ctx.ops.swapSplitPane(1),
    moveTabLeft: () => ctx.ops.moveActiveTab(-1),
    moveTabRight: () => ctx.ops.moveActiveTab(1),
    unsplit: () => ctx.ops.unsplitTab(),
    // Two questions, and the second one only when it has more than one answer.
    //
    // The move target is a tab POSITION, so it resolves exactly the way `;1`
    // does: one digit when that is a complete answer, two when it is not. It
    // used to take a bare single digit and therefore went unreachable —
    // silently, with no error — the moment a window passed nine tabs.
    //
    // THEN: which split. A window can hold several, and picking one silently is
    // how the move lands somewhere the user did not choose. With one split the
    // answer is not a question and nothing appears; with more, the destination
    // chooser opens and the digits name the SPLIT. The tab number is resolved
    // first because it is the number the strip shows and the user already typed
    // it — asking for the destination first would make the menu a promise the
    // sequence could not keep.
    moveTabIntoSplit: () =>
      armTabPosition(ctx, (n) => {
        void (async () => {
          let targets: { split: number; active: boolean; panes: { title: string; url: string; active: boolean }[] }[] = [];
          try {
            targets = await ctx.ops.splitTargets();
          } catch {
            targets = [];
          }
          if (targets.length > 1) {
            openSplitChooser(ctx, targets, (split) => ctx.ops.splitAddTabByIndex(n, split));
            return;
          }
          ctx.ops.splitAddTabByIndex(n, targets[0] ? targets[0].split : undefined);
        })();
      }),
    // `;W o` — take THIS tab out of the split and leave the other panes where
    // they are. `;W u` is still the "take the whole split apart" key; the two are
    // different intentions, which is why they are two keys rather than two
    // spellings of one.
    pullFromSplit: () => ctx.ops.pullFromSplit(),

    // ---- `;Z` Zoom ----
    zoomIn: () => ctx.ops.zoom(0.2),
    zoomOut: () => ctx.ops.zoom(-0.2),
    zoomReset: () => ctx.ops.zoom(0, 1),

    // ---- `;K` Address ----
    //
    // These two act on the PAGE url, not on a link under the cursor. `;K`
    // used to copy "the link in front of you", which had to invent an answer to
    // a question the user never asked, and `;y` was a second, one-key spelling
    // of the copy. Two keys for two different URLs, one of them guessing. There
    // is now exactly one meaning: this page's address.
    copyUrl: () => ctx.ops.copyUrl(),
    editUrl: () => openEditUrlPopup(ctx),
  };
}

/**
 * The action ids each host is expected to add on top of the shared table.
 *
 * Named rather than discovered so the coverage test can tell "this action is a
 * host's job" apart from "this action has no implementation anywhere" — the
 * second is a key that silently does nothing, which is the bug this table was
 * rebuilt to make impossible.
 */
export const HOST_ACTIONS = [
  "backStack",
  "forwardStack",
  "scrollRegionNext",
  "scrollRegionPrev",
  // Page-surface features. Like the scroll regions above, these need an object
  // only a host has — the page's own DOM — so a host that has no page (the
  // chrome helper, the home page) implements them as a note to the user rather
  // than as a silent no-op. The keymap does not care which host answers; the
  // coverage test only needs to know that SOMEONE does.
  "readerMode",
  "darkToggleSite",
  "darkCycleGlobal",
  "darkEngineToggle",
  "darkResetSite",
  // `;Y p` — the color-scheme picker lives on the dark controller like the
  // rest of the theme family, so it is a page-surface action in exactly the
  // same sense.
  "darkCyclePalette",
];