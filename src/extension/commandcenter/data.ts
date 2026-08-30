// Command center data: the mode table, the home-screen command grid, the
// per-mode suggestion fetchers, and the pure item renderer + action dispatch.
// No DOM or state here — everything is a function of (mode, query, item).

import { esc } from "../../shared/dom";
import { send } from "../../shared/protocol";

export const MODES = ["search", "url", "tabs", "history", "bookmarks", "downloads"];

export const PLACEHOLDERS: Record<string, string> = {
  search: "search the web (Google)\u2026",
  url: "type a site \u2014 no http:// or www needed\u2026",
  tabs: "filter tabs\u2026",
  history: "search history\u2026",
  bookmarks: "search bookmarks\u2026",
  downloads: "filter downloads\u2026",
};

export const EMPTY_TEXTS: Record<string, string> = {
  search: "",
  url: "type a site to open it \u2014 visited sites are fuzzy matched",
  tabs: "no tabs",
  history: "type to search history",
  bookmarks: "type to search bookmarks",
  downloads: "no downloads",
};

// The actions the home grid can run. Injected by the composition root so the
// grid stays a pure data table (no DOM, no state, no events).
export interface QuickActions {
  newTab(): void;
  reopenTab(): void;
  duplicateTab(): void;
  closeTab(): void;
  zen(): void;
  openResize(): void;
  openMove(): void;
  quit(): void;
  openOptions(): void;
  openPage(url: string): void;
  setMode(mode: string): void;
  stealthOpen(): void;
}

// The home screen command grid, grouped into sections. `group` drives the
// section headers; items are rendered in order within each section.
export interface QuickCmd {
  kind: string;
  group: string;
  ic: string;
  title: string;
  keys: string;
  desc: string;
  run: () => void;
}

export function quickCommands(a: QuickActions): QuickCmd[] {
  return [
    { kind: "cmd", group: "Tabs", ic: "\u229e", title: "New tab", keys: ";n", desc: "open a fresh tab", run: () => a.newTab() },
    { kind: "cmd", group: "Tabs", ic: "\u21b6", title: "Reopen closed tab", keys: ";v", desc: "restore the last one you closed", run: () => a.reopenTab() },
    { kind: "cmd", group: "Tabs", ic: "\u29c9", title: "Duplicate tab", keys: ";c", desc: "copy the current tab", run: () => a.duplicateTab() },
    { kind: "cmd", group: "Tabs", ic: "\u2715", title: "Close current tab", keys: ";x", desc: "close this tab", run: () => a.closeTab() },
    { kind: "cmd", group: "Tabs", ic: "\u21c4", title: "Switch mode", keys: "1-6", desc: "Search \u00b7 URL \u00b7 Tabs \u00b7 History \u00b7 Bookmarks \u00b7 Downloads", run: () => {} },
    { kind: "cmd", group: "Window", ic: "\u25c9", title: "Zen mode", keys: ";z", desc: "fullscreen \u2014 the toolbar stays hidden", run: () => a.zen() },
    { kind: "cmd", group: "Window", ic: "\u21f2", title: "Resize window", keys: ";w", desc: "resize with arrow keys or buttons", run: () => a.openResize() },
    { kind: "cmd", group: "Window", ic: "\u2726", title: "Move window", keys: ";m", desc: "move with arrow keys (Shift = fine step)", run: () => a.openMove() },
    { kind: "cmd", group: "Window", ic: "\u23fb", title: "Save and quit", keys: ";Q", desc: "save this session, then quit Firefox", run: () => a.quit() },
    { kind: "cmd", group: "Browser", ic: "\u2699", title: "Lazyfox settings", keys: "", desc: "open the extension options page", run: () => a.openOptions() },
    { kind: "cmd", group: "Browser", ic: "\u2608", title: "Components & versions", keys: "", desc: "extension, chrome helper, wasm core, native host versions", run: () => a.openOptions() },
    { kind: "cmd", group: "Browser", ic: "\u{1F98A}", title: "Firefox settings", keys: "", desc: "open about:preferences", run: () => a.openPage("about:preferences") },
    { kind: "cmd", group: "Browser", ic: "\u21ba", title: "History", keys: "", desc: "show history in this command center", run: () => a.setMode("history") },
    { kind: "cmd", group: "Browser", ic: "\u2913", title: "Downloads", keys: "", desc: "show downloads in this command center", run: () => a.setMode("downloads") },
    { kind: "cmd", group: "Privacy", ic: "\u{1F576}", title: "Stealth tab", keys: ";N", desc: "open a fresh isolated tab — wiped on close", run: () => a.stealthOpen() },
  ];
}

// Fetch the suggestion list for a mode + query. Each branch maps the
// background's reply to the shared PopupItem-ish shape.
export function getItems(mode: string, q: string): Promise<any[]> {
  if (mode === "search") {
    return send("searchSuggest", { q }).then((r: any) => (r && r.entries) || []);
  }
  if (mode === "url") {
    return send("urlSuggest", { q }).then((r: any) => (r && r.entries) || []);
  }
  if (mode === "history") {
    return send("history", { q }).then((r: any) => (r && r.items) || []);
  }
  if (mode === "bookmarks") {
    return send("bookmarks", { q }).then((r: any) => (r && r.items) || []);
  }
  if (mode === "downloads") {
    return send("downloads").then((r: any) => {
      const items = (r && r.items) || [];
      const ql = q.toLowerCase();
      if (!ql) return items;
      return items.filter((d: any) =>
        (d.filename || "").toLowerCase().indexOf(ql) !== -1 ||
        (d.url || "").toLowerCase().indexOf(ql) !== -1
      );
    });
  }
  if (mode === "tabs") {
    return send("tabs").then((r: any) => {
      const items = (r && r.tabs) || [];
      const ql = q.toLowerCase();
      if (!ql) return items;
      return items.filter((t: any) =>
        (t.title || "").toLowerCase().indexOf(ql) !== -1 ||
        (t.url || "").toLowerCase().indexOf(ql) !== -1
      );
    });
  }
  return Promise.resolve([]);
}

// Pure HTML for one row. `quickView` switches the command rows between the
// home-grid layout (icon + key badge) and the flat list layout.
export function renderItem(it: any, mode: string, quickView: boolean): string {
  if (it.kind === "cmd") {
    if (quickView) {
      return (
        "<div class='ic'>" + esc(it.ic || "\u25b8") + "</div>" +
        "<div class='tx'><div class='t'>" + (it.keys ? "<span class='k'>" + esc(it.keys) + "</span>" : "") +
        esc(it.title) + "</div><div class='s'>" + esc(it.desc || "") + "</div></div>"
      );
    }
    return (
      "<div class='t'>" + (it.keys ? "<span class='kbd'>" + esc(it.keys) + "</span>" : "") +
      esc(it.title) + "</div><div class='s'>" + esc(it.desc || "") + "</div>"
    );
  }
  if (mode === "tabs") {
    return (
      "<div class='t'>" + (it.active ? "<span class='dot'></span>" : "") + esc(it.title) +
      "</div><div class='s'>" + esc(it.url || "") + "</div>"
    );
  }
  if (mode === "downloads") {
    const prog =
      typeof it.progress === "number" && it.progress >= 0
        ? "<span class='dl-state'>" + it.progress + "%</span>"
        : "";
    return (
      "<div class='t'>" +
      esc(it.filename || "") +
      " <span class='dl-state'>" + esc(it.state || "") + "</span>" +
      prog +
      "</div><div class='s'>" + esc(it.path || it.url || "") + "</div>"
    );
  }
  return (
    "<div class='t'>" + esc(it.title) + "</div><div class='s'>" +
    esc(it.subtitle || it.url || "") + "</div>"
  );
}

// Dispatch the action for a selected item, given the current mode.
export function openItem(item: any, mode: string): void {
  if (!item) return;
  if (item.kind === "cmd") {
    item.run();
    return;
  }
  if (mode === "search") {
    void send("search", { query: item.query });
    return;
  }
  if (mode === "url") {
    void send("openUrl", { url: item.url });
    return;
  }
  if (mode === "tabs") {
    void send("activateTab", { id: item.id });
    return;
  }
  if (mode === "history" || mode === "bookmarks") {
    void send("openUrl", { url: item.url });
    return;
  }
  if (mode === "downloads") {
    void send("openDownload", { id: item.key });
  }
}
