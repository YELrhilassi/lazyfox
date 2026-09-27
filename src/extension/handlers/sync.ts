// The messages a CONTENT SCRIPT sends, plus the two config actions.
//
// This group is distinct in one way the others are not: every message here
// arrives from a tab, and three of them exist only to relay the content
// script's state to the chrome helper's window-level status bar, because on a
// web page the content script owns the leader key and the find widget while the
// helper owns the bar. That relay is the reason `sender` matters here, and the
// reason these three are together: they are one mechanism, applied to three
// different pieces of state.
//
// syncTyping stores its flag in the tab's session value rather than pushing it,
// because the typing state has to survive the content script being torn down and
// rebuilt (a bfcache restore, a virtual-DOM navigation).
import { getConfig } from "../config";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "syncTyping" | "syncLeader" | "syncFind" | "setConfig" | "toggleWhichKey" | "stealthOpen";

export interface SyncDeps {
  pushLeaderStateToChrome(index: number, active: boolean): void;
  pushFindStateToChrome(index: number, count: number, cur: number): void;
  stealthOpen(onDone: () => void): Promise<{ ok: boolean; error?: string }>;
  pushSessionStateToChrome(): Promise<void>;
}

export function createSyncHandlers(deps: SyncDeps): Domain<Owns> {
  return {
    syncTyping: async (data, sender) => {
      const tab = (sender as { tab?: { id?: number } } | undefined)?.tab;
      if (tab && tab.id != null) {
        try {
          await browser.sessions.setTabValue(tab.id, "lfTyping", data.typing ? "1" : "0");
        } catch (e) {
          // The tab can close between the message and this write. Losing the
          // typing flag on a closing tab is not worth reporting.
        }
      }
      return { ok: true };
    },

    syncLeader: (data, sender) => {
      // The chrome helper's window-level status bar needs to know when the
      // content-script leader is armed on a web page (the chrome helper's own
      // leader never arms there — the content script owns the keys).
      const tab = (sender as { tab?: { id?: number; index?: number } } | undefined)?.tab;
      if (tab && tab.id != null) {
        deps.pushLeaderStateToChrome(typeof tab.index === "number" ? tab.index : -1, !!data.active);
      }
      return { ok: true };
    },

    syncFind: (data, sender) => {
      // Live find-in-page count from the content script's find widget, relayed
      // the same way leaderState rides. count -1 = the widget closed (hide the
      // segment); 0 = no matches.
      const tab = (sender as { tab?: { id?: number; index?: number } } | undefined)?.tab;
      if (tab && tab.id != null) {
        const c = Number(data.count);
        deps.pushFindStateToChrome(
          typeof tab.index === "number" ? tab.index : -1,
          isNaN(c) ? -1 : c,
          Math.max(0, Number(data.cur) || 0)
        );
      }
      return { ok: true };
    },

    setConfig: async (data) => {
      await browser.storage.local.set({ config: data.config });
      return { ok: true };
    },

    toggleWhichKey: async () => {
      const c = await getConfig();
      c.whichKey = !c.whichKey;
      await browser.storage.local.set({ config: c });
      return { whichKey: !!c.whichKey };
    },

    stealthOpen: () => deps.stealthOpen(() => void deps.pushSessionStateToChrome()),
  };
}
