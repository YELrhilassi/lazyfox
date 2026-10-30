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
import { mergeConfig } from "../../shared/config";
import type { LeaderPanelHtml, LeaderSignal } from "../../shared/leadersignal";
import { createTabHoldState, type TabHoldState } from "../../shared/holdstate";
import { getConfig, setConfig } from "../config";
import { vConfig } from "../store";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns =
  | "syncTyping"
  | "syncLeader"
  | "splitState"
  | "splitState"
  | "syncContent"
  | "syncFind"
  | "syncDark"
  | "syncHold"
  | "setConfig"
  | "toggleWhichKey"
  | "stealthOpen";

const defaultHoldState = createTabHoldState({
  getTabValue: (tabId, key) => browser.sessions.getTabValue(tabId, key),
  setTabValue: (tabId, key, value) => browser.sessions.setTabValue(tabId, key, value),
  removeTabValue: (tabId, key) => browser.sessions.removeTabValue(tabId, key),
});

// The hold store is a parameter rather than a module singleton for the same
// reason `createTabHoldState` takes its storage: the one thing that has to be
// provable about `syncContent` is an ORDERING (a presence report that does not
// wait for hold bookkeeping), and an ordering can only be driven if the thing it
// must not wait for can be held open. See scripts/test/sync-content.test.ts.
export type { TabHoldState as SyncHoldState };

export interface SyncDeps {
  pushLeaderStateToChrome(index: number, signal: LeaderSignal, panel?: LeaderPanelHtml | null): void;
  pushContentStateToChrome(index: number, active: boolean, url: string, doc?: string): void;
  pushFindStateToChrome(index: number, count: number, cur: number): void;
  pushDarkStateToChrome(index: number, on: boolean, mode: string, engine: string): void;
  // The request the page sent, plus the window resolved by the CALLER (the
  // sender's own tab). Opening a stealth tab without a window is how it lands
  // in another session's window.
  stealthOpen(req: {
    url?: string;
    query?: string;
    winId?: number | null;
  }): Promise<{ ok: boolean; error?: string }>;
  pushSessionStateToChrome(winId?: number | null): Promise<void>;
  /** Push the changed config to the chrome helper (see bgpushes). */
  pushConfigToChrome(config: import("../../shared/types").Config): void;
}

export function createSyncHandlers(
  deps: SyncDeps,
  holdState: TabHoldState = defaultHoldState
): Domain<Owns> {
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
        deps.pushLeaderStateToChrome(
          typeof tab.index === "number" ? tab.index : -1,
          data.signal,
          data.panel
        );
      }
      return { ok: true };
    },
    // A page asking whether it is one pane of a split view. Read from the
    // sender's own tab: splitViewId is a tabs-API field and content scripts
    // have no tabs API.
    splitState: (_data, sender) => {
      const tab = (sender as { tab?: { splitViewId?: number } } | undefined)?.tab;
      const id = tab && tab.splitViewId;
      return { split: typeof id === "number" && id >= 0 };
    },

    syncContent: async (data, sender) => {
      // The tab's own content script is the only party that can say whether it
      // is running — the chrome helper's attempt to look is structurally
      // impossible (contentDocument is null out of process). Relayed with the
      // URL the script saw AND the document nonce it generated, so the helper can
      // discard an answer from a document that has been replaced without
      // discarding the LIVE document's answer the moment its URL changes — which
      // is what the URL alone did, on every single-page navigation.
      const tab = (sender as { tab?: { id?: number; index?: number } } | undefined)?.tab;
      const doc = String((data as { doc?: string }).doc || "");
      // OWNERSHIP FIRST, AND ON ITS OWN PATH. The presence push is the report
      // that decides who answers this tab's keys, and it used to be sent AFTER
      // the hold bookkeeping below — which means it waited on session storage
      // and on that tab's hold QUEUE (holdstate.serialized chains per tab). Any
      // write that never settles — a tab being torn down, a session store that
      // rejects, a queue still holding the previous document's operation — held
      // the report back, and the chrome helper went on owning a live page's
      // keys: the user's `;` armed the helper's leader, its chords worked, and
      // everything that lives in the page (j/k/d/u, hints, find) was dead until
      // they clicked or reloaded. That is exactly the freeze in
      // so the two are ordered by what they are: the
      // presence report is not bookkeeping and must not queue behind it.
      //
      // The hold work still runs before the reply, because the booting document
      // is waiting on the snapshot to pick its held leader back up.
      if (tab && tab.id != null) {
        deps.pushContentStateToChrome(
          typeof tab.index === "number" ? tab.index : -1,
          !!data.active,
          String(data.url || ""),
          String((data as { doc?: string }).doc || "")
        );
      }
      let saved = { hold: false, holdAt: 0, holdDoc: "", holdGeneration: 0 };
      if (tab && tab.id != null && doc) {
        try {
          if (data.active) {
            const snapshot = await holdState.activateDocument(tab.id, doc);
            saved = {
              hold: snapshot.hold,
              holdAt: snapshot.holdAt,
              holdDoc: snapshot.doc,
              holdGeneration: snapshot.generation,
            };
          } else {
            await holdState.deactivateDocument(tab.id, doc);
          }
        } catch {
          // Session storage can reject during tab shutdown; presence has already
          // relayed, which is the half that decides ownership.
        }
      }
      // A booting document learns the previous document's hold only after its
      // own presence report has established ownership. The queued read cannot
      // race a release/tombstone from this same tab.
      return { ok: true, ...saved };
    },

    syncHold: async (data, sender) => {
      const tab = (sender as { tab?: { id?: number } } | undefined)?.tab;
      if (tab && tab.id != null) {
        try {
          const generation = Number(data.generation);
          const doc = String(data.doc || "");
          if (!doc || !Number.isSafeInteger(generation) || generation <= 0) {
            return { ok: false, error: "hold generation and document are required" };
          }
          await holdState.publish(tab.id, doc, generation, data.hold);
        } catch (e) {
          // The tab can close between the message and this write; the hold it
          // carried died with it, which is correct.
        }
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

    syncDark: (data, sender) => {
      // The content script owns dark mode on a web page — it is the only side
      // that can see the page's colours — but the bar is the helper's. So the
      // verdict rides the same relay find uses, with the tab index the helper
      // needs to show it only on the tab you are looking at.
      const tab = (sender as { tab?: { id?: number; index?: number } } | undefined)?.tab;
      if (tab && tab.id != null) {
        deps.pushDarkStateToChrome(
          typeof tab.index === "number" ? tab.index : -1,
          !!data.on,
          String(data.mode || ""),
          String(data.engine || "")
        );
      }
      return { ok: true };
    },

    setConfig: async (data) => {
      // Validated on the way IN, not only on the way out. This is the one
      // config write in the system whose payload arrives over a message
      // boundary, so it is the one write that can store a shape the writers
      // never produce. Rejecting here means a bad payload is simply not
      // applied, instead of becoming a value that has to be defended against
      // at every one of the ~20 read sites forever after.
      const c = vConfig(data.config);
      if (!c) return { ok: false, error: "config is not an object" };
      await setConfig(mergeConfig(c));
      return { ok: true };
    },

    toggleWhichKey: async () => {
      const c = await getConfig();
      c.whichKey = !c.whichKey;
      await setConfig(c);
      // A `;q` on a web page is handled HERE, not by the chrome helper — so
      // this copy is the only one that can tell the helper the overlay is off.
      deps.pushConfigToChrome(c);
      return { whichKey: c.whichKey };
    },

    stealthOpen: (data, sender) => {
      // The SENDER's window, not the background's current one: a `;Nn` pressed
      // in session B while session A has focus used to open the tab in A.
      const tab = (sender as { tab?: { windowId?: number } } | undefined)?.tab;
      return deps.stealthOpen({
        url: data && data.url ? String(data.url) : undefined,
        query: data && data.query ? String(data.query) : undefined,
        winId: tab && typeof tab.windowId === "number" ? tab.windowId : null,
      });
    },
  };
}
