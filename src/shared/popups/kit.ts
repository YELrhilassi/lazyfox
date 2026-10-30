// Popup primitives shared by every popup module: the PopupCtx adapter interface
// and the makeSelector builder that turns a search+render+pick into a live
// popup control.
//
// The pure formatters that used to live here (fmtBytes, relTime, hostOfUrl)
// moved to shared/format.ts: they have nothing to do with popups, and keeping
// them here meant a content script that only wanted relTime had to import the
// overlay and the ops surface to get it.
import { esc } from "../dom";
import type { KeyLike } from "../keymap";
import type { CaptureResult } from "../leadercapture";
import { createSelector, type PopupCtl } from "../overlay";
import type { ActionOps } from "../ops";
import type { WkItem } from "../types";

export interface PopupCtx {
  ops: ActionOps;
  // Mounts a selector popup from panel HTML and returns its controller. Each
  // context provides its own mount (chrome: plain DOM in the browser window;
  // content: closed shadow root) and its own key wiring.
  open(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl;
  close(): void;
  toast(msg: string): void;
  // Runs a leader ACTION ID — not a printed chord. The help popup holds chords
  // (that is what a row shows), so it resolves one to an id through the keymap
  // before calling this; every host then hands the id straight to the action
  // table, which is keyed by id. Passing a chord here would be a second lookup
  // that could disagree with the dispatcher's.
  runAction(action: string): void;
  // The leader binding list, in core order.
  bindings(): Promise<WkItem[]>;
  // Arms a one-shot digit capture and hands the next digit to `apply`.
  // Actions that take a NUMBER after the leader key need this (move tab N into
  // the split, switch session N), and the leader controller is what owns that
  // capture — so the shared action table asks the host for it rather than
  // reaching into the controller, which keeps the sub-key table context-free.
  //
  // `expect` is what the capture is waiting for, surfaced on the status bar as
  // the indicator's "what we need next" half. It belongs in this signature
  // rather than in a side channel because the armer is the ONLY party that
  // knows it: the digits still legal after `;W m 1` depend on the tab count,
  // which only the action knows.
  //
  // The callback receives the WHOLE event rather than a bare character, so a
  // capture can still tell `1` from `Shift+1` and Enter from Ctrl+Enter.
  //
  // It returns a HANDLE, and both members of that handle exist for the same
  // reason: a sequence can span several keys and its resolution can involve an
  // await (the tab count is a background round trip).
  //
  //   retarget(next)  the digits that are legal change as the position is typed,
  //                   so the bar's "what comes next" has to be able to move with
  //                   them. Advertising the first key's expectation for the whole
  //                   sequence is how a live capture ends up describing a state
  //                   that has already passed.
  //   cancel()        a resolution that lands ASYNCHRONOUSLY (the count arrived,
  //                   the position is complete) must be able to disarm, or the
  //                   capture outlives its menu and swallows the next keystroke —
  //                   the "limbo" report, where a key disappears with nothing on
  //                   screen to explain it.
  armDigits(
    apply: (e: KeyLike) => CaptureResult,
    timeoutMs?: number,
    expect?: string,
    onTimeout?: () => void
  ): { cancel(): void; retarget(next: string): void; isActive(): boolean };
  // Content scripts preventDefault every key before it reaches the popup input,
  // so their selector must insert text manually; chrome's input receives keys
  // natively.
  manualText: boolean;
}

// `title` is not drawn. The panel has no header — it carries its name in
// data-lf-title, which is what the observability mirror reads, so "which popup is
// up" is still answerable without a strip of chrome above every list.
export function basePanel(title: string, emptyText: string, foot: string, fieldHint?: string): string {
  // The FIELD's hint and the EMPTY state's text are different sentences now:
  // the field says how to type (`i to search`), the empty state says what is
  // missing (`no bookmarks`). They shared one string, so a popup with nothing
  // in it said "type to search" over an empty list.
  const hint = fieldHint || emptyText;
  return (
    // THE FIELD IS FIRST. With no header, the panel reads as a command palette:
    // type at the top, results below. It used to sit between the list and the
    // footer, where a borderless well looked like part of the footer.
    "<div class='lf-panel' data-lf-title='" + esc(title) + "'>" +
    "<input class='lf-input' placeholder='" + esc(hint) + "' spellcheck='false'/>" +
    "<div class='lf-main'><div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>" + esc(emptyText) + "</div></div>" +
    "<div class='lf-foot'>" + (foot || "") + "</div></div>"
  );
}

// A panel with NO search field, for popups whose only inputs are the quick
// keys themselves (the tab-position chooser). Rendering a disabled text box
// there would claim there is something to type when there is not, and it
// would steal the digits the popup is actually driven by.
export function keyPanel(title: string, placeholder: string, foot: string): string {
  return (
    "<div class='lf-panel' data-lf-title='" + esc(title) + "'>" +
    "<div class='lf-main'><div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>" + esc(placeholder) + "</div></div>" +
    "<div class='lf-foot'>" + (foot || "") + "</div></div>"
  );
}

export function makeSelector<T>(ctx: PopupCtx, root: HTMLElement, opts: {
  search(q: string): Promise<T[]>;
  render(item: T): string;
  onPick(item: T): void;
  emptyText?: string;
  debounceMs?: number;
  itemClass?: string;
  extraKeys?: (e: KeyboardEvent, sel: { empty: boolean; item: T | null; refresh(): void; refreshSoon(delayMs: number): void }) => boolean;
  onEnter?: (value: string, item: T | null) => boolean;
  onChange?: (idx: number, item: T | null, count: number) => void;
  groupBy?: (item: T) => string;
  // Stable identity used to carry the selection across a refresh. See
  // overlay-selector.ts `search()` — without it every re-read throws the
  // highlight back to row 0, which is wrong for any popup that refreshes to
  // show a MUTATED list rather than a fresh search.
  keyOf?: (item: T) => string | number | undefined;
  // Where the selection lands on the first fill (see overlay-selector.ts).
  initial?: (items: T[]) => number;
}): PopupCtl {
  const listEl = root.querySelector(".lf-list") as HTMLElement;
  // A keyPanel has no input. The selector's text handling is written against
  // an input element, so give it a detached one: it stays an empty string
  // forever (every key the popup cares about is consumed by extraKeys before
  // the manual-text path runs), and focusing it below is a no-op because it is
  // not in the document. That keeps the one list engine serving both panel
  // shapes instead of forking a second copy for key-only popups.
  const inputEl =
    (root.querySelector(".lf-input") as HTMLInputElement | null) ||
    document.createElement("input");
  const emptyEl = root.querySelector(".lf-empty") as HTMLElement;
  const sel = createSelector<T>({
    listEl,
    inputEl,
    emptyEl,
    manualText: ctx.manualText,
    debounceMs: opts.debounceMs,
    itemClass: opts.itemClass,
    emptyText: opts.emptyText,
    search: opts.search,
    render: opts.render,
    onPick: opts.onPick,
    extraKeys: opts.extraKeys,
    onEnter: opts.onEnter,
    onChange: opts.onChange,
    groupBy: opts.groupBy,
    keyOf: opts.keyOf,
    initial: opts.initial,
  });
  return {
    onKey: sel.onKey,
    refresh: sel.refresh,
    refreshSoon: (ms: number) => sel.refreshSoon && sel.refreshSoon(ms),
    close: sel.close,
    // DELIBERATELY NO FOCUS. The popup opens in NORMAL mode (j/k navigate,
    // `i` enters the field); focusing the field here would put every key back
    // into the text box and undo the split. overlay-selector.ts focuses it
    // when the user asks, and only then.
    focus: () => {},
  };
}

// Host, time-bucket and relative-time formatting all live in the Go core
// (core.OrganizeHistory) so history and recovery render from precomputed rows.
