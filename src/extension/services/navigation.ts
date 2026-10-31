// Navigation service: opening URLs, about: pages and extension UI pages.
//
// Three routes exist because Firefox treats each differently:
//
//   - openUrl: regular http(s) URLs, through the tabs API. A command-center
//     tab is reused in place; the config's openInNewTab decides new vs current
//     when the caller does not say.
//   - openPage: about: URLs, which the tabs API rejects ("Illegal URL"). These
//     ride a throwaway #lfc=open hash tab that the chrome helper answers
//     natively, so the current command-center tab never reloads.
//   - openUI: extension UI popups, routed through the same #lfc= hash channel.
import { CC_URL, activeTabInWindow, isCommandCenter, stripHash } from "../tabs";
import { getConfig } from "../config";
import { stealthContainerOf } from "../stealth";

// Named page keys USED to live here ("about:history" → "history"), but the
// helper's #lfc=open grammar already reserves those nouns: open.history and
// open.downloads are the chrome history/downloads POPUPS (see the POPUP map in
// chrome/channel.ts). So "open the about:page" arrived at the helper as a name
// whose first token named a popup, and the helper — by its own contract —
// opened the popup instead of the page. about:preferences dodged it only
// because no popup is called "preferences". Every about: URL now rides the
// base64 payload the helper already opens natively (u.<b64>), which carries
// fragments (about:preferences#search) without a name map at all.

function base64Url(url: string): string | null {
  try {
    return "u." + btoa(unescape(encodeURIComponent(url))).replace(/=+$/, "");
  } catch {
    return null;
  }
}

// `winId` is the window the request came from (see tabs.senderWindowId). It is
// load-bearing on every `tabs.create`: the tabs API defaults to the window the
// BACKGROUND considers current, so a link picked in session A used to open in
// session B — the same cross-session jump as the reported `;g`/`;l`.
export async function openUrl(url: string, newTab: boolean | undefined, winId: number | null = null) {
  if (!url) return { ok: false };
  // about: pages cannot be navigated with the tabs API (Firefox rejects them
  // with "Illegal URL"), so they always route through the chrome helper.
  if (/^about:/i.test(url)) {
    return openPage(url, winId);
  }
  const tab = await activeTabInWindow(winId);
  if (isCommandCenter(tab)) {
    await browser.tabs.update(tab.id, { url, active: true });
    return { ok: true, reused: true };
  }
  if (newTab == null) {
    const c = await getConfig();
    newTab = c.openInNewTab !== false;
  }
  const inWin = winId == null ? {} : { windowId: winId };
  if (newTab || !tab) {
    // A link opened FROM a stealth tab belongs in that tab's jar. Without the
    // cookieStoreId the new tab lands in the default jar, which is a silent
    // escape from the sandbox: the page you clicked from was isolated and the
    // one it opened was signed in as you.
    const jar = await stealthContainerOf(tab);
    await browser.tabs.create({ url, active: true, ...inWin, ...(jar ? { cookieStoreId: jar } : {}) });
  } else {
    await browser.tabs.update(tab.id, { url });
  }
  return { ok: true };
}

export async function openPage(url: string, winId: number | null = null) {
  const tab = await activeTabInWindow(winId);
  let payload: string | null = null;
  if (/^about:/i.test(url)) {
    payload = base64Url(url);
    if (!payload) return { ok: false };
  }
  if (payload) {
    // Drive the open through a throwaway `.c` request tab: the chrome helper
    // opens the about: page natively and removes the throwaway. The current
    // command-center tab is never navigated, so it keeps its input and grid
    // state (an in-place #lfc= navigation would reload it).
    await browser.tabs.create({
      url: CC_URL + "#lfc=open." + payload + ".c",
      active: false,
      ...(winId == null ? {} : { windowId: winId })
    });
    return { ok: true };
  }
  if (isCommandCenter(tab)) {
    await browser.tabs.update(tab.id, { url, active: true });
    return { ok: true, reused: true };
  }
  const jar = await stealthContainerOf(tab);
  await browser.tabs.create({
    url,
    active: true,
    ...(winId == null ? {} : { windowId: winId }),
    ...(jar ? { cookieStoreId: jar } : {})
  });
  return { ok: true };
}

// Ask the chrome helper (userChrome.uc.js) to open one of its native popups.
export async function openUI(which: string, winId: number | null = null) {
  const tab = await activeTabInWindow(winId);
  const hash = "open." + which + ".c";
  if (isCommandCenter(tab)) {
    await browser.tabs.update(tab.id, {
      url: CC_URL + "#lfc=" + hash,
      active: true
    });
    try {
      await new Promise((r) => setTimeout(r, 800));
      const t = await browser.tabs.get(tab.id);
      if (t.url && t.url.indexOf("#lfc=") !== -1) {
        await browser.tabs.update(tab.id, { url: stripHash(t.url) });
      }
    } catch {
      // The tab may already be gone (a closing #lfc= relay tab).
    }
    return { ok: true, reused: true };
  }
  await browser.tabs.create({
    url: CC_URL + "#lfc=" + hash,
    active: true,
    ...(winId == null ? {} : { windowId: winId })
  });
  return { ok: true };
}
