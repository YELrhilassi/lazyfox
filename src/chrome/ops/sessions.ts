// Session + split-domain ops: the tmux-style session CRUD (relayed to the
// extension background, which owns browser.storage) and the native split-view
// actions. Every session mutation refreshes the chrome status bar's session
// list once the action has landed.

import { toast } from "../../shared/overlay";
import type { PopupItem, SessionSummaryItem } from "../../shared/types";
import type { ChromeEnv } from "../env";

// The relay channel surface the session ops need.
export interface SessionChannel {
  requestBg<K extends "saveSession" | "newSession" | "restoreSession" | "deleteSession" | "switchSessionByMarker" | "assignSessionMarker" | "toggleWhichKey" | "quit" | "sessionTabCopy" | "sessionTabMove">(
    action: K,
    arg?: any
  ): void;
  requestReply<K extends "sessionTabCopy" | "sessionTabMove">(
    action: K,
    arg: { from: string; index: number; to: string }
  ): Promise<any>;
  requestSessionState(): Promise<void>;
  requestSessionTabs(name: string): Promise<PopupItem[]>;
}

export function createSessionOps(
  env: ChromeEnv,
  channel: () => SessionChannel,
  status: { getInfo(): { sessions: SessionSummaryItem[] } }
) {
  // Session + split actions relay to the extension background, then refresh
  // the status bar's session list. The 900ms delay is not a guess about the
  // network: the relay is a URL slot polled every 500ms, and the refresh is
  // queued behind the action it is meant to reflect — a real ordering
  // dependency, not a retry. The timer is the injected one so a test can run it.
  const sessionAction = (action: Parameters<SessionChannel["requestBg"]>[0], arg?: any) => {
    channel().requestBg(action as any, arg);
    env.setTimeout(() => void channel().requestSessionState(), 900);
  };

  return {
    listSessions: async (q: string): Promise<PopupItem[]> => {
      // Await a fresh status-bar refresh so the list reflects a just-completed
      // save/delete instead of the stale cache (the sessions popup reads this
      // list right after a mutation).
      await channel().requestSessionState();
      const ql = (q || "").trim().toLowerCase();
      let items: PopupItem[] = status.getInfo().sessions.map((s) => ({
        kind: "session",
        title: s.name,
        marker: s.marker || 0,
        subtitle:
          (s.marker ? "marker " + s.marker + " \u00b7 " : "") +
          (s.tabCount || 0) +
          " tabs" +
          (s.splitCount ? " \u00b7 " + s.splitCount + " split" : ""),
      }));
      if (ql) items = items.filter((s) => (s.title || "").toLowerCase().indexOf(ql) !== -1);
      return items;
    },
    listSessionTabs: (name: string) => channel().requestSessionTabs(name),
    saveSession: (name: string) => sessionAction("saveSession", { name }),
    newSession: (name: string) => sessionAction("newSession", { name }),
    restoreSession: (name: string) => sessionAction("restoreSession", { name }),
    deleteSession: (name: string) => sessionAction("deleteSession", { name }),
    switchSessionByMarker: (marker: number) => sessionAction("switchSessionByMarker", { marker }),
    assignSessionMarker: (name: string, marker: number) => sessionAction("assignSessionMarker", { name, marker }),
    // These two answer with a reason when they fail, so they use the reply
    // path: a copy into a session that does not exist used to look exactly
    // like one that worked.
    sessionTabCopy: (from: string, index: number, to: string) => {
      void channel().requestReply("sessionTabCopy", { from, index, to }).then((r) => {
        if (r && r.ok === false) toast("tab copy failed: " + (r.note || "unknown"));
      });
      env.setTimeout(() => void channel().requestSessionState(), 900);
    },
    sessionTabMove: (from: string, index: number, to: string) => {
      void channel().requestReply("sessionTabMove", { from, index, to }).then((r) => {
        if (r && r.ok === false) toast("tab move failed: " + (r.note || "unknown"));
      });
      env.setTimeout(() => void channel().requestSessionState(), 900);
    },
  };
}

export function createSplitOps(
  env: ChromeEnv,
  split: {
    splitCurrentTab(orientation: "horizontal" | "vertical"): boolean;
    unsplit(): boolean;
    switchPane(dir: number): boolean;
    swapPane(dir: number): boolean;
    addTabToSplitByIndex(n: number): boolean;
  }
) {
  const win = env.window as any;
  return {
    splitTab: (orientation: "horizontal" | "vertical") => {
      if (!split.splitCurrentTab(orientation)) {
        const api = typeof win.gBrowser.addTabSplitView === "function";
        toast(api ? "could not split (pinned tab or stale split state)" : "native split needs Firefox 149+");
      }
    },
    unsplitTab: () => {
      if (!split.unsplit()) toast("not in a split view");
    },
    switchSplitPane: (dir: number) => {
      if (!split.switchPane(dir)) toast("not in a split view");
    },
    swapSplitPane: (dir: number) => {
      if (!split.swapPane(dir)) toast("not in a split view");
    },
    splitAddTabByIndex: (n: number) => {
      if (!split.addTabToSplitByIndex(n)) toast("no split view to move into");
    },
  };
}
