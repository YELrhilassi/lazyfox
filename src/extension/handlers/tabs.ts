// Tab-strip actions: query, activate, move, close, open, reload and navigate.
//
// The largest domain, and the one that reaches the furthest — it reads the tab
// list, and two of its actions (alternateTab, reopenTab) go through the
// background's FILTERED reopen rather than Firefox's own undo stack, because
// SessionStore's "most recently closed" is usually one of the extension's own
// hidden plumbing tabs.
import { CC_URL, getActiveTab, realTabsInWindow } from "../tabs";
import { activateTabByIndex, tabsInWindow } from "../windowops";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "tabs" | "activateTab" | "activateTabAt" | "moveTab" | "moveActiveTab" | "closeTab" | "newTab" | "duplicateTab" | "reload" | "back" | "forward" | "copyUrl" | "reopenTab" | "alternateTab";

export interface TabDeps {
  // The filtered reopen: skips the relay tab and the splitpanel companion, so
  // ";v" restores a page the user actually closed rather than a hidden tab.
  // It reports only whether it restored something — the tab's own identity is
  // not part of the answer, and callers that need it ask for recentlyClosed.
  reopenTab(): Promise<{ ok: boolean }>;
  // Remember/recall the previously-active tab, so ;a can toggle back to it.
  alternateTab(): Promise<{ ok: boolean }>;
}

export function createTabHandlers(deps: TabDeps): Domain<Owns> {
  return {
    tabs: () => tabsInWindow(),

    activateTab: async (data) => {
      await browser.tabs.update(data.id, { active: true });
      await browser.windows.update((await getActiveTab()).windowId, {
        focused: true,
      });
      return { ok: true };
    },

    activateTabAt: async (data) => {
      if (data.last) {
        const tabs = await realTabsInWindow();
        const t = tabs[tabs.length - 1];
        if (!t) return { ok: false };
        await browser.tabs.update(t.id, { active: true });
        await browser.windows.update(t.windowId, { focused: true });
        return { ok: true };
      }
      return activateTabByIndex(data.index || 1);
    },

    moveTab: async (data) => {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const idx = tabs.findIndex((t: { id?: number }) => t.id === data.id);
      if (idx < 0) return { ok: false };
      const dir = data.dir > 0 ? 1 : -1;
      const ni = Math.max(0, Math.min(tabs.length - 1, idx + dir));
      if (ni !== idx) await browser.tabs.move(data.id, { index: ni });
      return { ok: true };
    },

    moveActiveTab: async (data) => {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const idx = tabs.findIndex((t: { active?: boolean }) => t.active);
      if (idx < 0) return { ok: false };
      const dir = data.dir > 0 ? 1 : -1;
      const ni = Math.max(0, Math.min(tabs.length - 1, idx + dir));
      if (ni !== idx) await browser.tabs.move(tabs[idx]!.id, { index: ni });
      return { ok: true };
    },

    closeTab: async (data) => {
      // Removing the window's LAST tab closes the whole window (and Firefox, if
      // it's the only window). Guard it: report `last` so callers can ask for
      // confirmation, and only actually close on a second press (force).
      const targetId = data.id != null ? data.id : (await getActiveTab())?.id;
      const tabs = await realTabsInWindow();
      const isLast = tabs.length <= 1 && targetId != null && tabs[0] && tabs[0].id === targetId;
      if (isLast && !data.force) {
        return { ok: true, last: true };
      }
      if (targetId != null) await browser.tabs.remove(targetId);
      return { ok: true, last: false };
    },

    newTab: async () => {
      // A new tab is the command center, never a stray about:blank.
      await browser.tabs.create({ url: CC_URL, active: true });
      return { ok: true };
    },

    duplicateTab: async () => {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.duplicate(tab.id);
      return { ok: true };
    },

    reload: async () => {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.reload(tab.id);
      return { ok: true };
    },

    back: async () => {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.goBack(tab.id);
      return { ok: true };
    },

    forward: async () => {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.goForward(tab.id);
      return { ok: true };
    },

    copyUrl: async () => {
      const tab = await getActiveTab();
      if (!tab) return { url: "", title: "" };
      return { url: tab.url || "", title: tab.title || "" };
    },

    reopenTab: () => deps.reopenTab(),
    alternateTab: () => deps.alternateTab(),
  };
}
