// Window and tab operations reachable from the leader keys: resize/move/
// maximize/zen the window, activate/zoom/mute/reopen tabs, and produce the tab
// list for the tab-switcher popup.

import { getActiveTab, realTabsInWindow } from "./tabs";
import { reconcileStealth, stealthContainers } from "./stealth";
import { isRelayTabUrl } from "../shared/transient";
import type { PopupItem } from "../shared/types";

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

/* ---------- recently closed tabs + windows ---------- */

// The browser's recently-closed list (tabs AND whole windows) as popup rows.
// `key` is the sessionId the sessions.restore API needs; `tabCount` tells the
// popup how many tabs a closed window held. Time comes from lastModified.
export async function recentlyClosed(): Promise<PopupItem[]> {
  try {
    const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
    const out: PopupItem[] = [];
    for (const item of closed) {
      if (!item) continue;
      if (item.tab) {
        const t = item.tab;
        // Skip Lazyfox's own throwaway #lfc= relay tabs: they churn in and
        // out constantly and must never appear as "recently closed" pages.
        if (isRelayTabUrl(t.url)) continue;
        out.push({
          kind: "tab",
          key: t.sessionId || "",
          title: t.title || t.url || "",
          url: t.url || "",
          tabCount: 1,
          time: item.lastModified || 0
        });
      } else if (item.window && item.window.tabs && item.window.tabs.length) {
        const tabs = item.window.tabs;
        const head = tabs.find((t: any) => t.active) || tabs[0];
        out.push({
          kind: "window",
          key: item.window.sessionId || "",
          title: (head && (head.title || head.url)) || "Window",
          url: "",
          tabCount: tabs.length,
          time: item.lastModified || 0
        });
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

export async function restoreClosedTab(key: string): Promise<{ ok: boolean }> {
  if (!key) return { ok: false };
  try {
    await browser.sessions.restore(key);
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

export async function restoreAllClosedTabs(): Promise<{ ok: boolean; count?: number }> {
  try {
    const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
    const items = closed.filter(
      (c: any) =>
        c &&
        ((c.tab && !isRelayTabUrl(c.tab.url)) ||
          (c.window && c.window.tabs && c.window.tabs.length))
    );
    // Restore oldest-first so everything comes back in its original order.
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        const sid = items[i]!.tab ? items[i]!.tab.sessionId : items[i]!.window.sessionId;
        await browser.sessions.restore(sid);
      } catch (e) {
        // one failure must not stop the rest
      }
    }
    return { ok: true, count: items.length };
  } catch (e) {
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
      note: win.state + " \u2014 Esc to leave move mode"
    };
  }
  const left = Math.round((win.left || 0) + (dx || 0));
  const top = Math.round((win.top || 0) + (dy || 0));
  const up = await browser.windows.update(win.id, { left: left, top: top });
  return { left: up.left, top: up.top, state: up.state };
}

export async function activateTabByIndex(n: number) {
  const tabs = await realTabsInWindow();
  const idx = Math.max(0, (n || 1) - 1);
  const tab = tabs[Math.min(idx, tabs.length - 1)];
  if (!tab) return { ok: false };
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  return { ok: true, title: tab.title || "" };
}

export async function toggleMaximize() {
  const win = await browser.windows.getCurrent();
  const isMax = win.state === "maximized";
  const up = await browser.windows.update(win.id, {
    state: isMax ? "normal" : "maximized"
  });
  return { maximized: !isMax, state: up.state };
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

export async function toggleZen() {
  const win = await browser.windows.getCurrent();
  const isZen = win.state === "fullscreen";
  await browser.windows.update(win.id, {
    state: isZen ? "normal" : "fullscreen"
  });
  return { zen: !isZen };
}

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

export async function reopenTab() {
  const closed = await browser.sessions.getRecentlyClosed({
    maxResults: 10
  });
  for (const item of closed) {
    if (item.tab) {
      await browser.sessions.restore(item.tab.sessionId);
      return { ok: true };
    }
  }
  return { ok: false };
}
