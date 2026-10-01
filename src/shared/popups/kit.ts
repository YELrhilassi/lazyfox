// Popup primitives shared by every popup module: the PopupCtx adapter interface
// and the makeSelector builder that turns a search+render+pick into a live
// popup control.
//
// The pure formatters that used to live here (fmtBytes, relTime, hostOfUrl)
// moved to shared/format.ts: they have nothing to do with popups, and keeping
// them here meant a content script that only wanted relTime had to import the
// overlay and the ops surface to get it.
import { esc } from "../dom";
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
  // Runs a leader binding by key (used by the help popup).
  runAction(key: string): void;
  // The leader binding list, in core order.
  bindings(): Promise<WkItem[]>;
  // Content scripts preventDefault every key before it reaches the popup input,
  // so their selector must insert text manually; chrome's input receives keys
  // natively.
  manualText: boolean;
}

export function basePanel(title: string, placeholder: string, foot: string): string {
  return (
    "<div class='lf-panel'><div class='lf-title'>" + esc(title) + "</div>" +
    "<div class='lf-main'><div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>" + esc(placeholder) + "</div></div>" +
    "<input class='lf-input' placeholder='" + esc(placeholder) + "' spellcheck='false'/>" +
    "<div class='lf-foot'>" + (foot || "") + "</div></div>"
  );
}

// A panel with NO search field, for popups whose only inputs are the quick
// keys themselves (the tab-position chooser). Rendering a disabled text box
// there would claim there is something to type when there is not, and it
// would steal the digits the popup is actually driven by.
export function keyPanel(title: string, placeholder: string, foot: string): string {
  return (
    "<div class='lf-panel'><div class='lf-title'>" + esc(title) + "</div>" +
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
  vimNav?: boolean;
  extraKeys?: (e: KeyboardEvent, sel: { empty: boolean; item: T | null; refresh(): void }) => boolean;
  onEnter?: (value: string, item: T | null) => boolean;
  onChange?: (idx: number, item: T | null, count: number) => void;
  groupBy?: (item: T) => string;
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
    vimNav: opts.vimNav,
    emptyText: opts.emptyText,
    search: opts.search,
    render: opts.render,
    onPick: opts.onPick,
    extraKeys: opts.extraKeys,
    onEnter: opts.onEnter,
    onChange: opts.onChange,
    groupBy: opts.groupBy,
  });
  return {
    onKey: sel.onKey,
    refresh: sel.refresh,
    close: sel.close,
    focus: () => {
      if (inputEl.isConnected) inputEl.focus();
    },
  };
}

// Host, time-bucket and relative-time formatting all live in the Go core
// (core.OrganizeHistory) so history and recovery render from precomputed rows.
