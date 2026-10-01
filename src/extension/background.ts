// Extension background: the composition root.
//
// It wires the domain services together and routes the two message buses:
//
//   - browser.runtime messages from extension pages / content scripts,
//     dispatched through the per-domain handler tables in handlers/
//   - relay requests from the chrome helper, arriving over the persistent
//     relay port (services/relay.ts), dispatched through relayHandlers below
//
// Feature logic lives in the modules it composes: services/ (navigation,
// relay, chrome-layer liveness, home-tab conversion, component inventory),
// handlers/ (message handler tables), sessions/, stealth/, cache/,
// windowops/, downloads/.

import { ensureCore } from "../shared/core";
import type { CacheMode } from "../shared/types";
import type { BgAction, RelayAction, RelayReq, RelayRes } from "../shared/protocol";
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
import { getConfig, setConfig } from "./config";
import { writeKey } from "./store";
import { probeHostOnce } from "./host";
import { getActiveTab, transientTabIds } from "./tabs";
import {
  alternateTab as alternateTabOp,
  clearHistory,
  forgetTab,
  noteTabActivation,
  recentlyClosed,
  removeHistory,
  reopenTab,
  restoreAllClosedTabs,
  restoreClosedTab
} from "./windowops";
import { createCacheController } from "./cache";
import { reconcileStealth, removeStealthContainerForTab, stealthOpen } from "./stealth";
import {
  assignSessionMarker,
  bindChromeHooks,
  deleteSession,
  flushOnQuit,
  isRestoring,
  moveTabBetweenSessions,
  newSession,
  quitBrowser,
  restoreSession,
  resumeOnStartup,
  saveSession,
  scheduleAutosave,
  scheduleSnapshot,
  sessionState,
  sessionTabs,
  switchSessionByMarker
} from "./sessions";
import { openPage, openUI, openUrl } from "./services/navigation";
import { acceptRelayPort, isRelayUrl, registerTransientRelayTab, requestChrome } from "./services/relay";
import {
  checkChromeLayerHealth,
  isChromeLayerAlive,
  markChromeAlive,
  nudgeFreshInstall,
  onNotificationClick,
  resetChromeLayerOnStartup
} from "./services/chromelayer";
import { watchHomeTabs } from "./services/homeshim";
import {
  componentsInfo,
  diagnoseTabs,
  openDiagnosticsTab,
  openSetupTab,
  pageReport,
  watchPageTabs
} from "./services/components";

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

/* ===================== chrome-helper pushes ===================== */

// Push the fresh session summary to the chrome helper's status bar after a
// session mutation that did NOT originate from the helper (the helper
// refreshes on its own actions; content-script and options actions would
// otherwise leave its bar pointing at a stale session name).
async function pushSessionStateToChrome(): Promise<void> {
  try {
    const state = await sessionState();
    requestChrome("sessionState", state);
  } catch {
    // ignore
  }
}

// Relay the content script's leader arm/disarm to the chrome helper so its
// window-level status bar shows the pulsing LEADER chevron on web pages. The
// push carries the tab's strip index + active flag; the helper caches per index.
function pushLeaderStateToChrome(index: number, active: boolean): void {
  if (index < 0) return;
  requestChrome("leaderState", { index, active });
}

// Relay the content script's find-in-page count to the chrome helper so its
// window-level status bar shows "🔍 cur/count" on web pages.
function pushContentStateToChrome(index: number, active: boolean, url: string): void {
  if (index < 0) return;
  requestChrome("contentState", { index, active, url });
}

function pushFindStateToChrome(index: number, count: number, cur: number): void {
  if (index < 0) return;
  requestChrome("findState", { index, count, cur });
}

/* ===================== relay request handlers ===================== */

// One handler per RelayAction. The helper's requests arrive over the relay
// port (services/relay.ts); a missing handler answers null so the helper's
// request/reply never hangs until its timeout.
const relayHandlers: { [K in RelayAction]: (req: RelayReq<K>) => Promise<RelayRes<K>> | RelayRes<K> } = {
  // The chrome helper announces its version, the active profile's name and
  // directory leaf, and whether the Lazyfox window actor is registered. Stored
  // so the options Components panel, command-center footer and setup page can
  // show what is really installed. The truthy ack lets the helper stop
  // retrying (a fire-and-forget req only proves acceptance, not delivery).
  alive: (req) => {
    markChromeAlive();
    void writeKey("chromeHelperVersion", req.version || "");
    // Optional fields stay absent rather than becoming "": the emptiness is
    // meaningful ("the helper has not reported one yet").
    if (req.profileName) void writeKey("lfProfileName", req.profileName);
    if (req.profileDir) void writeKey("lfProfileDir", req.profileDir);
    if (req.bridge !== undefined) void writeKey("lfBridge", req.bridge);
    return { ok: true };
  },
  // The helper flipped its own cached copy; flip storage to match so content
  // scripts, the command center and options agree.
  toggleWhichKey: async () => {
    const c = await getConfig();
    c.whichKey = !c.whichKey;
    await setConfig(c);
    return null;
  },
  // Best-effort: a tab with no content script (about:, an extension page, a
  // restricted domain) is a normal outcome, not an error to surface.
  startHints: () => relayToContent("startHints"),
  focusFirstInput: () => relayToContent("focusFirstInput"),
  openOptions: async () => {
    try {
      await browser.runtime.openOptionsPage();
    } catch {
      // ignore
    }
    return null;
  },
  openSetup: async () => {
    await openSetupTab();
    return null;
  },
  openDiagnostics: async () => {
    await openDiagnosticsTab();
    return null;
  },
  quit: async () => {
    await quitBrowser();
    return null;
  },
  // The result ({ ok, error }) goes back so the helper can toast the outcome
  // instead of swallowing it.
  stealthOpen: () => stealthOpen(() => pushSessionStateToChrome()),
  // Read-only pulls for the chrome-side UI.
  sessionState: () => sessionState(),
  sessionTabs: (req) => sessionTabs(req.name),
  recentlyClosed: () => recentlyClosed(),
  // Routed here rather than calling gBrowser.undoCloseTab locally so it goes
  // through the same filtered reopen as the content script (SessionStore's
  // "most recently closed" is usually a hidden plumbing tab, which this skips).
  reopenTab: () => reopenTab(),
  // Session + tab mutations. Fire-and-forget; the helper refreshes the status
  // bar itself once the action has landed.
  saveSession: async (req) => {
    await saveSession(req.name);
    return null;
  },
  newSession: async (req) => {
    await newSession(req.name);
    return null;
  },
  restoreSession: async (req) => {
    await restoreSession(req.name);
    return null;
  },
  deleteSession: async (req) => {
    await deleteSession(req.name);
    return null;
  },
  switchSessionByMarker: async (req) => {
    await switchSessionByMarker(req.marker);
    return null;
  },
  assignSessionMarker: async (req) => {
    await assignSessionMarker(req.name, req.marker);
    return null;
  },
  sessionTabCopy: (req) => moveTabBetweenSessions(req.from, req.index, req.to, "copy"),
  sessionTabMove: (req) => moveTabBetweenSessions(req.from, req.index, req.to, "move"),
  // Tab strip / history actions the helper cannot do itself.
  alternateTab: async () => {
    await alternateTabOp();
    return null;
  },
  restoreClosedTab: async (req) => {
    await restoreClosedTab(req.key);
    return null;
  },
  restoreAllClosed: async () => {
    await restoreAllClosedTabs();
    return null;
  },
  removeHistory: async (req) => {
    await removeHistory(req.url);
    return null;
  },
  clearHistory: async () => {
    await clearHistory();
    return null;
  },
};

// Forward a request to the active tab's content script.
async function relayToContent(action: "startHints" | "focusFirstInput"): Promise<null> {
  const t = await getActiveTab();
  if (!t) return null;
  try {
    await browser.tabs.sendMessage(t.id, { action });
  } catch {
    // No content script in that tab. Normal, and not worth a toast.
  }
  return null;
}

function handleRelayReq(action: string, arg: unknown): Promise<unknown> {
  const fn = relayHandlers[action as RelayAction] as ((req: unknown) => unknown) | undefined;
  if (!fn) return Promise.resolve(null);
  // Every live request from the helper is evidence the chrome layer is up —
  // keep the gate latched even if the dedicated announce raced the extension
  // still loading on a cold start.
  if (action !== "alive") markChromeAlive();
  return Promise.resolve(fn((arg || {}) as never)).then((r) => (r === undefined ? null : r));
}

/* ===================== page-cache policy ===================== */

// The chrome helper enforces the per-tab scopes, so whenever it comes alive we
// re-push the stored policy (a policy set while the helper was down would
// otherwise never take effect).
const cache = createCacheController({
  requestChrome: (action, arg) => {
    // cache.ts pushes only the two actions declared here; the narrowing is
    // confined to this one adapter.
    if (action === "cacheGlobal") requestChrome("cacheGlobal", { mode: (arg as CacheMode) || "normal" });
    else if (action === "cachePolicy") {
      const p = (arg || {}) as { mode?: CacheMode; tabIds?: number[] };
      requestChrome("cachePolicy", { mode: p.mode || "normal", tabIds: Array.isArray(p.tabIds) ? p.tabIds : [] });
    }
  },
  isChromeAlive: isChromeLayerAlive,
});

/* ===================== lifecycle wiring ===================== */

browser.runtime.onConnect.addListener((port: any) => {
  acceptRelayPort(port, handleRelayReq, transientTabIds);
});

// Register/drop relay tabs as transient plumbing.
browser.tabs.onCreated.addListener((tab: any) => registerTransientRelayTab(tab, transientTabIds));
browser.tabs.onUpdated.addListener((tabId: number, _info: any, tab: any) => {
  if (isRelayUrl(tab && tab.url)) transientTabIds.add(tabId);
});
browser.tabs.onRemoved.addListener((tabId: number) => {
  transientTabIds.delete(tabId);
});

// Alternate-tab (;a) bookkeeping: remember the previously-active tab per
// window so the shortcut can toggle back to it. Suppressed during a session
// restore rebuild (the transient activations would pollute the pair).
browser.tabs.onActivated.addListener((info: any) => {
  if (isRestoring()) return;
  noteTabActivation(info.windowId, info.tabId);
});
browser.tabs.onRemoved.addListener((tabId: number, removeInfo: any) => {
  forgetTab(removeInfo && removeInfo.windowId, tabId);
});

// Session autosave + the in-memory quit snapshot, kept current on every tab
// change so flushing on quit never persists a stale window.
const onTabChange = () => {
  scheduleAutosave();
  scheduleSnapshot();
};
browser.tabs.onCreated.addListener(onTabChange);
browser.tabs.onRemoved.addListener(onTabChange);
browser.tabs.onMoved.addListener(onTabChange);
browser.tabs.onAttached.addListener(onTabChange);
browser.tabs.onDetached.addListener(onTabChange);
browser.tabs.onActivated.addListener(onTabChange);
browser.tabs.onUpdated.addListener((_tabId: number, info: any) => {
  if (info.url || info.status === "complete") onTabChange();
});

// When a stealth tab closes, wipe its container data + remove the container.
// (Racy if the browser dies first — reconcileStealth catches orphans next
// launch.)
browser.tabs.onRemoved.addListener((tabId: number) => {
  void removeStealthContainerForTab(tabId);
});

// On startup, resume the saved session when autoRestore is on. See
// sessions.resumeOnStartup for why this replaces Firefox's native restore.
browser.runtime.onStartup.addListener(async () => {
  try {
    const c = await getConfig();
    await resumeOnStartup(c.autoRestore);
  } catch {
    // ignore
  }
});

// When the last window closes, Firefox is quitting. Flush the last-known
// snapshot captured on the previous tab change.
browser.windows.onRemoved.addListener(async () => {
  try {
    await flushOnQuit();
  } catch {
    // ignore
  }
});

browser.notifications.onClicked.addListener((id: string) => {
  onNotificationClick(id, () => void openSetupTab());
});

// Chrome helper absent unless it pings "alive" on window startup.
browser.runtime.onStartup.addListener(() => {
  resetChromeLayerOnStartup();
  checkChromeLayerHealth(() => void openSetupTab());
  nudgeFreshInstall();
  void reconcileStealth();
});

// Also reconcile on background load (covers install/reload and the very first
// launch after enabling the feature) — idempotent.
void reconcileStealth();
// Fresh installs land here first (onStartup fires on later launches).
checkChromeLayerHealth(() => void openSetupTab());
nudgeFreshInstall();

// Wire the chrome-helper hooks into the session manager (breaks the import
// cycle sessions -> relay -> sessions).
bindChromeHooks({ requestChrome, pushSessionState: pushSessionStateToChrome });

// Home/newtab → command-center conversion (startup + mid-session watchers).
watchHomeTabs();

// Track the last real page tab for the diagnostics page report.
watchPageTabs();

// Warm the wasm core for the first URL suggestion.
void ensureCore().catch(() => {});

// Dev-only smoke test: log the native host's diag once. Absence is a silent
// no-op — the host is optional, and AMO/store installs without the
// installer's host step must degrade cleanly.
probeHostOnce();
