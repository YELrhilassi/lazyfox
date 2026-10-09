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
// Today ONE hidden relay tab (relay.html) carries everything. The helper reaches
// the relay page's window directly; the page holds a long-lived runtime port to
// the background and forwards traffic both ways. Nothing is created or removed
// per message.
//
// WHAT THIS FILE IS: the composition root for the helper side of that channel.
// It holds the MESSAGE state — the queue, the reply waiters, the single URL
// slot, and the 500ms poll that drains them — and wires four collaborators
// around it:
//
//   extbaseurl  what is the extension's base URL (four other callers too)
//   relaytab    the relay TAB: find/create/dedupe/navigate/identity
//   tabguard    is the selected tab a real user tab (existing module)
//   pushes      what each background->chrome command DOES
//
// and it owns the per-message real-tab channels that ride URL hashes on a real
// tab instead of the relay (the #lfc= keys synthesizer, the state query, cfg,
// open), which is a different transport and deliberately does not share the
// relay's state.
//
// The dependency runs one way: this file imports the collaborators, none of
// them import it.

import { mergeConfig, mergeHotkeys } from "../shared/config";
import { openBookmarksPopup, openDownloadsPopup, openHistoryPopup, openSearchPopup, openTabsPopup, openUrlPopup, type PopupCtx } from "../shared/popups";
import type { PopupItem } from "../shared/types";
import type { RelayAction, RelayReq, RelayRes } from "../shared/protocol";
import { HASH_PREFIX, decodeCommand, decodeReply, encodeRequest } from "../shared/relay-wire";
import { applyHoverRevealPref, type ChromeCfg } from "./config";
import { handleKeys } from "./keys";
import { createTabGuard } from "./tabguard";
import { resolveCcBaseUrl } from "./extbaseurl";
import { createRelayTabCtl } from "./relaytab";
import { createPushDispatcher } from "./pushes";
import type { CacheCtl } from "./cache";
import type { DebugHandlers } from "./debug";
import type { SplitView } from "./splitview";
import type { StatusBarCtl } from "./statusbar";

export interface ChannelDeps {
  // The popup context (built by main) — used to open search/url/tabs/... popups.
  ctx: PopupCtx;
  // The chrome ops adapter (built by ops.ts, wired by main).
  ops: {
    openTarget(which: string): boolean;
    openUrlNative(url: string): boolean;
    openResize(): void;
  };
  split: SplitView;
  status: StatusBarCtl;
  // Records that a tab's own content script is running (see noteContentPresent).
  setContentPresent(index: number, active: boolean, url: string): void;
  // Clear the bar's download notification(s) at a page's request (`;D` runs in
  // the page's own leader, but the bar is this side's).
  dismissDownloads(): void;
  cfg: ChromeCfg;
  debug: DebugHandlers;
  // Per-tab / per-session page-cache enforcement (the global scope is owned by
  // the extension background).
  cache: CacheCtl;
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
    }, target?: any): boolean;
    // The matching keyup for a synthesized key — see KeysDeps. The channel
    // forwards it to the SAME handler the real window keyup listener runs, so
    // a synthetic release and a genuine one cannot disagree.
    release(key: string): void;
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
  // Typed against RelayApi: an unknown action, or an argument of the wrong
  // shape, is a compile error rather than a message nobody handles.
  requestBg<K extends RelayAction>(action: K, arg?: RelayReq<K>): boolean;
  // True once the relay has actually connected its port (ready), i.e.
  // requestBg is being delivered rather than buffered. Callers use this to
  // decide whether a fire-and-forget request actually reached the background
  // (the alive announce must only latch when the message was REALLY delivered,
  // not merely queued — otherwise a cold-start drop leaves chromeAlive false
  // forever and content scripts keep drawing a second status bar).
  relayReady(): boolean;
  // Request with a reply (the background's response resolves the promise).
  // Resolves null on timeout / relay failure — callers must tolerate that.
  requestReply<K extends RelayAction>(action: K, arg?: RelayReq<K>): Promise<RelayRes<K> | null>;
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
  // True when this tab element IS the window's relay, by reference as well as
  // by URL — see relaytab.ts for why the URL alone is not enough.
  isKnownRelayTab(tab: any): boolean;
}

// How long a request may sit queued before the relay becomes ready, and how
// long a reply-bearing request waits for its response.
const RELAY_TIMEOUT = 6000;
// How long a queued request may keep waiting for the relay to come up (or for
// the slot ahead of it to free) before it is given up on. See requestBg.
const RELAY_BOOT_MAX = 45000;

export function createChannel(deps: ChannelDeps): Channel {
  // The persistent relay tab (relay.html) carries every helper<->background
  // message over SAME-DOCUMENT URL-hash slots (#lfr=..., "lazyfox relay", a
  // grammar distinct from the debug #lfc= channels). Why URL hashes and not
  // postMessage: the helper runs in the chrome (parent) process, and a remote
  // (out-of-process) extension page has NO reachable window object from there
  // — contentWindow and browsingContext.window are both null on the chrome
  // side for OOP tabs (verified against interactive Firefox; geckodriver hides
  // this by forcing extension pages in-process with
  // extensions.webextensions.remote=false). postMessage to a null window dies
  // silently, which left the announce stuck and every web page drawing its own
  // status bar. Same-document navigation works cross-process in both
  // directions: the helper navigates the relay tab to #lfr=rq.<id>.<action>
  // (the page forwards it over its runtime port), and the page rewrites its
  // own URL to #lfr=rp/cm.<...> which the helper polls (it already polls every
  // 500ms). The URL is a single slot: one request in flight at a time, the
  // rest queue here; the page never clobbers a pending request hash.
  let relayReady = false;
  // Requests queued for the single URL slot (helper -> background). The arg is
  // a structured value from RelayApi, not a string: the wire JSON-encodes it
  // exactly as it already did replies and commands.
  let pendingReqs: Array<{ id: number; action: RelayAction; arg: unknown }> = [];
  let relaySeq = 0;
  // Reply waiters keyed by request id, resolved when the relay page writes the
  // `#lfr=rp.<id>.<json>` hash back into the tab URL.
  const relayWaiters: Record<number, { resolve: (v: any) => void; timer: any }> = {};

  const ccBaseUrl = resolveCcBaseUrl;
  const relayTab = createRelayTabCtl({ ccBaseUrl });
  const handlePush = createPushDispatcher(deps);
  // The tab-selection guard (what a real user tab is, same-tick steering
  // after a close, delayed stranded recovery). Hooked once from startRelay, and
  // consulted by nothing else.
  const tabGuard = createTabGuard({ ccBaseUrl });

  // Declared once, in shared/relay-wire.ts, and used by the relay page too.
  const RELAY_HASH_PREFIX = HASH_PREFIX;

  /* ===================== relay bridge ===================== */

  // Pop the next queued request and write it into the URL slot.
  function sendNextRelay(): void {
    const b = relayTab.browser();
    if (!b) return;
    const base = ccBaseUrl();
    if (!base) return;
    if (relayTab.url().indexOf(RELAY_HASH_PREFIX) !== -1) return; // slot busy
    const next = pendingReqs.shift();
    if (!next) return;
    // The wire format is shared/relay-wire.ts, which the relay page also uses,
    // so the two ends cannot drift apart.
    relayTab.load(
      base + "relay.html" + RELAY_HASH_PREFIX + encodeRequest(next.id, next.action, next.arg)
    );
  }

  // Poll the relay tab's URL (called from startRelay every 500ms): handle a
  // reply or command hash the page wrote, then send the next queued request.
  function pollRelayUrl(): void {
    const b = relayTab.browser();
    if (!b) return;
    const spec = relayTab.url();
    const i = spec.indexOf(RELAY_HASH_PREFIX);
    if (i < 0) {
      // Slot free (page cleared a forwarded request): send the next one.
      sendNextRelay();
      return;
    }
    const frag = spec.slice(i + RELAY_HASH_PREFIX.length);
    if (frag.indexOf("rq.") === 0) return; // our own pending request; page will clear it
    const reply = decodeReply(frag);
    if (reply) {
      const w = relayWaiters[reply.id];
      if (w) {
        clearTimeout(w.timer);
        delete relayWaiters[reply.id];
        w.resolve(reply.result);
      }
      relayTab.clearHash();
      sendNextRelay();
      return;
    }
    const cmd = decodeCommand(frag);
    if (cmd) {
      handlePush(cmd.action, cmd.arg);
      relayTab.clearHash();
      sendNextRelay();
    }
  }

  function startRelay(): boolean {
    if (!ccBaseUrl()) return false;
    const r = relayTab.browser();
    tabGuard.hook();
    if (!r) {
      // No relay yet: create the tab; requests queue until it exists.
      relayTab.create();
      return true;
    }
    relayReady = true;
    relayTab.dedupe();
    tabGuard.ensureRealTabSelected();
    pollRelayUrl();
    return true;
  }

  function requestBg<K extends RelayAction>(action: K, arg?: RelayReq<K>): boolean {
    if (!ccBaseUrl()) return false;
    if (!startRelay()) return false;
    // Queue into the single URL slot; sendNextRelay drains it as the slot
    // frees (the page clears a forwarded request hash, and replies/commands
    // are handled+cleared by pollRelayUrl). If the relay never comes up, drop
    // the entry after RELAY_TIMEOUT (the caller — e.g. the alive announce —
    // retries on its own schedule).
    const entry = { id: 0, action: action, arg: arg ?? {} };
    pendingReqs.push(entry);
    // THE DROP DEADLINE IS NOT A STARTUP DEADLINE.
    //
    // A queued request is dropped after RELAY_TIMEOUT so a background that never
    // answers cannot leak the queue. But the relay is a real TAB: on a fresh
    // launch it has to be created and commit, and on a cold profile — or while a
    // session restore is reopening a windowful of tabs — that takes longer than
    // this window. The request was then dropped before it was ever sent, and
    // nothing said so: the action simply did not happen. That is what "not all
    // functionality works right after Firefox launches" was.
    //
    // So the timer re-arms while there has been NO OPPORTUNITY to send — the
    // relay tab is not up yet, or its single URL slot is still busy with the
    // request ahead of this one — up to a hard ceiling. Once the relay is up and
    // the slot is free, the original deadline applies again, so the queue still
    // cannot grow without bound.
    const queuedAt = Date.now();
    const dropIfStuck = (): void => {
      const i = pendingReqs.indexOf(entry);
      if (i < 0) return;
      const relayUp = !!relayTab.browser();
      const slotBusy = relayUp && relayTab.url().indexOf(RELAY_HASH_PREFIX) !== -1;
      if ((!relayUp || slotBusy) && Date.now() - queuedAt < RELAY_BOOT_MAX) {
        setTimeout(dropIfStuck, RELAY_TIMEOUT);
        return;
      }
      pendingReqs.splice(i, 1);
    };
    setTimeout(dropIfStuck, RELAY_TIMEOUT);
    sendNextRelay();
    return true;
  }

  // Resolves the background's reply, or null on timeout / relay failure —
  // callers must tolerate null, because "the other end never answered" is a
  // normal state for a channel that rides a browser tab's URL.
  function requestReply<K extends RelayAction>(action: K, arg?: RelayReq<K>): Promise<RelayRes<K> | null> {
    return new Promise((resolve) => {
      const id = ++relaySeq;
      const timer = setTimeout(() => {
        delete relayWaiters[id];
        resolve(null);
      }, RELAY_TIMEOUT);
      relayWaiters[id] = { resolve: resolve, timer: timer };
      if (!ccBaseUrl() || !startRelay()) {
        clearTimeout(timer);
        delete relayWaiters[id];
        resolve(null);
        return;
      }
      pendingReqs.push({ id: id, action: action, arg: arg ?? {} });
      sendNextRelay();
    });
  }

  /* ===================== public request wrappers ===================== */

  // The three read-only pulls the chrome UI makes, each with its reply already
  // shaped by RelayApi. They survive the `Array.isArray` / object guards
  // because the reply crosses a URL and a port: a truncated or half-parsed
  // payload must degrade to an empty list, never to a render-time crash.
  function requestSessionState(): Promise<void> {
    return requestReply("sessionState").then((state) => {
      if (state && typeof state === "object") deps.status.applySessionState(state);
    });
  }

  function requestSessionTabs(name: string): Promise<PopupItem[]> {
    return requestReply("sessionTabs", { name }).then((items) => (Array.isArray(items) ? items : []));
  }

  function requestRecentlyClosed(): Promise<PopupItem[]> {
    return requestReply("recentlyClosed").then((items) => (Array.isArray(items) ? items : []));
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

  // Close the requesting command-center tab. Shared by both arms of handleOpen.
  function closeRequestingTab(browser: any): void {
    try {
      const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
      if (tab) window.gBrowser.removeTab(tab);
    } catch (e) {
      // ignore
    }
  }

  function handleOpen(target: string, browser: any): void {
    // `.c` marks "close the requesting command-center tab after opening".
    // Checked by SUFFIX (not contains): the base64 URL payload below can
    // legitimately contain the letter c.
    const closeCc = target.endsWith(".c");
    // `u.<base64url>` opens an arbitrary URL natively (about: pages, which
    // the tabs API rejects as "Illegal URL", are routed here by the
    // background). base64 never contains a dot, so the first dot after the
    // `u.` prefix delimits the payload.
    if (target.indexOf("u.") === 0) {
      const rest = target.slice(2);
      const dot = rest.indexOf(".");
      const b64 = dot < 0 ? rest : rest.slice(0, dot);
      try {
        const url = decodeURIComponent(escape(atob(b64)));
        if (typeof deps.ops.openUrlNative === "function") deps.ops.openUrlNative(url);
      } catch (e) {
        // malformed payload — ignore
      }
      if (closeCc && browser) closeRequestingTab(browser);
      return;
    }
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
    if (closeCc && browser) closeRequestingTab(browser);
  }

  // The #lfc=keys channel — the e2e harness's synthetic key path (shift
  // maps, VK codes, cross-realm event construction, text-insert emulation,
  // reply nonce) — lives in keys.ts. It touches no relay state; its only
  // channel-side input is deps.keys.dispatch, passed through below.
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
      handleKeys(deps.keys, browser, rest, setHash);
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
            deps.cfg.bindings = mergeHotkeys(parsed.bindings as Partial<ChannelDeps["cfg"]["bindings"]>);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(deps.cfg.bindings));
          } else {
            deps.cfg.bindings = mergeHotkeys(parsed as Partial<ChannelDeps["cfg"]["bindings"]>);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(deps.cfg.bindings));
          }
          if (parsed.config && typeof parsed.config === "object") {
            deps.cfg.config = mergeConfig(parsed.config as Partial<ChannelDeps["cfg"]["config"]>);
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
        } catch (e) {
          // A tab can be torn down while we enumerate; its linkedBrowser is
          // already gone. A tab with no readable URL just is not a match.
        }
        return spec;
      });
      out.relayTabs = tabs.filter((s: string) => s.indexOf("relay.html") !== -1).length;
      out.allTabs = tabs.map((s: string) => s.replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(0, 60));
      const b = relayTab.browser();
      out.windowLive = !!b;
      out.urlSlot = b ? relayTab.url().split("#")[1] || "(empty)" : null;
      out.pending = pendingReqs.length;
      out.awaiting = Object.keys(relayWaiters).length;
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
    isKnownRelayTab: relayTab.isKnown,
    relayReady: () => relayReady,
  };
}