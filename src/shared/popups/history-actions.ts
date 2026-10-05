// What each modal intent DOES in the history popup.
//
// Split out of openHistoryPopup (popups/history.ts). history-keys.ts decides
// WHICH intent a key is — that half is pure and unit-tested — and this is the
// half that acts on it. Keeping them apart is what makes the modal rules
// readable: Escape everywhere, insert-mode text, the related pane, the armed
// group toggle, then the ordinary bindings, are a switch over a named union
// rather than a chain of nested key comparisons.
//
// Every intent here is already consumed (the caller preventDefaulted it), so
// the return value is only ever "false" for the one intent whose whole point
// is to leave the key un-consumed: startSearchNative, where the focused input
// is about to receive the character itself and typing it here as well would
// double it.

import { PAGE_STEP, type HistoryIntent } from "./history-keys";
import { disarmAll, type HistoryState } from "./history-state";

export interface HistoryActionDeps {
  state: HistoryState;
  /** The popup's search input. Typed loosely on purpose - see the file header. */
  inputEl: any;
  /** The key that produced this intent, for the `/`-vs-`i` search rule. */
  key: string;
  /** The KeyboardEvent being acted on — the typed-search intents type it. */
  event(): any;
  /**
   * Types the event's own character into the input, with the undo snapshot and
   * the `input` event the popup listens for.
   *
   * Injected like every other effect here. It is the only DOM-typed thing this
   * table touches, and importing it would put the whole overlay/manualtext chain
   * into this module's import graph — which the scripts test config cannot
   * compile, because it deliberately has no DOM lib.
   */
  manualTextKey(e: any, inputEl: any): boolean;
  /** The bucket this key names, when the group toggle is armed. */
  hit: string | null;
  render(): void;
  updateFoot(): void;
  setPane(p: "L" | "R"): void;
  move(d: number): void;
  moveRelated(d: number): void;
  openRow(newTab: boolean | undefined): void;
  openRelatedAtCursor(): void;
  toggleCurrentGroup(): void;
  collapseAll(): void;
  expandAll(): void;
  deleteEntry(): void;
  clearAll(): void;
  organize(): void;
}

export function applyHistoryIntent(intent: HistoryIntent, deps: HistoryActionDeps): boolean {
  const { state, inputEl, key, hit } = deps;
  switch (intent) {
    case "leaveInsert":
      state.mode = "cmd";
      inputEl.classList.add("lf-cmd");
      disarmAll(state);
      deps.render();
      return true;
    case "backToList":
      deps.setPane("L");
      return true;
    case "togglePane":
      deps.setPane(state.pane === "L" ? "R" : "L");
      return true;
    case "moveDown":
      deps.move(1);
      return true;
    case "moveUp":
      deps.move(-1);
      return true;
    case "pageDown":
      deps.move(PAGE_STEP);
      return true;
    case "pageUp":
      deps.move(-PAGE_STEP);
      return true;
    case "top":
      deps.move(Number.NEGATIVE_INFINITY);
      return true;
    case "bottom":
      deps.move(Number.POSITIVE_INFINITY);
      return true;
    case "open":
      deps.openRow(undefined);
      return true;
    case "openShift":
      deps.openRow(false);
      return true;
    case "openCurrentTab":
      deps.openRow(false);
      return true;
    case "relatedDown":
      deps.moveRelated(1);
      return true;
    case "relatedUp":
      deps.moveRelated(-1);
      return true;
    case "relatedPageDown":
      deps.moveRelated(PAGE_STEP);
      return true;
    case "relatedPageUp":
      deps.moveRelated(-PAGE_STEP);
      return true;
    case "relatedFirst":
      deps.moveRelated(Number.NEGATIVE_INFINITY);
      return true;
    case "relatedLast":
      deps.moveRelated(Number.POSITIVE_INFINITY);
      return true;
    case "openRelated":
      deps.openRelatedAtCursor();
      return true;
    case "typeText":
      // deps.inputEl's keydown is what calls us, so the character is NOT yet
      // in the input: type it here.
      deps.manualTextKey(deps.event(), inputEl);
      return true;
    case "toggleCurrentGroup":
      state.armGroup = false;
      deps.toggleCurrentGroup();
      return true;
    case "toggleGroup":
      state.armGroup = false;
      if (hit) state.collapsed[hit] = !state.collapsed[hit];
      deps.render();
      return true;
    case "search":
      // `/` starts from a clean query; `i` keeps whatever is there, so a
      // search can be refined without retyping it.
      if (key === "/") inputEl.value = "";
      state.mode = "insert";
      inputEl.classList.remove("lf-cmd");
      disarmAll(state);
      inputEl.focus();
      deps.updateFoot();
      deps.organize();
      return true;
    case "armGroup":
      state.armGroup = true;
      deps.render(); // repaint headers with the armed hint highlight
      return true;
    case "collapseAll":
      deps.collapseAll();
      return true;
    case "expandAll":
      deps.expandAll();
      return true;
    case "deleteEntry":
      deps.deleteEntry();
      return true;
    case "clearAll":
      deps.clearAll();
      return true;
    case "startSearchTyped":
      // The window capture handler already pre-empted this key, so the input
      // never sees it: switch to insert mode AND type it.
      state.mode = "insert";
      inputEl.classList.remove("lf-cmd");
      disarmAll(state);
      inputEl.focus();
      deps.updateFoot();
      deps.manualTextKey(deps.event(), inputEl);
      deps.organize();
      return true;
    case "startSearchNative":
      // The native input will receive the character itself, so switch to
      // insert mode but report the key as NOT consumed — otherwise it would be
      // typed twice. The input event re-runs organize.
      state.mode = "insert";
      inputEl.classList.remove("lf-cmd");
      disarmAll(state);
      inputEl.focus();
      deps.updateFoot();
      return false;
    case "consume":
    default:
      // Command mode swallows everything else, so a stray key can never type
      // into the (focused) input behind the overlay.
      return true;
  }
}