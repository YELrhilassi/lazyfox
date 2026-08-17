// Shared tab/window helpers for the background's feature modules.
//
// Deliberately dependency-free (only the `browser` global) so every module can
// import it without creating an import cycle. Constants and one-line queries
// that would otherwise be duplicated across search, sessions, stealth and the
// message router live here.

export const CC_URL = browser.runtime.getURL("commandcenter.html");

export async function getActiveTab(): Promise<any> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

// Transient UI tabs (the split-panel companion and the #lfc= request channel)
// are not user tabs: numbering (tab switcher, ;1-9, ;+N, the status bar) skips
// them so a tab's identity never shifts when a split/unsplit adds or removes a
// companion pane.
export function isUITab(t: any): boolean {
  const u = (t && t.url) || "";
  return u.indexOf("splitpanel.html") !== -1 || u.indexOf("#lfc=") !== -1;
}

// The user-visible tabs in the current window, in strip order.
export async function realTabsInWindow(): Promise<any[]> {
  const tabs = await browser.tabs.query({ currentWindow: true });
  return (tabs || []).filter((t: any) => !isUITab(t));
}

export function isCommandCenter(tab: any): boolean {
  return !!(tab && tab.url && tab.url.indexOf(CC_URL) === 0);
}

export function stripHash(url: string): string {
  const i = url ? url.indexOf("#") : -1;
  return i < 0 ? url : url.slice(0, i);
}
