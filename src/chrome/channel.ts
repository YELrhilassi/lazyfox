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

import { mergeHotkeys } from "../shared/config";
import { openBookmarksPopup, openDownloadsPopup, openHistoryPopup, openSearchPopup, openTabsPopup, openUrlPopup, type PopupCtx } from "../shared/popups";
import type { PopupItem } from "../shared/types";
import type { RelayAction, RelayReq, RelayRes } from "../shared/protocol";
import { HASH_PREFIX, decodeCommand, decodeReply, encodeRequest } from "../shared/relay-wire";
import type { ChromeCfg } from "./config";
import { handleKeys } from "./keys";
import { createRelaySeq, noteCmdSeq, relaySeqReadout } from "./relayseq";
import { createTabGuard } from "./tabguard";
import { resolveCcBaseUrl } from "./extbaseurl";
import { createRelayTabCtl } from "./relaytab";
import { createPushDispatcher } from "./pushes";
import type { CacheCtl } from "./cache";
import type { DebugHandlers } from "./debug";
import type { SplashCtl } from "./splash";
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
  // The session loader: raised and dropped by the background's `splash` push
  // and by the alive ack (a window booting mid-restore). See splash.ts.
  splash: SplashCtl;
  // Re-read the session summary when the loader comes down (see pushes.ts).
  refreshSessionState(): void;
  // Stealth traces the background recorded but only chrome can delete/reset:
  // exact Places visits and the password-manager pref (see stealthprivate.ts).
  removeStealthVisits(visits: Array<{ url: string; at: number }>, urls?: string[]): void;
  setStealthAutofill(off: boolean): void;
  // Records that a tab's own content script is running (see noteContentPresent).
  // `doc` identifies the reporting DOCUMENT — the URL describes it but cannot
  // identify it across a single-page navigation.
  setContentPresent(index: number, active: boolean, url: string, doc?: string): void;
  // Clear the bar's download notification(s) at a page's request (`;D` runs in
  // the page's own leader, but the bar is this side's).
  dismissDownloads(): void;
  // Firefox's native Screenshots for the selected tab, at a page's request
  // (`;C f` / `;C v` on any page whose keyboard an extension surface owns).
  takeScreenshot(shot: "full" | "visible"): void;
  cfg: ChromeCfg;
  // Apply a config change made elsewhere (the options page's #lfc=cfg push,
  // or the background's `cfg` push after a `;q` on a web page). The host owns
  // the prefs and the surfaces the change invalidates.
  applyConfig(config: Partial<import("../shared/types").Config>): void;
  // Paint (or clear) the which-key menu a SPLIT page sent; the window is the
  // only surface that spans every pane. See wkglobal.ts.
  pagePanel(index: number, panel: import("../shared/leadersignal").LeaderPanelHtml | null): void;
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
  /**
   * Read the relay's URL slot once, and act on what is there.
   *
   * The ONE thing that costs latency in this transport is that a command sits in
   * a slot until somebody looks: the background already delivered it, the relay
   * page already wrote it into its own URL, and the helper notices on its next
   * look. `startRelay()` used to be the only look, on a 500ms timer shared with
   * the status bar's own housekeeping — so a `;W [` waited behind the polls of
   * every status push that got there first, and the measured result was a pane
   * switch taking ~2.7s from the keypress. This is the same look, on its own
   * faster clock, with none of startRelay's other work (no tab dedupe, no
   * selection steering): the expensive half stays at 500ms.
   */
  poll(): void;
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
  // Resolves true when the background answered and the bar was updated, false
  // when the request could not even be sent (the relay is not up yet) or the
  // reply timed out. The caller retries on false; see winsync.ts.
  requestSessionState(): Promise<boolean>;
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
  // THE LOST-COMMAND COUNTER: the background's
  // per-window sequence numbers, the gaps between them, and which hop ate each
  // one. Every command that reaches this side is noted here, and the whole thing
  // is published in the state reply as `relay`, so "a report never arrived" is a
  // number a premise can assert on instead of a mystery. See relayseq.ts.
  //
  // Named for the COMMAND numbering, not `relaySeq` — that name belongs to the
  // request-id counter above, which numbers this side's own requests.
  const commandSeq = createRelaySeq();
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
    slotWrittenAt = Date.now();
    relayTab.load(
      base + "relay.html" + RELAY_HASH_PREFIX + encodeRequest(next.id, next.action, next.arg)
    );
  }

  // THE SLOT HAS MORE THAN ONE READER NOW (a location change and a backstop
  // timer), and clearing it is a cross-process write that takes a moment to
  // land — so the same fragment can be READ twice. Handling a command twice is
  // not harmless: a `moveToSplit` that already ran reports "already in a split
  // view", a request gets two replies, and the sequence arithmetic the helpers
  // keep reports out-of-order deliveries that never happened. Fragments are
  // unique (request ids and command sequence numbers both only go up), so an
  // identical fragment after one has been handled is always a re-read.
  let lastHandledSlot = "";

  // ---------------------------------------------------------------------
  // THE RELAY IS A REAL TAB, AND IDLE TABS DIE.
  //
  // Firefox freezes or discards background/hidden tabs, and the relay is a
  // hidden tab whose only job is to sit there. A frozen page cannot clear the
  // request hash the helper just navigated it to — which looks exactly like
  // "the page hasn't got to it YET". The URL cannot tell the two apart; only
  // time can, because a live page clears an `rq` hash synchronously.
  //
  // What a dead relay used to cost: every later command was written into the
  // URL of a document that would never read it. The leader still painted (that
  // part is local), and no action ran — the reported "after a while the leader
  // opens but nothing works, not even ;Q" — because nothing ever navigated the
  // dead page again.
  // ---------------------------------------------------------------------
  const RELAY_STUCK_MS = 3500;
  // Idle liveness. With no traffic the page has no way to prove it is still
  // running, so the helper asks; `__ping` is answered by the PAGE itself (see
  // extension/relay.ts), never forwarded, so this neither wakes the background
  // nor keeps its event page alive. One URL write every 20s is the whole cost.
  const RELAY_PING_MS = 20000;
  // When THIS side wrote the `rq` currently in the slot (0 = the slot holds no
  // request of ours: empty, or a page-written rp/cm).
  let slotWrittenAt = 0;
  // Seeded with the build time so the FIRST idle ping is one interval after
  // the window opens, not on its first poll.
  let lastRelayHeard = Date.now();
  let lastPingAt = 0;
  let lastHealAt = 0;

  function noteRelayAlive(): void {
    relayReady = true;
    lastRelayHeard = Date.now();
  }

  /**
   * Bring a dead relay page back.
   *
   * Loading the base URL is the one operation that means both halves: on a LIVE
   * page it is the same-document hash clear this transport already relies on,
   * and on a discarded/frozen page it starts a new document, which is the only
   * way back. The request that was in the slot is lost (its caller times out —
   * the retrying callers retry); the QUEUE is untouched and drains again once
   * the page is up.
   */
  function healRelay(): void {
    const now = Date.now();
    // A cooldown, not a one-shot: a page that is still coming up (a cold content
    // process) must not be reloaded on every poll while it boots.
    if (now - lastHealAt < 6000) return;
    lastHealAt = now;
    slotWrittenAt = 0;
    lastHandledSlot = "";
    lastRelayHeard = 0;
    relayTab.clearHash();
  }

  /** Ask the page to prove it is alive, when there is nothing else to say. */
  function maybePingRelay(): void {
    if (pendingReqs.length) return; // real traffic is its own heartbeat
    const now = Date.now();
    if (now - lastRelayHeard < RELAY_PING_MS) return;
    if (now - lastPingAt < RELAY_PING_MS) return;
    const base = ccBaseUrl();
    if (!base) return;
    if (relayTab.url().indexOf(RELAY_HASH_PREFIX) !== -1) return; // slot occupied
    lastPingAt = now;
    slotWrittenAt = now;
    relayTab.load(
      base + "relay.html" + RELAY_HASH_PREFIX + encodeRequest(++relaySeq, "__ping", {})
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
      // Slot free. If WE wrote it, the page read it — the strongest proof of
      // life this transport has, and the moment a dead relay stops looking
      // merely quiet.
      if (slotWrittenAt) {
        slotWrittenAt = 0;
        noteRelayAlive();
      }
      lastHandledSlot = "";
      maybePingRelay();
      sendNextRelay();
      return;
    }
    const frag = spec.slice(i + RELAY_HASH_PREFIX.length);
    if (frag === lastHandledSlot) return; // a re-read of a slot whose clear is still landing
    if (frag.indexOf("rq.") === 0) {
      // Our own request, still unanswered. A live page clears it in the same
      // task it reads it; one this old means the document is not running.
      if (slotWrittenAt && Date.now() - slotWrittenAt > RELAY_STUCK_MS) healRelay();
      return;
    }
    lastHandledSlot = frag;
    noteRelayAlive();
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
      // Counted BEFORE the push runs, and whatever the push does with it: this
      // counter measures whether the MESSAGE got here, and a command whose
      // handler throws was still delivered.
      noteCmdSeq(commandSeq, { seq: cmd.seq, lost: cmd.lost, slot: frag });
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
    // The tab exists but its page may not: do not let the next command be
    // written into a document that cannot read it.
    if (relayTab.isDiscarded()) healRelay();
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
  function requestSessionState(): Promise<boolean> {
    return requestReply("sessionState").then((state) => {
      if (!state || typeof state !== "object") return false;
      deps.status.applySessionState(state);
      return true;
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
    if (
      cmd === "reveal" ||
      cmd === "console" ||
      cmd === "diag" ||
      cmd === "state" ||
      // The keyboard rule, runnable on demand — see debug.ts handleFocus and
      // DebugState.giveKeyboard. Dev/verification only, like its neighbours.
      cmd === "focus" ||
      // Put the keyboard in the browser's own UI — the state a user reaches with
      // the mouse, and the one no e2e input can produce (see debug.ts handleBlur).
      cmd === "blur" ||
      // Drop the selected tab's presence record, so the "the helper answers a live
      // page's keys" state is reachable in a test (see debug.ts handleForget).
      cmd === "forget" ||
      // Put TEXT in the URL bar and mark it the way Firefox marks a field the
      // user typed into — the reported freeze, whose whole point is that the
      // field is one nobody can see (see debug.ts handleUrlText).
      cmd === "urltext"
    ) {
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
            deps.applyConfig(parsed.config as Partial<ChannelDeps["cfg"]["config"]>);
          }
        }
      } catch (e) {
        reply = "err";
      }
      setHash(browser, "#lfc=" + reply + "." + nonce);
    }
  }

  function relayDebug(): any {
    // The counter first, and OUTSIDE the try: the relay-tab details below are
    // best-effort (a tab can be torn down mid-enumeration), but the counter is
    // arithmetic on integers this side has already been handed, and a failure to
    // enumerate the strip must not be the reason a lost report cannot be read.
    const out: any = { ready: relayReady, ...relaySeqReadout(commandSeq) };
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
    poll: pollRelayUrl,
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
