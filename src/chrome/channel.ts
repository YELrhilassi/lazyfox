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
  // The chrome window's capture-phase keydown dispatch (leader, popups,
  // hotkeys, typing guard). Returns whether the key was consumed; the #lfc=
  // keys channel runs it so synthesized keys exercise the real code path.
  keys: {
    dispatch(e: {
      key: string;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      metaKey: boolean;
      isComposing: boolean;
    }): boolean;
  };
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
  requestRecentlyClosed(): Promise<PopupItem[]>;
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
  // One-shot waiters for requestRecentlyClosed, resolved by the handleLfc
  // "recentlyClosed" reply with the closed-tab rows.
  let recentlyClosedWaiters: Record<string, (items: PopupItem[]) => void> = {};

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

  function requestRecentlyClosed(): Promise<PopupItem[]> {
    const base = ccBaseUrl();
    if (!base) return Promise.resolve([]);
    const nonce = "rc" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    return new Promise((resolve) => {
      recentlyClosedWaiters[nonce] = resolve;
      try {
        const tab = window.gBrowser.addTab(
          base + "commandcenter.html#lfc=req.recentlyClosed." + nonce,
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
          if (recentlyClosedWaiters[nonce]) {
            delete recentlyClosedWaiters[nonce];
            resolve([]);
          }
        }, 5000);
      } catch (e) {
        if (recentlyClosedWaiters[nonce]) {
          delete recentlyClosedWaiters[nonce];
          resolve([]);
        }
      }
    });
  }

  function setHash(browser: any, hash: string): void {
    // Defer the reply by one macrotask: a synchronous location.replace here
    // re-enters the very WebDriver command (navigate / script.evaluate) that
    // triggered this request, and the re-entrant navigation leaves that
    // command waiting for a load that never fires (Firefox 155 / geckodriver
    // 0.37). The harness reads the reply hash asynchronously, so the defer is
    // invisible to it.
    setTimeout(() => {
      try {
        const cw = browser.contentWindow;
        if (cw && cw.location) {
          cw.location.replace(cw.location.href.split("#")[0] + hash);
        }
      } catch (e) {
        // ignore
      }
    }, 0);
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

  // Apply the Shift modifier to a printable key the way a real keyboard does
  // (the harness asks for `;|` as key "\\" + shift, `;+` as "=" + shift). The
  // real key path has Firefox compute the shifted character; the synthetic
  // #lfc=keys path must do it itself or the leader sees "\\" instead of "|".
  function shiftedKey(key: string): string {
    if (key.length !== 1) return key;
    if (key >= "a" && key <= "z") return key.toUpperCase();
    const map: Record<string, string> = {
      "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%",
      "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
      "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|",
      ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
    };
    return map[key] || key;
  }

  // Key names -> DOM_VK_ key codes for sendKeyEvent (printable chars use
  // charCode with keyCode 0).
  const SPECIAL_KEYS: Record<string, number> = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
  };

  // Synthesize a key sequence through the trusted input path (sendKeyEvent),
  // so the chrome document's capture-phase keydown listener AND the focused
  // page see exactly what a real key produces. The e2e harness drives the
  // command center this way because geckodriver's BiDi input is rejected on
  // moz-extension ("privileged scope") contexts and Marionette keys never
  // reach the chrome window's listener (so the helper's leader/popups — the
  // real user code path — would never see the leader key).
  // Build a synthetic KeyboardEvent matching a key spec, dispatching through
  // the normal DOM path so a page's window/document keydown listeners see it.
  // The constructor comes from the TARGET window's realm: an event created
  // with the chrome window's KeyboardEvent and dispatched into a content
  // document is invisible to the page's listeners (its internal Window is the
  // creator's), which is exactly what broke cross-realm dispatch.
  function buildKeyEvent(
    type: string,
    ev: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
    ctor: typeof KeyboardEvent = KeyboardEvent
  ): KeyboardEvent {
    const keyCode = SPECIAL_KEYS[ev.key] !== undefined ? SPECIAL_KEYS[ev.key] : ev.key.length === 1 ? ev.key.toUpperCase().charCodeAt(0) : 0;
    const charCode = ev.key.length === 1 ? ev.key.charCodeAt(0) : 0;
    return new ctor(type, {
      key: ev.key,
      code: ev.key,
      keyCode,
      which: keyCode || charCode,
      charCode,
      bubbles: true,
      cancelable: true,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
    });
  }

  // Synthetic (untrusted) key events never run the browser's native text
  // insertion, which pages rely on for typing. Emulate it exactly: only when
  // the keydown was NOT defaultPrevented (the page left the default action
  // to the browser) and the target is a text field, insert the character.
  function maybeInsertText(
    target: Element | null,
    ev: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
    notCanceled: boolean
  ): void {
    if (!notCanceled || !target) return;
    if (ev.key.length !== 1 || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    try {
      const tag = String(target.tagName || "").replace(/^.*:/, "").toUpperCase();
      const input = tag === "INPUT" || tag === "TEXTAREA"
        ? (target as HTMLInputElement)
        : target.closest && target.closest("input, textarea")
          ? (target.closest("input, textarea") as HTMLInputElement)
          : null;
      if (!input || input.readOnly || input.disabled) return;
      const s = input.selectionStart == null ? input.value.length : input.selectionStart;
      const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      input.value = input.value.slice(0, s) + ev.key + input.value.slice(en);
      try {
        input.setSelectionRange(s + 1, s + 1);
      } catch (e) {
        // ignore
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (e) {
      // ignore
    }
  }

  // Deliver an unconsumed key to wherever focus lives: the chrome popup input
  // when a popup is open, otherwise the target tab's content (the command
  // center). This mirrors what a real key would do after the chrome capture
  // listener lets it through. `targetTab` is the tab the harness asked to
  // address (defaults to the selected tab) — the chrome-level dispatch runs on
  // the REAL selection (so relative actions like ;[/;] switch the actual active
  // pane), but a key the chrome layer lets through lands in the addressed tab.
  function dispatchToFocused(
    ev: {
      key: string;
      shiftKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      metaKey: boolean;
    },
    targetTab: any
  ): void {
    try {
      const popupInput = document.querySelector(".lf-input") as HTMLElement | null;
      if (popupInput) {
        // No keypress: the editor inserts text natively on a trusted keypress,
        // so a synthetic one would double-insert alongside maybeInsertText.
        // Neither the command center nor the popups listen to keypress.
        const notCanceled = popupInput.dispatchEvent(buildKeyEvent("keydown", ev));
        popupInput.dispatchEvent(buildKeyEvent("keyup", ev));
        maybeInsertText(popupInput, ev, notCanceled);
        return;
      }
    } catch (e) {
      // fall through to content
    }
    try {
      const tab = targetTab || (window.gBrowser && window.gBrowser.selectedTab);
      const cw = tab && tab.linkedBrowser && tab.linkedBrowser.contentWindow;
      if (cw && cw.document) {
        const ctor = (cw as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent || KeyboardEvent;
        const target = cw.document.activeElement || cw.document.documentElement;
        // No keypress (see the popup path): a synthetic keypress with a
        // charCode makes the editor insert the text natively, double-inserting
        // alongside maybeInsertText.
        const notCanceled = target.dispatchEvent(buildKeyEvent("keydown", ev, ctor));
        target.dispatchEvent(buildKeyEvent("keyup", ev, ctor));
        maybeInsertText(target, ev, notCanceled);
      }
    } catch (e) {
      // ignore
    }
  }

  function handleKeys(browser: any, rest: string, setHash: (b: any, h: string) => void): void {
    // Reply loop guard: our own reply hash (keys.ok.<nonce>) re-enters via
    // onLocationChange. base64 payloads never start with "ok."/"err.".
    if (rest.startsWith("ok.") || rest.startsWith("err.")) return;
    const dot = rest.indexOf(".");
    const payload = dot < 0 ? rest : rest.slice(0, dot);
    const nonce = dot < 0 ? "" : rest.slice(dot + 1);
    let req: { idx?: number; keys?: Array<{ k: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }> } = {};
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      req = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      setHash(browser, "#lfc=keys.err." + nonce);
      return;
    }
    const seq = Array.isArray(req.keys) ? req.keys : [];
    try {
      Services.console.logStringMessage("lazyfox keys: got " + seq.map((k: any) => k.k).join(","));
    } catch (e) {}
    const errReply = (e: unknown): void => {
      try {
        Services.console.logStringMessage("lfc keys error: " + String((e && (e as Error).message) || e));
      } catch (e2) {
        // ignore
      }
      setHash(browser, "#lfc=keys.err." + nonce);
    };
    // Resolve the tab the harness addressed (idx -1 means the selected tab).
    // The chrome key dispatch runs on the REAL current selection, so leader
    // actions that are relative to the active pane (;[/;], ;+N, ;|) work on
    // whatever pane is actually active; only keys the chrome layer lets through
    // (typing) are routed to the addressed tab's content. Never force-select
    // req.idx here: that would reset the active pane mid-split and make ;[ /
    // ;] switch from the wrong pane (and it undid ;c's selection of the copy).
    let targetTab: any = window.gBrowser && window.gBrowser.selectedTab;
    try {
      if (typeof req.idx === "number" && req.idx >= 0 && window.gBrowser.tabs[req.idx]) {
        targetTab = window.gBrowser.tabs[req.idx];
      }
    } catch (e) {
      // ignore
    }
    let i = 0;
    const step = (): void => {
      if (i >= seq.length) {
        setHash(browser, "#lfc=keys.ok." + nonce);
        return;
      }
      const k = seq[i++] || { k: "" };
      try {
        const ev = {
          key: k.shift ? shiftedKey(k.k) : k.k,
          ctrlKey: !!k.ctrl,
          altKey: !!k.alt,
          shiftKey: !!k.shift,
          metaKey: !!k.meta,
          isComposing: false,
        };
        const consumed = deps.keys.dispatch(ev);
        if (!consumed) dispatchToFocused(ev, targetTab);
      } catch (e) {
        errReply(e);
        return;
      }
      setTimeout(step, 20);
    };
    step();
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
    if (cmd === "keys") {
      handleKeys(browser, rest, setHash);
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
    if (cmd === "leaderState") {
      // Content-script leader arm/disarm relayed from the background
      // (leaderState.<b64>.<nonce>): cache it per tab-strip index so the
      // window-level status bar can show the pulsing LEADER chevron on web
      // pages, then drop the request tab.
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      let st: { index?: number; active?: boolean } | null = null;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        st = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        st = null;
      }
      if (st && typeof st.index === "number" && st.index >= 0) {
        deps.status.setContentLeader(st.index, !!st.active);
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
    if (cmd === "recentlyClosed") {
      // Reply to requestRecentlyClosed: recentlyClosed.<b64>.<nonce>.
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
      const w = recentlyClosedWaiters[nonce];
      if (w) {
        delete recentlyClosedWaiters[nonce];
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
    requestRecentlyClosed,
    setHash,
    handleLfc,
  };
}
