// Extension background entry point: the message router and event wiring.
//
// Feature logic lives in sibling modules — search.ts (search/suggestions),
// windowops.ts (window/tab actions), stealth.ts (isolated tabs), sessions.ts
// (tmux-style sessions), downloads.ts (download actions), config.ts (settings).
// This file only routes browser.runtime messages and the persistent relay
// chrome-helper channel to those modules, and wires the tab/window lifecycle
// listeners.

import { ensureCore, core } from "../shared/core";
import { hostInfo } from "./host";
import type { BgAction, ChromeAction, ChromeReq, RelayAction, RelayReq, RelayRes } from "../shared/protocol";
import type { CacheMode } from "../shared/types";
import { getConfig } from "./config";
import { probeHostOnce } from "./host";
import { CC_URL, getActiveTab, isCommandCenter, isUITab, realTabsInWindow, stripHash, transientTabIds } from "./tabs";
import { bookmarksSearch, doSearch, historySearch, searchUrlFor, suggestSearch, suggestUrls } from "./search";
import {
  activateTabByIndex,
  alternateTab as alternateTabOp,
  clearHistory,
  forgetTab,
  getWindowSize,
  moveWindow,
  noteTabActivation,
  recentlyClosed,
  removeHistory,
  reopenTab,
  resizeWindow,
  restoreAllClosedTabs,
  restoreClosedTab,
  tabsInWindow,
  toggleMaximize,
  toggleMute,
  toggleZen,
  zoom
} from "./windowops";
import { openDownload, openDownloadLocation, removeDownload, retryDownload, downloadsList } from "./downloads";
import { createCacheController } from "./cache";
import { reconcileStealth, removeStealthContainerForTab, stealthOpen } from "./stealth";
import {
  assignSessionMarker,
  bindChromeHooks,
  deleteSession,
  flushOnQuit,
  isRestoring,
  newSession,
  quitBrowser,
  restoreSession,
  resumeOnStartup,
  saveSession,
  scheduleAutosave,
  scheduleSnapshot,
  sessionList,
  sessionState,
  sessionTabs,
  moveTabBetweenSessions,
  switchSessionByMarker
} from "./sessions";

// Only idle placeholders that can NEVER be mid-navigation are converted to
// the command center. about:blank is deliberately NOT here: a blank tab is
// always a transient placeholder for an in-flight navigation (a
// target=_blank link, ;o, a search results tab), and converting it races the
// navigation — after a Firefox update changed when a new tab reports its
// pending URL, that race won and every link / ;o / ;s landed on the
// command-center home instead of the target page ("empty new tab"). The
// command center for user-opened tabs comes from chrome_url_overrides.newtab
// (the stable manifest mechanism), so a genuinely blank tab is simply left
// alone.
const HOMEISH = /^about:(home|newtab)$/i;

const CHROME_PAGES: { [k: string]: string } = {
  "about:preferences": "preferences",
  "about:addons": "addons",
  "about:history": "history",
  "about:downloads": "downloads"
};

// Versions of every Lazyfox component, surfaced on the options page's
// Components panel. Each piece is versioned independently (the extension, the
// Go wasm core, the native host, and the chrome helper shipped by the
// installer), so this reports all of them rather than a single number.
async function componentsInfo() {
  const [ext, wasm, host] = await Promise.all([
    Promise.resolve(browser.runtime.getManifest().version),
    core.version().catch(() => "?"),
    hostInfo().catch(() => null),
  ]);
  const stored = await browser.storage.local
    .get("chromeHelperVersion")
    .catch(() => ({}));
  return {
    extension: ext,
    wasm: wasm,
    nativeHost: host && host.version ? String(host.version) : null,
    nativeProtocol: host && host.protocol ? String(host.protocol) : null,
    chromeHelper: (stored && stored.chromeHelperVersion) || null,
  };
}

async function openUrl(url: string, newTab: boolean | undefined) {
  if (!url) return { ok: false };
  // about: pages cannot be navigated with the tabs API (Firefox rejects them
  // with "Illegal URL" — the tests/probe confirm it), so they always route
  // through the chrome helper's native opener.
  if (/^about:/i.test(url)) {
    return openPage(url);
  }
  const tab = await getActiveTab();
  if (isCommandCenter(tab)) {
    await browser.tabs.update(tab.id, { url, active: true });
    return { ok: true, reused: true };
  }
  if (newTab == null) {
    const c = await getConfig();
    newTab = c.openInNewTab !== false;
  }
  if (newTab || !tab) {
    await browser.tabs.create({ url, active: true });
  } else {
    await browser.tabs.update(tab.id, { url });
  }
  return { ok: true };
}

async function openPage(url: string) {
  const tab = await getActiveTab();
  const base = CC_URL;
  // about: pages must be opened by the chrome helper's native opener. Known
  // pages map to a short key; a fragment (about:preferences#searchResults)
  // rides along; any other about: URL (about:config, ...) is carried
  // base64-encoded so the #lfc= hash grammar stays intact.
  let payload: string | null = null;
  let target = CHROME_PAGES[url];
  if (!target) {
    for (const [key, t] of Object.entries(CHROME_PAGES)) {
      if (url.startsWith(key)) {
        target = t + url.slice(key.length);
        break;
      }
    }
  }
  if (target) {
    payload = target;
  } else if (/^about:/i.test(url)) {
    try {
      payload = "u." + btoa(unescape(encodeURIComponent(url))).replace(/=+$/, "");
    } catch (e) {
      return { ok: false };
    }
  }
  if (payload) {
    const hash = "#lfc=open." + payload;
    // Always drive the open through a throwaway `.c` request tab: the chrome
    // helper opens the about: page natively and removes the throwaway. The
    // current command-center tab is NEVER navigated, so it keeps its input
    // and grid state (an in-place #lfc= navigation would reload it and dump
    // the user back at a fresh home grid).
    await browser.tabs.create({
      url: base + hash + ".c",
      active: false
    });
    return { ok: true };
  }
  if (isCommandCenter(tab)) {
    await browser.tabs.update(tab.id, { url, active: true });
    return { ok: true, reused: true };
  }
  await browser.tabs.create({ url, active: true });
  return { ok: true };
}

// Ask the chrome helper (userChrome.uc.js) to open one of its native popups.
async function openUI(which: string) {
  const tab = await getActiveTab();
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
    } catch (e) {}
    return { ok: true, reused: true };
  }
  await browser.tabs.create({ url: CC_URL + "#lfc=" + hash, active: true });
  return { ok: true };
}

async function handleMessage(msg: BgAction, sender: any) {
  // `data` stays loose: each case reads only the fields its action declares.
  const data: any = msg.data || {};
  switch (msg.action) {
    case "searchSuggest":
      return suggestSearch(data.q);
    case "urlSuggest":
      return suggestUrls(data.q);
    case "components":
      return componentsInfo();
    case "tabs":
      return tabsInWindow();
    case "activateTab":
      await browser.tabs.update(data.id, { active: true });
      await browser.windows.update((await getActiveTab()).windowId, {
        focused: true
      });
      return { ok: true };
    case "activateTabAt":
      if (data.last) {
        const tabs = await realTabsInWindow();
        const t = tabs[tabs.length - 1];
        if (!t) return { ok: false };
        await browser.tabs.update(t.id, { active: true });
        await browser.windows.update(t.windowId, { focused: true });
        return { ok: true };
      }
      return activateTabByIndex(data.index || 1);
    case "moveTab": {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const idx = tabs.findIndex((t: any) => t.id === data.id);
      if (idx < 0) return { ok: false };
      const dir = data.dir > 0 ? 1 : -1;
      const ni = Math.max(0, Math.min(tabs.length - 1, idx + dir));
      if (ni !== idx) await browser.tabs.move(data.id, { index: ni });
      return { ok: true };
    }
    case "moveActiveTab": {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const idx = tabs.findIndex((t: any) => t.active);
      if (idx < 0) return { ok: false };
      const dir = data.dir > 0 ? 1 : -1;
      const ni = Math.max(0, Math.min(tabs.length - 1, idx + dir));
      if (ni !== idx) await browser.tabs.move(tabs[idx]!.id, { index: ni });
      return { ok: true };
    }
    case "closeTab": {
      // Removing the window's LAST tab closes the whole window (and Firefox, if
      // it's the only window). Guard it: report `last` so callers can ask for
      // confirmation, and only actually close on a second press (force).
      const targetId = data.id != null ? data.id : (await getActiveTab())?.id;
      const tabs = await realTabsInWindow();
      const isLast =
        tabs.length <= 1 && targetId != null && tabs[0] && tabs[0].id === targetId;
      if (isLast && !data.force) {
        return { ok: true, last: true };
      }
      if (targetId != null) await browser.tabs.remove(targetId);
      return { ok: true, last: false };
    }
    case "newTab":
      // A new tab is the command center, never a stray about:blank.
      await browser.tabs.create({ url: CC_URL, active: true });
      return { ok: true };
    case "reopenTab":
      return reopenTab();
    case "alternateTab":
      return alternateTabOp();
    case "recentlyClosed":
      return { items: await recentlyClosed() };
    case "restoreClosedTab":
      return restoreClosedTab(data.key);
    case "restoreAllClosed":
      return restoreAllClosedTabs();
    case "removeHistory":
      return removeHistory(data.url);
    case "clearHistory":
      return clearHistory();
    case "duplicateTab": {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.duplicate(tab.id);
      return { ok: true };
    }
    case "reload": {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.reload(tab.id);
      return { ok: true };
    }
    case "back": {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.goBack(tab.id);
      return { ok: true };
    }
    case "forward": {
      const tab = await getActiveTab();
      if (tab) await browser.tabs.goForward(tab.id);
      return { ok: true };
    }
    case "openUrl":
      return openUrl(data.url, data.newTab);
    case "openPage":
      return openPage(data.url);
    case "openUI":
      return openUI(data.which);
    case "search": {
      const q = (data.query || "").trim();
      if (!q) return { ok: false };
      // ;S (newTab === false) replaces the current tab; ;s defers to config.
      if (data.newTab === false) {
        const tab = await getActiveTab();
        if (tab) await browser.tabs.update(tab.id, { url: await searchUrlFor(q), active: true });
        return { ok: true };
      }
      return doSearch(q);
    }
    case "searchInPlace": {
      const q = (data.query || "").trim();
      if (!q) return { ok: false };
      const tab = await getActiveTab();
      if (tab) await browser.tabs.update(tab.id, { url: await searchUrlFor(q), active: true });
      return { ok: true };
    }
    case "windowSize":
      return getWindowSize();
    case "resizeWindow":
      return resizeWindow(data.dx || 0, data.dy || 0);
    case "moveWindow":
      return moveWindow(data.dx || 0, data.dy || 0);
    case "maximize":
      return toggleMaximize();
    case "history":
      return historySearch(data.q);
    case "bookmarks":
      return bookmarksSearch(data.q);
    case "downloads":
      return downloadsList();
    case "openDownload":
      return openDownload(data.id);
    case "removeDownload":
      return removeDownload(data.id);
    case "openDownloadLocation":
      return openDownloadLocation(data.id);
    case "retryDownload":
      return retryDownload(data.id);
    case "zen":
      return toggleZen();
    case "zoom":
      return zoom(data.delta || 0, data.factor);
    case "mute":
      return toggleMute();
    case "copyUrl": {
      const tab = await getActiveTab();
      if (!tab) return { url: "", title: "" };
      return { url: tab.url || "", title: tab.title || "" };
    }
    case "setConfig":
      await browser.storage.local.set({ config: data.config });
      return { ok: true };
    case "syncTyping":
      if (sender && sender.tab && sender.tab.id != null) {
        try {
          await browser.sessions.setTabValue(
            sender.tab.id,
            "lfTyping",
            data.typing ? "1" : "0"
          );
        } catch (e) {}
      }
      return { ok: true };
    case "syncLeader":
      // The chrome helper's window-level status bar needs to know when the
      // content-script leader is armed on a web page (the chrome helper's
      // own leader never arms there — the content script owns the keys).
      // Relay it through the transient #lfc= leaderState push (the same
      // channel pushSessionStateToChrome uses): the chrome helper caches it
      // per tab-strip index and shows the LEADER chevron for that tab.
      if (sender && sender.tab && sender.tab.id != null) {
        pushLeaderStateToChrome(
          typeof sender.tab.index === "number" ? sender.tab.index : -1,
          !!data.active
        );
      }
      return { ok: true };
    case "syncFind":
      // Live find-in-page count from the content script's find widget,
      // relayed to the chrome helper's window-level status bar the same way
      // leaderState rides (findState.<b64>.<nonce> per tab-strip index).
      // count -1 = the widget closed (hide the segment); 0 = no matches.
      if (sender && sender.tab && sender.tab.id != null) {
        const c = Number(data.count);
        pushFindStateToChrome(
          typeof sender.tab.index === "number" ? sender.tab.index : -1,
          isNaN(c) ? -1 : c,
          Math.max(0, Number(data.cur) || 0)
        );
      }
      return { ok: true };
    case "sessionList":
      return sessionList();
    case "listSessionTabs":
      return { items: await sessionTabs(data.name || "") };
    case "sessionSave":
      return saveSession(data.name);
    case "sessionNew":
      return newSession(data.name);
    case "sessionRestore":
      return restoreSession(data.name);
    case "sessionDelete":
      return deleteSession(data.name);
    case "sessionSwitchByMarker":
      return switchSessionByMarker(data.marker);
    case "sessionAssignMarker":
      return assignSessionMarker(data.name, data.marker);
    case "sessionTabCopy":
      return moveTabBetweenSessions(data.from, data.index, data.to, "copy");
    case "sessionTabMove":
      return moveTabBetweenSessions(data.from, data.index, data.to, "move");
    case "sessionSplit":
      // Native splits are the chrome helper's domain (gBrowser.addTabSplitView);
      // relay the request over the persistent relay.
      requestChrome("splitTab");
      return { ok: true };
    case "sessionUnsplit":
      requestChrome("unsplit");
      return { ok: true };
    case "sessionSwitchPane":
      requestChrome("switchPane", { dir: data.dir > 0 ? 1 : -1 });
      return { ok: true };
    case "sessionSwapPane":
      requestChrome("swapSplitPanes", { dir: data.dir > 0 ? 1 : -1 });
      return { ok: true };
    case "sessionSplitAddTabByIndex": {
      const n = Number(data && data.index);
      if (!(n >= 1 && n <= 9)) return { ok: false, note: "tab number must be 1-9" };
      requestChrome("moveToSplit", { index: n });
      return { ok: true };
    }
    case "splitPanelTabs": {
      // Number REAL tabs only (skip splitpanel + #lfc=), so the list's numbers
      // match ;+N and never shift when a companion pane is added/removed.
      const tabs = await realTabsInWindow();
      return {
        tabs: tabs.map((t: any, i: number) => ({
          index: i + 1,
          id: t.id,
          url: t.url || "",
          title: t.title || "",
          active: !!t.active,
          inSplit: typeof t.splitViewId === "number" && t.splitViewId >= 0
        }))
      };
    }
    case "moveTabToSplit": {
      const n = Number(data && data.index);
      if (!(n >= 1 && n <= 9)) return { ok: false };
      requestChrome("moveToSplit", { index: n });
      return { ok: true };
    }
    case "toggleWhichKey": {
      const c = await getConfig();
      c.whichKey = !c.whichKey;
      await browser.storage.local.set({ config: c });
      return { whichKey: !!c.whichKey };
    }
    case "stealthOpen":
      return stealthOpen(() => pushSessionStateToChrome());
    case "openSetup":
      return openSetupTab();
    case "openDiagnostics":
      return openDiagnosticsTab();
    case "pageReport":
      // Ask a tab's content script for a live self-report. A page with no
      // content script (about:/error pages, restricted domains) throws here —
      // that is an answer, not a failure, so it comes back as report: null.
      return pageReport(data);
    case "diagnoseTabs":
      return diagnoseTabs();
    case "cacheState":
      return cache.cacheState();
    case "cacheSet":
      return cache.cacheSet(data.scope, data.mode);
    case "hardReload":
      return cache.hardReload();
    case "quit":
      return quitBrowser();
    case "sessionState":
      return sessionState();
    default:
      return { ok: false, error: "unknown action" };
  }
}

browser.runtime.onMessage.addListener((msg: BgAction, sender: any) => {
  return handleMessage(msg, sender).catch((err: any) => ({
    ok: false,
    error: String(err && err.message ? err.message : err)
  }));
});

browser.commands.onCommand.addListener((name: string) => {
  if (name === "open-command-center") {
    browser.tabs
      .create({ url: browser.runtime.getURL("commandcenter.html"), active: true })
      .catch(() => {});
  } else if (name === "split-horizontal") {
    requestChrome("splitTab");
  } else if (name === "split-next-pane") {
    requestChrome("switchPane", { dir: 1 });
  } else if (name === "split-prev-pane") {
    requestChrome("switchPane", { dir: -1 });
  } else if (name === "unsplit") {
    requestChrome("unsplit");
  }
});

// True while a tab is loading or already navigating somewhere. Converting
// such a tab would hijack the in-flight navigation, so conversion must
// never touch it.
function isNavigating(t: any): boolean {
  if (!t) return true;
  if (t.status === "loading") return true;
  return !!(t.pendingUrl && t.pendingUrl !== t.url);
}

function maybeConvertHome(tab: any) {
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

browser.tabs.onUpdated.addListener((_tabId: number, info: any, tab: any) => {
  if (isRestoring()) return;
  if (info.status === "complete" && tab && tab.active) maybeConvertHome(tab);
});

// A launch tab left on about:blank (a profile whose startup.homepage is
// about:blank and/or startup.page is 0) is the HOME tab, not a navigation
// placeholder — but about:blank is deliberately excluded from maybeConvertHome
// because a blank tab mid-session is always a transient placeholder for an
// in-flight navigation (target=_blank, ;o, search results). The two cases are
// told apart by WHEN and WHERE the blank tab sits: this runs once at startup,
// and converts only when the window has exactly one real tab that is STILL a
// blank, idle tab after native startup restore has had time to settle. Any
// other blank tab (a second tab, a pending session-restore tab, a navigation
// that started) is left alone, so the mid-session hijack regression cannot
// come back.
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
maybeConvertStartupBlank();
browser.runtime.onStartup.addListener(() => {
  maybeConvertStartupBlank();
});

// Persistent relay channel (see docs/MESSAGING.md): ONE hidden relay tab
// (relay.html) carries every helper<->background message over a long-lived
// runtime port. The relay page connects a port named "lazyfox-relay"; requests
// from the chrome helper arrive on it and replies go back the same way, and
// background->chrome commands are pushed over it too. No tab is created or
// removed per message.
const RELAY_QUEUE_TTL = 6000;
// windowId -> live Port (the relay page reconnects if it drops).
const relayPorts = new Map<number, any>();
// Commands queued while no port was connected yet (the relay tab may still be
// coming up); flushed on connect, dropped after RELAY_QUEUE_TTL so a stale
// command can never fire late.
const relayCmdQueues = new Map<number, Array<{ action: string; arg?: any }>>();

browser.runtime.onConnect.addListener((port: any) => {
  if (!port || !port.name || port.name.indexOf("lazyfox-relay") !== 0) return;
  // The relay page carries its windowId in the connection name
  // ("lazyfox-relay:<windowId>") because sender.tab is not guaranteed; fall
  // back to sender.tab when the name lacks it.
  const nameWin = /^lazyfox-relay:(\d+)$/.exec(port.name);
  const sender = port.sender;
  const tab = sender && sender.tab;
  const tabId = tab && tab.id != null ? tab.id : null;
  const winId =
    (nameWin && nameWin[1] != null ? Number(nameWin[1]) : null) ||
    (tab && tab.windowId != null ? tab.windowId : null);
  if (winId == null) return;
  // The relay tab is invisible plumbing: never a user tab, never in the strip.
  // NOTE: it is deliberately NOT hidden via browser.tabs.hide() — hiding
  // detaches the tab's chrome-side browsing context (contentWindow /
  // browsingContext.window become null), which is exactly what broke the
  // helper<->relay window bridge on interactive Firefox (remote extension
  // pages). The chrome helper hides the tab natively (tab.hidden = true,
  // cosmetic, keeps the browsing context alive) and both sides filter relay
  // tabs from every count/strip/list.
  if (tabId != null) transientTabIds.add(tabId);
  relayPorts.set(winId, port);
  // Flush commands queued while no port was connected.
  const q = relayCmdQueues.get(winId) || [];
  relayCmdQueues.delete(winId);
  for (const c of q) {
    try {
      port.postMessage({ type: "cmd", action: c.action, arg: c.arg !== undefined ? c.arg : "" });
    } catch (e) {
      // ignore
    }
  }
  port.onMessage.addListener((msg: any) => {
    if (!msg || msg.type !== "req") return;
    handleRelayReq(String(msg.action || ""), msg.arg)
      .then((result) => {
        try {
          port.postMessage({ type: "resp", id: msg.id, result: result !== undefined ? result : null });
        } catch (e) {
          // ignore
        }
      })
      .catch((e: any) => {
        try {
          port.postMessage({ type: "resp", id: msg.id, error: String((e && e.message) || e) });
        } catch (e2) {
          // ignore
        }
      });
  });
  port.onDisconnect.addListener(() => {
    if (relayPorts.get(winId) === port) relayPorts.delete(winId);
  });
});

// Find the relay tab for the current window (the chrome helper CREATES it at
// startup — the extension must never create a second one, which is what
// produced duplicate relay tabs racing the helper's own). Query-only: when no
// relay tab exists there is no chrome helper attached (or it hasn't come up
// yet), so pushes are dropped — the helper's own requests/announce recreate
// the tab the moment its ccBaseUrl resolves.
function ensureRelayTab(): Promise<any | null> {
  return browser.tabs
    .query({ currentWindow: true })
    .then((ts: any[]) => (ts || []).find((t: any) => t.url && t.url.indexOf("relay.html") !== -1) || null)
    .catch(() => null);
}

// Relay tabs are invisible plumbing — register + hide them the moment they
// appear (the port-connect handler does the same, but only after the page
// loads; this covers the creation window).
browser.tabs.onCreated.addListener((tab: any) => {
  if (tab && tab.id != null && tab.url && tab.url.indexOf("relay.html") !== -1) {
    transientTabIds.add(tab.id);
  }
});
browser.tabs.onUpdated.addListener((tabId: number, _info: any, tab: any) => {
  if (tab && tab.url && tab.url.indexOf("relay.html") !== -1) {
    transientTabIds.add(tabId);
  }
});

// Ask the chrome helper to do something only it can (native splits, status
// pushes): post the command over the relay's runtime port. `arg` may be any
// structured-cloneable value (objects arrive as objects on the helper side).
//
// Delivery must survive the relay tab being torn down: a session restore
// removes every unpinned tab (the relay included), so the port in relayPorts
// can be DEAD while the map still holds it (the disconnect listener is
// async). Posting into a dead port silently drops the command — the exact bug
// that lost restoreSplits after a restore. So: verify the port is live,
// fall through to ensure+queue when it isn't, and keep retrying until the
// port is actually delivering (or the TTL expires, so a stale command can
// never fire late).
// Typed against ChromeApi, so a push whose payload does not match what the
// chrome side destructures is a compile error rather than a status bar that
// silently stops updating.
function requestChrome<K extends ChromeAction>(action: K, arg?: ChromeReq<K>): void {
  browser.tabs
    .query({ currentWindow: true, active: true })
    .then((ts: any[]) => {
      const winId = ts && ts[0] ? ts[0].windowId : null;
      if (winId == null) return;
      const entry = { action: action, arg: arg };
      const tryPost = (): boolean => {
        const port = relayPorts.get(winId);
        if (!port) return false;
        try {
          // Always an object, never "": the chrome side reads named fields, and
          // a command that arrives as an empty string reads as undefined for
          // every one of them.
          port.postMessage({ type: "cmd", action: action, arg: arg === undefined ? {} : arg });
          return true;
        } catch (e) {
          // The port is dead (its relay tab was removed); drop it so the next
          // attempt goes through ensureRelayTab.
          relayPorts.delete(winId);
          return false;
        }
      };
      if (tryPost()) return;
      // No live port: the relay tab may be coming up (the helper creates it
      // and the page connects a beat later). Queue the command and keep
      // retrying until the port delivers or the command ages out — without
      // ever creating a relay tab ourselves (the helper owns that). The
      // retry covers the gap between "the port connected" and "the onConnect
      // flush ran" (the flush can beat the queue push), and the dead-port
      // case above. The entry stays in the queue so onConnect's drain can
      // deliver it; the retry loop stops the moment the entry leaves the
      // queue (delivered or aged out), so a command is never posted twice.
      void ensureRelayTab().then(() => {
        const started = Date.now();
        const q = relayCmdQueues.get(winId) || [];
        q.push(entry);
        relayCmdQueues.set(winId, q);
        const tick = () => {
          const cur = relayCmdQueues.get(winId) || [];
          const i = cur.indexOf(entry);
          if (i < 0) return; // already delivered by onConnect's drain
          if (tryPost()) {
            cur.splice(i, 1);
            return;
          }
          if (Date.now() - started > RELAY_QUEUE_TTL) {
            cur.splice(i, 1);
            return;
          }
          setTimeout(tick, 200);
        };
        tick();
      });
    })
    .catch(() => {});
}

// Ask the chrome helper to do something only it can, and learn whether it was
// actually reachable. Same delivery path as requestChrome, but resolves true
// only when a LIVE port for the current window took the command. It never
// queues: a request that has to wait for the relay to come up would be far too
// late for a click (the user has already moved on), so "not connected yet" is
// reported as unavailable and the caller falls back immediately.
// Push the fresh session summary to the chrome helper's status bar after a
// session mutation that did NOT originate from the chrome helper itself (the
// helper refreshes on its own actions; content-script and options actions would
// otherwise leave its bar pointing at a stale session name).
async function pushSessionStateToChrome(): Promise<void> {
  try {
    const state = await sessionState();
    requestChrome("sessionState", state);
  } catch (e) {
    // ignore
  }
}

// Relay the content script's leader arm/disarm to the chrome helper so its
// window-level status bar can show the pulsing LEADER chevron on web pages
// (where the content script owns the leader key). The push carries the tab's
// strip index + active flag; the chrome helper caches it per index.
function pushLeaderStateToChrome(index: number, active: boolean): void {
  if (index < 0) return;
  requestChrome("leaderState", { index: index, active: active });
}

// Relay the content script's find-in-page count to the chrome helper so its
// window-level status bar can show "🔍 cur/count" on web pages. The push
// carries the tab's strip index + count state; the helper caches it per index.
function pushFindStateToChrome(index: number, count: number, cur: number): void {
  if (index < 0) return;
  requestChrome("findState", { index: index, count: count, cur: cur });
}

// Handle a chrome-helper request arriving over the relay port. Returns the
// reply value (structured-cloned back to the helper) or null for
// fire-and-forget actions. Every request proves the helper is alive — flip
// the gate so content scripts stop drawing their own status bar. The
// dedicated "alive" announce can race the extension still loading on a cold
// start; every other request (e.g. the startup sessionState poll) covers that
// window.
// The relay request handlers, one per action in RelayApi.
//
// This used to be a 30-branch if-chain over a bare string, which had two
// costs that only showed up at runtime: an action nobody handled fell off
// the end and returned null in total silence (that is exactly how
// `openDiagnostics` shipped broken — the chrome side sent it, the content
// script's own send() worked, so the only symptom was that `;T` did nothing
// when the chrome helper owned the key), and the arguments arrived as
// U+0001-packed strings that had to be re-parsed by hand at each site.
//
// As a table over RelayAction, a missing handler is a compile error and a
// handler's argument is the declared request type.
const relayHandlers: { [K in RelayAction]: (req: RelayReq<K>) => Promise<RelayRes<K>> | RelayRes<K> } = {
  // The chrome helper announces its version AND the active profile's
  // user-facing name + raw directory leaf. Store the version so the options
  // Components panel can report it independently of the extension, and the
  // profile so the command-center footer and setup page can show which
  // profile is active even before any session has been saved.
  alive: (req) => {
    markChromeAlive();
    const set: Record<string, string> = { chromeHelperVersion: req.version || "" };
    if (req.profileName) set.lfProfileName = req.profileName;
    if (req.profileDir) set.lfProfileDir = req.profileDir;
    // Whether the chrome helper could see the Lazyfox window actor
    // registered. The diagnostics page reports it, so a silently missing
    // bridge is visible instead of being felt only as "keys do nothing on
    // this page".
    if (req.bridge !== undefined) set.lfBridge = req.bridge;
    browser.storage.local.set(set).catch(() => {});
    // A truthy ack so the helper can confirm the announce was really
    // delivered (and stop retrying). Without it the helper could only know a
    // fire-and-forget req was accepted/queued, not that chromeAlive landed.
    return { ok: true };
  },
  // The chrome helper flipped its own cached copy; flip storage to match so
  // content scripts, the command center and options agree.
  toggleWhichKey: async () => {
    const c = await getConfig();
    c.whichKey = !c.whichKey;
    await browser.storage.local.set({ config: c });
    return null;
  },
  // Best-effort: a tab with no content script (about:, an extension page, a
  // restricted domain) is a normal outcome, not an error to surface.
  startHints: () => relayToContent("startHints"),
  focusFirstInput: () => relayToContent("focusFirstInput"),
  openOptions: async () => {
    try {
      await browser.runtime.openOptionsPage();
    } catch (e) {
      // ignore
    }
    return null;
  },
  openSetup: async () => {
    await openSetupTab();
    return null;
  },
  // Was missing entirely: the chrome side sent this and the chain fell
  // through, so `;T` did nothing unless the content script owned the key.
  openDiagnostics: async () => {
    await openDiagnosticsTab();
    return null;
  },
  quit: async () => {
    await quitBrowser();
    return null;
  },
  // The result ({ ok, error }) goes back so the helper can toast the outcome
  // instead of swallowing it.
  stealthOpen: () => stealthOpen(() => pushSessionStateToChrome()),
  // Read-only pulls for the chrome-side UI.
  sessionState: () => sessionState(),
  sessionTabs: (req) => sessionTabs(req.name),
  recentlyClosed: () => recentlyClosed(),
  // Routed here rather than calling gBrowser.undoCloseTab locally so it goes
  // through the same filtered reopen as the content script: SessionStore's
  // "most recently closed" is usually a hidden plumbing tab, which this skips.
  reopenTab: () => reopenTab(),
  // Session + tab mutations. Fire-and-forget; the helper refreshes the
  // status bar itself once the action has landed.
  saveSession: async (req) => {
    await saveSession(req.name);
    return null;
  },
  newSession: async (req) => {
    await newSession(req.name);
    return null;
  },
  restoreSession: async (req) => {
    await restoreSession(req.name);
    return null;
  },
  deleteSession: async (req) => {
    await deleteSession(req.name);
    return null;
  },
  switchSessionByMarker: async (req) => {
    await switchSessionByMarker(req.marker);
    return null;
  },
  assignSessionMarker: async (req) => {
    await assignSessionMarker(req.name, req.marker);
    return null;
  },
  sessionTabCopy: (req) => moveTabBetweenSessions(req.from, req.index, req.to, "copy"),
  sessionTabMove: (req) => moveTabBetweenSessions(req.from, req.index, req.to, "move"),
  // Tab strip / history actions the helper cannot do itself.
  alternateTab: async () => {
    await alternateTabOp();
    return null;
  },
  restoreClosedTab: async (req) => {
    await restoreClosedTab(req.key);
    return null;
  },
  restoreAllClosed: async () => {
    await restoreAllClosedTabs();
    return null;
  },
  removeHistory: async (req) => {
    await removeHistory(req.url);
    return null;
  },
  clearHistory: async () => {
    await clearHistory();
    return null;
  },
};

// Forward a request to the active tab's content script. Typed as returning the
// two actions it can carry, so the two `relayToContent` entries above stay
// honest about which actions they claim to handle.
async function relayToContent(action: "startHints" | "focusFirstInput"): Promise<null> {
  const t = await getActiveTab();
  if (!t) return null;
  try {
    await browser.tabs.sendMessage(t.id, { action: action });
  } catch (e) {
    // No content script in that tab. Normal, and not worth a toast.
  }
  return null;
}

function handleRelayReq(action: string, arg: unknown): Promise<unknown> {
  const fn = relayHandlers[action as RelayAction] as ((req: unknown) => unknown) | undefined;
  if (!fn) {
    // A helper newer than this background, or vice versa. Answering null keeps
    // the helper's request/reply from hanging until its timeout.
    return Promise.resolve(null);
  }
  // markChromeAlive() ran for EVERY action in the old chain (it was above
  // the first branch), which is what let any traffic from the helper latch
  // the chrome layer as alive. Keep that: the announce is the reliable
  // signal, but a live request is evidence too.
  if (action !== "alive") markChromeAlive();
  return Promise.resolve(fn((arg || {}) as never)).then((r) => (r === undefined ? null : r));
}

browser.tabs.onActivated.addListener((info: any) => {
  if (isRestoring()) return;
  browser.tabs
    .get(info.tabId)
    .then((tab: any) => maybeConvertHome(tab))
    .catch(() => {});
});

// Alternate-tab (;a) bookkeeping: remember the previously-active tab per
// window so the shortcut can toggle back to it. Suppressed during a session
// restore rebuild (the transient activations would pollute the pair).
browser.tabs.onActivated.addListener((info: any) => {
  if (isRestoring()) return;
  noteTabActivation(info.windowId, info.tabId);
});
browser.tabs.onRemoved.addListener((tabId: number, removeInfo: any) => {
  forgetTab(removeInfo && removeInfo.windowId, tabId);
});

browser.tabs
  .query({})
  .then((tabs: any[]) => {
    for (const t of tabs || []) {
      if (t.active) maybeConvertHome(t);
    }
  })
  .catch(() => {});

// Authoritative in-memory source of truth for "is the chrome layer alive this
// session?". Set true by markChromeAlive (the helper's confirmed announce);
// reset false on startup. Content scripts query this via the "chromeLayer"
// message (NOT a storage flag, which onStartup's write can race) so exactly one
// status bar ever renders.
let chromeLayerAlive = false;

function setChromeLayerAlive(v: boolean): void {
  chromeLayerAlive = v;
}

// Page-cache policy controller. The chrome helper enforces the per-tab scopes,
// so whenever it comes alive we re-push the stored policy (a policy set while
// the helper was down would otherwise never take effect).
const cache = createCacheController({
  requestChrome: (action, arg) => {
    // cache.ts pushes only the two actions declared here; the cast is confined
    // to this one adapter rather than spread over requestChrome's signature.
    if (action === "cacheGlobal") requestChrome("cacheGlobal", { mode: (arg as CacheMode) || "normal" });
    else if (action === "cachePolicy") {
      const p = (arg || {}) as { mode?: CacheMode; tabIds?: number[] };
      requestChrome("cachePolicy", { mode: p.mode || "normal", tabIds: Array.isArray(p.tabIds) ? p.tabIds : [] });
    }
  },
  isChromeAlive: () => chromeLayerAlive,
});

// Chrome helper absent unless it pings "alive" on window startup; clear the gate
// so a stale flag never permanently disables content-side handling. Since
// content scripts must never trust a racy storage write for the one-bar
// decision, the authoritative flag is reset here and only the confirmed announce
// sets it true again.
browser.runtime.onStartup.addListener(() => {
  setChromeLayerAlive(false);
  browser.storage.local.set({ chromeAlive: false }).catch(() => {});
  checkChromeLayerHealth();
  nudgeFreshInstall();
  void reconcileStealth();
});

// Open the "complete the installation" page (setup.html). Used by ;I, the
// chrome-down notifications, and the relay-tab channel from the chrome helper
// (which cannot call browser.tabs itself). From the command-center home the
// tab is reused in place (like ;o/;h open in place) so ;I never stacks a
// second extension tab; from a real page a fresh tab opens (replacing the
// user's page would lose it).
function openSetupTab(): Promise<{ ok: boolean }> {
  const url = browser.runtime.getURL("setup.html");
  return getActiveTab()
    .then((t) => {
      if (t && t.id && isCommandCenter(t)) {
        return browser.tabs.update(t.id, { url: url, active: true });
      }
      return browser.tabs.create({ url: url, active: true });
    })
    .then(() => ({ ok: true }))
    .catch(() => ({ ok: false, error: "tab failed" } as { ok: boolean }));
}

// Open the diagnostics & performance page. Same tab-reuse rule as ;I: from the
// command center the tab is replaced in place, from a real page a new tab opens
// so the user's page is never lost.
function openDiagnosticsTab(): Promise<{ ok: boolean }> {
  const url = browser.runtime.getURL("diagnostics.html");
  return getActiveTab()
    .then((t) => {
      if (t && t.id && isCommandCenter(t)) {
        return browser.tabs.update(t.id, { url: url, active: true });
      }
      return browser.tabs.create({ url: url, active: true });
    })
    .then(() => ({ ok: true }))
    .catch(() => ({ ok: false, error: "tab failed" } as { ok: boolean }));
}

// The diagnostics page is itself an extension tab, so "the active tab" is
// usually the diagnostics page — which has no content script, and would always
// report null. Track the most recent tab that is a REAL web page (not the
// relay, the split panel, or any extension page) and report on that instead,
// falling back to the active tab when it is itself a real page.
const EXT_BASE = browser.runtime.getURL("");
let lastPageTabId: number | null = null;
function isWebPageTab(t: any): boolean {
  const url = (t && t.url) || "";
  if (!url) return false;
  if (url.indexOf(EXT_BASE) === 0) return false; // extension UI page
  if (url.indexOf("relay.html") !== -1 || url.indexOf("splitpanel.html") !== -1) return false;
  // about:/error/restricted pages are real answers too (they report null),
  // so they count as page tabs — the diagnostics page then says WHY.
  return true;
}
browser.tabs.onActivated.addListener((info: any) => {
  browser.tabs
    .get(info.tabId)
    .then((t: any) => {
      if (isWebPageTab(t)) lastPageTabId = info.tabId;
    })
    .catch(() => {});
});

// The live page report. With no tabId it reports the active tab, or the last
// real page tab (since the diagnostics page itself is an extension tab); a
// tabId targets any specific tab. Returns { report: null } when the tab has no
// content script at all, which is itself the most useful diagnostic answer on
// about:/error/restricted/extension pages.
function pageReport(data?: { tabId?: number }): Promise<{ report: unknown; tabId: number | null }> {
  const want = data && typeof data.tabId === "number" ? data.tabId : null;
  return getActiveTab()
    .then(async (active) => {
      let t: any = null;
      if (want != null) {
        t = await browser.tabs.get(want).catch(() => null);
      } else if (active && isWebPageTab(active)) {
        t = active;
      } else if (lastPageTabId != null) {
        t = await browser.tabs.get(lastPageTabId).catch(() => null);
      }
      if (!t || !t.id) return { report: null, tabId: want };
      try {
        const res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
        return { report: (res && res.report) || null, tabId: t.id };
      } catch (e) {
        return { report: null, tabId: t.id };
      }
    })
    .catch(() => ({ report: null, tabId: want }));
}

// Every tab in the current window, in strip order, for the diagnostics tab
// picker. Deliberately unfiltered (unlike `tabs`): diagnosing an about:/error/
// extension page is exactly the case the picker exists for.
async function diagnoseTabs(): Promise<{ tabs: { id: number; title: string; url: string; active: boolean }[] }> {
  try {
    const tabs = await browser.tabs.query({ currentWindow: true });
    return {
      tabs: (tabs || []).map((t: any) => ({
        id: t.id,
        title: t.title || t.url || "about:blank",
        url: t.url || "",
        active: !!t.active,
      })),
    };
  } catch (e) {
    return { tabs: [] };
  }
}

// The chrome-down notification opens the setup page so the user can re-run the
// installer (or finish a fresh install) in one click.
const CHROME_NOTIF = "lf-chrome-down";
browser.notifications.onClicked.addListener((id: string) => {
  if (id === CHROME_NOTIF) void openSetupTab();
});

// Update-survivability: the chrome helper announces "alive" on every window
// startup (retrying every 500ms until the extension URL resolves). If it used
// to announce (chromeEverAlive) but stays silent through the startup window,
// a Firefox update very likely broke the autoconfig loader — the exact
// silent-death failure of Firefox 155 (bug 1974213). Tell the user instead of
// letting every chrome-only feature degrade to standalone mode with no sign.
function markChromeAlive(): void {
  setChromeLayerAlive(true); // authoritative, before any async storage write
  browser.storage.local
    .set({ chromeAlive: true, chromeEverAlive: true })
    .catch(() => {});
  // Re-apply a page-cache policy the helper may have missed while down.
  void cache.resync();
}

function checkChromeLayerHealth(): void {
  browser.storage.local
    .get("chromeEverAlive")
    .then((r: { chromeEverAlive?: boolean }) => {
      // Never loaded even once (fresh install, standalone-only user): the
      // extension alone is the intended state; the fresh-install nudge below
      // offers the full install once.
      if (!r || !r.chromeEverAlive) return;
      setTimeout(async () => {
        try {
          const c = await browser.storage.local.get("chromeAlive");
          if (c && c.chromeAlive) return; // the helper announced in time
          await browser.notifications.create({
            type: "basic",
            iconUrl: browser.runtime.getURL("icons/icon96.png"),
            title: "Lazyfox chrome layer didn't load",
            message:
              "Firefox may have updated and broken the loader. Click to open the setup page and re-run the installer.",
          });
        } catch (e) {
          // never let the check break startup
        }
      }, 15000);
    })
    .catch(() => {});
}

// The active Firefox profile the extension is running under is stored so the
// setup page can tell the user which profile the installer will target. The
// WebExtension context has NO access to the profile directory (Services is
// not exposed there — verified: "Services is not defined" in extension
// contexts), so the ONLY source is the chrome helper's alive announce, which
// carries the user-facing name + raw directory leaf. The raw dir is a folder
// like "zfdaq0c3.dev-edition-default"; the USER-FACING name is the part after
// the first dot ("dev-edition-default") — exactly what the installer's
// profile picker lists. (A store-only install shows the honest placeholder
// until the chrome layer is installed and announces.)

// Fresh store installs (chrome never announced): offer the full UI once, since
// the add-on alone is only half of Lazyfox. One-shot via setupNudgeShown so a
// standalone-only user is not nagged again.
function nudgeFreshInstall(): void {
  browser.storage.local
    .get(["chromeEverAlive", "setupNudgeShown"])
    .then((r: { chromeEverAlive?: boolean; setupNudgeShown?: boolean }) => {
      if (r.chromeEverAlive || r.setupNudgeShown) return;
      setTimeout(async () => {
        try {
          const c = await browser.storage.local.get("chromeAlive");
          if (c && c.chromeAlive) return; // the helper announced in time
          await browser.notifications.create({
            type: "basic",
            iconUrl: browser.runtime.getURL("icons/icon96.png"),
            title: "Complete your Lazyfox install",
            message:
              "The add-on works, but the toolbar-free UI needs a one-time setup. Click to open it.",
          });
          await browser.storage.local.set({ setupNudgeShown: true });
        } catch (e) {
          // never let the check break startup
        }
      }, 20000);
    })
    .catch(() => {});
}
// Also reconcile on background load (covers install/reload and the very first
// launch after enabling the feature) — idempotent.
void reconcileStealth();
// Fresh installs land here first (onStartup fires on later launches): offer
// the full-UI setup once, and keep the chrome-layer health check honest on
// reloads.
checkChromeLayerHealth();
nudgeFreshInstall();

/* ===================== session autosave + restore ===================== */

const onTabChange = () => {
  scheduleAutosave();
  // Keep the in-memory quit snapshot current (short debounce, no storage
  // write) so flushing on quit never persists a stale window.
  scheduleSnapshot();
};
browser.tabs.onCreated.addListener(onTabChange);
browser.tabs.onRemoved.addListener(onTabChange);
// A relay tab can be removed by the chrome helper itself (removeReqTab) before
// the safety timeout — drop its id so the set never holds dead tabs.
browser.tabs.onRemoved.addListener((tabId: number) => {
  transientTabIds.delete(tabId);
});
// When a stealth tab closes, wipe its container data + remove the container.
// (Racy if the browser dies first — reconcileStealth catches orphans next
// launch.)
browser.tabs.onRemoved.addListener((tabId: number) => {
  void removeStealthContainerForTab(tabId);
});
browser.tabs.onMoved.addListener(onTabChange);
browser.tabs.onAttached.addListener(onTabChange);
browser.tabs.onDetached.addListener(onTabChange);
browser.tabs.onActivated.addListener(onTabChange);
browser.tabs.onUpdated.addListener((_tabId: number, info: any) => {
  if (info.url || info.status === "complete") onTabChange();
});

// On startup, resume the saved session when autoRestore is on. See
// sessions.resumeOnStartup for why this replaces Firefox's native restore.
browser.runtime.onStartup.addListener(async () => {
  try {
    const c = await getConfig();
    await resumeOnStartup(c.autoRestore);
  } catch (e) {
    // ignore
  }
});

// When the last window closes, Firefox is quitting. Flush the last-known
// snapshot captured on the previous tab change.
browser.windows.onRemoved.addListener(async () => {
  try {
    await flushOnQuit();
  } catch (e) {
    // ignore
  }
});

// Wire the chrome-helper hooks into the session manager (breaks the import
// cycle sessions -> chrome channel -> sessions).
bindChromeHooks({ requestChrome, pushSessionState: pushSessionStateToChrome });

// Warm the wasm core for the first URL suggestion.
void ensureCore().catch(() => {});

// Dev-only smoke test: log the native host's diag once (a working host shows
// up in the console; absence is a silent no-op — the host is optional, and
// AMO/store installs without the installer's host step must degrade cleanly).
probeHostOnce();
