// Chrome helper entry (userChrome.uc.js equivalent). This is the composition
// root: it builds the focused modules (config, popup host, split view, status
// bar, debug, channel), wires the chromeOps adapter to them, and glues the
// shared leader/popups to the browser window (key handling, hotkeys, the
// #lfc= progress listener, status-bar polling). No logic lives here beyond
// the wiring — each concern lives in its own module.

import { dbg } from "../shared/dev";
import { LeaderController } from "../shared/leader";
import { toast } from "../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";
import { createChannel, type Channel } from "./channel";
import { applyHoverRevealPref, loadCfg, persistCfg, type ChromeCfg } from "./config";
import { ensureChromeCore, initChromeCore } from "./core";
import { createDebug, type DebugHandlers } from "./debug";
import { createChromeOps } from "./ops";
import { createPopupHost } from "./popup";
import { createSplitView, type SplitView } from "./splitview";
import { createStatusBar, type StatusBarCtl } from "./statusbar";
import { createTypingChannel } from "./typing";

(function () {
  "use strict";

  // Version of the chrome helper (userChrome.uc.js) shipped by the installer.
  // Announced to the extension's background with the alive ping and shown on
  // the options Components panel. Tracks the release; bump with each release.
  const CHROME_HELPER_VERSION = "0.5.7";

  // Profile directory leaf name (e.g. "65rp05zu.lfxdev-…"), announced with the
  // alive ping so the extension can show the ACTIVE profile in the command-
  // center footer even before any tmux-style session has been saved. The
  // user-facing name is the part after the first dot ("lfxdev-…") — the raw
  // leaf "zfdaq0c3.dev-edition-default" would show the hash prefix instead.
  let profileName = "";
  let profileDir = "";
  try {
    // dirsvc.get needs the nsIFile IID in this context — the one-arg form
    // throws "Not enough arguments [nsIProperties.get]" and the profile would
    // silently stay empty (setup page showing "your current profile").
    profileDir = String(Services.dirsvc.get("ProfD", Ci.nsIFile).leafName || "");
    const dot = profileDir.indexOf(".");
    profileName = dot > 0 ? profileDir.slice(dot + 1) : profileDir;
  } catch (e) {
    // ignore — the footer falls back to versions only
  }

  if (window.top !== window) return;
  if (!window.gBrowser) return;

  if (__DEV__) {
    dbg("chrome bundle loaded", "ff=" + Services.appinfo.version,
      "evalSys=" + Services.prefs.getBoolPref("security.allow_eval_with_system_principal", false),
      "evalParent=" + Services.prefs.getBoolPref("security.allow_eval_in_parent_process", false));
  }

  initChromeCore();

  /* ===================== config (prefs) ===================== */

  const cfg: ChromeCfg = loadCfg();
  applyHoverRevealPref(cfg);
  const leaderKey = () => cfg.config.leader || ";";

  /* ===================== modules ===================== */

  const popup = createPopupHost();

  // Late-bound references: the modules below are mutually dependent (split
  // needs the channel's base URL, the channel needs split/status), so each is
  // created with getters that resolve the others at call time.
  let split!: SplitView;
  let status!: StatusBarCtl;
  let channel!: Channel;
  let debug!: DebugHandlers;
  let leader: LeaderController | null = null;
  let lastAction: string | null = null;
  let lastMoveDebug: string | null = null;

  const getMode = (): "POPUP" | "LEADER" | "NORMAL" => {
    if (popup.isOpen()) return "POPUP";
    if (leader && leader.active) return "LEADER";
    // The content script owns the leader key on web pages; its arm/disarm is
    // relayed through the background and cached per tab-strip index. Check
    // the SELECTED tab's index (the bar shows the selected tab's mode).
    if (contentLeaderActive()) return "LEADER";
    return "NORMAL";
  };

  status = createStatusBar({
    realTabs: () => split.realTabs(),
    getConfig: () => cfg,
    getMode,
  });

  split = createSplitView({
    ccBaseUrl: () => channel.ccBaseUrl(),
    onSplitChange: () => status.update(),
    onMove: (msg) => { lastMoveDebug = msg; },
  });

  debug = createDebug({
    getState: () => ({
      hasPopup: () => popup.isOpen(),
      leaderActive: () => !!(leader && leader.active),
      leaderPending: () => !!(leader && leader.hasPending()),
      lastAction: () => lastAction,
      lastMoveDebug: () => lastMoveDebug,
      statusMounted: () => status.mounted(),
      statusPosition: () => cfg.config.statusBarPosition || "bottom",
      dlActive: () => status.dlActive(),
      isFullscreen: () => status.isFullscreen(),
      activeSplitView: () => split.activeSplitView(),
      cfg: () => cfg,
      // The persistent relay's helper-side state (found window, ready flag)
      // so the harness can verify the bridge is up.
      relay: () => channel.relayDebug(),
    }),
  });

  /* ===================== chrome ops adapter ===================== */

  // Built with every dependency injected — no post-hoc monkey-patching. The
  // channel is created below and resolved lazily through the getter: the
  // channel needs the popup context that wraps ops, so the two form a
  // construction cycle broken by late binding.
  const chromeOps = createChromeOps({
    split,
    popup,
    status,
    cfg,
    persistCfg,
    applyHoverRevealPref,
    getChannel: () => channel,
  });

  /* ===================== popup context + leader ===================== */

  let leaderActions: Record<string, () => void> = {};
  const ctx: PopupCtx = {
    ops: chromeOps,
    open: popup.open,
    close: popup.close,
    toast: toast,
    runAction: (k) => runLeaderAction(leaderActions, k),
    bindings: () => (leader ? leader.bindings() : Promise.resolve([])),
    manualText: false,
  };
  leaderActions = makeLeaderActions(ctx);
  // `;f` is link-hints. Web pages run a content script that owns them; the
  // command-center home has no page links, so there it arms hint-PICK (each
  // grid tile gets a letter and the next key runs it); and on chrome-owned
  // pages with no content script (about:, error pages) the helper draws its
  // own hints (chromePageHints below).
  {
    const startHints = leaderActions["f"]!;
    leaderActions["f"] = () => {
      if (isCommandCenterTab()) {
        signalCommandCenterFind();
        return;
      }
      // chromeOwnsKeys() is true exactly where the content script does not run
      // (about:, extension pages) — provide hints locally there.
      if (chromeOwnsKeys()) {
        chromePageHints();
        return;
      }
      startHints();
    };
  }

  // The chrome-level key dispatch (leader/popups/hotkeys/typing guard), set
  // up below but referenced here so the #lfc=keys channel can drive it. The
  // closure resolves at call time (after init), so ordering is safe.
  let chromeKeyDown: (e: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  }) => boolean = () => false;

  channel = createChannel({
    ctx,
    ops: chromeOps as unknown as { openTarget(which: string): boolean; openUrlNative(url: string): boolean; openResize(): void },
    split,
    status,
    cfg,
    debug,
    keys: { dispatch: (e) => chromeKeyDown(e) },
  });

  /* ===================== typing channel ===================== */

  const typing = createTypingChannel();

  /* ===================== leader + shared popups ===================== */

  leader = new LeaderController(
    (k) => {
      lastAction = k;
      runLeaderAction(leaderActions, k);
    },
    () => cfg.config.whichKey !== false,
    // Re-render the status bar the instant the leader arms/disarms so its
    // pulsing chevron appears immediately (the 500ms poll would lag a fast
    // ;<key> press).
    () => status.compute()
  );
  // ;' = quick switch: capture the next digit and jump to the marked session.
  leaderActions["'"] = () =>
    leader!.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        chromeOps.switchSessionByMarker(Number(k));
        return true;
      }
      return false;
    }, 3000);
  // ;+1-9 = move tab N into the current split view.
  leaderActions["+"] = () =>
    leader!.armPending((k) => {
      lastAction = "+" + k;
      if (/^[1-9]$/.test(k)) {
        chromeOps.splitAddTabByIndex(Number(k));
        return true;
      }
      return false;
    }, 3000);

  // Warm the wasm core so the first leader press is already synchronous.
  ensureChromeCore()
    .then((a) => { if (__DEV__) dbg("core ready, version=" + a.version()); })
    .catch((e) => {
      if (__DEV__) {
        dbg(
          "CORE INIT FAILED: name=" + (e && e.name) +
          " msg=" + JSON.stringify(e && e.message) +
          " str=" + String(e) +
          " stack=" + (e && e.stack)
        );
      }
    });

  // Dev-only end-to-end check of the which-key render path.
  void leader
    .bindings()
    .then(async (all) => {
      if (!__DEV__) return;
      dbg("bindings loaded, count=" + all.length);
      const out = await leader!.devSelfTest();
      dbg("wk self-test: " + out);
    })
    .catch((e) => { if (__DEV__) dbg("loadBindings FAILED: " + String(e)); });

  // Announce to the extension background that the chrome helper is alive, so
  // content scripts can hand leader-key handling over to chrome and hide their
  // own status bar (the chrome helper owns the single window-level bar). This
  // is a CONFIRMED handshake, not a fire-and-forget: the background replies to
  // the "alive" req with an { ok:true } ack after it has set the storage
  // chromeAlive flag, and only that ack latches the helper out of retrying. A
  // fire-and-forget announce could be accepted-while-queued and then dropped
  // (relay not ready yet), silently leaving chromeAlive=false forever and
  // every restored web page drawing its own bar on top of the window one.
  let announcedAlive = false;
  let aliveAckInFlight = false;
  function announceChromeAlive(): void {
    if (announcedAlive || aliveAckInFlight) return;
    if (!channel.ccBaseUrl()) return; // extension not ready yet; poll retries
    aliveAckInFlight = true;
    // The arg carries the helper version, the active profile's user-facing
    // name and its raw directory leaf (\u0001-separated); the background
    // stores all three so the command-center footer and setup page can show
    // the profile this window is running under.
    void channel.requestReply("alive", CHROME_HELPER_VERSION + "\u0001" + profileName + "\u0001" + profileDir).then((ack: any) => {
      aliveAckInFlight = false;
      // requestReply resolves null on timeout/error; the ack object on success.
      if (ack && ack.ok) announcedAlive = true;
      // otherwise the next 500ms poll retries
    });
  }
  announceChromeAlive();

  /* ==================== status bar (tmux-style) ==================== */

  status.update();
  status.compute();
  // Poll every 500ms so the bar hides the moment content enters DOM fullscreen
  // (video) — only a poll catches that attribute transition reliably.
  // status.update is idempotent and cheap. startRelay() keeps the relay tab
  // alive: the announce creates it, and if the relay ever dies (tab closed,
  // window rebuilt) this re-creates it within half a second.
  setInterval(() => {
    announceChromeAlive(); // once the extension URL resolves, tell it we're here
    channel.startRelay();
    status.update();
    status.compute();
  }, 500);
  // Download progress on the bar: poll Downloads.sys.mjs once a second and
  // refresh the ⭳ segment. The popup reads the same manager cache, so the two
  // always agree.
  setInterval(() => {
    void status.pollDownloads();
  }, 1000);
  setTimeout(() => {
    void status.pollDownloads();
  }, 1500);
  // When a page element goes fullscreen (a video), the window-level bar would
  // sit over the full-screen content — hide it and re-show when it exits.
  // status.update() reads isFullscreen() itself, so it handles both edges.
  // The observer notifications are the same signals Firefox's own UI
  // listens to: they make the hide/re-show immediate (the 500ms poll is
  // only a backstop) and survive changes to the chrome document's
  // inDOMFullscreen attribute handling.
  try {
    const onFullscreen = () => status.update();
    window.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("willenterfullscreen", onFullscreen);
    window.addEventListener("willexitfullscreen", onFullscreen);
    const fsObs = {
      observe: onFullscreen,
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
    };
    Services.obs.addObserver(fsObs, "MozDOMFullscreen:Entered");
    Services.obs.addObserver(fsObs, "MozDOMFullscreen:Exited");
  } catch (e) {
    // ignore
  }
  // Fetch the session name + list once at startup and after chrome-triggered
  // session actions. Deliberately NOT polled on a timer or on TabSelect: the
  // round-trip creates a transient background tab, and doing that on a timer
  // would churn tab counts under automation.
  setTimeout(channel.requestSessionState, 2000);
  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      split.rememberSplit();
      // The stealth badge must track the tab you switched to immediately;
      // sessionState round-trips are not polled on TabSelect, so derive the
      // flag locally from the per-tab stealthFlags the last reply carried.
      try {
        const sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
        status.setActiveStealth(!!(status.getStealthFlags()[sel] || false));
      } catch (e) {
        // ignore
      }
      // A fresh command-center tab starts with Firefox's URL-bar focus (the
      // standard new-tab behavior), which would swallow every key — the grid's
      // hjkl, `;`, `;f` hint-pick letters, Enter. Pull focus into the page so
      // the keyboard-first home actually receives keys (the page blurs its own
      // input, so this leaves it in command mode).
      if (isCommandCenterTab()) focusCommandCenterContent();
      status.update();
      status.compute();
    });
  } catch (e) {
    // ignore
  }

  // Move keyboard focus into the command-center tab's content document (out
  // of the hidden URL bar / chrome UI), leaving it in command mode: hjkl
  // navigate, `;` arms the leader, ;f arms hint-pick. Focuses the page body,
  // never the <browser> element (which grabs the search input).
  function focusCommandCenterContent(): void {
    try {
      const cw = window.gBrowser.selectedBrowser.contentWindow;
      const doc = cw && cw.document;
      const input = doc && doc.getElementById("input");
      if (input && doc.activeElement === input && typeof input.blur === "function") {
        input.blur();
      }
    } catch (e) {
      // ignore
    }
    focusCCBody();
  }

  /* ==================== lfc progress listener ==================== */

  window.gBrowser.addTabsProgressListener({
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener"]),
    onLocationChange(browser: any, _webProgress: any, _request: any, location: any) {
      if (!location) return;
      // The selected tab may have crossed the web/chrome boundary (e.g. a web
      // page navigated to about:preferences): remount the chrome status bar
      // accordingly. update is cheap and idempotent, and the status module
      // reads the *selected* browser, so location changes in background tabs
      // are harmless here.
      status.update();
      if (location.scheme !== "moz-extension") return;
      const spec = location.spec;
      const h = spec.indexOf("#");
      if (h < 0) return;
      const frag = spec.slice(h + 1);
      if (frag.indexOf("lfc=") !== 0) return;
      channel.handleLfc(browser, frag.slice(4));
    },
  });

  /* ==================== hotkeys ===================== */

  function keyCombo(e: KeyboardEvent): string {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    let key = e.key;
    if (key === " ") key = "Space";
    return mods.join("+") + (mods.length ? "+" : "") + key;
  }

  function handleHotkeys(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      const combo = keyCombo(e);
      for (const t of Object.keys(cfg.bindings)) {
        if (cfg.bindings[t as keyof typeof cfg.bindings] === combo) {
          e.preventDefault();
          e.stopPropagation();
          chromeOps.openTarget(t);
          return true;
        }
      }
    }
    return false;
  }

  /* ==================== key handling ==================== */

  // Core chrome-level key dispatch, shared by the window capture listener and
  // the #lfc=keys test channel (which drives the command center because
  // geckodriver's BiDi input is rejected on moz-extension contexts). Returns
  // whether the key was consumed — the capture listener then
  // preventDefaults/stops propagation, and the channel skips dispatching to
  // content.
  chromeKeyDown = (e) => {
    if (e.isComposing) return false;

    // Web pages are the content script's territory (its own leader, popups,
    // hints and typing guard). If Firefox forwards their keys to this chrome
    // window listener (some builds do), never consume them here — the content
    // script already let them through or handled them. The chrome helper only
    // owns keys on its own pages (command center, about:, extension pages).
    if (!chromeOwnsKeys() && !popup.isOpen()) return false;

    // A chrome popup is open: Esc closes it first (before the page/window).
    if (popup.isOpen()) {
      if (e.key === "Escape") {
        if (popup.resizeOnKey(e as KeyboardEvent)) return true;
        // Let the popup consume Esc itself (e.g. the sessions popup cancels a
        // pending copy/move target picker or steps back to the left pane)
        // before closing it.
        if (popup.handleKey(e as KeyboardEvent)) return true;
        popup.close();
        return true;
      }
      if (popup.resizeOnKey(e as KeyboardEvent)) return true;
      return false;
    }

    const typingNow = typing.focusedIsTyping(e as KeyboardEvent);
    const typingValue = typing.focusedTypingValue(e as KeyboardEvent);

    // The leader (or a one-shot capture) is armed: the next key is a binding —
    // but only while the user isn't composing text. A field HOLDING text means
    // typing wins: a stale leader/capture (e.g. `;` pressed on a page, then
    // clicking into a search box) must disarm and the key must type. An EMPTY
    // focused field keeps the binding (the command-center home input and an
    // about: page's search box hold focus but no text — `;` there must still
    // arm the leader so commands work without a click or Esc first).
    if (leader!.active || leader!.hasPending()) {
      if (typingNow && !(typingValue === "" && (isCommandCenterTab() || isAboutPage()))) {
        if (leader!.active) leader!.hide();
        if (leader!.hasPending()) leader!.cancelPending();
        return false;
      }
      if (leader!.hasPending()) {
        leader!.handlePending(e.key);
        return true;
      }
      leader!.handleKey(e as KeyboardEvent);
      return true;
    }

    // Esc on chrome-owned pages (about:, extension pages) blurs the focused
    // element so the page returns to a neutral state — the settings search box
    // on about:preferences#searchResults keeps focus otherwise, eating every
    // key (and the native page does not always clear it). NOT consumed: the
    // page also receives Esc (its own cancel/clear). The command center owns
    // its Esc (clear input / exit command mode), and web pages are the content
    // script's territory.
    if (e.key === "Escape") {
      if (!isCommandCenterTab()) blurFocusedElement();
      return false;
    }

    // Typing in an editable (a page input, the command center's own input, the
    // URL bar): never intercept — the leader key types like any other. The one
    // exception is an EMPTY focused field on a Lazyfox-owned page (the command
    // center's home input, an about: page's search box): `;` there arms the
    // leader so commands work without a mouse click or an Esc first. The URL
    // bar is deliberately excluded (isAboutPage is false for it).
    if (typingNow) {
      if (
        e.key === leaderKey() &&
        !e.ctrlKey && !e.altKey && !e.metaKey &&
        typingValue === "" &&
        (isCommandCenterTab() || isAboutPage())
      ) {
        leader!.show();
        return true;
      }
      return false;
    }

    // The command center is Lazyfox's own page. In command mode (input
    // blurred) the leader key must arm here so the home-screen shortcuts
    // (;n, ;z, ;s, 1-6, ...) work; in insert mode the typing check above
    // already let `;` through so it types into the input like any other key.
    const k = e.key;
    if (
      k === leaderKey() &&
      !e.ctrlKey && !e.altKey && !e.metaKey &&
      isCommandCenterTab()
    ) {
      leader!.show();
      return true;
    }

    // Ctrl+1-9: hot-swap to the session with that marker (tmux-style).
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      chromeOps.switchSessionByMarker(Number(e.key));
      return true;
    }

    if (handleHotkeys(e as KeyboardEvent)) return true;

    // Ctrl/Alt/Meta chords are never the leader key on their own.
    if (e.ctrlKey || e.altKey || e.metaKey) return false;

    // Vim scroll keys on chrome-owned pages where the content script never
    // runs (about:, extension pages): j/k/d/u scroll, gg/G jump to top/bottom,
    // mirroring the content script's web-page handling. The command center
    // grid owns its own j/k/h/l navigation, so it is excluded.
    if (!isCommandCenterTab() && handleChromeScrollKeys(e)) return true;

    if (k === leaderKey()) {
      leader!.show();
      return true;
    }
    return false;
  };

  // Tell the command-center page `;f` was pressed. The page decides: on the
  // home grid it arms hint-pick, elsewhere it focuses the search box. The home
  // tab is in-process whenever the chrome helper owns its keys, so dispatching
  // an event in the page's realm reaches its listener; out-of-process the page
  // owns the leader and handles `;f` itself.
  function signalCommandCenterFind(): void {
    let reached = false;
    try {
      const cw = window.gBrowser.selectedBrowser.contentWindow;
      const doc = cw && cw.document;
      if (doc && typeof doc.dispatchEvent === "function") {
        doc.dispatchEvent(new (cw as any).Event("lazyfox-find", { bubbles: false, cancelable: false }));
        reached = true;
      }
    } catch (e) {
      // fall through to the input-focus fallback below
    }
    try {
      const cw = window.gBrowser.selectedBrowser.contentWindow;
      const input = cw && cw.document && cw.document.getElementById("input");
      if (input && typeof input.focus === "function") input.focus();
    } catch (e) {
      // ignore
    }
    if (!reached) return;
    // The home-grid hint-pick letter must reach the PAGE even when focus is
    // NOT in it — Firefox keeps the (hidden) URL bar focused on a fresh new
    // tab, and a hint letter typed there would vanish into the URL bar while
    // the page sits armed. The chrome capture listener sees every key, so
    // capture the next one and forward it into the page's document: hint-pick
    // then works regardless of where focus lives. Only armed on the home grid
    // (the page disarms on any non-home mode switch), matching the page-side
    // hintArmed state.
    leader!.armPending((k) => {
      dispatchToCCPage(k);
      return true;
    }, 10000);
    // Pull focus into the page so keys AFTER the pick (and hjkl on the grid)
    // land naturally instead of in the hidden URL bar. Focus the page BODY,
    // never the <browser> element: browser.focus() on an in-process page
    // grabs the first focusable element, which is the search input — silently
    // switching the page into insert mode.
    focusCCBody();
  }

  // Focus the command-center page's body (tabindex=-1) so keyboard focus sits
  // in the page, in command mode, away from Firefox's URL bar and the page's
  // own search input. The page blurs/focuses on load too; this is the chrome
  // side of the same pull, for when the helper routes keys.
  function focusCCBody(): void {
    try {
      const cw = window.gBrowser.selectedBrowser.contentWindow;
      const doc = cw && cw.document;
      const body = doc && doc.body;
      if (body && doc.activeElement !== body && typeof body.focus === "function") {
        body.focus();
      }
    } catch (e) {
      // page not loaded / cross-process — nothing to focus yet
    }
  }

  // Forward a single key into the command-center page's document (the page's
  // own keydown listener drives hint-pick / modes / typing from it). Built
  // with the PAGE's KeyboardEvent constructor — an event created in the chrome
  // realm is invisible to the page's listeners.
  function dispatchToCCPage(k: string): void {
    try {
      const cw = window.gBrowser.selectedBrowser.contentWindow;
      const doc = cw && cw.document;
      if (!doc) return;
      const ctor = (cw as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent || KeyboardEvent;
      const target = (doc.activeElement as Element | null) || doc.documentElement;
      const opts = { key: k, code: k, bubbles: true, cancelable: true };
      target.dispatchEvent(new ctor("keydown", opts));
      target.dispatchEvent(new ctor("keyup", opts));
    } catch (e) {
      // page unreachable — nothing to forward (safe no-op)
    }
  }

  // Is the selected tab a privileged about: page (not the URL bar, not an
  // extension page)? Used to scope the empty-field leader exception.
  function isAboutPage(): boolean {
    try {
      const u = window.gBrowser.selectedBrowser.currentURI;
      return !!(u && u.spec && /^about:/i.test(u.spec));
    } catch (e) {
      return false;
    }
  }

  // Vim-style scrolling for chrome-owned pages where the content script never
  // runs (about:, extension pages): j/k/d/u scroll, gg/G jump. Mirrors the
  // content script's web-page scroll keys. Only works when the page is
  // reachable from chrome (in-process); cross-process pages fall through
  // unconsumed (nothing else can scroll them).
  let lastG = false;
  function handleChromeScrollKeys(e: { key: string }): boolean {
    if (cfg.config.scrollKeys === false) return false;
    const k = e.key;
    const scroll = (fn: (w: any) => void): boolean => {
      try {
        const cw = window.gBrowser.selectedBrowser.contentWindow;
        if (!cw || !cw.document) return false;
        fn(cw);
        return true;
      } catch (err) {
        return false;
      }
    };
    if (k === "j") return scroll((w) => w.scrollBy(0, 60));
    if (k === "k") return scroll((w) => w.scrollBy(0, -60));
    if (k === "d") return scroll((w) => w.scrollBy(0, Math.max(120, w.innerHeight * 0.5)));
    if (k === "u") return scroll((w) => w.scrollBy(0, -Math.max(120, w.innerHeight * 0.5)));
    if (k === "G") {
      return scroll((w) =>
        w.scrollTo(0, w.document.documentElement.scrollHeight || w.document.body.scrollHeight || 0)
      );
    }
    if (k === "g") {
      if (lastG) {
        lastG = false;
        return scroll((w) => w.scrollTo(0, 0));
      }
      lastG = true;
      setTimeout(() => {
        lastG = false;
      }, 600);
      return true;
    }
    return false;
  }

  // Esc on chrome-owned pages: blur whatever holds focus (an about: page's
  // search box, a focused button) so the page returns to its neutral state
  // and the vim keys / leader work without a click. Chrome UI fields (the URL
  // bar) are left alone — the browser owns their Esc behavior.
  function blurFocusedElement(): void {
    try {
      const fd = (document as { commandDispatcher?: { focusedElement?: Element | null } }).commandDispatcher;
      const el = fd && fd.focusedElement;
      if (
        el &&
        el !== document.body &&
        el !== document.documentElement &&
        typeof (el as HTMLElement).blur === "function"
      ) {
        (el as HTMLElement).blur();
        return;
      }
    } catch (e) {
      // fall through to the content probe
    }
    try {
      const cw = window.gBrowser.selectedBrowser.contentWindow;
      const doc = cw && cw.document;
      const ae = doc && doc.activeElement;
      if (ae && ae !== doc.body && ae !== doc.documentElement && typeof ae.blur === "function") {
        ae.blur();
      }
    } catch (e) {
      // cross-process or dead — nothing to blur
    }
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (chromeKeyDown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
  // and `'`, so it fires even after the leader has consumed the `keydown`.
  // Suppress it outside text fields so `;/` opens the find bar deliberately
  // rather than the native bar stealing the key. Also skip when a popup is
  // open — the popup input must receive these characters.
  window.addEventListener(
    "keypress",
    (e) => {
      if (e.key !== "/" && e.key !== "'") return;
      // Same ownership rule as the keydown handler: never suppress quick-find
      // on web pages (the content script does that there).
      if (!typing.focusedIsTyping(e) && !popup.isOpen() && chromeOwnsKeys()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  window.addEventListener("blur", () => {
    // A blur fires on every tab switch (tabbrowser's _adjustFocusAfterTabSwitch
    // moves focus through the window), so close only on a real deactivation of
    // the OS window — checked on the next tick, after the switch settles.
    typing.reset();
    setTimeout(() => {
      try {
        if (Services.focus.activeWindow === window) return;
      } catch (e) {
        // fall through and close
      }
      if (popup.isOpen()) popup.close();
      if (leader!.active) leader!.hide();
    }, 0);
  });

  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      typing.reset();
    });
  } catch (e) {
    // ignore
  }

  // Is the CONTENT script's leader armed in the selected tab? On web pages
  // the content script owns the leader key (chromeOwnsKeys() is false), so
  // the chrome helper's own leader never arms there — but the window-level
  // status bar must still show the pulsing LEADER chevron. The content
  // script reports every arm/disarm to the background, which relays it as a
  // per-index cache the status bar reads. On chrome-owned pages the content
  // script never runs, so the cache is empty and the chrome helper's own
  // leader is the truth.
  function contentLeaderActive(): boolean {
    try {
      const sel = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
      return sel >= 0 && status.contentLeaderActive(sel);
    } catch (e) {
      // ignore
    }
    return false;
  }

  // Does the CHROME helper own this tab's keys? True for its own pages
  // (command center, about:, extension URLs) — false for web content, where
  // the content script owns the leader/popups/hints and the chrome helper
  // must stay hands-off even if Firefox forwards content keys up here.
  function chromeOwnsKeys(): boolean {
    try {
      const b = window.gBrowser.selectedBrowser;
      const u = b && b.currentURI;
      if (!u) return true;
      const s = u.spec || "";
      if (/^https?:/i.test(s) || /^file:/i.test(s)) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  // Link-hints for chrome-owned pages (about:, error pages) where no content
  // script runs. Collects the visible links in the page's real DOM (reachable
  // via contentWindow when the page is in-process), labels the first few with
  // 1-9, then captures the next key through the leader's one-shot slot: a
  // digit opens that link in the current tab, Esc cancels. Gracefully does
  // nothing when the page is unreachable (an out-of-process about:/extension
  // page) and never swallows a key when it cannot draw labels, so it can never
  // break normal key handling.
  let hintKeyEntries: Array<{ href: string; el: any }> = [];
  let hintKeyLabels: any[] = [];
  let hintKeyCleanup: ReturnType<typeof setTimeout> | null = null;
  function clearChromeHints(): void {
    for (const l of hintKeyLabels) {
      try {
        l.remove();
      } catch (e) {
        // ignore
      }
    }
    hintKeyLabels = [];
    hintKeyEntries = [];
    if (hintKeyCleanup) {
      clearTimeout(hintKeyCleanup);
      hintKeyCleanup = null;
    }
  }
  function cleanHref(href: string): string {
    return (href || "").trim();
  }
  function openInSelectedTab(href: string, cw: any): void {
    try {
      const base = cw && (cw.document && cw.document.baseURI);
      const url = new (cw ? cw.URL : URL)(href, base).href;
      const b = window.gBrowser.selectedBrowser;
      if (b && typeof b.fixupAndLoadURIString === "function") {
        b.fixupAndLoadURIString(url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
    } catch (e) {
      // give up silently
    }
  }
  function chromePageHints(): void {
    clearChromeHints();
    let cw: any = null;
    let doc: any = null;
    try {
      const b = window.gBrowser.selectedBrowser;
      cw = b && b.contentWindow;
      doc = cw && cw.document;
      if (!doc || !doc.querySelectorAll) return;
      const vwHeight = cw.innerHeight || 600;
      const anchors = Array.from(doc.querySelectorAll("a[href]")) as any[];
      for (const a of anchors) {
        const href = cleanHref(a.getAttribute("href"));
        // Skip pure-fragment anchors and invisible links.
        if (!href || href.charCodeAt(0) === 35 /* # */) continue;
        const r = a.getBoundingClientRect();
        if (!r || r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vwHeight) continue;
        hintKeyEntries.push({ href: href, el: a });
        if (hintKeyEntries.length >= 9) break;
      }
    } catch (e) {
      return; // page unreachable — no hints (safe no-op)
    }
    if (!hintKeyEntries.length) {
      toast("no links on this page");
      return;
    }
    // Draw the 1-9 labels over each hintable link.
    try {
      const host = doc.body || doc.documentElement;
      hintKeyEntries.forEach((it, i) => {
        const r = it.el.getBoundingClientRect();
        const label = doc.createElement("span");
        label.textContent = String(i + 1);
        label.setAttribute(
          "style",
          "position:fixed;z-index:2147483647;background:#1e1e2e;color:#7aa2f7;" +
            "border:1px solid #414868;border-radius:4px;min-width:16px;height:16px;" +
            "line-height:16px;text-align:center;font:600 11px monospace;" +
            "top:" + (r.top + 2) + "px;left:" + (r.left + 2) + "px;pointer-events:none;"
        );
        host.appendChild(label);
        hintKeyLabels.push(label);
      });
    } catch (e) {
      // Couldn't draw the labels — drop the mode so it never swallows a key.
      clearChromeHints();
      return;
    }
    const snapshot = hintKeyEntries.map((it) => it.href);
    leader!.armPending((k) => {
      const chose = k !== "Escape" ? Number(k) : 0;
      clearChromeHints();
      if (!chose || chose < 1 || chose > snapshot.length) return true;
      const target = snapshot[chose - 1];
      if (target) openInSelectedTab(target, cw);
      return true;
    }, 8000);
    hintKeyCleanup = setTimeout(clearChromeHints, 8000);
  }

  // Is the selected tab the extension's command center page?
  function isCommandCenterTab(): boolean {
    try {
      const b = window.gBrowser.selectedBrowser;
      const uri = b && b.currentURI;
      if (!uri) return false;
      const s = uri.spec || "";
      return s.indexOf("commandcenter.html") !== -1;
    } catch (e) {
      return false;
    }
  }
})();
