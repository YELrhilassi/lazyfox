// Popup primitives shared by every popup module: the PopupCtx adapter interface,
// pure formatting helpers, and the makeSelector builder that turns a search+
// render+pick into a live popup control.
import { esc } from "../dom";
import { createSelector, type PopupCtl } from "../overlay";
import type { ActionOps } from "../ops";
import type { WkItem } from "../types";

// Synchronous byte formatter for popup rows (the status bar path uses the Go
// core's formatBytes; this mirrors it for the one-shot list render).
export function fmtBytes(n: number): string {
  if (!n || n < 0) return "";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let f = n;
  let i = -1;
  while (f >= 1024 && i + 1 < units.length) {
    f /= 1024;
    i++;
  }
  return (Math.round(f * 10) / 10).toFixed(1).replace(/\.0$/, "") + " " + units[i];
}

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
}): PopupCtl {
  const listEl = root.querySelector(".lf-list") as HTMLElement;
  const inputEl = root.querySelector(".lf-input") as HTMLInputElement;
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
  });
  return { onKey: sel.onKey, refresh: sel.refresh, close: sel.close, focus: () => inputEl.focus() };
}


export function relTime(ts: number): string {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d ago";
  const w = Math.floor(d / 7);
  if (w < 5) return w + "w ago";
  return Math.floor(d / 30) + "mo ago";
}

// Display host for the related-history index ("example.com" from a full URL),
// stripping a leading "www." the same way the Go core's HostOf does.
export function hostOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url || "");
  return ((m && m[1]) || "").replace(/^www\./, "");
}

// Host, time-bucket and relative-time formatting all live in the Go core
// (core.OrganizeHistory) so history and recovery render from precomputed rows.
