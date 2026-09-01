// Command center data: the mode table, the home-screen command grid, the
// per-mode suggestion fetchers, and the pure item renderer + action dispatch.
// No DOM or state here — everything is a function of (mode, query, item).

import { esc, favicon } from "../../shared/dom";
import { send } from "../../shared/protocol";
import type { QuickApp } from "../../shared/types";

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
  openSetup(): void;
  openPage(url: string): void;
  setMode(mode: string): void;
  stealthOpen(): void;
}

// The home screen command grid, grouped into sections. `group` drives the
// section headers; items are rendered in order within each section. This list
// is deliberately SHORT: everything already on the which-key leader menu
// (`;n` new tab, `;x` close, `;z` zen, `;w` resize, `;S` strip, sessions, ...)
// is removed so the home page only surfaces what the leader does not — the
// browser page access and Lazyfox settings, plus the quick-launch apps below.
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
    { kind: "cmd", group: "Browser", ic: "\u2699", title: "Lazyfox settings", keys: "", desc: "tune the leader, apps, sessions and chrome", run: () => a.openOptions() },
    { kind: "cmd", group: "Browser", ic: "\u{1F527}", title: "Complete the install", keys: "I", desc: "open the installer / setup page (;I)", run: () => a.openSetup() },
    { kind: "cmd", group: "Browser", ic: "\u{1F98A}", title: "Firefox settings", keys: "", desc: "open about:preferences", run: () => a.openPage("about:preferences") },
    { kind: "cmd", group: "Browser", ic: "\u2609", title: "Add-ons manager", keys: "", desc: "open about:addons", run: () => a.openPage("about:addons") },
    { kind: "cmd", group: "Browser", ic: "\u21ba", title: "History", keys: "", desc: "show history here", run: () => a.setMode("history") },
    { kind: "cmd", group: "Browser", ic: "\u2913", title: "Downloads", keys: "", desc: "show downloads here", run: () => a.setMode("downloads") },
  ];
}

// Enabled quick-launch apps -> home-grid tiles. Each tile opens its url; the
// renderer draws the site's real favicon (see favicon()). Definition + toggle
// live in the options page (config.apps).
export function appItems(apps: QuickApp[]): Array<{ kind: "app"; group: string; name: string; url: string }> {
  return apps
    .filter((a) => a.enabled && a.url)
    .map((a) => ({ kind: "app" as const, group: "Quick launch", name: a.name, url: a.url }));
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
  if (it.kind === "app") {
    // An app tile: real favicon + name. Broken favicon loads just show empty.
    const ic = favicon(it.url);
    return (
      "<div class='ic'>" +
      (ic ? "<img src='" + ic + "' alt='' loading='lazy' referrerpolicy='no-referrer'>" : "\u25b8") +
      "</div>" +
      "<div class='tx'><div class='t'>" + esc(it.name) +
      "</div><div class='s'>" + esc(it.url) + "</div></div>"
    );
  }
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
  if (item.kind === "app") {
    void send("openUrl", { url: item.url });
    return;
  }
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
