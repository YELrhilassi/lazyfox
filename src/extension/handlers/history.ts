// History, bookmarks and the recently-closed list.
//
// One domain because they answer one question — "what has this browser been
// looking at, and can I get it back" — and because they all live on
// windowops.ts, which owns the storage view they read.
import { bookmarksSearch, historySearch } from "../search";
import {
  clearHistory,
  recentlyClosed,
  removeHistory,
  restoreAllClosedTabs,
  restoreClosedTab,
} from "../windowops";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "history" | "bookmarks" | "removeHistory" | "clearHistory" | "recentlyClosed" | "restoreClosedTab" | "restoreAllClosed";

export function createHistoryHandlers(): Domain<Owns> {
  return {
    history: (data) => historySearch(data.q),
    bookmarks: (data) => bookmarksSearch(data.q),

    removeHistory: (data) => removeHistory(data.url),
    clearHistory: () => clearHistory(),

    recentlyClosed: async () => ({ items: await recentlyClosed() }),
    restoreClosedTab: (data) => restoreClosedTab(data.key),
    restoreAllClosed: () => restoreAllClosedTabs(),
  };
}
