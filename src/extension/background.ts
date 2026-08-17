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
import { CC_URL, getActiveTab, isCommandCenter, realTabsInWindow, stripHash } from "./tabs";
import { bookmarksSearch, doSearch, historySearch, searchUrlFor, suggestSearch, suggestUrls } from "./search";
import {
  activateTabByIndex,
  getWindowSize,
  moveWindow,
  reopenTab,
  resizeWindow,
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
  switchSessionByMarker
} from "./sessions";

const HOMEISH = /^about:(home|newtab|blank)$/i;

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

function maybeConvertHome(tab: any) {
  if (isRestoring()) return Promise.resolve();
  if (!tab || !tab.url || !HOMEISH.test(tab.url)) return Promise.resolve();
  // A blank/home tab that is already navigating somewhere (e.g.
  // browser.search.search opening a results tab) must be left alone — only
  // idle blank/home tabs are converted.
  if (tab.pendingUrl && tab.pendingUrl !== tab.url) return Promise.resolve();
  if (tab.url === "about:blank") {
    // about:blank is frequently a transient placeholder (search results,
    // in-flight navigations); convert it only once it has been idle briefly.
    const id = tab.id;
    setTimeout(() => {
      browser.tabs
        .get(id)
        .then((t: any) => {
          if (t && t.url === "about:blank" && !(t.pendingUrl && t.pendingUrl !== t.url)) {
            return browser.tabs.update(id, { url: CC_URL });
          }
        })
        .catch(() => {});
    }, 500);
    return Promise.resolve();
  }
  return browser.tabs.update(tab.id, { url: CC_URL }).catch(() => {});
}

browser.tabs.onUpdated.addListener((tabId: number, info: any, tab: any) => {
  if (isRestoring()) return;
  if (info.status === "complete" && tab && tab.active) maybeConvertHome(tab);
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
      setTimeout(() => {
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

async function handleReq(tab: any, action: string, arg: string) {
  // Every #lfc=req tab is created by the chrome helper, so handling ANY
  // request proves it is alive — flip the gate so content scripts stop
  // drawing their own status bar. The dedicated "alive" announce can race
  // the extension still loading on a cold start; every other request (e.g.
  // the startup sessionState poll) covers that window.
  if (action !== "alive") {
    browser.storage.local.set({ chromeAlive: true }).catch(() => {});
  }
  if (action === "alive") {
    await browser.storage.local.set({ chromeAlive: true });
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
  const keepOpen = m[1] === "sessionState" || m[1] === "sessionTabs" || m[1] === "stealthOpen";
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
  void reconcileStealth();
});
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
