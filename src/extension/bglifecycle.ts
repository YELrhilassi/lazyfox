// Every browser event listener the background registers, in one place.
//
// background.ts is the composition root; a root should say WHAT it wires, not
// spell out every callback inline. Each install* function below owns one
// concern and is called once from the root, so adding a listener is an
// addition to this file rather than another block appended to the router.
//
// These are pure side-effect registrations — nothing here is exported except
// installBackgroundLifecycle(), which the root calls last.

import { getConfig } from "./config";
import { probeHostOnce } from "./host";
import { transientTabIds } from "./tabs";
import { createCacheController } from "./cache";
import { forgetTabTrack, noteTabTitle, noteTabUrl, primeTracks } from "./navstore";
import {
  forgetTab,
  noteKnownTab,
  noteTabActivation,
  noteTabRemoved,
  primeActivation,
  primeKnownTabs
} from "./windowops";
import {
  reconcileStealth,
  removeStealthContainerForTab
} from "./stealth";
import {
  bindChromeHooks,
  flushOnQuit,
  isRestoring,
  resumeOnStartup,
  scheduleAutosave,
  scheduleSnapshot
} from "./sessions";
import {
  acceptRelayPort,
  isRelayUrl,
  registerTransientRelayTab,
  requestChrome
} from "./services/relay";
import {
  checkChromeLayerHealth,
  isChromeLayerAlive,
  nudgeFreshInstall,
  onNotificationClick,
  resetChromeLayerOnStartup
} from "./services/chromelayer";
import { watchHomeTabs } from "./services/homeshim";
import { openSetupTab, watchPageTabs } from "./services/components";
import { ensureCore } from "../shared/core";
import type { CacheMode } from "../shared/types";
import { handleRelayReq } from "./bgrelay";
import { pushSessionStateToChrome } from "./bgpushes";

// The page-cache policy. The chrome helper enforces the per-tab scopes, so
// whenever it comes alive we re-push the stored policy (a policy set while the
// helper was down would otherwise never take effect).
export const cache = createCacheController({
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

// The relay port the chrome helper talks over.
function installRelayPort(): void {
  browser.runtime.onConnect.addListener((port: any) => {
    acceptRelayPort(port, handleRelayReq, transientTabIds);
  });
}

// Register/drop relay tabs as transient plumbing.
function installTransientTabs(): void {
  browser.tabs.onCreated.addListener((tab: any) => registerTransientRelayTab(tab, transientTabIds));
  browser.tabs.onUpdated.addListener((tabId: number, _info: any, tab: any) => {
    if (isRelayUrl(tab && tab.url)) transientTabIds.add(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId: number) => {
    transientTabIds.delete(tabId);
  });
}

// Alternate-tab (;a) bookkeeping plus the record of what was closed.
function installTabBookkeeping(): void {
  // rememberTab keeps the per-tab close-description current (see noteTabRemoved).
  const rememberTab = (tab: any) => noteKnownTab(tab);
  browser.tabs.onCreated.addListener(rememberTab);
  browser.tabs.onUpdated.addListener((_tabId: number, _info: any, tab: any) => rememberTab(tab));
  browser.tabs.onMoved.addListener(rememberTab);
  browser.tabs.onAttached.addListener(rememberTab);
  browser.tabs.onDetached.addListener(rememberTab);
  browser.windows.onCreated.addListener(() => {
    void primeKnownTabs();
  });
  // Tabs that already existed when the background woke up.
  void primeKnownTabs();
  // One MRU entry per window, so `;a` has a list even in a window that has not
  // seen an activation since this process started (see windowops.alternateTab).
  void primeActivation();

  // Suppressed during a session restore rebuild (the transient activations
  // would pollute the pair).
  browser.tabs.onActivated.addListener((info: any) => {
    if (isRestoring()) return;
    noteTabActivation(info.windowId, info.tabId);
  });
  browser.tabs.onRemoved.addListener((tabId: number, removeInfo: any) => {
    forgetTab(removeInfo && removeInfo.windowId, tabId);
    // Record the close itself, whoever made it. `;x` closes through `gBrowser`
    // in the chrome process and so never reaches the extension's close handler;
    // without this, the one command whose job is to undo a close could not undo
    // that close, and fell back on Firefox's list - where the extension's own
    // transient closes live. See noteTabRemoved.
    noteTabRemoved(tabId, removeInfo);
  });
}

// Per-tab navigation tracks for `;G` / `;L` (see navstore.ts for why the
// background is the one that knows). No permission is added: a URL change on
// any tab already reaches the background through tabs.onUpdated, and that
// stream is exactly what the tracker rebuilds a stack from. `onUpdated` fires
// once with the URL and (usually) once more with the title, so both fields are
// read from the same event — whichever is present.
function installNavTracks(): void {
  browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
    if (info && info.url) noteTabUrl(tabId, info.url, (tab && tab.title) || "");
    if (info && info.title) noteTabTitle(tabId, info.title);
  });
  browser.tabs.onRemoved.addListener((tabId: number) => forgetTabTrack(tabId));
  void primeTracks();
}

// Session autosave + the in-memory quit snapshot, kept current on every tab
// change so flushing on quit never persists a stale window.
function installSessionAutosave(): void {
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
}

// When a stealth tab closes, wipe its container data + remove the container.
// (Racy if the browser dies first — reconcileStealth catches orphans next
// launch.)
function installStealthCleanup(): void {
  browser.tabs.onRemoved.addListener((tabId: number) => {
    void removeStealthContainerForTab(tabId);
  });
}

// Browser-level startup/quit/notification events.
function installBrowserLifecycle(): void {
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
}

// Everything that runs on background load itself (install/reload and the very
// first launch after enabling a feature), plus the watchers that never stop.
function installWatchers(): void {
  // Also reconcile on background load — idempotent.
  void reconcileStealth();
  // Fresh installs land here first (onStartup fires on later launches).
  checkChromeLayerHealth(() => void openSetupTab());
  nudgeFreshInstall();

  // Home/newtab -> command-center conversion (startup + mid-session watchers).
  watchHomeTabs();
  // Track the last real page tab for the diagnostics page report.
  watchPageTabs();

  // Warm the wasm core for the first URL suggestion.
  void ensureCore().catch(() => {});

  // Dev-only smoke test: log the native host's diag once. Absence is a silent
  // no-op — the host is optional, and AMO/store installs without the
  // installer's host step must degrade cleanly.
  probeHostOnce();
}

/**
 * Registers every listener the background needs. Called exactly once, after
 * the message router is in place, because several of these dispatch through
 * it.
 */
export function installBackgroundLifecycle(): void {
  installRelayPort();
  installTransientTabs();
  installTabBookkeeping();
  installNavTracks();
  installSessionAutosave();
  installStealthCleanup();
  installBrowserLifecycle();
  // Wire the chrome-helper hooks into the session manager (breaks the import
  // cycle sessions -> relay -> sessions).
  bindChromeHooks({ requestChrome, pushSessionState: pushSessionStateToChrome });
  installWatchers();
}