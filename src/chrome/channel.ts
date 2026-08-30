// The persistent relay channel between the chrome helper and the extension
// background (see docs/MESSAGING.md for the full design).
//
// The chrome helper cannot use browser.runtime directly, so historically every
// helper<->background message opened a throwaway commandcenter tab whose URL
// hash carried the payload (`#lfc=req.<action>…`). That created/removed a tab
// PER MESSAGE — the empty tabs users saw flashing open and auto-close, plus a
// timing-sensitive handshake (a reply racing the removal, safety timeouts
// dropping late requests).
//
// Today ONE hidden relay tab (relay.html) carries everything. The helper
// reaches the relay page's window directly (postMessage); the page holds a
// long-lived runtime port to the background and forwards traffic both ways.
// Nothing is created or removed per message.
//
// This module owns the helper side of the channel: relay resolution/creation,
// the message bridge (req/resp/cmd/ready), the reply waiters, and the command
// dispatcher for background->chrome pushes. The deliberate per-message URL
// channels that ride REAL tabs (the #lfc=keys test synthesizer, the #lfc=state
// debug query, #lfc=cfg, #lfc=open) are handled here too, in handleLfc.

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
  // Ensure the persistent relay tab exists and the message bridge is attached
  // (idempotent; self-heals if the relay tab died). Returns whether the relay
  // is usable.
  startRelay(): boolean;
  // Fire-and-forget request to the background (the alive announce, session
  // ops, ...). Returns whether the request was accepted by the relay.
  requestBg(action: string, arg?: string): boolean;
  // True once the relay has actually connected its port (ready), i.e.
  // requestBg is being delivered rather than buffered. Callers use this to
  // decide whether a fire-and-forget request actually reached the background
  // (the alive announce must only latch when the message was REALLY delivered,
  // not merely queued — otherwise a cold-start drop leaves chromeAlive false
  // forever and content scripts keep drawing a second status bar).
  relayReady(): boolean;
  // Request with a reply (the background's response resolves the promise).
  // Resolves null on timeout / relay failure — callers must tolerate that.
  requestReply(action: string, arg?: string): Promise<any>;
  requestSessionState(): Promise<void>;
  // Fetches one named session's tabs (for the sessions popup's right pane).
  requestSessionTabs(name: string): Promise<PopupItem[]>;
  requestRecentlyClosed(): Promise<PopupItem[]>;
  setHash(browser: any, hash: string): void;
  // Routes a #lfc= payload from a REAL tab (keys/state/cfg/open/debug).
  handleLfc(browser: any, payload: string): void;
  // Debug/verification: the helper's view of the relay (found window, ready
  // flag, tab list) — surfaced through the #lfc=state channel.
  relayDebug(): any;
}

const EXT_ID = "lazyfox@lazyfox.dev";
// How long a request may sit queued before the relay becomes ready, and how
// long a reply-bearing request waits for its response.
const RELAY_TIMEOUT = 6000;

export function createChannel(deps: ChannelDeps): Channel {
  // The relay tab's contentWindow (resolved lazily, re-created on demand).
  let relayWin: any = null;
  // True once the relay page has connected its runtime port (it announces via
  // a "ready" message and a __lfxReady flag the helper can read directly).
  let relayReady = false;
  // Fire-and-forget requests queued while the relay is still coming up.
  let pendingReqs: Array<{ action: string; arg?: string }> = [];
  // Reply waiters keyed by request id, resolved by the "resp" message.
  let relaySeq = 0;
  const relayWaiters: Record<number, { resolve: (v: any) => void; timer: any }> = {};

  function ccBaseUrl(): string | null {
    // Primary: resolve the extension's policy directly. Firefox's
    // WebExtensionPolicy.getByID() keys on the add-on's moz-extension HOSTNAME
    // UUID (e.g. ebf1759a-…), not the email-style add-on id, so on a permanent
    // install it can return null for EXT_ID. Iterate the active policies and
    // match by the add-on id — the field that is ALWAYS the email id we ship —
    // so the helper resolves its base URL on a cold boot even with no
    // extension page tab open (no commandcenter yet). This is what lets the
    // alive announce + relay come up on a real interactive session; relying
    // only on getByID + a commandcenter-tab scan left the announce stuck and a
    // second content status bar drawn.
    try {
      const policies = WebExtensionPolicy.getActiveExtensions();
      for (const p of policies) {
        if (p && p.id === EXT_ID) return p.getURL("");
      }
    } catch (e) {
      // fall through to getByID then tab scan
    }
    // Secondary: getByID by id (works for some installs), then fall back to
    // scanning for an open commandcenter/relay/extension page tab.
    try {
      const p = WebExtensionPolicy.getByID(EXT_ID);
      if (p) return p.getURL("");
    } catch (e) {
      // fall through to tab scan
    }
    for (const t of window.gBrowser.tabs) {
      try {
        const s = t.linkedBrowser.currentURI.spec;
        if (s.indexOf("moz-extension://") !== 0) continue;
        // Any extension page tab works — commandcenter, relay, setup, options.
        if (
          s.indexOf("commandcenter.html") !== -1 ||
          s.indexOf("relay.html") !== -1 ||
          s.indexOf("setup.html") !== -1 ||
          s.indexOf("options") !== -1
        ) {
          // base = moz-extension://<hostname>/  (slice past hostname to slash).
          const host = s.indexOf("//") + 2;
          const slash = s.indexOf("/", host);
          return slash < 0 ? s : s.slice(0, slash + 1);
        }
      } catch (e) {
        // skip tab
      }
    }
    return null;
  }

  /* ===================== relay bridge ===================== */

  // The relay tab is identified by its page name (relay.html) — its URL never
  // changes, so scanning is unambiguous even while messages are in flight.
  // The <browser>'s contentWindow object is REPLACED when the page commits
  // (the initial about:blank window dies), so the window must be re-resolved
  // from the tab on every use — never cached from creation time.
  const relayBrowsers = new Set<any>();

  // Any live <browser> in this window whose tab is a relay page — the one true
  // answer to "do we already have a relay?", regardless of which side created
  // it (chrome helper via addTab, or the background via browser.tabs.create).
  // Returns { browser, tab } or null.
  function findRelayTab(): { browser: any; tab: any } | null {
    try {
      for (const t of window.gBrowser.tabs) {
        const b = t.linkedBrowser;
        if (!b) continue;
        let isRelay = false;
        try {
          isRelay = b.currentURI.spec.indexOf("relay.html") !== -1;
        } catch (e) {
          // ignore
        }
        // A relay tab created a moment ago may still show about:blank; the
        // created-browsers set covers that window.
        if (!isRelay && relayBrowsers.has(b)) isRelay = true;
        if (!isRelay) continue;
        // A relay must carry the extension's page (never a stale leftover);
        // check the created set OR a committed relay URL.
        return { browser: b, tab: t };
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  function findRelayWindow(): any {
    // Prune browsers whose tab is gone (a relay recreated after a death).
    for (const b of relayBrowsers) {
      try {
        if (!window.gBrowser.tabs.some((t: any) => t.linkedBrowser === b)) relayBrowsers.delete(b);
      } catch (e) {
        relayBrowsers.delete(b);
      }
    }
    const r = findRelayTab();
    if (!r) return null;
    relayBrowsers.add(r.browser);
    return r.browser.contentWindow;
  }

  function createRelayTab(): void {
    // One relay per window, ever: if a relay already exists (helper-created or
    // background-created), never add another. Before this guard, a 500ms poll
    // that ran before the first relay's page committed (currentURI was still
    // about:blank) could spawn a duplicate relay tab every tick — the "tabs
    // flashing open and closed" + one content process per stray tab.
    if (findRelayTab()) return;
    const base = ccBaseUrl();
    if (!base) return;
    try {
      const tab = window.gBrowser.addTab(base + "relay.html", {
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      if (tab && tab.linkedBrowser) relayBrowsers.add(tab.linkedBrowser);
    } catch (e) {
      // ignore
    }
  }

  function flushPending(): void {
    if (!relayReady || !relayWin) return;
    const q = pendingReqs;
    pendingReqs = [];
    for (const r of q) postReq(r.action, r.arg);
  }

  function postReq(action: string, arg?: string): void {
    const w = relayWin;
    if (!w) return;
    try {
      w.postMessage({ lfx: { type: "req", id: 0, action: action, arg: arg != null ? arg : "" } }, "*");
    } catch (e) {
      // ignore
    }
  }

  function onRelayMessage(e: any): void {
    const d = e && e.data;
    if (!d || typeof d !== "object" || !d.lfx || typeof d.lfx !== "object") return;
    const m = d.lfx;
    if (m.type === "ready") {
      relayReady = true;
      flushPending();
      return;
    }
    if (m.type === "resp") {
      const w = relayWaiters[m.id];
      if (w) {
        clearTimeout(w.timer);
        delete relayWaiters[m.id];
        w.resolve(m.error !== undefined ? null : m.result !== undefined ? m.result : null);
      }
      return;
    }
    if (m.type === "cmd") {
      handleCmd(m.action, m.arg);
    }
  }

  // The relay page is content: the helper's view of its window is an Xray
  // wrapper, which HIDES expando properties the page script set (__lfxReady).
  // Read them through wrappedJSObject, or the helper can never see the page
  // become ready (and the 500ms poll would reset relayReady to false forever,
  // leaving every request queued).
  function rawWindow(w: any): any {
    try {
      return (w && w.wrappedJSObject) || w;
    } catch (e) {
      return w;
    }
  }

  function startRelay(): boolean {
    if (!ccBaseUrl()) return false;
    const w = findRelayWindow();
    if (!w) {
      // No relay yet: create the tab (if needed) and let a later poll pick up
      // the live window once the page commits. Creating is enough for the
      // caller to consider the relay accepted — requests queue until ready.
      createRelayTab();
      return true;
    }
    // Re-attach + re-read readiness on every call: the contentWindow is
    // replaced when the page loads, and the page connects after we may have
    // first seen the tab. addEventListener on the same window twice is a
    // no-op, so this is cheap and idempotent.
    if (w !== relayWin) {
      relayWin = w;
      relayReady = false;
    }
    try {
      (w as any).addEventListener("message", onRelayMessage);
    } catch (e) {
      // ignore
    }
    // Announce our listener: the relay page buffers background -> chrome
    // commands until the helper is attached (a session restore recreates the
    // relay tab, so the page is live a beat before the helper re-resolves
    // it), then flushes them. Idempotent — the page treats every hello the
    // same, and addEventListener above is a no-op on repeat.
    try {
      (w as any).postMessage({ lfx: { type: "hello" } }, "*");
    } catch (e) {
      // ignore
    }
    const ready = !!(rawWindow(w) && (rawWindow(w) as any).__lfxReady);
    if (ready && !relayReady) {
      relayReady = true;
      flushPending();
    }
    // Never reset relayReady to false here: the "ready" message / the page's
    // own flag (read via wrappedJSObject) are the source of truth, and the
    // poll's only job is to detect a window replacement (handled above) and
    // latch readiness for a fresh window.
    return true;
  }

  function requestBg(action: string, arg?: string): boolean {
    if (!ccBaseUrl()) return false;
    if (!startRelay()) return false;
    if (relayReady) {
      postReq(action, arg);
    } else {
      const entry = { action: action, arg: arg };
      pendingReqs.push(entry);
      // If the relay never becomes ready, drop the entry (the caller — e.g.
      // the alive announce — retries on its own schedule).
      setTimeout(() => {
        const i = pendingReqs.indexOf(entry);
        if (i >= 0) pendingReqs.splice(i, 1);
      }, RELAY_TIMEOUT);
    }
    return true;
  }

  function requestReply(action: string, arg?: string): Promise<any> {
    return new Promise((resolve) => {
      const id = ++relaySeq;
      const timer = setTimeout(() => {
        delete relayWaiters[id];
        resolve(null);
      }, RELAY_TIMEOUT);
      relayWaiters[id] = { resolve: resolve, timer: timer };
      if (!requestBg(action, arg)) {
        clearTimeout(timer);
        delete relayWaiters[id];
        resolve(null);
      }
    });
  }

  /* ===================== background -> chrome commands ===================== */

  // Commands the background pushes through the relay (native splits, status
  // pushes, ...). `arg` arrives structured-cloned: objects come through as
  // objects, strings as strings.
  function handleCmd(action: string, arg: any): void {
    if (action === "splitTab") {
      try {
        deps.split.splitCurrentTab("horizontal");
      } catch (e) {
        // ignore
      }
      return;
    }
    if (action === "unsplit") {
      try {
        deps.split.unsplit();
      } catch (e) {
        // ignore
      }
      return;
    }
    if (action === "switchPane") {
      try {
        deps.split.switchPane(parseInt(arg, 10) || 1);
      } catch (e) {
        // ignore
      }
      return;
    }
    if (action === "swapSplitPanes") {
      try {
        deps.split.swapPane(parseInt(arg, 10) || 1);
      } catch (e) {
        // ignore
      }
      return;
    }
    if (action === "moveToSplit") {
      try {
        deps.split.addTabToSplitByIndex(parseInt(arg, 10) || 0);
      } catch (e) {
        // ignore
      }
      return;
    }
    if (action === "restoreSplits") {
      // Session restore finished opening tabs; re-create the native split
      // groupings. `arg` is JSON of [[index, ...], ...] with 1-based
      // positions over the SAVED tab list.
      try {
        deps.split.restoreSplits(String(arg));
      } catch (e) {
        // ignore
      }
      return;
    }
    if (action === "sessionState") {
      // Status-bar push/reply: the fresh session summary as an object.
      deps.status.applySessionState(arg);
      return;
    }
    if (action === "leaderState") {
      // Content-script leader arm/disarm: cache it per tab-strip index so the
      // window-level status bar can show the pulsing LEADER chevron on web
      // pages.
      const st = arg || {};
      if (typeof st.index === "number" && st.index >= 0) {
        deps.status.setContentLeader(st.index, !!st.active);
      }
      return;
    }
    if (action === "findState") {
      // Content-script find-in-page count: cache it per tab-strip index so
      // the window-level status bar shows the live match count on web pages.
      const st = arg || {};
      if (typeof st.index === "number" && st.index >= 0) {
        deps.status.setContentFind(st.index, st.count || 0, st.cur || 0);
      }
    }
  }

  /* ===================== public request wrappers ===================== */

  function requestSessionState(): Promise<void> {
    return requestReply("sessionState").then((state: any) => {
      if (state && typeof state === "object") deps.status.applySessionState(state);
    });
  }

  function requestSessionTabs(name: string): Promise<PopupItem[]> {
    return requestReply("sessionTabs", name).then((items: any) =>
      Array.isArray(items) ? (items as PopupItem[]) : []
    );
  }

  function requestRecentlyClosed(): Promise<PopupItem[]> {
    return requestReply("recentlyClosed").then((items: any) =>
      Array.isArray(items) ? (items as PopupItem[]) : []
    );
  }

  /* ===================== real-tab channels (keys/state/cfg/open) ===================== */

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
    const errReply = (e: unknown): void => {
      try {
        const msg = String((e && (e as Error).message) || e);
        const st = String((e && (e as Error).stack) || "").split("\n").slice(0, 2).join(" @ ");
        Services.console.logStringMessage("lfc keys error: " + msg + " @ " + st);
        setHash(browser, "#lfc=keys.err." + btoa(msg + " @ " + st).replace(/=+$/g, "") + "." + nonce);
      } catch (e2) {
        setHash(browser, "#lfc=keys.err." + nonce);
      }
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

  function relayDebug(): any {
    const out: any = { ready: relayReady };
    try {
      const tabs = Array.from(window.gBrowser.tabs).map((t: any) => {
        let spec = "";
        try {
          spec = t.linkedBrowser && t.linkedBrowser.currentURI ? t.linkedBrowser.currentURI.spec : "";
        } catch (e) {}
        return spec;
      });
      out.relayTabs = tabs.filter((s: string) => s.indexOf("relay.html") !== -1).length;
      out.allTabs = tabs.map((s: string) => s.replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(0, 60));
      const w = relayWin;
      out.windowLive = !!w;
      try {
        // Xray wrappers hide content-set expandos; read the raw window.
        out.lfxReady = w ? !!(rawWindow(w) && (rawWindow(w) as any).__lfxReady) : null;
      } catch (e) {
        out.lfxReady = "ERR:" + String(e);
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }

  return {
    ccBaseUrl,
    startRelay,
    requestBg,
    requestReply,
    requestSessionState,
    requestSessionTabs,
    requestRecentlyClosed,
    setHash,
    handleLfc,
    relayDebug,
    relayReady: () => relayReady,
  };
}
