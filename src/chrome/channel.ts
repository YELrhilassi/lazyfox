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
import type { ChromeAction, ChromeReq, RelayAction, RelayReq, RelayRes } from "../shared/protocol";
import { HASH_PREFIX, decodeCommand, decodeReply, encodeRequest } from "../shared/relay-wire";
import { applyHoverRevealPref, type ChromeCfg } from "./config";
import { handleKeys } from "./keys";
import { createTabGuard } from "./tabguard";
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
}

const EXT_ID = "lazyfox@lazyfox.dev";
// How long a request may sit queued before the relay becomes ready, and how
// long a reply-bearing request waits for its response.
const RELAY_TIMEOUT = 6000;

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
  let relayTab: { browser: any; tab: any } | null = null;
  let relayReady = false;
  // Requests queued for the single URL slot (helper -> background). The arg is
  // a structured value from RelayApi, not a string: the wire JSON-encodes it
  // exactly as it already did replies and commands.
  let pendingReqs: Array<{ id: number; action: RelayAction; arg: unknown }> = [];
  // Reply waiters keyed by request id, resolved when the relay page writes the
  // `#lfr=rp.<id>.<json>` hash back into the tab URL.
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
        const lb = t.linkedBrowser;
        const s = lb && lb.currentURI ? lb.currentURI.spec : "";
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
          isRelay = !!b.currentURI && b.currentURI.spec.indexOf("relay.html") !== -1;
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

  // Resolve + cache the relay tab's { browser, tab }. Prunes a dead cache
  // (tab recreated after a death), hides the tab natively (cosmetic — never
  // browser.tabs.hide(), which detaches the browsing context and nulls the
  // URL/loadURI path), and returns null when no relay exists yet.
  function resolveRelayTab(): { browser: any; tab: any } | null {
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
    try {
      r.tab.hidden = true; // cosmetic hide only (see above)
    } catch (e) {
      // ignore
    }
    relayTab = r;
    return r;
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
      relayTab = tab && tab.linkedBrowser ? { browser: tab.linkedBrowser, tab: tab } : null;
    } catch (e) {
      // ignore
    }
  }

  // ---- URL-slot relay (see the state comment above) ----------------------

  // Declared once, in shared/relay-wire.ts, and used by the relay page too.
  const RELAY_HASH_PREFIX = HASH_PREFIX;

  function relayBrowser(): any {
    const cached = relayTab;
    if (cached && cached.browser) {
      try {
        if (window.gBrowser.tabs.some((t: any) => t.linkedBrowser === cached.browser)) return cached.browser;
      } catch (e) {
        // ignore
      }
    }
    const r = resolveRelayTab();
    return r ? r.browser : null;
  }

  // Exactly one relay tab per window, ever. Session restore recreates the
  // previous relay tab while the helper is also creating one at startup, and a
  // stray second relay means a second hidden page + content process for no
  // benefit (and the "many processes on htop" the user saw). Called from
  // startRelay's 500ms poll, so any extra is closed within half a second.
  function dedupeRelayTabs(): void {
    try {
      const relays = Array.from(window.gBrowser.tabs).filter((t: any) => {
        try {
          return t.linkedBrowser && t.linkedBrowser.currentURI && t.linkedBrowser.currentURI.spec.indexOf("relay.html") !== -1;
        } catch (e) {
          return false;
        }
      });
      for (const extra of relays.slice(1)) {
        try {
          window.gBrowser.removeTab(extra);
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }

  function relayUrl(browser: any): string {
    try {
      return (browser && browser.currentURI && browser.currentURI.spec) || "";
    } catch (e) {
      return "";
    }
  }

  // Navigate the relay tab to url. Same-document hash changes (the common
  // case) never reload the page; even a full reload is survivable (the page
  // re-connects its port and re-reads the hash on pageshow). Works for remote
  // (out-of-process) tabs from the chrome side — plain navigation.
  function loadRelay(url: string): void {
    const b = relayBrowser();
    if (!b) return;
    try {
      // Fragment-only changes must stay same-document (no reload, no content
      // process churn per message): loadURI with an nsIURI preserves the
      // document for a pure fragment change, while fixupAndLoadURIString can
      // fix up a fragment-bearing URL into a FULL RELOAD (verified: the relay
      // page's boot counter incremented on every rq write / hash clear,
      // spinning a content process per message). loadURI accepts an nsIURI,
      // not a bare string.
      const uri = Services.io.newURI(url);
      b.loadURI(uri, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } catch (e) {
      // ignore
    }
  }

  // Clear a handled #lfr hash (same-document navigation back to the bare
  // relay URL), freeing the slot for the next message.
  function clearRelayHash(): void {
    const b = relayBrowser();
    if (!b) return;
    const base = ccBaseUrl();
    if (!base) return;
    loadRelay(base + "relay.html");
  }

  // Pop the next queued request and write it into the URL slot.
  function sendNextRelay(): void {
    const b = relayBrowser();
    if (!b) return;
    const base = ccBaseUrl();
    if (!base) return;
    const cur = relayUrl(b);
    if (cur.indexOf(RELAY_HASH_PREFIX) !== -1) return; // slot busy
    const next = pendingReqs.shift();
    if (!next) return;
    // The wire format is shared/relay-wire.ts, which the relay page also uses,
    // so the two ends cannot drift apart.
    loadRelay(
      base + "relay.html" + RELAY_HASH_PREFIX + encodeRequest(next.id, next.action, next.arg)
    );
  }

  // Poll the relay tab's URL (called from startRelay every 500ms): handle a
  // reply or command hash the page wrote, then send the next queued request.
  function pollRelayUrl(): void {
    const b = relayBrowser();
    if (!b) return;
    const spec = relayUrl(b);
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
      clearRelayHash();
      sendNextRelay();
      return;
    }
    const cmd = decodeCommand(frag);
    if (cmd) {
      handleCmd(cmd.action, cmd.arg);
      clearRelayHash();
      sendNextRelay();
    }
  }

  // The tab-selection guard (what a real user tab is, same-tick steering
  // after a close, delayed stranded recovery) lives in tabguard.ts. It is
  // created here, hooked once from startRelay, and consulted by relayDebug
  // and nothing else.
  const tabGuard = createTabGuard({ ccBaseUrl });

  function startRelay(): boolean {
    if (!ccBaseUrl()) return false;
    let r = resolveRelayTab();
    tabGuard.hook();
    if (!r) {
      // No relay yet: create the tab; requests queue until it exists.
      createRelayTab();
      return true;
    }
    relayReady = true;
    dedupeRelayTabs();
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
    setTimeout(() => {
      const i = pendingReqs.indexOf(entry);
      if (i >= 0) pendingReqs.splice(i, 1);
    }, RELAY_TIMEOUT);
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

  /* ===================== background -> chrome commands ===================== */

  // Commands the background pushes through the relay (native splits, status
  // pushes, ...). `arg` arrives structured-cloned: objects come through as
  // objects, strings as strings.
  // Commands the background pushes through the relay (native splits, status
  // pushes, ...). The arg arrives structured-cloned, so what actually shows up
  // here is exactly the request shape declared in ChromeApi.
  //
  // The dispatch is a table rather than an if-chain for one concrete reason: an
  // if-chain silently ignores an action it does not recognise, so a rename on
  // the background side turned into a push that did nothing and nobody could
  // tell. A table typed over ChromeAction makes an unhandled action a compile
  // error, and a removed action a compile error here too.
  function handleCmd(action: string, arg: unknown): void {
    const table: { [K in ChromeAction]: (req: ChromeReq<K>) => void } = {
      splitTab: () => deps.split.splitCurrentTab("horizontal"),
      unsplit: () => deps.split.unsplit(),
      switchPane: (req) => deps.split.switchPane(req.dir >= 0 ? 1 : -1),
      swapSplitPanes: (req) => deps.split.swapPane(req.dir >= 0 ? 1 : -1),
      moveToSplit: (req) => deps.split.addTabToSplitByIndex(req.index),
      // Session restore finished opening tabs; re-create the native split
      // groupings. Positions are 1-based over the SAVED tab list.
      restoreSplits: (req) => deps.split.restoreSplits(req.groups),
      // Status-bar push/reply: the fresh session summary as an object.
      sessionState: (req) => deps.status.applySessionState(req),
      // Content-script leader arm/disarm, cached per tab-strip index so the
      // window-level status bar can show the pulsing LEADER chevron on web
      // pages, where the content script owns the leader key.
      leaderState: (req) => {
        if (req.index >= 0) deps.status.setContentLeader(req.index, !!req.active);
      },
      // Content-script find-in-page count, cached the same way.
      findState: (req) => {
        if (req.index >= 0) deps.status.setContentFind(req.index, req.count || 0, req.cur || 0);
      },
      // Global page-cache mode pushed by the background's diagnostics page.
      cacheGlobal: (req) => deps.cache.setGlobalMode(req.mode || "normal"),
      // Per-tab/session page-cache policy; tabIds aligned to the strip order
      // the tab switcher already relies on.
      cachePolicy: (req) =>
        deps.cache.setPolicy(req.mode || "normal", Array.isArray(req.tabIds) ? req.tabIds : []),
    };
    const fn = table[action as ChromeAction];
    if (!fn) return; // an action this build does not know: ignore, never throw
    try {
      fn((arg || {}) as never);
    } catch (e) {
      // A push that throws must not take the whole chrome helper down with it.
      // Losing one status-bar update is survivable; losing the leader key is not.
    }
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
      if (closeCc && browser) {
        try {
          const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
          if (tab) window.gBrowser.removeTab(tab);
        } catch (e) {
          // ignore
        }
      }
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
    if (closeCc && browser) {
      try {
        const tab = window.gBrowser.tabs.find((t: any) => t.linkedBrowser === browser);
        if (tab) window.gBrowser.removeTab(tab);
      } catch (e) {
        // ignore
      }
    }
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
        } catch (e) {
          // A tab can be torn down while we enumerate; its linkedBrowser is
          // already gone. A tab with no readable URL just is not a match.
        }
        return spec;
      });
      out.relayTabs = tabs.filter((s: string) => s.indexOf("relay.html") !== -1).length;
      out.allTabs = tabs.map((s: string) => s.replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(0, 60));
      const b = relayBrowser();
      out.windowLive = !!b;
      out.urlSlot = b ? relayUrl(b).split("#")[1] || "(empty)" : null;
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
    relayReady: () => relayReady,
  };
}
