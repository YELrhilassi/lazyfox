// Window and tab operations reachable from the leader keys: resize/move/
// maximize/zen the window, activate/zoom/mute/reopen tabs, and produce the tab
// list for the tab-switcher popup.
//
// This is the geometry-and-strip module. The two recovery flows it used to
// carry now live beside it and are re-exported from the bottom, so every
// existing importer keeps one obvious import site:
//
//   closedtabs.ts   Firefox's recently-closed list, for the `;V` popup
//   reopentab.ts    the verified `;v` undo chain, and what it remembers
//
// They are separate modules rather than private functions here because each has
// a long correctness argument (see reopentab.ts) that must be readable without
// the window-management code around it.

import { getActiveTab, isUITab, omittedTabsInWindow, realTabsInWindow } from "./tabs";
import { reconcileStealth, stealthContainers } from "./stealth";
import {
  ALT_MRU_MAX,
  alternateCandidates,
  forgetTab as forgetTabEntry,
  mergeMru,
  noteActivation,
} from "../shared/alttab";

// Re-exported, not re-implemented: these are part of the leader key surface,
// and an importer that reaches for `reopenTab` should not have to know which
// of three files it landed in.
export {
  recentlyClosed,
  restoreAllClosedTabs,
  restoreClosedTab
} from "./closedtabs";
export {
  noteClosedTab,
  noteKnownTab,
  noteTabRemoved,
  primeKnownTabs,
  reopenTab,
  type ClosedTab
} from "./reopentab";

/* ---------- alternate-tab (last used tab) ---------- */

// Per-window most-recently-used tab list, so `;a` can toggle between the
// current tab and the one active before it. Fed by the background's
// tabs.onActivated listener (any activation — chrome helper or content).
//
// A LIST, not the pair of ids this used to be: the pair could only answer one
// toggle, and it went permanently silent the moment its remembered partner was
// closed (`tabs.get` rejected, the entry was dropped, and nothing re-armed it
// until the user activated a tab again). See shared/alttab.ts — the rule is
// pure and unit-tested there, because a silent no-op is invisible in a browser.
const mruByWindow = new Map<number, number[]>();

// THE LIST IS MIRRORED INTO storage.session, and the reason is the lifetime of
// an MV3 background. Firefox runs it as an EVENT PAGE: it is suspended when it
// goes idle, and a suspended page loses everything it held in memory. `;a` is a
// TOGGLE, so losing the list between its two presses produces exactly the report
// "away works, back does nothing": the second press wakes a fresh background
// whose list holds only the tab it is standing on (primeActivation), so there is
// nowhere to go and the answer is a silent no-op.
//
// storage.session is the right lifetime, not storage.local: it survives a
// background suspension AND is cleared when the browser exits, which is the
// lifetime TAB IDS have. A persisted id from a previous browser session is a
// different tab; restoring one would make `;a` jump to a stranger.
const MRU_STORE = "lf.alttab.mru";
// Coalesce the writes: a session restore activates tabs in a burst, and the
// list's whole value is available without waiting for a write to land.
let mruWriteTimer: ReturnType<typeof setTimeout> | null = null;

function persistMru(): void {
  if (mruWriteTimer) return;
  mruWriteTimer = setTimeout(() => {
    mruWriteTimer = null;
    try {
      const session = (browser.storage as any)?.session;
      if (!session || typeof session.set !== "function") return;
      const value: Record<string, number[]> = {};
      for (const [windowId, ids] of mruByWindow) {
        if (ids.length) value[String(windowId)] = ids.slice(0, ALT_MRU_MAX);
      }
      void Promise.resolve(session.set({ [MRU_STORE]: value })).catch(() => {});
    } catch (e) {
      // Older Gecko without storage.session: the list lives in memory only,
      // which is the behaviour every version had before this.
    }
  }, 250);
  // Never keep the event page alive for a write.
  try {
    (mruWriteTimer as any).unref?.();
  } catch (e) {
    // ignore
  }
}

export function noteTabActivation(windowId: number, tabId: number): void {
  if (windowId == null || tabId == null) return;
  mruByWindow.set(windowId, noteActivation(mruByWindow.get(windowId) || [], tabId));
  persistMru();
}

export function forgetTab(windowId: number, tabId: number): void {
  if (windowId == null || tabId == null) return;
  const cur = mruByWindow.get(windowId);
  if (!cur) return;
  mruByWindow.set(windowId, forgetTabEntry(cur, tabId));
  persistMru();
}

/**
 * Rehydrate the per-window lists from storage.session.
 *
 * MERGED, not replaced: a live activation may already have been recorded while
 * the read was in flight, and it is newer than anything on disk. `mergeMru`
 * keeps the live order and appends only what it does not have, so this cannot
 * demote the tab the user is actually on.
 *
 * A no-op wherever storage.session does not exist — which is better than a
 * throw, because the caller is startup code that must not fail for a key.
 */
export async function restoreAlternateTabs(): Promise<void> {
  try {
    const session = (browser.storage as any)?.session;
    if (!session || typeof session.get !== "function") return;
    const got = await session.get(MRU_STORE);
    const raw = got && got[MRU_STORE];
    if (!raw || typeof raw !== "object") return;
    for (const key of Object.keys(raw)) {
      const windowId = Number(key);
      const ids = raw[key];
      if (!isFinite(windowId) || !Array.isArray(ids)) continue;
      const clean = ids.filter((id: unknown) => typeof id === "number" && id > 0);
      if (!clean.length) continue;
      mruByWindow.set(windowId, mergeMru(mruByWindow.get(windowId) || [], clean));
    }
  } catch (e) {
    // No storage.session, or a hostile value: keep whatever memory holds.
  }
}

// The toggle is a WALK down the list, not a single lookup.
//
// It used to ask the list for one id and then try that id once: if the partner
// had been closed (or had been a plumbing tab, see isUITab), the answer was a
// silent {ok:false} — nothing moved, nothing was said — even though the list
// still held live tabs right behind it. From the user's side that is `;a`
// "working once and then not coming back".
//
// So every candidate is checked, dead ids are dropped on the way, and the first
// REAL tab in the window wins. Plumbing (the relay page, the split-panel
// companion, an `#lfc=` carrier) is skipped rather than forgotten: it is a
// legitimate activation, just not a place the user can be "on".
export async function alternateTab(): Promise<{ ok: boolean }> {
  const active = await getActiveTab();
  if (!active || active.id == null) return { ok: false };
  const windowId = active.windowId;
  for (const target of alternateCandidates(mruByWindow.get(windowId) || [], active.id)) {
    let t: any = null;
    try {
      t = await browser.tabs.get(target);
    } catch (e) {
      t = null;
    }
    if (!t || t.windowId !== windowId) {
      forgetTab(windowId, target);
      continue;
    }
    if (isUITab(t)) continue;
    try {
      await browser.tabs.update(target, { active: true });
      await browser.windows.update(windowId, { focused: true });
      return { ok: true };
    } catch (e) {
      forgetTab(windowId, target);
      return { ok: false };
    }
  }
  // Nowhere left to go: a genuinely silent answer, not a wrong tab.
  return { ok: false };
}

/**
 * Seed one entry per window from the tabs that are active right now.
 *
 * Not a fix for the first press after a cold start (nothing anywhere knows
 * which tab preceded the current one — that fact died with the previous
 * process), but it keeps the map non-empty for every window that exists, so a
 * window that has never seen an activation still has an entry the first time
 * one is needed. Called once, at background load.
 */
export async function primeActivation(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ active: true });
    for (const t of tabs as Array<{ id?: number; windowId?: number }>) {
      if (t && t.id != null && t.windowId != null) noteTabActivation(t.windowId, t.id);
    }
  } catch {
    // The list is built from the first activation instead.
  }
}

/* ---------- history deletion ---------- */

export async function removeHistory(url: string): Promise<{ ok: boolean }> {
  if (!url) return { ok: false };
  try {
    await browser.history.deleteUrl({ url });
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

export async function clearHistory(): Promise<{ ok: boolean }> {
  try {
    await browser.history.deleteAll();
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

/* ---------- window geometry ---------- */

export async function getWindowSize() {
  const win = await browser.windows.getCurrent();
  return {
    width: win.width,
    height: win.height,
    state: win.state,
    top: win.top,
    left: win.left
  };
}

export async function resizeWindow(dx: number, dy: number) {
  const win = await browser.windows.getCurrent();
  const w = Math.max(420, (win.width || 1200) + (dx || 0));
  const h = Math.max(300, (win.height || 800) + (dy || 0));
  const up = await browser.windows.update(win.id, { width: w, height: h });
  return { width: up.width, height: up.height, state: up.state };
}

export async function moveWindow(dx: number, dy: number) {
  const win = await browser.windows.getCurrent();
  if (win.state === "maximized" || win.state === "fullscreen") {
    return {
      left: win.left,
      top: win.top,
      state: win.state,
      note: win.state + " — Esc to leave move mode"
    };
  }
  const left = Math.round((win.left || 0) + (dx || 0));
  const top = Math.round((win.top || 0) + (dy || 0));
  const up = await browser.windows.update(win.id, { left: left, top: top });
  return { left: up.left, top: up.top, state: up.state };
}

export async function toggleMaximize() {
  const win = await browser.windows.getCurrent();
  const isMax = win.state === "maximized";
  const up = await browser.windows.update(win.id, {
    state: isMax ? "normal" : "maximized"
  });
  return { maximized: !isMax, state: up.state };
}

export async function toggleZen() {
  const win = await browser.windows.getCurrent();
  const isZen = win.state === "fullscreen";
  await browser.windows.update(win.id, {
    state: isZen ? "normal" : "fullscreen"
  });
  return { zen: !isZen };
}

/* ---------- the tab strip ---------- */

export async function activateTabByIndex(n: number) {
  const tabs = await realTabsInWindow();
  const idx = Math.max(0, (n || 1) - 1);
  const tab = tabs[Math.min(idx, tabs.length - 1)];
  if (!tab) return { ok: false };
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  return { ok: true, title: tab.title || "" };
}

export async function tabsInWindow() {
  await reconcileStealth();
  const tabs = await realTabsInWindow();
  // What the list left out, and why (see omittedTabsInWindow): the popup
  // ignores it, and a reader comparing two counts stops having to guess which
  // tab is missing.
  const omitted = await omittedTabsInWindow();
  return {
    omitted,
    tabs: tabs.map((t: any) => ({
      id: t.id,
      title: t.title || t.url || "about:blank",
      url: t.url || "",
      active: t.active,
      pinned: t.pinned,
      muted: t.mutedInfo && t.mutedInfo.muted,
      favIconUrl: t.favIconUrl || "",
      stealth: stealthContainers.has(t.cookieStoreId)
    }))
  };
}

/* ---------- per-tab state ---------- */

export async function zoom(delta: number, factor: number | undefined) {
  const tab = await getActiveTab();
  if (!tab || tab.id === browser.tabs.TAB_ID_NONE) return { factor: 1 };
  let f: number | null = factor != null ? factor : null;
  if (f == null) {
    f = Math.max(0.3, Math.min(5, Math.round(((await browser.tabs.getZoom(tab.id)) + delta) * 100) / 100));
  }
  await browser.tabs.setZoom(tab.id, f);
  return { factor: f };
}

export async function toggleMute() {
  const tab = await getActiveTab();
  if (!tab) return { muted: false };
  const muted = !(tab.mutedInfo && tab.mutedInfo.muted);
  await browser.tabs.update(tab.id, { muted });
  return { muted };
}