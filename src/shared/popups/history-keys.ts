// The history popup's keymap, as a pure lookup.
//
// Extracted from history.ts because the modal routing there was 140 lines of
// nested `if (k === ...)` conditionals interleaved with the DOM mutations each
// branch performs. Reading the keymap and reading the rendering meant reading
// the same 140 lines, and the interesting question — "what does `G` do when the
// group-toggle arm is live?" — was only answerable by tracing control flow.
//
// This file answers that question with a table. It is PURE: it takes the modal
// state and the key, and returns an intent. Nothing here touches the DOM,
// mutates state or knows what "collapse" means. That is what makes the whole
// keymap — including the interaction between the two panes, the two modes and
// the armed group-toggle — testable without a browser, and it is why the
// precedence between Escape, the arm, and the ordinary bindings is now stated
// once instead of emerging from the nesting order of the ifs.
//
// The precedence order is deliberate and is the load-bearing part:
//
//   1. Escape always wins, in every mode and pane. In insert mode it drops back
//      to command mode; in the right pane it returns to the list; in command
//      mode on the list it falls through so the HOST closes the popup.
//   2. Insert mode handles its own keys and lets printable text through to the
//      native input (chrome) or manual insertion (content).
//   3. The right pane handles its own keys, in both modes.
//   4. An armed group-toggle claims the NEXT key, before any ordinary binding —
//      that is the whole point of a two-key chord, and it is why it is checked
//      here rather than being folded into the command keymap.
//   5. Command mode's own bindings.
//   6. Any other printable key starts a search, rather than doing nothing.

export type HistoryMode = "cmd" | "insert";
export type HistoryPane = "L" | "R";

/** What a key means, before anything acts on it. */
export type HistoryIntent =
  // ---- escape, in every mode (highest precedence) ----
  | "close" // command mode on the list: let the host close the popup
  | "leaveInsert" // insert mode: back to command mode
  | "backToList" // right pane: return to the grouped list
  // ---- insert mode ----
  | "togglePane"
  | "openShift" // Enter with shift: open without stealing the tab
  | "open" // Enter
  | "moveDown"
  | "moveUp"
  | "pageDown"
  | "pageUp"
  | "typeText" // a printable/backspace/delete key the input must receive
  // ---- right pane (related history), either mode ----
  | "relatedDown"
  | "relatedUp"
  | "relatedPageDown"
  | "relatedPageUp"
  | "relatedFirst"
  | "relatedLast"
  | "openRelated"
  | "openCurrentTab"
  // ---- the armed group toggle ----
  | "cancelArm"
  | "toggleCurrentGroup"
  | "toggleGroup" // the key named a bucket's hint letter
  // ---- command mode ----
  | "top" // Home, or g
  | "bottom" // End, or G
  | "search" // i, or / (which also clears the query)
  | "armGroup"
  | "collapseAll"
  | "expandAll"
  | "deleteEntry" // x
  | "clearAll" // X
  | "startSearchTyped" // any other printable key: switch to insert and type it
  | "startSearchNative" // …same switch, but let the native input insert it
  // ---- fallthrough ----
  | "consume" // swallow it (command mode: stray keys must not reach the input)
  | "pass"; // not ours: let the host handle it

// The keys that always mean the same thing, whichever pane is focused. Shared so
// the list and the related pane cannot drift about what PageDown does.
const MOVE: Record<string, HistoryIntent> = {
  ArrowDown: "moveDown",
  ArrowUp: "moveUp",
  PageDown: "pageDown",
  PageUp: "pageUp",
};

// How far PageDown/PageUp move. A page is eight rows because that is roughly
// what fits the popup; it is a single constant so the two panes cannot disagree.
export const PAGE_STEP = 8;

/** True for a key that is plain text: no Ctrl/Alt/Meta, one printable char. */
function isPrintable(key: string, noMods: boolean): boolean {
  return noMods && key.length === 1;
}

/**
 * Resolve one key press into an intent.
 *
 * `armGroupLive` is the one input that is not a key: whether the two-key `c`
 * toggle is currently armed. It is passed in rather than read, so the whole
 * decision is a function of its arguments.
 *
 * `groupHintHit` is true when the key matches the hint letter of some bucket,
 * which only the caller can know (the hints depend on the current rows).
 */
export function historyIntent(args: {
  key: string;
  shiftKey?: boolean;
  noMods: boolean;
  mode: HistoryMode;
  pane: HistoryPane;
  armGroupLive?: boolean;
  groupHintHit?: boolean;
  /**
   * Does this context insert text itself?
   *
   * Content scripts pre-empt every key before it reaches the input, so they
   * must insert it by hand. Chrome lets the focused input receive it natively.
   * Which of the two applies changes the INTENT, not just the implementation:
   * when the native path is in play the key must be reported as unconsumed so
   * the input really does get it — a popup that "handles" the key and still
   * lets the input type it would double the character.
   */
  manualText?: boolean;
}): HistoryIntent {
  const { key, noMods, mode, pane } = args;
  const armGroupLive = !!args.armGroupLive;
  const manualText = !!args.manualText;

  // 1. Escape wins everywhere. Its meaning narrows with the modal state:
  // innermost first, and the host closing the popup is the outermost.
  if (key === "Escape") {
    if (mode === "insert") return "leaveInsert";
    if (pane === "R") return "backToList";
    return "close";
  }

  // 2. Insert mode: the input owns typing, so text is passed to it rather than
  // being interpreted as a binding.
  if (mode === "insert") {
    if (key === "Tab") return "togglePane";
    const mv = MOVE[key];
    if (mv) return mv;
    if (key === "Enter") return args.shiftKey ? "openShift" : "open";
    // Backspace/Delete and printable text belong to the input. Only when the
    // host cannot deliver them natively does this become an explicit intent;
    // otherwise `pass` lets the native input handle it.
    if (key === "Backspace" || key === "Delete" || isPrintable(key, noMods)) {
      return manualText ? "typeText" : "pass";
    }
    return "pass";
  }

  // 3. The related pane, in command mode. Tab returns to the list; everything
  // else is unrelated to the list's own navigation.
  if (pane === "R") {
    if (key === "Tab") return "backToList";
    if (key === "j" || key === "ArrowDown") return "relatedDown";
    if (key === "k" || key === "ArrowUp") return "relatedUp";
    if (key === "PageDown") return "relatedPageDown";
    if (key === "PageUp") return "relatedPageUp";
    if (key === "Home") return "relatedFirst";
    if (key === "End") return "relatedLast";
    if (key === "Enter") return "openRelated";
    if (key === "o" && noMods) return "openCurrentTab";
    return "consume";
  }

  // 4. The armed group toggle claims the next key, before any ordinary
  // binding. Escape is already handled above, so it cancels rather than being
  // re-read as "the key that names a group".
  if (armGroupLive) {
    if (key === "c" && noMods) return "toggleCurrentGroup";
    // The hint letter must itself be an unmodified single character: Ctrl+t is
    // the browser's new-tab chord and must never resolve to "today". The
    // check lives HERE rather than at the call site so no caller can pass a
    // hint hit for a key that was not actually a hint letter.
    if (args.groupHintHit && noMods && key.length === 1) return "toggleGroup";
    // A key that names nothing disarms WITHOUT acting — the user may still
    // pick a top-level binding, and swallowing the key would make the next
    // keystroke do something they did not ask for. The caller drops the arm
    // and then re-dispatches this same key as an ordinary one.
    return "pass";
  }

  // 5. Command mode on the grouped list.
  if (key === "Tab") return "togglePane";
  if (key === "j" || key === "ArrowDown") return "moveDown";
  if (key === "k" || key === "ArrowUp") return "moveUp";
  if (key === "PageDown") return "pageDown";
  if (key === "PageUp") return "pageUp";
  if (key === "Home" || (key === "g" && noMods)) return "top";
  if (key === "End" || (key === "G" && noMods)) return "bottom";
  if (key === "i" || key === "/") return "search";
  if (key === "Enter") return args.shiftKey ? "openShift" : "open";
  if (key === "o" && noMods) return "openCurrentTab";
  if (key === "c" && noMods) return "armGroup";
  if (key === "C" && noMods) return "collapseAll";
  if (key === "O" && noMods) return "expandAll";
  if (key === "x" && noMods) return "deleteEntry";
  if (key === "X" && noMods) return "clearAll";
  // 6. Any other printable key starts a search instead of doing nothing. Both
  // outcomes switch to insert mode; they differ only in who types the character
  // that started the search.
  if (isPrintable(key, noMods)) {
    return manualText ? "startSearchTyped" : "startSearchNative";
  }
  return "consume";
}
