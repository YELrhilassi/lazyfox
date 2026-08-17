// Window and tab operations reachable from the leader keys: resize/move/
// maximize/zen the window, activate/zoom/mute/reopen tabs, and produce the tab
// list for the tab-switcher popup.

import { getActiveTab, realTabsInWindow } from "./tabs";
import { reconcileStealth, stealthContainers } from "./stealth";

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
