// Keeping the chrome helper in step with the window: the pollers, the
// #lfc= progress route, and the per-tab-select bookkeeping.
//
// Split out of main.ts. These are the parts of the helper that happen on a
// TIMER or on a chrome event rather than in response to a key, and they share
// one property that made them hard to leave in the composition root: they all
// reach across every module at once (status, split, leader, channel, alive), so
// reading main.ts to answer "what runs every 500ms" meant reading all of it.
//
// The intervals themselves stay named constants rather than being configured:
// there are exactly two, their periods are load-bearing (500ms is the relay
// poll the messaging design assumes; 1s is the download indicator, which is
// allowed to be approximate), and a config knob here would be a knob nobody
// would ever turn.

import { chromeOwnsSurfaces } from "./keystate";
import { isCommandCenterTab } from "./keystate";
import { focusCommandCenterContent } from "./commandcenterfocus";
import type { ChromeEnv } from "./env";

export interface WinSyncDeps {
  // The chrome environment, as the whole ChromeEnv: this module reaches for
  // the window, ChromeUtils.generateQI, services.obs and setTimeout, and all of
  // them are members of it - so the composition root hands over one object and
  // this module has no idea where the chrome document came from.
  env: ChromeEnv;
  // The relay channel: startRelay keeps the relay tab alive, handleLfc routes
  // the real-tab #lfc= channels.
  channel: { startRelay(): boolean; requestSessionState(): Promise<void>; handleLfc(browser: any, payload: string): void };
  // The alive announce, re-announced every tick.
  alive: { announce(): void };
  split: { rememberSplit(): void };
  status: {
    update(): void;
    compute(): void;
    pollDownloads(): Promise<void>;
    setActiveStealth(on: boolean): void;
    getStealthFlags(): boolean[];
  };
  // The chrome leader, late-bound.
  leader(): { active: boolean; hasPending(): boolean; hide(): void } | null;
}

// How often the relay is polled and the bar recomputed. The relay poll is not
// an arbitrary tick: the messaging design in docs/MESSAGING.md has the helper
// read the relay page's rewritten URL, and this is the rate at which it does.
const RELAY_POLL_MS = 500;
// Download progress is allowed to be approximate — it is a visual indicator and
// the popup reads the same manager cache, so the two always agree.
const DOWNLOAD_POLL_MS = 1000;
// A first read slightly after startup, so the ⭳ segment is populated before
// anyone is waiting on it.
const DOWNLOAD_FIRST_READ_MS = 1500;
// The session summary round-trip creates a transient background tab, so it is
// fetched ONCE at startup and then only after chrome-triggered session actions —
// never on a timer and never on TabSelect, which would churn tab counts under
// automation.
const SESSION_STATE_FIRST_READ_MS = 2000;

export function installWinSync(deps: WinSyncDeps): void {
  const { env, status } = deps;
  const win = env.window as any;

  /* ---- tab select bookkeeping ---- */

  // Fetch the session name + list once at startup and after chrome-triggered
  // session actions (see the constant above for why not on a timer).
  env.setTimeout(() => void deps.channel.requestSessionState(), SESSION_STATE_FIRST_READ_MS);

  try {
    win.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      deps.split.rememberSplit();
      // The stealth badge must track the tab you switched to immediately;
      // sessionState round-trips are not polled on TabSelect, so derive the
      // flag locally from the per-tab stealthFlags the last reply carried.
      try {
        const sel = win.gBrowser.tabs.indexOf(win.gBrowser.selectedTab);
        status.setActiveStealth(!!(status.getStealthFlags()[sel] || false));
      } catch {
        // ignore
      }
      // A fresh command-center tab starts with Firefox's URL-bar focus, which
      // would swallow every key — pull focus into the page.
      if (isCommandCenterTab(win)) focusCommandCenterContent(win);
      status.update();
      status.compute();
    });
  } catch {
    // ignore
  }

  /* ---- the real-tab #lfc= channels ---- */

  win.gBrowser.addTabsProgressListener({
    QueryInterface: env.ChromeUtils!.generateQI(["nsIWebProgressListener"]),
    onLocationChange(browser: any, _webProgress: any, _request: any, loc: any) {
      if (!loc) return;
      // The selected tab may have crossed the web/chrome boundary (e.g. a web
      // page navigated to about:preferences): remount the chrome status bar
      // accordingly. update is cheap and idempotent, and the status module
      // reads the *selected* browser, so location changes in background tabs
      // are harmless here.
      status.update();
      if (loc.scheme !== "moz-extension") return;
      const spec = loc.spec;
      const h = spec.indexOf("#");
      if (h < 0) return;
      const frag = spec.slice(h + 1);
      if (frag.indexOf("lfc=") !== 0) return;
      deps.channel.handleLfc(browser, frag.slice(4));
    },
  });

  /* ---- pollers ---- */

  // Poll every 500ms so the bar hides the moment content enters DOM fullscreen
  // (video) — only a poll catches that attribute transition reliably.
  // status.update is idempotent and cheap. startRelay() keeps the relay tab
  // alive: the announce creates it, and if the relay ever dies (tab closed,
  // window rebuilt) this re-creates it within half a second.
  win.setInterval(() => {
    deps.alive.announce(); // once the extension URL resolves, tell it we're here
    deps.channel.startRelay();
    // Stand down surfaces this window no longer owns. TabSelect covers a tab
    // switch, but a NAVIGATION WITHIN the selected tab does not fire it — and
    // that is the other way the chrome which-key overlay outlived its page:
    // arm it on the command center, navigate that same tab to a web page, and
    // the chrome overlay stayed lit under the content script's own. Polling is
    // the honest catch-all for an ownership change nothing else announces, and
    // it costs one attribute read when nothing needs doing.
    try {
      const leader = deps.leader();
      if (!chromeOwnsSurfaces(win) && leader && (leader.active || leader.hasPending())) {
        leader.hide();
      }
    } catch (e) {
      // ignore
    }
    status.update();
    status.compute();
  }, RELAY_POLL_MS);

  // Download progress on the bar: poll Downloads.sys.mjs once a second and
  // refresh the ⭳ segment. The popup reads the same manager cache, so the two
  // always agree.
  win.setInterval(() => {
    void status.pollDownloads();
  }, DOWNLOAD_POLL_MS);
  env.setTimeout(() => {
    void status.pollDownloads();
  }, DOWNLOAD_FIRST_READ_MS);

  // When a page element goes fullscreen (a video), the window-level bar would
  // sit over the full-screen content — hide it and re-show when it exits.
  // status.update() reads isFullscreen() itself, so it handles both edges.
  // The observer notifications are the same signals Firefox's own UI listens
  // to: they make the hide/re-show immediate (the 500ms poll is only a
  // backstop) and survive changes to the chrome document's inDOMFullscreen
  // attribute handling.
  try {
    const onFullscreen = () => status.update();
    win.addEventListener("fullscreenchange", onFullscreen);
    win.addEventListener("willenterfullscreen", onFullscreen);
    win.addEventListener("willexitfullscreen", onFullscreen);
    const fsObs = {
      observe: onFullscreen,
      QueryInterface: env.ChromeUtils!.generateQI(["nsIObserver"]),
    };
    env.services.obs.addObserver(fsObs, "MozDOMFullscreen:Entered");
    env.services.obs.addObserver(fsObs, "MozDOMFullscreen:Exited");
  } catch {
    // ignore
  }
}