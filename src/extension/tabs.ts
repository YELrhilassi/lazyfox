// Shared tab/window helpers for the background's feature modules.
//
// Deliberately dependency-free (only the `browser` global) so every module can
// import it without creating an import cycle. Constants and one-line queries
// that would otherwise be duplicated across search, sessions, stealth and the
// message router live here.

import { isRelayTabUrl } from "../shared/transient";

export const CC_URL = browser.runtime.getURL("commandcenter.html");

/**
 * The DEFAULT window, for callers with no better answer: the one the background
 * context considers current. It is only the right window when nobody told us
 * which one the request came from.
 */
export async function getActiveTab(): Promise<any> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

/**
 * The tab a message came FROM, when the sender is a tab.
 *
 * `currentWindow` is not the answer to "which window is the user in". With one
 * window the two agree by luck; the moment a session holds several windows — or
 * a stale one is left open mid-restore — the background's notion of "current"
 * drifts to whichever window IT last touched, and every action that acts on
 * "the active tab" (back/forward, the tab list, zoom, mute, splits) is applied
 * there instead. What the user sees is a keystroke landing on a tab in ANOTHER
 * session: the reported ";g / ;l switches to a tab in some other session".
 *
 * A message that carries a sender tab names its window exactly, so it is the
 * one authority every one of those actions uses now (see getActiveTabFor).
 */
export function senderTab(sender: unknown): any | null {
  const t = (sender as { tab?: any } | undefined)?.tab;
  return t && typeof t === "object" && t.id != null ? t : null;
}

/** The window a request came from, or null when the sender is not a tab. */
export function senderWindowId(sender: unknown): number | null {
  const t = senderTab(sender);
  return t && typeof t.windowId === "number" ? t.windowId : null;
}

/**
 * The tab an action should act on: the SENDER'S OWN TAB when the request came
 * from a tab, otherwise the focused window's active tab (the chrome-helper
 * relay path, which has no tab sender).
 */
export async function getActiveTabFor(sender: unknown): Promise<any> {
  const t = senderTab(sender);
  if (t) return t;
  return getActiveTab();
}

/** The active tab of a NAMED window, or of the default window for null. */
export async function activeTabInWindow(winId: number | null): Promise<any> {
  if (winId == null) return getActiveTab();
  const tabs = await browser.tabs.query({ windowId: winId, active: true }).catch(() => []);
  return (tabs && tabs[0]) || null;
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

// The user-visible tabs of a NAMED window, in strip order. Null means the
// default window (the focused one), which is what every pre-sender caller wants.
export async function realTabsIn(winId: number | null): Promise<any[]> {
  const tabs = await browser.tabs.query(winId == null ? { currentWindow: true } : { windowId: winId });
  return (tabs || []).filter(
    (t: any) => !isUITab(t) && !isPendingRelayTab(t)
  );
}

// The user-visible tabs in the current window, in strip order.
export async function realTabsInWindow(): Promise<any[]> {
  return realTabsIn(null);
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
  return omittedTabsIn(null);
}

/** The rows realTabsIn(winId) leaves out, with the reason. */
export async function omittedTabsIn(
  winId: number | null
): Promise<{ id: number; url: string; why: string }[]> {
  const tabs = await browser.tabs.query(winId == null ? { currentWindow: true } : { windowId: winId });
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
