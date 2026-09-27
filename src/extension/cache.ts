// Page-cache policy, background half.
//
// Firefox's HTTP cache is a single global switch with no per-tab knob. So
// Lazyfox's three scopes map onto two very different mechanisms:
//
//   global  — the real browser-wide cache switch (`browserSettings.
//             cacheEnabled`), plus a revalidate-everything pref for "fresh".
//             Works with or without the chrome helper.
//   session — every tab of the active Lazyfox session (its real tabs at the
//   tab       moment Apply was pressed). Enforced by the privileged chrome
//             helper, which can add `Cache-Control: no-cache` to the requests
//             of specific tabs. Requires the chrome layer.
//
// The policy is persisted so it survives a background restart and can be
// re-pushed to the chrome helper whenever the helper announces itself alive.

import type { CacheMode, CacheScope, CacheState } from "../shared/types";
import { sessionState } from "./sessions";

interface CachePolicy {
  scope: CacheScope;
  mode: CacheMode;
  // Tabs the session/tab policy covers. Empty for a global policy.
  tabIds: number[];
}

const POLICY_KEY = "cachePolicy";

const DEFAULT_POLICY: CachePolicy = { scope: "global", mode: "normal", tabIds: [] };

interface CacheDeps {
  requestChrome(action: string, arg?: unknown): void;
  isChromeAlive(): boolean;
}

// Read the stored policy, tolerating a missing/corrupt value.
async function readPolicy(): Promise<CachePolicy> {
  try {
    const r = await browser.storage.local.get(POLICY_KEY);
    const p = r && r[POLICY_KEY];
    if (p && typeof p === "object") {
      return {
        scope: (p.scope as CacheScope) || "global",
        mode: (p.mode as CacheMode) || "normal",
        tabIds: Array.isArray(p.tabIds) ? p.tabIds.map(Number).filter((n: number) => n > 0) : [],
      };
    }
  } catch (e) {
    // ignore
  }
  return { ...DEFAULT_POLICY };
}

async function writePolicy(p: CachePolicy): Promise<void> {
  try {
    await browser.storage.local.set({ [POLICY_KEY]: p });
  } catch (e) {
    // ignore
  }
}

function globalCacheSwitch(): { get(v: boolean): Promise<void> } | null {
  try {
    const bs = browser.browserSettings;
    if (bs && bs.cacheEnabled && typeof bs.cacheEnabled.set === "function") {
      return { get: (v: boolean) => bs.cacheEnabled.set({ value: v }) };
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// Keep only tab ids that still exist, so a policy never names a dead tab.
async function liveTabIds(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const out: number[] = [];
  for (const id of ids) {
    try {
      await browser.tabs.get(id);
      out.push(id);
    } catch (e) {
      // tab is gone
    }
  }
  return out;
}

function describe(scope: CacheScope, mode: CacheMode): string {
  if (mode === "normal") return "Firefox's default cache behaviour.";
  const what = mode === "off" ? "no cached copies (every request hits the network)" : "revalidate every load";
  if (scope === "global") return "Everywhere: " + what + ".";
  if (scope === "session") return "This session's tabs: " + what + ".";
  return "This tab only: " + what + ".";
}

export function createCacheController(deps: CacheDeps) {
  // Push the stored per-tab policy to the chrome helper. Called on every Apply
  // and whenever the helper announces itself alive, so a policy set while the
  // helper was down still takes effect once it comes back.
  async function pushToChrome(p?: CachePolicy): Promise<void> {
    const pol = p || (await readPolicy());
    if (pol.scope === "global") {
      // The helper only needs to know the global mode for the revalidate pref.
      deps.requestChrome("cacheGlobal", pol.mode);
      return;
    }
    const ids = await liveTabIds(pol.tabIds);
    deps.requestChrome("cachePolicy", { mode: pol.mode, tabIds: ids });
  }

  async function cacheState(): Promise<CacheState> {
    const pol = await readPolicy();
    const tabIds = pol.scope === "global" ? [] : await liveTabIds(pol.tabIds);
    const chromeSupported = deps.isChromeAlive();
    let note = describe(pol.scope, pol.mode);
    // A global "fresh" is the one mode the background cannot enforce alone: it
    // needs the helper's revalidate pref. Say so instead of implying it is live.
    if (pol.scope === "global" && pol.mode === "fresh" && !chromeSupported) {
      note += " (Needs the Lazyfox window chrome to actually revalidate — install it, then apply again.)";
    }
    return {
      scope: pol.scope,
      mode: pol.mode,
      globalSupported: !!globalCacheSwitch(),
      chromeSupported: chromeSupported,
      tabIds: tabIds,
      note: note,
    };
  }

  async function cacheSet(scope: CacheScope, mode: CacheMode): Promise<{ ok: boolean; state?: CacheState; error?: string }> {
    // Narrow scopes need the privileged helper; refuse cleanly rather than
    // pretend a policy is in force when nothing can enforce it.
    if (scope !== "global" && !deps.isChromeAlive()) {
      return { ok: false, error: "Per-tab cache control needs the Lazyfox window chrome (run the installer)." };
    }
    if (scope === "global") {
      const sw = globalCacheSwitch();
      if (mode === "off" && !sw) {
        return { ok: false, error: "Firefox does not expose the global cache switch on this build." };
      }
      try {
        if (sw) await sw.get(mode !== "off");
      } catch (e) {
        return { ok: false, error: "Firefox refused the cache switch." };
      }
      // "fresh" (and leaving "off") needs the revalidate pref, which only the
      // chrome helper can set. Push it; if the helper is down "fresh" degrades
      // to "normal" and the note that comes back says so.
      deps.requestChrome("cacheGlobal", mode);
    }
    let tabIds: number[] = [];
    if (scope === "session") {
      try {
        const st = await sessionState();
        tabIds = (st.tabIds || []).filter((n) => typeof n === "number" && n > 0);
      } catch (e) {
        tabIds = [];
      }
    } else if (scope === "tab") {
      try {
        const ts = await browser.tabs.query({ currentWindow: true, active: true });
        if (ts && ts[0] && ts[0].id) tabIds = [ts[0].id];
      } catch (e) {
        // ignore
      }
    }
    const pol: CachePolicy = { scope: scope, mode: mode, tabIds: tabIds };
    await writePolicy(pol);
    await pushToChrome(pol);
    // If the scope is narrow but nothing could be captured, say so.
    if (scope !== "global" && !tabIds.length) {
      return { ok: false, error: "No tabs matched that scope.", state: await cacheState() };
    }
    return { ok: true, state: await cacheState() };
  }

  // Reload the active tab bypassing its HTTP cache (Firefox's "hard reload").
  async function hardReload(): Promise<{ ok: boolean }> {
    try {
      const ts = await browser.tabs.query({ currentWindow: true, active: true });
      const id = ts && ts[0] ? ts[0].id : null;
      if (id == null) return { ok: false };
      await browser.tabs.reload(id, { bypassCache: true });
      return { ok: true };
    } catch (e) {
      return { ok: false };
    }
  }

  return {
    cacheState,
    cacheSet,
    hardReload,
    resync: () => pushToChrome(),
  };
}
