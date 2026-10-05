// The background -> chrome command dispatcher.
//
// Split out of channel.ts. The channel decides WHEN a command arrives (it polls
// the relay's URL slot); this decides what each command DOES. Those are
// different kinds of change: adding a push is a product change, changing the
// queueing is a transport change, and putting both in one file meant every
// transport edit re-read the split/status/cache bindings.
//
// It is a TABLE rather than an if-chain for one concrete reason, measured: an
// if-chain silently ignores an action it does not recognise, so a rename on the
// background side became a push that did nothing and nobody could tell. The
// table is typed over ChromeAction, which makes an unhandled action a compile
// error HERE and a removed action a compile error on the background side too.

import type { ChromeAction, ChromeReq } from "../shared/protocol";
import type { CacheCtl } from "./cache";
import type { SplitView } from "./splitview";
import type { StatusBarCtl } from "./statusbar";

export interface PushDeps {
  split: SplitView;
  status: StatusBarCtl;
  // Records that a tab's own content script is running.
  setContentPresent(index: number, active: boolean, url: string): void;
  // Per-tab / per-session page-cache enforcement (the global scope is owned by
  // the extension background).
  cache: CacheCtl;
}

export type PushDispatcher = (action: string, arg: unknown) => void;

export function createPushDispatcher(deps: PushDeps): PushDispatcher {
  // Commands the background pushes through the relay (native splits, status
  // pushes, ...). `arg` arrives structured-cloned, so what actually shows up
  // here is exactly the request shape declared in ChromeApi.
  return function handlePush(action: string, arg: unknown): void {
    const table: { [K in ChromeAction]: (req: ChromeReq<K>) => void } = {
      splitTab: () => deps.split.splitCurrentTab("horizontal"),
      unsplit: () => deps.split.unsplit(),
      switchPane: (req) => deps.split.switchPane(req.dir >= 0 ? 1 : -1),
      swapSplitPanes: (req) => deps.split.swapPane(req.dir >= 0 ? 1 : -1),
      moveToSplit: (req) => deps.split.addTabToSplitByIndex(req.index),
      // Session restore finished opening tabs; re-create the native split
      // groupings. Positions are 1-based over the SAVED tab list.
      restoreSplits: (req) => deps.split.restoreSplits(req.groups, req.expect),
      // Status-bar push/reply: the fresh session summary as an object.
      sessionState: (req) => deps.status.applySessionState(req),
      // Content-script leader arm/disarm, cached per tab-strip index so the
      // window-level status bar can show the pulsing LEADER chevron on web
      // pages, where the content script owns the leader key. The chord and the
      // expected-next key ride with it so the bar can read `⌘ W ▸ 1-9` rather
      // than a bare glyph for the entire sequence.
      leaderState: (req) => {
        if (req.index >= 0) deps.status.setContentLeader(req.index, req.signal);
      },
      // "A content script is running in this tab", pushed by the tab itself.
      // The helper cannot work this out on its own — see noteContentPresent.
      contentState: (req) => {
        if (req.index >= 0) deps.setContentPresent(req.index, !!req.active, String(req.url || ""));
      },
      // Content-script find-in-page count, cached the same way.
      findState: (req) => {
        if (req.index >= 0) deps.status.setContentFind(req.index, req.count || 0, req.cur || 0);
      },
      // Global page-cache mode pushed by the background's diagnostics page.
      cacheGlobal: (req) => deps.cache.setGlobalMode(req.mode || "normal"),
      // Per-tab/session page-cache policy; tabIds aligned to the strip order
      // the tab switcher already relies on.
      cachePolicy: (req) =>
        deps.cache.setPolicy(req.mode || "normal", Array.isArray(req.tabIds) ? req.tabIds : []),
    };
    const fn = table[action as ChromeAction];
    if (!fn) return; // an action this build does not know: ignore, never throw
    try {
      fn((arg || {}) as never);
    } catch (e) {
      // A push that throws must not take the whole chrome helper down with it.
      // Losing one status-bar update is survivable; losing the leader key is not.
    }
  };
}