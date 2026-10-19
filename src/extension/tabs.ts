// Shared tab/window helpers for the background's feature modules.
//
// Deliberately dependency-free (only the `browser` global) so every module can
// import it without creating an import cycle. Constants and one-line queries
// that would otherwise be duplicated across search, sessions, stealth and the
// message router live here.

import { isRelayTabUrl } from "../shared/transient";

export const CC_URL = browser.runtime.getURL("commandcenter.html");

export async function getActiveTab(): Promise<any> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

// Transient UI tabs (the split-panel companion and the throwaway #lfc= request
// relays) are not user tabs: numbering (tab switcher, ;1-9, ;+N, the status
// bar) skips them so a tab's identity never shifts when a split/unsplit adds
// or removes a companion pane. A real tab carrying a momentary #lfc=keys/state
// request hash is NOT transient — it must keep its number.
export function isUITab(t: any): boolean {
  return isRelayTabUrl((t && t.url) || "");
}

// Tab IDs of throwaway #lfc= request relays currently being created. URL-based
// filtering (isRelayTabUrl) misses a relay tab whose URL has not been applied
// yet (about:blank during first paint), so a tab query racing the create can
// mistake one for a real user tab — and ;k/;9/;t would target it. The
// background registers every relay tab id here the moment the create resolves
// and removes it when the tab closes, so realTabsInWindow can never count one.
export const transientTabIds = new Set<number>();

// Is this tab a relay that has not committed its URL yet?
//
// The id set exists for ONE window: the moment between `tabs.create` and the
// relay URL being applied, when the tab still reports about:blank and
// URL-based filtering cannot recognise it. It must not outlive that window.
//
// It used to: the id is remembered for the life of the tab and dropped only
// when the tab closes, so a tab that later carried a REAL page stayed
// invisible to every numbering path for the rest of the session — the tab
// switcher, `;1`-`;9`, `;+` and the session writer all dropped it while the
// user could see it in the strip. Measured on the e2e suite as a permanent
// off-by-one between the product's tab list and the harness's own query (13
// against 14), with the invisible tab named in the comparison.
function isPendingRelayTab(t: any): boolean {
  if (!t || !transientTabIds.has(t.id)) return false;
  const url = (t && t.url) || "";
  // No URL yet (or the placeholder): still the create window, so still
  // plumbing. Anything else means this tab is not a relay any more.
  return url === "" || url === "about:blank";
}

// The user-visible tabs in the current window, in strip order.
export async function realTabsInWindow(): Promise<any[]> {
  const tabs = await browser.tabs.query({ currentWindow: true });
  return (tabs || []).filter(
    (t: any) => !isUITab(t) && !isPendingRelayTab(t)
  );
}

/**
 * The rows `realTabsInWindow` leaves out, with the reason — the tab list's own
 * account of what it dropped and why.
 *
 * A list that silently omits a tab is indistinguishable from a correct one
 * until someone counts, and both bugs found on the numbering path (the relay
 * id set outliving its create window, and a borrowed tab being mistaken for
 * plumbing) were found by comparing two counts and then guessing at the
 * difference. Published with the `tabs` reply, which is the one place a
 * diagnostic can sit on the hot path of a popup at no extra cost.
 */
export async function omittedTabsInWindow(): Promise<
  { id: number; url: string; why: string }[]
> {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const out: { id: number; url: string; why: string }[] = [];
  for (const t of tabs || []) {
    if (isUITab(t)) {
      out.push({ id: t.id, url: t.url || "", why: "plumbing" });
    } else if (isPendingRelayTab(t)) {
      out.push({ id: t.id, url: t.url || "", why: "relay-not-committed" });
    }
  }
  return out;
}

export function isCommandCenter(tab: any): boolean {
  return !!(tab && tab.url && tab.url.indexOf(CC_URL) === 0);
}

export function stripHash(url: string): string {
  const i = url ? url.indexOf("#") : -1;
  return i < 0 ? url : url.slice(0, i);
}
