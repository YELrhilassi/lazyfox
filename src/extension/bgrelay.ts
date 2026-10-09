// The relay request table: one handler per RelayAction, dispatched from the
// chrome helper's persistent relay port.
//
// This was the single largest block in background.ts and the least like a
// composition root — it is a *table*, and a table reads better on its own. The
// port itself is still accepted by background.ts, which owns the runtime
// listener that installs it.

import type { RelayAction, RelayReq, RelayRes } from "../shared/protocol";
import { getConfig, setConfig } from "./config";
import { writeKey } from "./store";
import { getActiveTab } from "./tabs";
import {
  alternateTab as alternateTabOp,
  clearHistory,
  recentlyClosed,
  removeHistory,
  reopenTab,
  restoreAllClosedTabs,
  restoreClosedTab
} from "./windowops";
import {
  assignSessionMarker,
  deleteSession,
  moveTabBetweenSessions,
  newSession,
  quitBrowser,
  restoreSession,
  saveSession,
  sessionState,
  sessionTabs,
  switchSessionByMarker
} from "./sessions";
import { markChromeAlive } from "./services/chromelayer";
import { openDiagnosticsTab, openSetupTab } from "./services/components";
import { stealthOpen } from "./stealth";
import { pushSessionStateToChrome } from "./bgpushes";

// Forward a request to the active tab's content script.
async function relayToContent(
  action: "startHints" | "focusFirstInput"
): Promise<null> {
  const t = await getActiveTab();
  if (!t) return null;
  try {
    await browser.tabs.sendMessage(t.id, { action });
  } catch {
    // No content script in that tab. Normal, and not worth a toast.
  }
  return null;
}

// One handler per RelayAction. The helper's requests arrive over the relay
// port (services/relay.ts); a missing handler answers null so the helper's
// request/reply never hangs until its timeout.
export const relayHandlers: {
  [K in RelayAction]: (req: RelayReq<K>) => Promise<RelayRes<K>> | RelayRes<K>;
} = {
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
  // Returns the outcome: the caller awaits it to know the storage write has
  // landed before it re-reads the list (see protocol.ts).
  deleteSession: (req) => deleteSession(req.name),
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

export function handleRelayReq(action: string, arg: unknown): Promise<unknown> {
  const fn = relayHandlers[action as RelayAction] as ((req: unknown) => unknown) | undefined;
  if (!fn) return Promise.resolve(null);
  // Every live request from the helper is evidence the chrome layer is up —
  // keep the gate latched even if the dedicated announce raced the extension
  // still loading on a cold start.
  if (action !== "alive") markChromeAlive();
  return Promise.resolve(fn((arg || {}) as never)).then((r) => (r === undefined ? null : r));
}