// Extension background entry point: the message router and event wiring.
//
// Feature logic lives in sibling modules — search.ts (search/suggestions),
// windowops.ts (window/tab actions), stealth.ts (isolated tabs), sessions.ts
// (tmux-style sessions), downloads.ts (download actions), config.ts (settings).
// This file only routes browser.runtime messages and the #lfc=req chrome-helper
// channel to those modules, and wires the tab/window lifecycle listeners.

import { ensureCore } from "../shared/core";
import type { BgAction } from "../shared/protocol";
import { getConfig } from "./config";
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
import { openDownload, openDownloadLocation, removeDownload, downloadsList } from "./downloads";
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

async function openUrl(url: string, newTab: boolean | undefined) {
  if (!url) return { ok: false };
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
  const target = CHROME_PAGES[url];
  const tab = await getActiveTab();
  if (target) {
    const base = CC_URL;
    if (isCommandCenter(tab)) {
      await browser.tabs.update(tab.id, {
        url: base + "#lfc=open." + target,
        active: true
      });
      try {
        await new Promise((r) => setTimeout(r, 800));
        const t = await browser.tabs.get(tab.id);
        if (t.url && t.url.indexOf("#lfc=") !== -1) {
          await browser.tabs.update(tab.id, { url: t.url.split("#")[0] });
        }
      } catch (e) {}
      return { ok: true, reused: true };
    }
    await browser.tabs.create({
      url: base + "#lfc=open." + target + ".c",
      active: true
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
    case "getConfig":
      return browser.storage.local.get("config");
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
      // relay the request through a transient #lfc= tab.
      requestChrome("splitTab");
      return { ok: true };
    case "sessionUnsplit":
      requestChrome("unsplit");
      return { ok: true };
    case "sessionSwitchPane":
      requestChrome("switchPane", String(data.dir > 0 ? 1 : -1));
      return { ok: true };
    case "sessionSwapPane":
      requestChrome("swapSplitPanes", String(data.dir > 0 ? 1 : -1));
      return { ok: true };
    case "sessionSplitAddTabByIndex": {
      const n = Number(data && data.index);
      if (!(n >= 1 && n <= 9)) return { ok: false, note: "tab number must be 1-9" };
      requestChrome("moveToSplit", String(n));
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
      requestChrome("moveToSplit", String(n));
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
    requestChrome("switchPane", "1");
  } else if (name === "split-prev-pane") {
    requestChrome("switchPane", "-1");
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

browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
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

// Chrome helper request channel: a background tab whose URL is
// commandcenter.html#lfc=req.<action>[.<arg>]. Handle the request, then remove
// the tab. The `sessionState` request is the one exception: its reply is
// written back into the tab's hash and the chrome helper removes the tab itself
// after reading it (otherwise it would race the removal).
function b64utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

// Ask the chrome helper to do something only it can (native split view): open a
// transient background tab whose #lfc= fragment the chrome helper's progress
// listener handles; the chrome helper removes the tab itself. A safety timeout
// drops it if the chrome helper never answers.
function requestChrome(action: string, arg?: string): void {
  let frag = "lfc=" + action;
  if (arg != null && arg !== "") frag += "." + encodeURIComponent(arg);
  browser.tabs
    .create({ url: CC_URL + "#" + frag, active: false })
    .then((tab: any) => {
      // Register the relay tab id immediately so realTabsInWindow filters it
      // even while its URL is still being applied (see transientTabIds).
      if (tab && tab.id != null) transientTabIds.add(tab.id);
      setTimeout(() => {
        transientTabIds.delete(tab.id);
        browser.tabs
          .remove(tab.id)
          .catch(() => {});
      }, 5000);
    })
    .catch(() => {});
}

// Push the fresh session summary to the chrome helper's status bar after a
// session mutation that did NOT originate from the chrome helper itself (the
// helper refreshes on its own actions; content-script and options actions would
// otherwise leave its bar pointing at a stale session name). The push rides the
// same #lfc=sessionState channel the helper's own requestSessionState uses, so
// the helper updates its bar and removes the transient tab.
async function pushSessionStateToChrome(): Promise<void> {
  try {
    const state = await sessionState();
    const nonce = "push" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    requestChrome("sessionState." + b64utf8(JSON.stringify(state)), nonce);
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
  const nonce = "ls" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  requestChrome(
    "leaderState." + b64utf8(JSON.stringify({ index: index, active: active })),
    nonce
  );
}

async function handleReq(tab: any, action: string, arg: string) {
  // Every #lfc=req tab is created by the chrome helper, so handling ANY
  // request proves it is alive — flip the gate so content scripts stop
  // drawing their own status bar. The dedicated "alive" announce can race
  // the extension still loading on a cold start; every other request (e.g.
  // the startup sessionState poll) covers that window.
  if (action !== "alive") {
    markChromeAlive();
  }
  if (action === "alive") {
    markChromeAlive();
    return;
  }
  if (action === "toggleWhichKey") {
    // The chrome helper flipped its own cached copy; flip storage to match so
    // content scripts, the command center and options agree.
    const c = await getConfig();
    c.whichKey = !c.whichKey;
    await browser.storage.local.set({ config: c });
    return;
  }
  if (action === "startHints" || action === "focusFirstInput") {
    const t = await getActiveTab();
    if (!t || t.id === tab.id) return;
    try {
      await browser.tabs.sendMessage(t.id, { action: action });
    } catch (e) {}
    return;
  }
  if (action === "openOptions") {
    try {
      await browser.runtime.openOptionsPage();
    } catch (e) {}
    return;
  }
  if (action === "stealthOpen") {
    // Reply through the tab's hash so the chrome helper can toast the outcome
    // instead of failing silently; the chrome helper removes the reply tab
    // itself (see the reqResult handler).
    const r = await stealthOpen(() => pushSessionStateToChrome());
    const nonce = "req" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    await browser.tabs
      .update(tab.id, {
        url: CC_URL + "#lfc=reqResult." + b64utf8(JSON.stringify(r)) + "." + nonce
      })
      .catch(() => {});
    return;
  }
  if (action === "sessionState") {
    // Round-trip for the chrome helper's status bar: reply into the hash so the
    // helper can read the current session name + the session list.
    const state = await sessionState();
    await browser.tabs.update(tab.id, {
      url: CC_URL + "#lfc=sessionState." + b64utf8(JSON.stringify(state)) + "." + (arg || "")
    });
    return;
  }
  if (action === "sessionTabs") {
    // Round-trip for the chrome helper's sessions popup right pane: reply with
    // the requested session's tabs and let the helper remove the tab.
    // arg is "<encoded name>.<nonce>" (name may contain dots, so split from
    // the right on the nonce).
    const dot = (arg || "").lastIndexOf(".");
    const name = dot < 0 ? decodeURIComponent(arg || "") : decodeURIComponent((arg || "").slice(0, dot));
    const nonce = dot < 0 ? "" : (arg || "").slice(dot + 1);
    const items = await sessionTabs(name);
    await browser.tabs.update(tab.id, {
      url: CC_URL + "#lfc=sessionTabs." + b64utf8(JSON.stringify(items)) + "." + nonce
    });
    return;
  }
  if (action === "saveSession") {
    await saveSession(decodeURIComponent(arg || ""));
    return;
  }
  if (action === "newSession") {
    await newSession(decodeURIComponent(arg || ""));
    return;
  }
  if (action === "restoreSession") {
    await restoreSession(decodeURIComponent(arg || ""));
    return;
  }
  if (action === "alternateTab") {
    await alternateTabOp();
    return;
  }
  if (action === "restoreClosedTab") {
    await restoreClosedTab(decodeURIComponent(arg || ""));
    return;
  }
  if (action === "restoreAllClosed") {
    await restoreAllClosedTabs();
    return;
  }
  if (action === "recentlyClosed") {
    // Reply channel for the chrome helper's recently-closed popup (mirrors
    // sessionTabs): write the rows into the tab's hash; the chrome helper
    // removes the tab after reading it.
    const items = await recentlyClosed();
    await browser.tabs.update(tab.id, {
      url: CC_URL + "#lfc=recentlyClosed." + b64utf8(JSON.stringify(items)) + "." + (arg || "")
    });
    return;
  }
  if (action === "removeHistory") {
    await removeHistory(decodeURIComponent(arg || ""));
    return;
  }
  if (action === "clearHistory") {
    await clearHistory();
    return;
  }
  if (action === "deleteSession") {
    await deleteSession(decodeURIComponent(arg || ""));
    return;
  }
  if (action === "switchSessionByMarker") {
    await switchSessionByMarker(parseInt(arg || "0", 10));
    return;
  }
  if (action === "assignSessionMarker") {
    const raw = decodeURIComponent(arg || "");
    const sep = raw.indexOf("\u0001");
    const nm = sep < 0 ? raw : raw.slice(0, sep);
    const mk = sep < 0 ? 0 : parseInt(raw.slice(sep + 1), 10);
    await assignSessionMarker(nm, mk);
    return;
  }
  if (action === "sessionTabCopy" || action === "sessionTabMove") {
    const raw = decodeURIComponent(arg || "");
    const p1 = raw.indexOf("\u0001");
    const p2 = p1 < 0 ? -1 : raw.indexOf("\u0001", p1 + 1);
    const from = p1 < 0 ? raw : raw.slice(0, p1);
    const idx = p1 < 0 ? -1 : p2 < 0 ? parseInt(raw.slice(p1 + 1), 10) : parseInt(raw.slice(p1 + 1, p2), 10);
    const to = p2 < 0 ? "" : raw.slice(p2 + 1);
    await moveTabBetweenSessions(from, idx, to, action === "sessionTabCopy" ? "copy" : "move");
    return;
  }
  if (action === "quit") {
    await quitBrowser();
    return;
  }
}

browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
  if (info.status !== "complete" || !tab || !tab.url) return;
  if (stripHash(tab.url) !== CC_URL) return;
  const m = /#lfc=req[.]([a-zA-Z]+)(?:[.]([^#]*))?$/.exec(tab.url);
  if (!m) return;
  // sessionState, sessionTabs and stealthOpen write their reply into the tab's
  // hash and let the chrome helper remove the tab after reading it.
  const keepOpen =
    m[1] === "sessionState" ||
    m[1] === "sessionTabs" ||
    m[1] === "stealthOpen" ||
    m[1] === "recentlyClosed";
  handleReq(tab, m[1]!, m[2] || "")
    .catch(() => {})
    .then(() => {
      if (!keepOpen) return browser.tabs.remove(tabId).catch(() => {});
    });
});

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

// Chrome helper absent unless it pings "alive" on window startup; clear the gate
// so a stale flag never permanently disables content-side handling.
browser.runtime.onStartup.addListener(() => {
  browser.storage.local.set({ chromeAlive: false }).catch(() => {});
  checkChromeLayerHealth();
  void reconcileStealth();
});

// Update-survivability: the chrome helper announces "alive" on every window
// startup (retrying every 500ms until the extension URL resolves). If it used
// to announce (chromeEverAlive) but stays silent through the startup window,
// a Firefox update very likely broke the autoconfig loader — the exact
// silent-death failure of Firefox 155 (bug 1974213). Tell the user instead of
// letting every chrome-only feature degrade to standalone mode with no sign.
function markChromeAlive(): void {
  browser.storage.local
    .set({ chromeAlive: true, chromeEverAlive: true })
    .catch(() => {});
}

function checkChromeLayerHealth(): void {
  browser.storage.local
    .get("chromeEverAlive")
    .then((r: { chromeEverAlive?: boolean }) => {
      // Never loaded even once (fresh install, standalone-only user): the
      // extension alone is the intended state, so stay quiet.
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
              "Firefox may have updated and broken the loader. Re-run the Lazyfox installer to repair it.",
          });
        } catch (e) {
          // never let the check break startup
        }
      }, 15000);
    })
    .catch(() => {});
}
// Also reconcile on background load (covers install/reload and the very first
// launch after enabling the feature) — idempotent.
void reconcileStealth();

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
browser.tabs.onUpdated.addListener((tabId: number, info: any) => {
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
