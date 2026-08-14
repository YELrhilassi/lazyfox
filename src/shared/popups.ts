// Unified popup builders + leader action table, shared by the chrome helper
// and the content script. Both contexts previously carried their own copy of
// every popup (search, URL, tabs, history, bookmarks, downloads, help) plus a
// near-identical leader key map; this is the single implementation. Every data
// source and action goes through the ActionOps adapter, so a popup built here
// behaves identically no matter which context renders it.
//
// Search functions are async (Promise-returning) by contract: createSelector
// requires it, which is exactly the bug that broke the chrome `;t`/`;h` popups
// before unification.
import { esc } from "./dom";
import { createSelector, type PopupCtl } from "./overlay";
import type { ActionOps } from "./ops";
import type { PopupItem, WkItem } from "./types";

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

function basePanel(title: string, placeholder: string, foot: string): string {
  return (
    "<div class='lf-panel'><div class='lf-title'>" + esc(title) + "</div>" +
    "<div class='lf-main'><div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>" + esc(placeholder) + "</div></div>" +
    "<input class='lf-input' placeholder='" + esc(placeholder) + "' spellcheck='false'/>" +
    "<div class='lf-foot'>" + (foot || "") + "</div></div>"
  );
}

function makeSelector<T>(ctx: PopupCtx, root: HTMLElement, opts: {
  search(q: string): Promise<T[]>;
  render(item: T): string;
  onPick(item: T): void;
  emptyText?: string;
  debounceMs?: number;
  itemClass?: string;
  vimNav?: boolean;
  extraKeys?: (e: KeyboardEvent, sel: { empty: boolean; item: T | null; refresh(): void }) => boolean;
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
  });
  return { onKey: sel.onKey, refresh: sel.refresh, close: sel.close, focus: () => inputEl.focus() };
}

/* ---------------- search ---------------- */

export function openSearchPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Search",
      "type to search",
      "<span class='lf-badge'>Enter</span> search &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "type to search",
        search: (q) => ctx.ops.searchSuggest(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.subtitle || "search the web") + "</div>",
        onPick: (it) => {
          ctx.close();
          ctx.ops.search(it.query || "");
        },
      })
  );
}

/* ---------------- URL ---------------- */

export function openUrlPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Open URL",
      "type a URL or a site name",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 70,
        vimNav: false,
        emptyText: "type a URL or a site name",
        search: (q) => ctx.ops.urlSuggest(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.subtitle || it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          ctx.ops.openUrl(it.url || "", false);
        },
      })
  );
}

/* ---------------- tabs ---------------- */

export function openTabsPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Tabs",
      "no tabs",
      "<span class='lf-badge'>Enter</span> switch &middot; <span class='lf-badge'>x</span> close &middot; " +
        "<span class='lf-badge'>h/l</span> move &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 40,
        itemClass: "lf-tab",
        emptyText: "no tabs",
        search: (q) => ctx.ops.listTabs(q),
        render: (t) =>
          "<div class='t'>" +
          (t.active ? "<span class='dot'></span>" : "") +
          (t.pinned ? "\uD83D\uDCCC " : "") +
          (t.muted ? "\uD83D\uDD07 " : "") +
          esc(t.title || "") +
          "</div><div class='s'>" + esc(t.url || "") + "</div>",
        onPick: (t) => {
          ctx.close();
          if (t.id != null) ctx.ops.activateTab(t.id);
        },
        extraKeys: (e, sel) => {
          const k = e.key;
          if (!sel.empty || sel.item == null || sel.item.id == null) return false;
          if (k === "x") {
            e.preventDefault();
            ctx.ops.closeTab(sel.item.id);
            sel.refresh();
            return true;
          }
          if (k === "l" || k === "]") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, 1);
            sel.refresh();
            return true;
          }
          if (k === "h" || k === "[") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, -1);
            sel.refresh();
            return true;
          }
          return false;
        },
      })
  );
}

/* ---------------- history ---------------- */

export function openHistoryPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "History",
      "no history yet",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "no history yet",
        search: (q) => ctx.ops.history(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          ctx.ops.openUrl(it.url || "", false);
        },
      })
  );
}

/* ---------------- bookmarks ---------------- */

export function openBookmarksPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Bookmarks",
      "type to search bookmarks",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "type to search bookmarks",
        search: (q) => ctx.ops.bookmarks(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          ctx.ops.openUrl(it.url || "", false);
        },
      })
  );
}

/* ---------------- downloads ---------------- */

export function openDownloadsPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Downloads",
      "no downloads",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 40,
        vimNav: false,
        emptyText: "no downloads",
        search: (q) => ctx.ops.downloads(q),
        render: (d) =>
          "<div class='t'>" + esc(d.filename || "") + "</div>" +
          "<div class='s'>" + esc(d.url || "") + " \u00b7 " + esc(d.state || "") + "</div>",
        onPick: (d) => {
          ctx.close();
          if (d.id != null) ctx.ops.openDownload(d.id);
        },
      })
  );
}

/* ---------------- sessions ---------------- */

export function openSessionsPopup(ctx: PopupCtx): void {
  // Marker -> name map rebuilt on every search so digit keys can jump straight
  // to a marked session when the input is empty.
  let byMarker: Record<number, string> = {};
  ctx.open(
    basePanel(
      "Sessions",
      "no saved sessions",
      "<span class='lf-badge'>Enter</span> switch &middot; <span class='lf-badge'>1-9</span> marker &middot; <span class='lf-badge'>x</span> delete &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 40,
        emptyText: "type a name and press Enter to save the current tabs",
        search: async (q) => {
          const items = await ctx.ops.listSessions(q);
          byMarker = {};
          for (const it of items) {
            if (it.kind !== "save" && it.marker) byMarker[it.marker] = it.title || "";
          }
          return items;
        },
        render: (s) => {
          if (s.kind === "save") {
            return (
              "<div class='t'><span class='dot'></span>" +
              esc(s.title || "") +
              "</div><div class='s'>" + esc(s.subtitle || "") + "</div>"
            );
          }
          return (
            "<div class='t'>" +
            (s.marker ? "<span class='lf-marker'>" + s.marker + "</span>" : "") +
            esc(s.title || "") +
            "</div><div class='s'>" + esc(s.subtitle || "") + "</div>"
          );
        },
        onPick: (s) => {
          ctx.close();
          if (s.kind === "save") ctx.ops.saveSession(s.title || "");
          else ctx.ops.restoreSession(s.title || "");
        },
        extraKeys: (e, sel) => {
          const k = e.key;
          if (/^[1-9]$/.test(k) && sel.empty) {
            const name = byMarker[Number(k)];
            if (!name) return false;
            e.preventDefault();
            ctx.close();
            ctx.ops.restoreSession(name);
            return true;
          }
          if (k !== "x") return false;
          if (!sel.empty || sel.item == null || sel.item.kind === "save") return false;
          e.preventDefault();
          ctx.ops.deleteSession(sel.item.title || "");
          sel.refresh();
          return true;
        },
      })
  );
}

/* ---------------- help ---------------- */

export function openHelpPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Keybindings",
      "no matches",
      "<span class='lf-badge'>;key</span> run &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<WkItem>(ctx, root, {
        debounceMs: 30,
        emptyText: "no matches",
        search: async (q) => {
          const all = await ctx.bindings();
          const ql = q.trim().toLowerCase();
          if (!ql) return all.slice();
          return all.filter(
            (h) =>
              h.label.toLowerCase().indexOf(ql) !== -1 ||
              h.key.toLowerCase().indexOf(ql) !== -1
          );
        },
        render: (h) => {
          const label = h.native ? h.key : ";" + h.key;
          const tag = h.native ? "<span class='lf-native-tag'>native</span>" : "";
          return (
            "<div class='t'><span class='kbd'>" + esc(label) + "</span>" +
            tag + esc(h.label) + "</div>"
          );
        },
        onPick: (h) => {
          ctx.close();
          if (h.native) return;
          ctx.runAction(h.key);
        },
      })
  );
}

/* ---------------- leader actions ---------------- */

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
    o: () => openUrlPopup(ctx),
    t: () => openTabsPopup(ctx),
    w: () => ctx.ops.openResize(),
    h: () => openHistoryPopup(ctx),
    b: () => openBookmarksPopup(ctx),
    d: () => openDownloadsPopup(ctx),
    p: () => openSessionsPopup(ctx),
    "'": () => openSessionsPopup(ctx),
    "|": () => ctx.ops.splitTab(),
    "[": () => ctx.ops.switchSplitPane(),
    "]": () => ctx.ops.switchSplitPane(),
    "\\": () => ctx.ops.unsplitTab(),
    i: () => ctx.ops.focusFirstInput(),
    n: () => ctx.ops.newTab(),
    x: () => ctx.ops.closeTab(),
    v: () => ctx.ops.reopenTab(),
    c: () => ctx.ops.duplicateTab(),
    r: () => ctx.ops.reload(),
    g: () => ctx.ops.back(),
    l: () => ctx.ops.forward(),
    j: () => ctx.ops.tabNav(1),
    k: () => ctx.ops.tabNav(-1),
    y: () => ctx.ops.copyUrl(),
    m: () => ctx.ops.muteTab(),
    a: () => ctx.ops.pinTab(),
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
  };
}
