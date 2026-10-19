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
import { cacheNote, globalSwitchFor } from "./cache-policy";
import { readKey, writeKey, vTabIds, type CachePolicy } from "./store";
import { sessionState } from "./sessions";

// The key and the shape are declared in ./store; the default stays here,
// next to the code that uses it, because "what a fresh profile does" is a
// policy decision rather than a schema fact.
const DEFAULT_POLICY: CachePolicy = { scope: "global", mode: "normal", tabIds: [] };

interface CacheDeps {
  requestChrome(action: string, arg?: unknown): void;
  isChromeAlive(): boolean;
}

// Read the stored policy, tolerating a missing/corrupt value.
//
// The validation used to be inline and is now the store's, so it is stated
// once. Note the behaviour it had to preserve: scope and mode fall back
// INDEPENDENTLY (a record with a valid mode but a garbage scope kept the mode),
// and tabIds is sanitised rather than rejected — a profile written by an older
// build with numeric strings still gets a usable policy, which matters because
// "the cache policy reset itself" is a bug report, not a graceful degradation.
const vPolicy = (raw: unknown): CachePolicy | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as { scope?: unknown; mode?: unknown; tabIds?: unknown };
  return {
    scope: (p.scope as CacheScope) || "global",
    mode: (p.mode as CacheMode) || "normal",
    tabIds: vTabIds(p.tabIds) || [],
  };
};

async function readPolicy(): Promise<CachePolicy> {
  return readKey("cachePolicy", vPolicy, { ...DEFAULT_POLICY });
}

async function writePolicy(p: CachePolicy): Promise<void> {
  await writeKey("cachePolicy", p);
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

/**
 * The switch's CURRENT value, or null when this build does not expose it.
 *
 * Read rather than assumed, because the switch is the one part of a cache policy
 * that lives OUTSIDE the policy record: it is a browser-wide setting that
 * outlives the Lazyfox session, the background page and the add-on's own idea of
 * what the user chose. Anything that reports "what is in force" about the cache
 * has to ask the browser, not the stored policy, or it reports the intention
 * rather than the state.
 */
async function globalCacheValue(): Promise<boolean | null> {
  try {
    const bs = browser.browserSettings;
    if (bs && bs.cacheEnabled && typeof bs.cacheEnabled.get === "function") {
      const o = await bs.cacheEnabled.get({});
      const v = o && (o as { value?: unknown }).value;
      if (typeof v === "boolean") return v;
    }
  } catch (e) {
    // A switch that cannot be read is reported as unknown, never guessed at.
  }
  return null;
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
    // Asked, not assumed: see globalCacheValue. `null` is "this build will not
    // say", which the note treats differently from "off".
    const globalOn = await globalCacheValue();
    return {
      scope: pol.scope,
      mode: pol.mode,
      globalSupported: !!globalCacheSwitch(),
      globalOn: globalOn,
      chromeSupported: chromeSupported,
      tabIds: tabIds,
      note: cacheNote(pol.scope, pol.mode, { globalOn: globalOn, chromeAlive: chromeSupported }),
    };
  }

  async function cacheSet(scope: CacheScope, mode: CacheMode): Promise<{ ok: boolean; state?: CacheState; error?: string }> {
    // Narrow scopes need the privileged helper; refuse cleanly rather than
    // pretend a policy is in force when nothing can enforce it.
    if (scope !== "global" && !deps.isChromeAlive()) {
      return { ok: false, error: "Per-tab cache control needs the Lazyfox window chrome (run the installer)." };
    }
    const sw = globalCacheSwitch();
    if (scope === "global" && mode === "off" && !sw) {
      return { ok: false, error: "Firefox does not expose the global cache switch on this build." };
    }
    // Resolve what the policy COVERS before anything is written. The order used
    // to be write-then-check, so refusing an empty scope still left that empty
    // policy stored and pushed to the helper: the panel said "No tabs matched
    // that scope" while the helper was already enforcing an empty list, and the
    // refusal had changed the machine. Nothing is persisted now until the policy
    // is one that can be enforced.
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
        // A query that throws covers nothing, which is the branch below.
      }
    }
    if (scope !== "global" && !tabIds.length) {
      return { ok: false, error: "No tabs matched that scope — nothing was changed.", state: await cacheState() };
    }
    // The browser-wide switch is set from the SCOPE, not only when the scope is
    // global: leaving it off would silently apply a global "off" to every tab
    // while the panel described a per-tab policy. See globalSwitchFor.
    if (sw) {
      try {
        await sw.get(globalSwitchFor(scope, mode));
      } catch (e) {
        // "off everywhere" is the one case where the switch IS the policy, so a
        // refusal there is a failed apply rather than something to report later.
        if (scope === "global" && mode === "off") {
          return { ok: false, error: "Firefox refused the cache switch." };
        }
        // Otherwise the helper still enforces the chosen scope; the note that
        // comes back says the browser-wide switch is still off rather than
        // implying the apply did everything it promised.
      }
    }
    if (scope === "global") {
      // "fresh" (and leaving "off") needs the revalidate pref, which only the
      // chrome helper can set. Push it; if the helper is down "fresh" degrades
      // to "normal" and the note that comes back says so.
      deps.requestChrome("cacheGlobal", mode);
    }
    const pol: CachePolicy = { scope: scope, mode: mode, tabIds: tabIds };
    await writePolicy(pol);
    await pushToChrome(pol);
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
