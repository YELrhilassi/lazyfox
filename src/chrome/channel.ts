// The #lfc= URL channel between the chrome helper and the extension
// background. The chrome helper cannot use browser.runtime directly, so it
// opens transient commandcenter tabs whose URL hash carries a request
// (`#lfc=req.<action>.<arg>`), the background answers by navigating the tab to
// a reply hash, and the progress listener routes that reply here.
//
// This module owns the channel primitives (base URL resolution, requestBg,
// requestSessionState with its one-shot waiters, setHash, removeReqTab) and
// the handleLfc router that dispatches every reply. The debug/verification
// commands (reveal/console/diag/state) live in debug.ts; the session/split
// relays and the status-bar reply are handled here.

import { mergeConfig, mergeHotkeys } from "../shared/config";
import { openBookmarksPopup, openDownloadsPopup, openHistoryPopup, openSearchPopup, openTabsPopup, openUrlPopup, type PopupCtx } from "../shared/popups";
import type { ChromeHotkeys, Config, PopupItem } from "../shared/types";
import { applyHoverRevealPref, type ChromeCfg } from "./config";
import type { DebugHandlers } from "./debug";
import type { SplitView } from "./splitview";
import type { StatusBarCtl } from "./statusbar";

export interface ChannelDeps {
  // The popup context (built by main) — used to open search/url/tabs/... popups.
  ctx: PopupCtx;
  // The chrome ops adapter (built by ops.ts, wired by main).
  ops: {
    openTarget(which: string): boolean;
    openResize(): void;
  };
  split: SplitView;
  status: StatusBarCtl;
  cfg: ChromeCfg;
  debug: DebugHandlers;
}

export interface Channel {
  ccBaseUrl(): string | null;
  // Opens a transient #lfc=req tab for the background. Returns whether the
  // request tab was actually created, so callers (the alive announce) can
  // retry a failed send instead of assuming it landed.
  requestBg(action: string, arg?: string): boolean;
  requestSessionState(): Promise<void>;
  // Fetches one named session's tabs (for the sessions popup's right pane).
  requestSessionTabs(name: string): Promise<PopupItem[]>;
  setHash(browser: any, hash: string): void;
  handleLfc(browser: any, payload: string): void;
}

const EXT_ID = "lazyfox@lazyfox.dev";

export function createChannel(deps: ChannelDeps): Channel {
  // One-shot waiters for requestSessionState, keyed by nonce, resolved by the
  // handleLfc "sessionState" reply. Lets the sessions popup await a FRESH
  // list after a delete/save instead of reading the stale cache (which made a
  // deleted session keep showing until the next Firefox restart).
  let sessionStateWaiters: Record<string, () => void> = {};
  // One-shot waiters for requestSessionTabs, resolved by the handleLfc
  // "sessionTabs" reply with the session's tab rows.
  let sessionTabsWaiters: Record<string, (items: PopupItem[]) => void> = {};

  function ccBaseUrl(): string | null {
    try {
      const p = WebExtensionPolicy.getByID(EXT_ID);
      if (p) return p.getURL("");
    } catch (e) {
      // fall through to tab scan
    }
    for (const t of window.gBrowser.tabs) {
      try {
        const s = t.linkedBrowser.currentURI.spec;
        const i = s.indexOf("commandcenter.html");
        if (s.indexOf("moz-extension://") === 0 && i !== -1) {
          return s.slice(0, i);
        }
      } catch (e) {
        // skip tab
      }
    }
    return null;
  }

  function requestBg(action: string, arg?: string): boolean {
    const base = ccBaseUrl();
    if (!base) return false;
    let frag = "lfc=req." + action;
    if (arg != null && arg !== "") frag += "." + encodeURIComponent(arg);
    try {
      const tab = window.gBrowser.addTab(base + "commandcenter.html#" + frag, {
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      // Background removes the request tab after handling; give it a safety timeout.
      setTimeout(() => {
        try {
          if (tab && !tab.closing) window.gBrowser.removeTab(tab);
        } catch (e) {
          // ignore
        }
      }, 3000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function requestSessionState(): Promise<void> {
    const base = ccBaseUrl();
    if (!base) return Promise.resolve();
    const nonce = "ss" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    return new Promise((resolve) => {
      sessionStateWaiters[nonce] = resolve;
      try {
        const tab = window.gBrowser.addTab(
          base + "commandcenter.html#lfc=req.sessionState." + nonce,
          {
            inBackground: true,
            skipAnimation: true,
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          }
        );
        // Safety net: if the reply never arrives, drop the request tab.
        setTimeout(() => {
          try {
            if (tab && !tab.closing) window.gBrowser.removeTab(tab);
          } catch (e) {
            // ignore
          }
          if (sessionStateWaiters[nonce]) {
            delete sessionStateWaiters[nonce];
            resolve();
          }
        }, 5000);
      } catch (e) {
        if (sessionStateWaiters[nonce]) {
          delete sessionStateWaiters[nonce];
          resolve();
        }
      }
    });
  }

  function requestSessionTabs(name: string): Promise<PopupItem[]> {
    const base = ccBaseUrl();
    if (!base) return Promise.resolve([]);
    const nonce = "st" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    return new Promise((resolve) => {
      sessionTabsWaiters[nonce] = resolve;
      try {
        const tab = window.gBrowser.addTab(
          base + "commandcenter.html#lfc=req.sessionTabs." + encodeURIComponent(name) + "." + nonce,
          {
            inBackground: true,
            skipAnimation: true,
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          }
        );
        // Safety net: if the reply never arrives, drop the request tab.
        setTimeout(() => {
          try {
            if (tab && !tab.closing) window.gBrowser.removeTab(tab);
          } catch (e) {
            // ignore
          }
          if (sessionTabsWaiters[nonce]) {
            delete sessionTabsWaiters[nonce];
            resolve([]);
          }
        }, 5000);
      } catch (e) {
        if (sessionTabsWaiters[nonce]) {
          delete sessionTabsWaiters[nonce];
          resolve([]);
        }
      }
    });
  }

  function setHash(browser: any, hash: string): void {
    try {
      const cw = browser.contentWindow;
      if (cw && cw.location) {
        cw.location.replace(cw.location.href.split("#")[0] + hash);
        return;
      }
    } catch (e) {
      // ignore
    }
  }

  function handleOpen(target: string, browser: any): void {
    const closeCc = target.indexOf("c") !== -1;
    const which = target.split(".")[0]!;
    const POPUP_ACTIONS: Record<string, () => void> = {
      search: () => openSearchPopup(deps.ctx),
      url: () => openUrlPopup(deps.ctx),
      tabs: () => openTabsPopup(deps.ctx),
      history: () => openHistoryPopup(deps.ctx),
      bookmarks: () => openBookmarksPopup(deps.ctx),
      downloads: () => openDownloadsPopup(deps.ctx),
      resize: () => deps.ops.openResize(),
    };
    const fn = POPUP_ACTIONS[which];
    if (fn) {
      fn();
    } else {
      deps.ops.openTarget(which);
    }
    if (closeCc && browser) {
      try {
        const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
        if (tab) window.gBrowser.removeTab(tab);
      } catch (e) {
        // ignore
      }
    }
  }

  // Drop the transient #lfc request tab after the chrome helper handles it.
  function removeReqTab(browser: any): void {
    try {
      const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
      if (tab) window.gBrowser.removeTab(tab);
    } catch (e) {
      // ignore
    }
  }

  function handleLfc(browser: any, payload: string): void {
    const idx = payload.indexOf(".");
    const cmd = idx < 0 ? payload : payload.slice(0, idx);
    const rest = idx < 0 ? "" : payload.slice(idx + 1);
    if (cmd === "open") {
      handleOpen(rest, browser);
      return;
    }
    if (cmd === "reveal" || cmd === "console" || cmd === "diag" || cmd === "state") {
      deps.debug.handle(browser, cmd, rest, setHash);
      return;
    }
    if (cmd === "moveToSplit") {
      // ;+1-9 relayed from the background (or the split panel): move tab N
      // into the active split view, then remove the request tab.
      try {
        deps.split.addTabToSplitByIndex(parseInt(rest, 10) || 0);
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "splitTab") {
      // ;| relayed from the background (content-script context).
      try {
        deps.split.splitCurrentTab("horizontal");
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "unsplit") {
      // ;\ relayed from the background.
      try {
        deps.split.unsplit();
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "switchPane") {
      // ;[ / ;] relayed from the background.
      try {
        deps.split.switchPane(parseInt(rest, 10) || 1);
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "restoreSplits") {
      // Session restore finished opening tabs; re-create the native split
      // groupings. `rest` is JSON of [[index, ...], ...] with 1-based
      // positions over the SAVED tab list.
      try {
        deps.split.restoreSplits(decodeURIComponent(rest));
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "swapSplitPanes") {
      // ;{ / ;} relayed from the background (content-script context): swap
      // the active pane with its left/right neighbour.
      try {
        deps.split.swapPane(parseInt(rest, 10) || 1);
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "sessionState") {
      // Status-bar reply from the background: sessionState.<b64>.<nonce>.
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      const nonce = dot < 0 ? "" : rest.slice(dot + 1);
      deps.status.applySessionState(b64);
      const w = sessionStateWaiters[nonce];
      if (w) {
        delete sessionStateWaiters[nonce];
        w();
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "sessionTabs") {
      // Reply to requestSessionTabs: sessionTabs.<b64>.<nonce>.
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      const nonce = dot < 0 ? "" : rest.slice(dot + 1);
      let items: PopupItem[] = [];
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        items = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        items = [];
      }
      const w = sessionTabsWaiters[nonce];
      if (w) {
        delete sessionTabsWaiters[nonce];
        w(items || []);
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "reqResult") {
      // Async reply to a chrome-helper request (e.g. stealthOpen): toast the
      // outcome so a failure is never silent, then drop the reply tab.
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const r = JSON.parse(new TextDecoder().decode(bytes));
        if (r && r.ok === true) deps.debug.toast("stealth tab opened");
        else deps.debug.toast("stealth tab failed: " + ((r && r.error) || "unknown"));
      } catch (e) {
        // ignore
      }
      removeReqTab(browser);
      return;
    }
    if (cmd === "cfg") {
      const dot = rest.indexOf(".");
      const nonce = dot < 0 ? rest : rest.slice(0, dot);
      const json = dot < 0 ? "" : decodeURIComponent(rest.slice(dot + 1));
      let reply = "ok";
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          if (parsed.bindings && typeof parsed.bindings === "object") {
            deps.cfg.bindings = mergeHotkeys(parsed.bindings as Partial<ChromeHotkeys>);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(deps.cfg.bindings));
          } else {
            deps.cfg.bindings = mergeHotkeys(parsed as Partial<ChromeHotkeys>);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(deps.cfg.bindings));
          }
          if (parsed.config && typeof parsed.config === "object") {
            deps.cfg.config = mergeConfig(parsed.config as Partial<Config>);
            Services.prefs.setStringPref("lazyfox.chrome.config", JSON.stringify(deps.cfg.config));
            applyHoverRevealPref(deps.cfg);
          }
        }
      } catch (e) {
        reply = "err";
      }
      setHash(browser, "#lfc=" + reply + "." + nonce);
    }
  }

  return {
    ccBaseUrl,
    requestBg,
    requestSessionState,
    requestSessionTabs,
    setHash,
    handleLfc,
  };
}
