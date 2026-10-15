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
import { LOCATION_CHANGE_SAME_DOCUMENT, noteLocationChange } from "./keystate";
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
  // Give the SELECTED tab's content the keyboard. Called on a tab selection and
  // on a new document committing in the selected tab, because those are the two
  // moments the keyboard's target changes — see chrome/keyboardfocus.ts for the
  // report this answers and the three states in which it declines.
  keyboard: { giveKeyboardToSelectedPage(): unknown };
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

  /**
   * Give the keyboard to whichever browser an event is about — IF that browser
   * is the selected one.
   *
   * The two progress triggers (a document committed, a document loaded) are
   * about a browser, and a background tab's document must never take the
   * keyboard away from the page the user is looking at. This is that guard,
   * written once, plus the failure rule every trigger shares: a read that throws
   * (a torn-down tab mid-teardown) must not break the event that carried it.
   */
  const giveKeyboardIfSelected = (browser: any): void => {
    try {
      if (browser === win.gBrowser.selectedBrowser) deps.keyboard.giveKeyboardToSelectedPage();
    } catch {
      // a torn-down tab cannot take the keyboard; the next event tries again
    }
  };

  /* ---- the window's own boot, before any tab can be selected ---- */

  // THE FIRST DOCUMENT OF A SESSION HAS NO EVENT TO ANNOUNCE IT.
  //
  // Every other trigger here is an EVENT — a tab selected, a document
  // replaced, a document finished loading — and at startup there is no event:
  // the window opens with its first tab already selected and, on a restored
  // session, its document already loaded by the time the helper is installed.
  // Whatever holds the keyboard in that state keeps it — Firefox hands a fresh
  // window's keyboard to its address bar on a blank/new-tab page — and the
  // user's first keystroke is spent discovering that nothing answers.
  //
  // So the rule is applied once when the window itself is done loading, which
  // is the one moment guaranteed to be after the initial tab exists and before
  // the user can type into it. It declines in exactly the same cases as the
  // event triggers (a popup, a transient tab, a chrome field the user has
  // typed into), because it is the same rule — see keyboardfocus.ts.
  //
  // WHAT IS AND IS NOT MEASURED HERE. The load trigger below has a failing
  // case and a unit test behind it; this one does not, and saying so is more
  // useful than implying otherwise. The harness launches its own window, so it
  // cannot speak for a session's first tab, and a browser that hands the
  // keyboard to the page itself at startup would make this trigger a no-op
  // rather than a mistake (the rule declines the same way it does everywhere
  // else). It is here because "no event fires" is a real state, not a
  // theoretical one, and the cost of being wrong is one idempotent focus call.
  try {
    const chromeDoc: any = env.document;
    const apply = (): void => {
      try {
        deps.keyboard.giveKeyboardToSelectedPage();
      } catch {
        // a window torn down mid-boot has no page to give the keyboard to
      }
    };
    if (chromeDoc && chromeDoc.readyState === "complete") env.setTimeout(apply, 0);
    else win.addEventListener("load", apply, { once: true } as any);
  } catch {
    // a window without a readable document loads no page here
  }

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
      // THE KEYBOARD FOLLOWS THE TAB, whatever the tab holds. This used to be a
      // command-center-only rule ("a fresh home tab starts with Firefox's
      // URL-bar focus, which would swallow every key"), which left the same hole
      // on every other kind of page — and, measured, on the command center too:
      // the tab is selected a moment BEFORE its document exists, so the pull ran
      // against `about:blank` and the page that finally loaded never got the
      // keyboard. The rule and the two triggers that fire it live in
      // chrome/keyboardfocus.ts; this is the selection half.
      deps.keyboard.giveKeyboardToSelectedPage();
      status.update();
      status.compute();
    });
  } catch {
    // ignore
  }

  /* ---- the real-tab #lfc= channels ---- */

  win.gBrowser.addTabsProgressListener({
    QueryInterface: env.ChromeUtils!.generateQI(["nsIWebProgressListener"]),
    // THE DOCUMENT FINISHED LOADING — the third and last moment the keyboard's
    // target changes, and the one neither earlier trigger can see.
    //
    // Measured, on the failing case: `;n` opens the home tab. TabSelect fires
    // while the tab is still `about:blank`, and the location change fires while
    // the document is being replaced — so a focus granted then is a focus
    // granted to a document that is about to go away, and the document that
    // arrives finds NOBODY has the keyboard at all (the browser's own focus
    // manager reports `focusedElement: null`, not even the <browser> element)
    // until the user clicks the page. That is the reported freeze, at the one
    // action a keyboard-first user performs most.
    //
    // So the rule is applied once more when the top-level document in the
    // SELECTED tab is done loading. Top-level only (`STATE_IS_WINDOW`), because
    // a frame finishing is not a change of who the keyboard belongs to; and the
    // selected tab only, because a background load must not take the keyboard
    // away from the page the user is looking at.
    onStateChange(browser: any, _webProgress: any, _request: any, stateFlags: any) {
      // The IDL's own constants when the host exposes them; the literals are
      // `nsIWebProgressListener.STATE_STOP` (0x10) and `STATE_IS_WINDOW`
      // (0x80000). Read through the host so a platform that renumbers them
      // cannot silently turn this trigger off.
      let stop = 0x10;
      let isWindow = 0x80000;
      try {
        const L = env.Ci && env.Ci.nsIWebProgressListener;
        if (L && typeof L.STATE_STOP === "number") stop = L.STATE_STOP;
        if (L && typeof L.STATE_IS_WINDOW === "number") isWindow = L.STATE_IS_WINDOW;
      } catch {
        // the literals are the IDL's own values
      }
      const flags = Number(stateFlags) || 0;
      if (!(flags & stop) || !(flags & isWindow)) return;
      giveKeyboardIfSelected(browser);
    },
    onLocationChange(browser: any, _webProgress: any, _request: any, loc: any, flags: any) {
      if (!loc) return;
      // A REAL NAVIGATION MEANS THE DOCUMENT THAT ANNOUNCED ITSELF IS GONE, and
      // this is the only notification that says so when the document could not
      // say it itself (a killed content process sends no `pagehide`, and a
      // replacement document only ever REPLACES a record — so a page with no
      // content script of its own would inherit the dead one's answer forever).
      // An in-page navigation is marked as the same document and keeps its
      // record; see keystate.noteLocationChange for the whole argument, and the
      // e2e case that proves this build really delivers the flag for
      // `pushState` on a remote browser.
      const crossDocument = !(Number(flags) & LOCATION_CHANGE_SAME_DOCUMENT);
      noteLocationChange(win, browser, Number(flags) || 0, env.Ci);
      // THE OTHER MOMENT THE KEYBOARD'S TARGET CHANGES: a NEW DOCUMENT in the
      // SELECTED tab. A tab is selected while it is still showing `about:blank`,
      // so the selection trigger above runs against a document that is about to
      // be replaced — and the replacement arrives with no keyboard, which is the
      // "I open a tab and Lazyfox is dead until I click" half of the report.
      // Measured: `;n` opened the home tab, the tab was in front, and the page
      // answered no keys until the page was clicked.
      //
      // Only the SELECTED tab (a background load must not steal the keyboard) and
      // only a CROSS-DOCUMENT change (an in-page navigation keeps the document,
      // so there is nothing to give back — and a page that rewrites its own URL
      // while the user is typing in it must not be touched).
      if (crossDocument) giveKeyboardIfSelected(browser);
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