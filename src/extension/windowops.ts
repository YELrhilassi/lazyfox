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

import { getActiveTab, realTabsInWindow } from "./tabs";
import { reconcileStealth, stealthContainers } from "./stealth";

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

// Per-window most-recently-activated tab, so `;a` can toggle between the
// current tab and the one active before it. Fed by the background's
// tabs.onActivated listener (any activation — chrome helper or content).
const lastActivated = new Map<number, number>();
const prevActivated = new Map<number, number>();

export function noteTabActivation(windowId: number, tabId: number): void {
  if (windowId == null || tabId == null) return;
  const last = lastActivated.get(windowId);
  if (last != null && last !== tabId) prevActivated.set(windowId, last);
  lastActivated.set(windowId, tabId);
}

export function forgetTab(windowId: number, tabId: number): void {
  if (prevActivated.get(windowId) === tabId) prevActivated.delete(windowId);
  if (lastActivated.get(windowId) === tabId) lastActivated.delete(windowId);
}

export async function alternateTab(): Promise<{ ok: boolean }> {
  const active = await getActiveTab();
  if (!active || active.id == null) return { ok: false };
  const target = prevActivated.get(active.windowId);
  if (target == null || target === active.id) return { ok: false };
  try {
    const t = await browser.tabs.get(target);
    if (!t || t.windowId !== active.windowId) {
      prevActivated.delete(active.windowId);
      return { ok: false };
    }
    await browser.tabs.update(target, { active: true });
    await browser.windows.update(active.windowId, { focused: true });
    return { ok: true };
  } catch (e) {
    prevActivated.delete(active.windowId);
    return { ok: false };
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
  return {
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