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
import { realTabsIn, senderWindowId } from "../tabs";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns =
  | "sessionSplit"
  | "sessionUnsplit"
  | "sessionSwitchPane"
  | "sessionSwapPane"
  | "sessionSplitAddTabByIndex"
  | "sessionSplitTargets"
  | "sessionPullFromSplit"
  | "splitPanelTabs"
  | "moveTabToSplit"
  | "layoutChanged";

export interface SplitDeps {
  requestChrome<K extends ChromeAction>(action: K, arg?: ChromeReq<K>): void;
  /** The same, aimed at a NAMED window (relay.requestChromeToWindow). */
  requestChromeToWindow<K extends ChromeAction>(
    winId: number,
    action: K,
    arg?: ChromeReq<K>
  ): void;
  /**
   * A split appeared, was dissolved, or had its panes rearranged. Recorded here
   * because it is the one event in this domain that changes the SAVED layout
   * without changing the tab list, so no tabs.* listener can see it.
   */
  onLayoutChanged(): void;
}

/**
 * Send a split command to the WINDOW THE REQUEST CAME FROM.
 *
 * A split forms in the window you are looking at, and only that window's chrome
 * helper can form it. Addressing it by "the focused window" (the old
 * requestChrome) meant a `;|` pressed in session A could pair two tabs in
 * session B: the same class of bug as `;g`/`;l`, on the same reported path.
 */
function ask<K extends ChromeAction>(
  deps: SplitDeps,
  sender: unknown,
  action: K,
  arg?: ChromeReq<K>
): void {
  const winId = senderWindowId(sender);
  if (winId == null) deps.requestChrome(action, arg);
  else deps.requestChromeToWindow(winId, action, arg);
}

export function createSplitHandlers(deps: SplitDeps): Domain<Owns> {
  return {
    sessionSplit: (_data, sender) => {
      ask(deps, sender, "splitTab");
      return { ok: true };
    },
    sessionUnsplit: (_data, sender) => {
      ask(deps, sender, "unsplit");
      return { ok: true };
    },
    sessionSwitchPane: (data, sender) => {
      ask(deps, sender, "switchPane", { dir: data.dir > 0 ? 1 : -1 });
      return { ok: true };
    },
    sessionSwapPane: (data, sender) => {
      ask(deps, sender, "swapSplitPanes", { dir: data.dir > 0 ? 1 : -1 });
      return { ok: true };
    },
    sessionSplitAddTabByIndex: (data, sender) => {
      const n = Number(data.index);
      if (!(n >= 1 && n <= 9)) return { ok: false, note: "tab number must be 1-9" };
      const split = Number(data.split);
      ask(
        deps,
        sender,
        "moveToSplit",
        split >= 1 ? { index: n, split: split } : { index: n }
      );
      return { ok: true };
    },

    sessionSplitTargets: async (_data, sender) => {
      // A window can hold MORE THAN ONE native split, so "move this tab into
      // the split" has more than one answer and the chooser needs the list.
      //
      // `splitViewId` is what makes this answerable from the extension: it is
      // the platform's own group id, already on every tab, so the groups are
      // derived from the same numbering the strip uses rather than from a
      // second guess about it. Groups are ordered by their first tab, which is
      // the order the user sees them in.
      const tabs = await realTabsIn(senderWindowId(sender));
      const groups = new Map<number, typeof tabs>();
      for (const t of tabs) {
        const id = (t as any).splitViewId;
        if (typeof id !== "number" || id < 0) continue;
        const hit = groups.get(id);
        if (hit) hit.push(t);
        else groups.set(id, [t]);
      }
      const splits = Array.from(groups.values()).map((panes, i) => ({
        split: i + 1,
        active: panes.some((p: any) => !!p.active),
        panes: panes.map((p: any) => ({
          title: String(p.title || ""),
          url: String(p.url || ""),
          active: !!p.active,
        })),
      }));
      return { splits: splits };
    },

    sessionPullFromSplit: (_data, sender) => {
      ask(deps, sender, "pullFromSplit");
      return { ok: true };
    },

    layoutChanged: () => {
      // The helper's report that the pane layout moved. It carries no data on
      // purpose: the groups are re-derived from `browser.tabs`' own
      // `splitViewId` at snapshot time, which is the same source the restore
      // reads, so a payload could only disagree with it.
      deps.onLayoutChanged();
      return null;
    },

    splitPanelTabs: async (_data, sender) => {
      // Number REAL tabs only (skip splitpanel + #lfc=), so the list's numbers
      // match ;+N and never shift when a companion pane is added/removed.
      const tabs = await realTabsIn(senderWindowId(sender));
      return {
        tabs: tabs.map((t, i) => ({
          index: i + 1,
          id: t.id,
          url: t.url || "",
          title: t.title || "",
          active: !!t.active,
          inSplit: typeof t.splitViewId === "number" && t.splitViewId >= 0,
          favIconUrl: typeof t.favIconUrl === "string" ? t.favIconUrl : "",
        })),
      };
    },

    moveTabToSplit: (data, sender) => {
      const n = Number(data.index);
      if (!(n >= 1 && n <= 9)) return { ok: false };
      ask(deps, sender, "moveToSplit", { index: n });
      return { ok: true };
    },
  };
}
