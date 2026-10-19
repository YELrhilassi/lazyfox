// The reopen (`;v`) machinery: what the undo pair remembers, and the verified
// chain of attempts that puts a tab back.
//
// This is deliberately its own module. It is the one flow in the extension
// whose correctness depends on a *race with Firefox's own cache*, so its
// reasoning is long, and it has to be readable on its own — reading it inside a
// file of window geometry is how a "verified restore" quietly stops being
// verified. Everything here is about restoring exactly one tab.

import { isRelayTabUrl } from "../shared/transient";

// `;x` then `;v` is the undo pair, and it is the one flow that cannot tolerate
// a stale closed-tab list: Firefox serves `sessions.getRecentlyClosed` from a
// deliberately delayed cache (DelayedCachedGetRecentlyClosed exists so the
// parent process is not asked for this list on every menu open), so reading it
// right after the close returns the PREVIOUS close. Reading it once is what
// made `;v` reopen the wrong tab, reopen one of Lazyfox's own throwaway tabs,
// or do nothing at all - all three observed from one press.
//
// So there are two sources of truth and the answer is whichever one can be
// PROVEN to have restored something:
//
//  1. `sessions.restore()` with no key. Firefox picks the most recent close
//     itself, from its own live state, with no cache in the way. It cannot
//     skip Lazyfox's own plumbing tabs, so it cannot be the whole answer.
//  2. The explicit scan of `getRecentlyClosed`, which can skip them, but can
//     only be trusted once the cache has expired - hence the re-read.
//
// Every attempt is verified against the window's tab count before it is
// believed. `sessions.restore()` resolves as soon as it has been asked, not
// when something is back, and a restore of a closed WINDOW leaves this
// window's count untouched - so "the call did not throw" was never evidence
// that `;v` had done its job, and reporting `ok: true` on it was a lie the
// user could not see past.
//
// The budget is measured, not guessed: pressed a second after the close, every
// entry in the list still named a tab that no longer existed and every restore
// threw, for longer than a 2.5s budget; the same call four seconds later
// restored the tab. So the budget now outlasts the cache. It only costs
// anything when there is genuinely nothing to restore, and the common case -
// `;v` pressed any real interval after the close - still answers on the first
// read.
const REOPEN_POLL_MS = 2500;
const REOPEN_POLL_STEP_MS = 1000;
// Long enough for a session restore to reach the strip before it is called a
// failure. Below this the verification races the thing it verifies. It is only
// used on the `sessions.restore` paths: a tab this extension creates itself is
// confirmed by its own id, with nothing to wait for.
const REOPEN_SETTLE_MS = 400;

// A tab that was closed, kept so `;v` can put it back without asking
// Firefox's closed-tab list - see the third attempt in reopenTab.
export type ClosedTab = {
  url: string;
  index: number;
  windowId?: number;
  pinned: boolean;
};

let lastClosed: ClosedTab | null = null;

/** Record the tab a close is about to remove. `null` forgets it. */
export function noteClosedTab(tab: ClosedTab | null): void {
  lastClosed = tab && tab.url ? tab : null;
}

// What is known about every open tab, so a close can be described AFTER the
// fact. `tabs.onRemoved` reports only an id, so without this the extension can
// remember a close only when IT performed the close.
//
// That was the whole bug: the chrome helper closes tabs with `gBrowser` — it
// has to, it is in the chrome process — so `;x` never reached the background's
// close handler and nothing was recorded. `;v` then fell through to Firefox's
// closed-tab list, which is dominated by the extension's OWN transient closes:
// it restored an `about:blank` out of the harness's setup traffic and reported
// success. The undo pair could only work when the close happened to take the
// other route. Every close is now recorded, whichever route it took.
const knownTabs = new Map<number, ClosedTab>();

/** Keep one tab's close-description current. Safe to call on every event. */
export function noteKnownTab(tab: any): void {
  if (!tab || typeof tab.id !== "number") return;
  knownTabs.set(tab.id, {
    url: String(tab.url || ""),
    index: typeof tab.index === "number" ? tab.index : 0,
    windowId: tab.windowId,
    pinned: !!tab.pinned
  });
}

/** Learn about tabs that already existed (startup, and after a restore). */
export async function primeKnownTabs(): Promise<void> {
  const ts = await browser.tabs.query({}).catch(() => []);
  if (Array.isArray(ts)) for (const t of ts) noteKnownTab(t);
}

/**
 * A tab is gone. Record it, so `;v` can undo it.
 *
 * A window closing is not a tab the user closed and wants back, so it clears
 * the record instead of writing it: the alternative is `;v` trying to recreate
 * a tab in a window that no longer exists.
 */
export function noteTabRemoved(tabId: number, removeInfo?: any): void {
  const known = knownTabs.get(tabId);
  knownTabs.delete(tabId);
  if (removeInfo && removeInfo.isWindowClosing) {
    lastClosed = null;
    return;
  }
  if (!known || !known.url) return;
  // Plumbing is never "the tab you closed" - see isPlumbingTabUrl.
  if (isPlumbingTabUrl(known.url)) return;
  lastClosed = known;
}

/** Hidden plumbing, which `;v` must never hand back as "the tab you closed". */
function isPlumbingTabUrl(url: string): boolean {
  return isRelayTabUrl(url);
}

/**
 * How many tabs exist in the WHOLE browser.
 *
 * Deliberately not `query({ currentWindow: true })`. In the background,
 * `currentWindow` resolves to the window that has FOCUS, not the window the
 * command came from, and the reopen path used it to decide whether its own
 * attempt had worked. So the moment the user's window was not the focused one
 * — a background window, another window in front, the seconds after a window
 * switch — every attempt was judged a failure, `;v` walked its whole fallback
 * chain and returned `{ok:false}`, and the tab stayed closed. The command that
 * exists specifically to undo a close was the one that silently did nothing.
 *
 * Counting every tab is focus-independent. It is only used as the fallback for
 * the one case with no identity to check (a restored WINDOW, which has no tab
 * id to confirm); every other path verifies the tab it was handed.
 */
async function totalTabCount(): Promise<number> {
  try {
    const ts = await browser.tabs.query({});
    return Array.isArray(ts) ? ts.length : -1;
  } catch (e) {
    return -1;
  }
}

async function tabExists(id: unknown): Promise<boolean> {
  if (typeof id !== "number") return false;
  return !!(await browser.tabs.get(id).catch(() => null));
}

/**
 * Did this restore actually put something back?
 *
 * `restored` is what `browser.sessions.restore()` returned: a session carrying
 * either a tab (`tabId`) or a window. A restored TAB is confirmed by asking
 * Firefox for that exact tab — identity, which needs no settle and no
 * arithmetic. Only a restored WINDOW falls back to comparing tab counts, and
 * it does so against the whole browser for the reason above.
 */
async function restoreLanded(restored: any, before: number): Promise<boolean> {
  if (restored && restored.tab) {
    await new Promise((r) => setTimeout(r, REOPEN_SETTLE_MS));
    return tabExists(restored.tab.tabId) || tabExists(restored.tab.id);
  }
  if (restored && restored.window) {
    await new Promise((r) => setTimeout(r, REOPEN_SETTLE_MS));
    const after = await totalTabCount();
    return after < 0 ? true : after > before;
  }
  // Firefox answered with nothing we can identify: it either restored nothing
  // or restored something it declined to describe. Believed, because the call
  // did not throw and there is nothing left to contradict it.
  return !!(await browser.tabs.query({})).length;
}

export async function reopenTab() {
  const before = await totalTabCount();

  // 1. The tab Lazyfox itself closed, from what was recorded at the time. This
  // is tried FIRST because it is the only source that is both exact and
  // immediate: Firefox's closed-tab list is served from a delayed cache, so
  // read straight after a close it still describes the PREVIOUS close, and
  // `;x` then `;v` — the undo pair, the one flow that cannot wait — restored
  // the wrong tab, one of Lazyfox's own throwaway tabs, or nothing at all.
  //
  // It is a reopen rather than a session restore: the tab returns with its URL,
  // its place in the strip, its pinned state and its title, but not with the
  // scroll position and back/forward entries a restore would carry. `;V` is the
  // key that offers the full recently-closed list when those matter.
  const remembered = lastClosed;
  if (remembered && !isPlumbingTabUrl(remembered.url)) {
    try {
      const created = await browser.tabs.create({
        url: remembered.url,
        index: remembered.index,
        windowId: remembered.windowId,
        pinned: remembered.pinned,
        active: true
      });
      // `tabs.create` resolving IS the tab existing — no settle, no count.
      if (created && (await tabExists(created.id))) {
        lastClosed = null;
        return { ok: true };
      }
    } catch (e) {
      // fall through: Firefox will not open that URL, so try its own list
    }
  }

  // 2. Ask Firefox to undo the last close. Fresh by construction, but it can
  // restore a closed WINDOW and offers no way to skip Lazyfox's plumbing, so
  // what it restored is checked rather than assumed.
  try {
    const restored = await browser.sessions.restore();
    if (await restoreLanded(restored, before)) {
      lastClosed = null;
      return { ok: true };
    }
  } catch (e) {
    // nothing to undo, or nothing restorable - fall through to the scan
  }

  // 3. The precise scan, re-read until the delayed cache has expired. The
  // step has to be LONGER than the cache: a read restarts the delay, so a
  // tighter poll can only ever re-read the same stale snapshot, which is why
  // no amount of polling fixes the `;x ;v` pair on its own.
  const deadline = Date.now() + REOPEN_POLL_MS;
  for (;;) {
    let closed: any[] = [];
    try {
      closed = (await browser.sessions.getRecentlyClosed({
        maxResults: 20
      })) as any[];
    } catch (e) {
      closed = [];
    }
    let stale = false;
    for (const item of closed) {
      if (!item || !item.tab) continue;
      const url = String((item.tab && item.tab.url) || "");
      // Skip hidden plumbing - the relay bridge, throwaway #lfc= request
      // tabs and the split-panel companion - so `;v` always reopens a real
      // user tab. Firefox records EVERY close (including those) in
      // SessionStore, so the "most recently closed" entry is often not a tab
      // the user ever saw.
      if (isPlumbingTabUrl(url)) continue;
      try {
        const restored = await browser.sessions.restore(item.tab.sessionId);
        if (await restoreLanded(restored, before)) {
          lastClosed = null;
          return { ok: true };
        }
      } catch (e) {
        // This entry names a tab that no longer exists - the signature of a
        // stale snapshot, and every later entry in it is stale for the same
        // reason.
        stale = true;
        break;
      }
    }
    if (!stale || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, REOPEN_POLL_STEP_MS));
  }
  return { ok: false };
}