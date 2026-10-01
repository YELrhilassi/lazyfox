// Tab-strip actions: query, activate, move, close, open, reload and navigate.
//
// The largest domain, and the one that reaches the furthest — it reads the tab
// list, and two of its actions (alternateTab, reopenTab) go through the
// background's FILTERED reopen rather than Firefox's own undo stack, because
// SessionStore's "most recently closed" is usually one of the extension's own
// hidden plumbing tabs.
import { CC_URL, getActiveTab, realTabsInWindow } from "../tabs";
import { activateTabByIndex, tabsInWindow } from "../windowops";
import type { NavEntry } from "../../shared/types";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "tabs" | "tabCount" | "activateTab" | "activateTabAt" | "moveTab" | "moveActiveTab" | "closeTab" | "newTab" | "duplicateTab" | "reload" | "back" | "forward" | "navStack" | "navGoto" | "copyUrl" | "reopenTab" | "alternateTab";

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

    // The count only — no per-tab rows. This is on the `;1` hot path, where
    // the only question is whether the digit is a prefix of more than one tab
    // number, and building every row to answer it would be visible latency on
    // the most-used binding in the app.
    tabCount: async () => ({ count: (await realTabsInWindow()).length }),

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
      if (!tab) return { ok: false };
      const can = await browser.tabs.callPageMethod?.(tab.id, "canGoBack").catch?.(() => false) ?? true;
      if (!can) return { ok: true, atRoot: true };
      await browser.tabs.goBack(tab.id);
      return { ok: true };
    },

    forward: async () => {
      const tab = await getActiveTab();
      if (!tab) return { ok: false };
      const can = await browser.tabs.callPageMethod?.(tab.id, "canGoForward").catch?.(() => false) ?? true;
      if (!can) return { ok: true, atEnd: true };
      await browser.tabs.goForward(tab.id);
      return { ok: true };
    },

    // The active tab's navigation stack, oldest-first with the current entry
    // included. Session history is a privileged API (browser.sessionStore),
    // so this runs in the background.
    navStack: async () => {
      const tab = await getActiveTab();
      if (!tab || tab.id == null) return { canBack: false, canForward: false, index: 0, entries: [] };
      try {
        // tabSessions (Firefox's sessionStore API via sessions.getTabValue is
        // not the history); the real path is `browser.sessionStore` in older
        // APIs but today the supported surface is:
        const ss = (browser as any).sessionStore;
        if (ss && ss.getTabState) {
          const raw = ss.getTabState(tab.id);
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          const entriesRaw = parsed?.entries || [];
          const index = typeof parsed?.index === "number" ? parsed.index - 1 : Math.max(0, entriesRaw.length - 1);
          const entries: NavEntry[] = entriesRaw.map((e: any) => ({
            url: e.url || "",
            title: e.title || e.url || "",
          }));
          return {
            canBack: index > 0,
            canForward: index < entries.length - 1,
            index,
            entries,
          };
        }
      } catch {
        // fall through to the minimal answer
      }
      return {
        canBack: false,
        canForward: false,
        index: 0,
        entries: [{ url: tab.url || "", title: tab.title || tab.url || "" }],
      };
    },

    // Jump to a stack position by walking back/forward the needed steps.
    // Walking rather than a single "goto" is what Firefox's tabs API offers;
    // each step is instant from the user's perspective (bfcache).
    navGoto: async (data) => {
      const tab = await getActiveTab();
      if (!tab || tab.id == null) return { ok: false };
      // data.index is the DELTA (negative = back steps, positive = forward)
      // computed by the popup against the stack it just showed.
      const steps = Number(data.index);
      if (!isFinite(steps) || steps === 0) return { ok: true };
      try {
        if (steps < 0) {
          for (let i = 0; i < -steps; i++) await browser.tabs.goBack(tab.id);
        } else {
          for (let i = 0; i < steps; i++) await browser.tabs.goForward(tab.id);
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
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
