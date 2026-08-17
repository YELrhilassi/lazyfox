// Stealth tabs: real Firefox containers with an isolated cookie jar that is
// wiped when the tab closes (approximating private browsing inside one window).
//
// The container lifecycle is owned here: create on open, wipe + remove on
// close, and reconcile orphans on startup (a hard crash can leave a container
// behind; the next launch catches it). The module keeps the live membership in
// `stealthContainers`/`stealthTabs` so tab snapshots and the status bar can
// label a tab without an extra query.

import { CC_URL } from "./tabs";

const STEALTH_KEY = "lfStealth";
// cookieStoreIds WE own. A tab's cookieStoreId alone can't identify a stealth
// tab (a user's own container would look identical), so snapshot/restore test
// membership in this set.
export const stealthContainers = new Set<string>();
// Live tabId -> cookieStoreId so tabs.onRemoved wipes the right container.
const stealthTabs = new Map<number, string>();
let stealthReconcile: Promise<void> | null = null;

async function readStealth(): Promise<{ containers: string[] }> {
  try {
    const r = await browser.storage.local.get(STEALTH_KEY);
    const v = r && r[STEALTH_KEY];
    if (v && Array.isArray(v.containers)) return v as { containers: string[] };
  } catch (e) {
    // fall through
  }
  return { containers: [] };
}

async function writeStealth(st: { containers: string[] }): Promise<void> {
  await browser.storage.local.set({ [STEALTH_KEY]: st });
}

async function persistStealth(): Promise<void> {
  await writeStealth({ containers: Array.from(stealthContainers) });
}

async function wipeStealthContainer(cs: string): Promise<void> {
  stealthContainers.delete(cs);
  try {
    // Remove everything the container stored (cookies, storage, cache, ...).
    await browser.browsingData.remove({ cookieStoreId: cs, since: 0 });
  } catch (e) {
    // ignore
  }
  try {
    await browser.contextualIdentities.remove(cs);
  } catch (e) {
    // ignore
  }
}

// Rebuild the live maps from storage and wipe any container whose tab is
// already gone — the "racy cleanup" path: if Firefox quit before the close
// handler ran, the orphan is caught here on next launch.
async function doReconcileStealth(): Promise<void> {
  const st = await readStealth();
  const keep: string[] = [];
  for (const cs of st.containers || []) {
    let tabs: any[] = [];
    try {
      tabs = await browser.tabs.query({ cookieStoreId: cs });
    } catch (e) {
      tabs = [];
    }
    if (tabs.length === 0) {
      await wipeStealthContainer(cs);
    } else {
      keep.push(cs);
      stealthContainers.add(cs);
      for (const t of tabs) {
        if (t.id != null) stealthTabs.set(t.id, cs);
      }
    }
  }
  await writeStealth({ containers: keep });
}

export function reconcileStealth(): Promise<void> {
  if (!stealthReconcile) {
    stealthReconcile = doReconcileStealth().catch(() => {});
  }
  return stealthReconcile;
}

async function createStealthContainer(): Promise<string> {
  const ci = await browser.contextualIdentities.create({
    name: "Stealth",
    color: "purple",
    icon: "fingerprint"
  });
  stealthContainers.add(ci.cookieStoreId);
  return ci.cookieStoreId;
}

export async function stealthCreateTab(url: string, active: boolean): Promise<any> {
  const cs = await createStealthContainer();
  const t = await browser.tabs.create({ url, cookieStoreId: cs, active });
  if (t && t.id != null) stealthTabs.set(t.id, cs);
  await persistStealth();
  return t;
}

// Open a fresh empty stealth tab (the command center home page, which renders
// with the stealth look) rather than cloning the current page — ;N means
// "start somewhere new and isolated". `onDone` fires after the tab is created
// so the caller can push fresh session state without importing this module's
// callers (avoids an import cycle).
export async function stealthOpen(
  onDone?: () => void
): Promise<{ ok: boolean; error?: string }> {
  await reconcileStealth();
  try {
    // The contextualIdentities API only exists when the permission was granted
    // at install time. A stale install (or one updated without approving the
    // new permission) silently loses it — browser.contextualIdentities becomes
    // undefined and .create throws. Diagnose that case so the toast says what
    // to do instead of a cryptic error.
    const ci: any = (browser as any).contextualIdentities;
    if (!ci || typeof ci.create !== "function") {
      return {
        ok: false,
        error:
          "contextualIdentities permission missing — reload the extension " +
          "(about:debugging → This Firefox → Lazyfox → Reload) or reinstall " +
          "the built dist/ extension so the new permissions apply"
      };
    }
    await stealthCreateTab(CC_URL, true);
    if (onDone) onDone();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as any) && (e as any).message ? (e as any).message : e) };
  }
}

export async function removeStealthContainerForTab(tabId: number): Promise<void> {
  const cs = stealthTabs.get(tabId);
  if (!cs) return;
  stealthTabs.delete(tabId);
  await wipeStealthContainer(cs);
  await persistStealth();
}
