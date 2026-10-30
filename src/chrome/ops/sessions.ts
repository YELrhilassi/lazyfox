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
  requestReply<
    K extends
      | "sessionTabCopy"
      | "sessionTabMove"
      | "deleteSession"
      | "restoreSession"
      | "switchSessionByMarker"
  >(
    action: K,
    arg: K extends "sessionTabCopy" | "sessionTabMove"
      ? { from: string; index: number; to: string }
      : K extends "deleteSession"
        ? { name: string }
        : K extends "restoreSession"
          ? { name: string }
          : { marker: number }
  ): Promise<any>;
  requestSessionState(): Promise<boolean>;
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
      //
      // ONE RETRY, because a popup can open while the relay is still coming up
      // (a launch, or right after a switch replaced the window's tabs): the
      // first read then answers false and the list would render empty even
      // though the sessions exist. A failed read costs a property read, not a
      // tab.
      if (!(await channel().requestSessionState())) {
        await new Promise<void>((r) => env.setTimeout(() => r(), 250));
        await channel().requestSessionState();
      }
      const ql = (q || "").trim().toLowerCase();
      let items: PopupItem[] = status.getInfo().sessions.map((s) => ({
        kind: "session",
        title: s.name,
        marker: s.marker || 0,
        current: !!s.current,
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
    // BY REPLY, so a switch that cannot happen says so. It used to be
    // fire-and-forget: `;P` on a session whose name had just been deleted closed
    // the popup and did nothing, with no way to tell that from a slow restore.
    // The wait is only the rebuild; the loader settles afterwards on its own.
    // A null reply is a relay timeout, which is not a failure to report.
    restoreSession: (name: string) =>
      void channel()
        .requestReply("restoreSession", { name })
        .then((r) => {
          if (r && r.ok === false) toast("could not switch session: " + (r.note || "unknown"));
        })
        .catch(() => {}),
    // By REPLY, not fire-and-forget, and not the delayed status refresh its
    // siblings use. `sessionAction` refreshes the status bar 900ms later, and
    // `listSessions` reads THAT cache — so the popup's immediate re-read after
    // a delete returned the list from before it, and `x x` looked like it had
    // done nothing. Waiting for the reply makes the write land first, and the
    // explicit refresh makes the cache the popup reads the post-delete one.
    deleteSession: (name: string) =>
      channel()
        .requestReply("deleteSession", { name })
        .then((r) => {
          if (r && r.ok === false) toast("delete failed: " + (r.note || "unknown"));
          return channel().requestSessionState();
        })
        .then(() => undefined),
    switchSessionByMarker: (marker: number) =>
      void channel()
        .requestReply("switchSessionByMarker", { marker })
        .then((r) => {
          if (r && r.ok === false) toast("no session at marker " + marker);
        })
        .catch(() => {}),
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
    addTabToSplitByIndex(n: number, split?: number): boolean;
    pullFromSplit(): boolean;
    splitTargets(): { split: number; active: boolean; panes: { title: string; url: string; active: boolean }[] }[];
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
    splitAddTabByIndex: (n: number, at?: number) => {
      if (!split.addTabToSplitByIndex(n, at)) toast("no split view to move into");
    },
    // The chrome window can read the groups straight off the strip, so the
    // chooser is fed from the same place the operation acts on.
    splitTargets: () => split.splitTargets(),
    pullFromSplit: () => {
      if (!split.pullFromSplit()) toast("not in a split view");
    },
  };
}
