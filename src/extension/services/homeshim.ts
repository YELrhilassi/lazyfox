// Home-tab conversion: turn Firefox's native home/newtab placeholders into
// the Lazyfox command center.
//
// The command center for user-opened tabs comes from
// chrome_url_overrides.newtab (the stable manifest mechanism). This service
// only mops up the cases the manifest cannot cover:
//
//   - a native home/newtab tab still sitting there after startup, and
//   - the launch tab left on about:blank by a profile whose startup page is
//     blank.
//
// about:blank is deliberately excluded from the mid-session conversion: a
// blank tab mid-session is a transient placeholder for an in-flight
// navigation (target=_blank, ;o, a search-results tab), and converting it
// hijacks that navigation. The launch-tab case is told apart by WHEN and
// WHERE the blank tab sits: it runs once at startup, and converts only when
// the window has exactly one real tab that is still blank and idle after
// native startup restore has had time to settle.

import { CC_URL, isUITab } from "../tabs";
import { isRestoring } from "../sessions";

// Only idle placeholders that can never be mid-navigation are converted.
const HOMEISH = /^about:(home|newtab)$/i;

// True while a tab is loading or already navigating somewhere. Converting
// such a tab would hijack the in-flight navigation.
function isNavigating(t: any): boolean {
  if (!t) return true;
  if (t.status === "loading") return true;
  return !!(t.pendingUrl && t.pendingUrl !== t.url);
}

export function maybeConvertHome(tab: any): Promise<void> {
  if (isRestoring()) return Promise.resolve();
  if (!tab || !tab.id || !tab.url || !HOMEISH.test(tab.url)) return Promise.resolve();
  if (isNavigating(tab)) return Promise.resolve();
  // Defer and re-check: a tab's pendingUrl can appear a beat AFTER the tab
  // itself (a link click starts its navigation slightly later), so an
  // immediate conversion can still race it. After the delay the tab is
  // converted only if it is STILL an idle home/newtab placeholder.
  const id = tab.id;
  setTimeout(() => {
    browser.tabs
      .get(id)
      .then((t: any) => {
        if (!t || !t.url || !HOMEISH.test(t.url) || isNavigating(t)) return;
        return browser.tabs.update(id, { url: CC_URL });
      })
      .catch(() => {});
  }, 800);
  return Promise.resolve();
}

function maybeConvertStartupBlank(): void {
  const started = Date.now();
  let done = false;
  const tick = () => {
    if (done || Date.now() - started > 12000) return;
    // Never fight a session-restore rebuild in progress.
    if (isRestoring()) {
      setTimeout(tick, 700);
      return;
    }
    browser.tabs
      .query({ currentWindow: true })
      .then((tabs: any[]) => {
        const real = (tabs || []).filter((t: any) => !isUITab(t));
        const tab = real.length === 1 ? real[0] : null;
        if (!tab || !tab.active) {
          // Window not settled yet (or extra tabs appeared): keep waiting only
          // while there is still a chance this is the untouched home tab.
          setTimeout(tick, 700);
          return;
        }
        // It left blank (navigated somewhere, or a restore/conversion landed):
        // nothing to do, and re-checking would only risk a later hijack.
        if (tab.url !== "about:blank" || isNavigating(tab)) return;
        done = true;
        browser.tabs.update(tab.id, { url: CC_URL }).catch(() => {});
      })
      .catch(() => setTimeout(tick, 700));
  };
  // Give native startup restore (if enabled) time to put real tabs in place
  // before we decide the sole blank tab is genuinely the home tab.
  setTimeout(tick, 1000);
}

// On a real browser launch the background starts with the first window already
// open; run the check then and again on startup events (install/reload of the
// add-on mid-session is harmless — the window has real tabs, so nothing
// converts).
export function watchHomeTabs(): void {
  maybeConvertStartupBlank();
  browser.runtime.onStartup.addListener(() => {
    maybeConvertStartupBlank();
  });
  browser.tabs.onUpdated.addListener((_tabId: number, info: any, tab: any) => {
    if (isRestoring()) return;
    if (info.status === "complete" && tab && tab.active) maybeConvertHome(tab);
  });
  browser.tabs.onActivated.addListener((info: any) => {
    if (isRestoring()) return;
    browser.tabs
      .get(info.tabId)
      .then((tab: any) => maybeConvertHome(tab))
      .catch(() => {});
  });
  browser.tabs
    .query({})
    .then((tabs: any[]) => {
      for (const t of tabs || []) {
        if (t.active) maybeConvertHome(t);
      }
    })
    .catch(() => {});
}
