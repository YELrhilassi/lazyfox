// The recently-closed list: rows for the `;V` recovery popup, and the two
// session-restore actions behind them.
//
// This is the *browsing* half of tab recovery; reopentab.ts is the *undo* half.
// They are separate because they answer different questions: this one asks
// Firefox what it has, that one asks what Lazyfox itself just closed.

import { isRelayTabUrl } from "../shared/transient";
import type { PopupItem } from "../shared/types";

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