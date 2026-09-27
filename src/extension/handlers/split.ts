// Split-view actions.
//
// Native split views are the chrome helper's domain — they need
// gBrowser.addTabSplitView, which no extension API exposes — so every one of
// these is a relay push and an immediate `{ ok: true }`. That is a deliberate
// boundary, not a stub: the extension is the coordinator, the helper is the only
// side that can actually create the split.
//
// The list/target actions (splitPanelTabs, moveTabToSplit) are here too because
// they are the same feature from the other end: what the split panel shows, and
// which tab the user picked from it.
import type { ChromeAction, ChromeReq } from "../../shared/protocol";
import { realTabsInWindow } from "../tabs";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "sessionSplit" | "sessionUnsplit" | "sessionSwitchPane" | "sessionSwapPane" | "sessionSplitAddTabByIndex" | "splitPanelTabs" | "moveTabToSplit";

export interface SplitDeps {
  requestChrome<K extends ChromeAction>(action: K, arg?: ChromeReq<K>): void;
}

export function createSplitHandlers(deps: SplitDeps): Domain<Owns> {
  return {
    sessionSplit: () => {
      deps.requestChrome("splitTab");
      return { ok: true };
    },
    sessionUnsplit: () => {
      deps.requestChrome("unsplit");
      return { ok: true };
    },
    sessionSwitchPane: (data) => {
      deps.requestChrome("switchPane", { dir: data.dir > 0 ? 1 : -1 });
      return { ok: true };
    },
    sessionSwapPane: (data) => {
      deps.requestChrome("swapSplitPanes", { dir: data.dir > 0 ? 1 : -1 });
      return { ok: true };
    },
    sessionSplitAddTabByIndex: (data) => {
      const n = Number(data.index);
      if (!(n >= 1 && n <= 9)) return { ok: false, note: "tab number must be 1-9" };
      deps.requestChrome("moveToSplit", { index: n });
      return { ok: true };
    },

    splitPanelTabs: async () => {
      // Number REAL tabs only (skip splitpanel + #lfc=), so the list's numbers
      // match ;+N and never shift when a companion pane is added/removed.
      const tabs = await realTabsInWindow();
      return {
        tabs: tabs.map((t, i) => ({
          index: i + 1,
          id: t.id,
          url: t.url || "",
          title: t.title || "",
          active: !!t.active,
          inSplit: typeof t.splitViewId === "number" && t.splitViewId >= 0,
        })),
      };
    },

    moveTabToSplit: (data) => {
      const n = Number(data.index);
      if (!(n >= 1 && n <= 9)) return { ok: false };
      deps.requestChrome("moveToSplit", { index: n });
      return { ok: true };
    },
  };
}
