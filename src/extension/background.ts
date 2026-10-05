// Extension background: the composition root.
//
// It wires the domain services together and routes the two message buses:
//
//   - browser.runtime messages from extension pages / content scripts,
//     dispatched through the per-domain handler tables in handlers/
//   - relay requests from the chrome helper, arriving over the persistent
//     relay port (services/relay.ts), dispatched through bgrelay.ts
//
// Everything it wires lives elsewhere. The three collaborators this file owns
// are:
//
//   handlers/       one message-handler table per domain (composed below)
//   bgrelay.ts      the relay request table the chrome helper dispatches
//   bglifecycle.ts  every browser event listener, behind one install call
//
// Feature logic lives in the modules those compose: services/ (navigation,
// relay, chrome-layer liveness, home-tab conversion, component inventory),
// sessions/, stealth/, cache/, windowops/, downloads/.

import type { BgAction } from "../shared/protocol";
import { createDiagnosticsHandlers } from "./handlers/diagnostics";
import { createDownloadHandlers } from "./handlers/downloads";
import { createHistoryHandlers } from "./handlers/history";
import { createSearchHandlers } from "./handlers/search";
import { createSessionHandlers } from "./handlers/sessions";
import { createSplitHandlers } from "./handlers/split";
import { createSyncHandlers } from "./handlers/sync";
import { createTabHandlers } from "./handlers/tabs";
import { createWindowHandlers } from "./handlers/window";
import type { BgActionName } from "./handlers/types";
import { openPage, openUI, openUrl } from "./services/navigation";
import { requestChrome } from "./services/relay";
import {
  componentsInfo,
  diagnoseTabs,
  openDiagnosticsTab,
  openSetupTab,
  pageReport
} from "./services/components";
import { stealthOpen } from "./stealth";
import { quitBrowser, saveSession } from "./sessions";
import { alternateTab as alternateTabOp, reopenTab } from "./windowops";
import {
  pushContentStateToChrome,
  pushFindStateToChrome,
  pushLeaderStateToChrome,
  pushSessionStateToChrome
} from "./bgpushes";
import { cache, installBackgroundLifecycle } from "./bglifecycle";

/* ===================== runtime message router ===================== */

// The message handlers, composed from one table per domain.
//
// The `MissingActions` check below is the guarantee: an action declared in
// BgApi and not handled here is a compile error, not a runtime "unknown
// action" a user finds by pressing a key.
const handlers = {
  ...createTabHandlers({
    reopenTab: () => reopenTab(),
    alternateTab: () => alternateTabOp(),
  }),
  ...createSearchHandlers({ openUrl, openPage, openUI }),
  ...createHistoryHandlers(),
  ...createDownloadHandlers(),
  ...createWindowHandlers(),
  ...createSessionHandlers({
    saveSession: (name: string) => saveSession(name),
  }),
  ...createSplitHandlers({ requestChrome }),
  ...createDiagnosticsHandlers({
    componentsInfo,
    pageReport,
    diagnoseTabs,
    openSetupTab,
    openDiagnosticsTab,
    cacheState: () => cache.cacheState(),
    cacheSet: (scope, mode) => cache.cacheSet(scope, mode),
    hardReload: () => cache.hardReload(),
    quitBrowser,
  }),
  ...createSyncHandlers({
    pushLeaderStateToChrome,
    pushContentStateToChrome,
    pushFindStateToChrome,
    stealthOpen,
    pushSessionStateToChrome,
  }),
};

type MissingActions = Exclude<BgActionName, keyof typeof handlers>;
const _everyActionIsHandled: Record<MissingActions, never> = {};
void _everyActionIsHandled;

async function handleMessage(msg: BgAction, sender: unknown) {
  const fn = handlers[msg.action] as ((d: unknown, s: unknown) => unknown) | undefined;
  // Unreachable for any action in BgApi (see the completeness check above);
  // this exists for a client older than this background.
  if (!fn) return { ok: false, error: "unknown action" };
  return fn((msg.data || {}) as never, sender);
}

browser.runtime.onMessage.addListener((msg: BgAction, sender: any) => {
  return handleMessage(msg, sender).catch((err: any) => ({
    ok: false,
    error: String(err && err.message ? err.message : err)
  }));
});

/* ===================== keyboard commands ===================== */

// The `browser.commands` shortcuts. Each one is a chrome-helper request dressed
// as a key chord, so they go through requestChrome rather than the handler
// table — except opening the command center, which is a plain extension page.
browser.commands.onCommand.addListener((name: string) => {
  if (name === "open-command-center") {
    browser.tabs
      .create({ url: browser.runtime.getURL("commandcenter.html"), active: true })
      .catch(() => {});
  } else if (name === "split-horizontal") {
    requestChrome("splitTab");
  } else if (name === "split-next-pane") {
    requestChrome("switchPane", { dir: 1 });
  } else if (name === "split-prev-pane") {
    requestChrome("switchPane", { dir: -1 });
  } else if (name === "unsplit") {
    requestChrome("unsplit");
  }
});

/* ===================== listeners ===================== */

// Last, because several of the listeners dispatch through the router above.
installBackgroundLifecycle();