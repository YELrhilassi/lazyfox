// Search and URL actions: what happens when the user types a query or picks a
// suggestion.
//
// These were cases in the background's 290-line switch. They are here because
// they share a dependency and nothing else does: every one of them is a
// question about a query string, answered by search.ts and the tabs API.
import { getActiveTabFor, senderWindowId } from "../tabs";
import { doSearch, searchUrlFor, suggestSearch, suggestUrls } from "../search";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "searchSuggest" | "urlSuggest" | "search" | "searchInPlace" | "openUrl" | "openPage" | "openUI";

// The background's own open helpers. They live in background.ts because they
// are the bridge into the chrome helper's UI (which popup is on screen) and into
// the Go host's URL resolution, and pulling background.ts in here would be an
// import cycle. They are injected instead.
export interface SearchDeps {
  // The window id is the request's own window (see tabs.senderWindowId); it is
  // what keeps an open/search from landing in another session's window.
  openUrl(url: string, newTab?: boolean, winId?: number | null): Promise<{ ok: boolean }>;
  openPage(url: string, winId?: number | null): Promise<{ ok: boolean }>;
  openUI(which: string, winId?: number | null): Promise<{ ok: boolean }>;
}

export function createSearchHandlers(deps: SearchDeps): Domain<Owns> {
  return {
    searchSuggest: (data) => suggestSearch(data.q),
    urlSuggest: (data) => suggestUrls(data.q),

    search: async (data, sender) => {
      const q = (data.query || "").trim();
      if (!q) return { ok: false };
      // ;S (newTab === false) replaces the current tab; ;s defers to config.
      // "The current tab" is the SENDER's tab: replacing another window's tab
      // is a navigation the user never asked for.
      if (data.newTab === false) {
        const tab = await getActiveTabFor(sender);
        if (tab) await browser.tabs.update(tab.id, { url: await searchUrlFor(q), active: true });
        return { ok: true };
      }
      return doSearch(q, senderWindowId(sender));
    },

    searchInPlace: async (data, sender) => {
      const q = (data.query || "").trim();
      if (!q) return { ok: false };
      const tab = await getActiveTabFor(sender);
      if (tab) await browser.tabs.update(tab.id, { url: await searchUrlFor(q), active: true });
      return { ok: true };
    },

    openUrl: (data, sender) => deps.openUrl(data.url, data.newTab, senderWindowId(sender)),
    openPage: (data, sender) => deps.openPage(data.url, senderWindowId(sender)),
    openUI: (data, sender) => deps.openUI(data.which, senderWindowId(sender)),
  };
}
