// Typed message contracts between the extension contexts:
//   - content script / command center / popup / options  ->  background
//     (browser.runtime.sendMessage, handled in background.ts)
//   - chrome helper -> background via the #lfc=req.<action> tab channel
//   - background -> content script (startHints / focusFirstInput)
// One table, typed request and response per action, so the send() helper and
// the background handler cannot drift.
import type { LeaderPanelHtml, LeaderSignal } from "./leadersignal";
import type { CacheMode, CacheScope, CacheState, Config, PageReport, PopupItem, Session, SessionSummaryItem, TabInfo } from "./types";

export interface WindowSize {
  width: number;
  height: number;
  top: number;
  left: number;
  state: string;
}

export interface BgApi {
  searchSuggest: { req: { q: string }; res: { entries: PopupItem[] } };
  urlSuggest: { req: { q: string }; res: { entries: PopupItem[] } };
  tabs: { req: Record<string, never>; res: { tabs: TabInfo[] } };
  // Separate from `tabs`: the multi-digit tab jump needs only the count and
  // is on the hot path — a digit press must not pay for every tab's title,
  // url and favicon to learn whether `;1` is ambiguous.
  tabCount: { req: Record<string, never>; res: { count: number } };
  activateTab: { req: { id: number }; res: { ok: boolean } };
  activateTabAt: { req: { index?: number; last?: boolean }; res: { ok: boolean; title?: string } };
  moveTab: { req: { id: number; dir: number }; res: { ok: boolean } };
  moveActiveTab: { req: { dir: number }; res: { ok: boolean } };
  closeTab: { req: { id?: number; force?: boolean }; res: { ok: boolean; last?: boolean } };
  newTab: { req: Record<string, never>; res: { ok: boolean } };
  reopenTab: { req: Record<string, never>; res: { ok: boolean } };
  alternateTab: { req: Record<string, never>; res: { ok: boolean } };
  recentlyClosed: { req: Record<string, never>; res: { items: PopupItem[] } };
  restoreClosedTab: { req: { key: string }; res: { ok: boolean } };
  restoreAllClosed: { req: Record<string, never>; res: { ok: boolean; count?: number } };
  removeHistory: { req: { url: string }; res: { ok: boolean } };
  clearHistory: { req: Record<string, never>; res: { ok: boolean } };
  duplicateTab: { req: Record<string, never>; res: { ok: boolean } };
  reload: { req: Record<string, never>; res: { ok: boolean } };
  back: { req: Record<string, never>; res: { ok: boolean; atRoot?: boolean } };
  forward: { req: Record<string, never>; res: { ok: boolean; atEnd?: boolean } };
  // Active tab's navigation stack: entries oldest-first (current included),
  // canBack/canForward for the "at root / at end" indications.
  navStack: { req: Record<string, never>; res: { canBack: boolean; canForward: boolean; index: number; entries: { url: string; title: string }[] } };
  // Jump to a position in the navigation stack (0-based, oldest = 0).
  navGoto: { req: { index: number }; res: { ok: boolean } };
  openUrl: { req: { url: string; newTab?: boolean }; res: { ok: boolean } };
  openPage: { req: { url: string }; res: { ok: boolean } };
  openUI: { req: { which: string }; res: { ok: boolean } };
  search: { req: { query: string; newTab?: boolean }; res: { ok: boolean; engine?: string; reused?: boolean } };
  searchInPlace: { req: { query: string }; res: { ok: boolean } };
  listSessionTabs: { req: { name: string }; res: { items: PopupItem[] } };
  windowSize: { req: Record<string, never>; res: WindowSize };
  resizeWindow: { req: { dx: number; dy: number }; res: { width: number; height: number; state: string } };
  moveWindow: { req: { dx: number; dy: number }; res: { left: number; top: number; state: string } };
  maximize: { req: Record<string, never>; res: { maximized: boolean; state: string } };
  history: { req: { q: string }; res: { items: PopupItem[] } };
  bookmarks: { req: { q: string }; res: { items: PopupItem[] } };
  downloads: { req: Record<string, never>; res: { items: PopupItem[] } };
  openDownload: { req: { id: string }; res: { ok: boolean } };
  removeDownload: { req: { id: string }; res: { ok: boolean } };
  openDownloadLocation: { req: { id: string }; res: { ok: boolean } };
  retryDownload: { req: { id: string }; res: { ok: boolean; error?: string; resumed?: boolean } };
  // Relayed to the chrome helper (ChromeApi["dismissDownload"]): the bar is
  // the helper's, so `;D` on a page that has no bar used to be a documented
  // no-op — bound, consumed, and doing nothing.
  dismissDownload: { req: Record<string, never>; res: { ok: boolean } };
  stealthOpen: { req: Record<string, never>; res: { ok: boolean; error?: string } };
  openSetup: { req: Record<string, never>; res: { ok: boolean } };
  // The diagnostics & performance page (live page diagnosis, framework
  // detection report, efficiency metering).
  openDiagnostics: { req: Record<string, never>; res: { ok: boolean } };
  // The add-ons page: what is installed, and what can be turned off, opened or
  // removed. Never an installer — see src/extension/addons.ts.
  openAddons: { req: Record<string, never>; res: { ok: boolean } };
  // Live page report. No tabId = the active tab (or the last real page tab,
  // since the diagnostics page is itself an extension tab); null report =
  // the tab has no content script at all — itself a diagnostic answer.
  pageReport: { req: { tabId?: number }; res: { report: PageReport | null; tabId: number | null } };
  // Every tab in the window the diagnostics page can target, strip order.
  diagnoseTabs: { req: Record<string, never>; res: { tabs: { id: number; title: string; url: string; active: boolean }[] } };
  // Page-cache policy: read here, changed through cacheSet (see CacheState).
  cacheState: { req: Record<string, never>; res: CacheState };
  cacheSet: { req: { scope: CacheScope; mode: CacheMode }; res: { ok: boolean; state?: CacheState; error?: string } };
  // Hard reload of the active tab (bypasses the HTTP cache).
  hardReload: { req: Record<string, never>; res: { ok: boolean } };
  quit: { req: Record<string, never>; res: { ok: boolean } };
  zen: { req: Record<string, never>; res: { zen: boolean } };
  mute: { req: Record<string, never>; res: { muted: boolean } };
  copyUrl: { req: Record<string, never>; res: { url: string; title: string } };
  components: {
    req: Record<string, never>;
    res: {
      extension: string;
      wasm: string;
      nativeHost: string | null;
      nativeProtocol: string | null;
      chromeHelper: string | null;
      /** Whether the helper can see the window actor ("ok"/"missing"), or null while it has never announced. Distinct from chromeHelper === null: installed but not reaching the content process is exactly the "keys do nothing on this page" case. */
      bridge: "ok" | "missing" | null;
    };
  };
  zoom: { req: { delta: number; factor?: number }; res: { factor?: number } };
  // Screenshot: forward to the chrome helper, whose Firefox Screenshots
  // module owns the native region picker and capture. Reply means "asked".
  screenshot: { req: { shot: string }; res: { ok: boolean; note?: string } };
  setConfig: { req: { config: Config }; res: { ok: boolean } };
  toggleWhichKey: { req: Record<string, never>; res: { whichKey: boolean } };
  syncTyping: { req: { typing: boolean }; res: { ok: boolean } };
  // Content-script leader arm/disarm, relayed to the helper's bar (the only
  // leader indicator on web pages). One readout value, NOT three fields: a
  // wire shape the sender can half-fill showed a chord with no expectation
  // in a live browser only.
  syncLeader: {
    req: {
      signal: LeaderSignal;
      // The rendered which-key menu, when the page is in a SPLIT view and has
      // asked the chrome helper to paint it (a page's own overlay is clipped to
      // its pane). Absent for every other page: nothing in the window changes.
      panel?: LeaderPanelHtml | null;
    };
    res: { ok: boolean };
  };
  // "Is THIS document one pane of a split view?" Asked once on boot, because a
  // content script has no way to read splitViewId (it is a tabs-API field) and
  // the answer changes which surface paints the leader menu.
  splitState: { req: Record<string, never>; res: { split: boolean } };
  // "A content script is running in this tab", boot-pushed / pagehide-
  // retracted. It exists because the helper cannot look it up itself
  // (contentDocument is null for every OOP tab) — dead-keyboard prevention.
  // `hold` rides back: a just-booted script asks "is the leader key still
  // physically down?" and only the background can answer for a document it
  // has never seen.
  syncContent: {
    req: { active: boolean; url: string; doc?: string };
    res: { ok: boolean; hold?: boolean; holdAt?: number; holdDoc?: string; holdGeneration?: number };
  };
  // The HELD leader key, a per-tab fact: the hold used to live in the script
  // that set it, so hold `;` + `x` (close tab) left the next script with
  // sticky === false and the second `x` typed a literal character — exactly
  // on the actions worth chaining (close/back/forward, `;g`/`;l`). A tab
  // session value, the one store that outlives the script.
  syncHold: { req: { hold: boolean; generation: number; doc: string }; res: { ok: boolean; error?: string } };
  // Find-in-page state (1-based current, total), relayed to the helper's bar.
  syncFind: { req: { cur: number; count: number }; res: { ok: boolean } };
  // The dark verdict for THIS tab: mode is auto|dark|light (empty/off clears
  // the segment), engine native|dynamic|filter — what lets the bar tell "the
  // site's own theme" apart from one we recoloured.
  syncDark: { req: { on: boolean; mode: string; engine: string }; res: { ok: boolean } };
  sessionList: { req: Record<string, never>; res: { sessions: Session[] } };
  sessionSave: { req: { name: string }; res: { ok: boolean; session?: Session } };
  sessionNew: { req: { name: string }; res: { ok: boolean; note?: string } };
  sessionRestore: { req: { name: string }; res: { ok: boolean } };
  // `note`: deleteSession ANSWERS with a reason ("no such session"); an
  // outcome the caller cannot read is an outcome it cannot toast.
  sessionDelete: { req: { name: string }; res: { ok: boolean; note?: string } };
  sessionSwitchByMarker: { req: { marker: number }; res: { ok: boolean; name?: string } };
  sessionAssignMarker: { req: { name: string; marker: number }; res: { ok: boolean; note?: string } };
  sessionTabCopy: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  sessionTabMove: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  // No payload: the groups are re-derived from `browser.tabs`' own
  // `splitViewId` when the snapshot is written, so a payload could only
  // disagree with the thing it describes.
  layoutChanged: { req: Record<string, never>; res: null };
  sessionSplit: { req: { orientation: "horizontal" | "vertical" }; res: { ok: boolean; note?: string } };
  sessionUnsplit: { req: Record<string, never>; res: { ok: boolean; note?: string } };
  sessionSwitchPane: { req: { dir: number }; res: { ok: boolean; note?: string } };
  sessionSwapPane: { req: { dir: number }; res: { ok: boolean; note?: string } };
  // `split` is 1-based among the window's split groups in strip order,
  // omitted when there is only one — several native splits can coexist, so
  // "move this tab into the split" is a question with multiple answers.
  sessionSplitAddTabByIndex: { req: { index: number; split?: number }; res: { ok: boolean; note?: string } };
  // The splits in this window, strip order. The `;W m` chooser draws this:
  // tabs carry `splitViewId`, so the extension groups them without asking
  // the chrome helper for anything.
  sessionSplitTargets: {
    req: Record<string, never>;
    res: {
      splits: { split: number; active: boolean; panes: { title: string; url: string; active: boolean }[] }[];
    };
  };
  // Take the SELECTED tab out of its split, leaving the rest of the group
  // intact — unlike sessionUnsplit, which dissolves the whole group.
  sessionPullFromSplit: { req: Record<string, never>; res: { ok: boolean; note?: string } };
  splitPanelTabs: {
    req: Record<string, never>;
    res: {
      tabs: {
        index: number;
        id: number;
        url: string;
        title: string;
        active: boolean;
        inSplit: boolean;
        // The tab's own icon, so the pane list reads like the tab strip.
        favIconUrl?: string;
      }[];
    };
  };
  moveTabToSplit: { req: { index: number }; res: { ok: boolean } };

  sessionState: {
    req: Record<string, never>;
    res: {
      name: string;
      marker: number;
      tabIndex: number;
      tabCount: number;
      inSplit: boolean;
      splitOrientation?: "horizontal" | "vertical";
      splitActive: number;
      splitPanes: number;
      sessions: SessionSummaryItem[];
      tabIds: number[];
      activeStealth: boolean;
      stealthFlags: boolean[];
    };
  };
}

export type BgAction = {
  [K in keyof BgApi]: { action: K; data: BgApi[K]["req"] };
}[keyof BgApi];

export type BgResult<K extends keyof BgApi> = BgApi[K]["res"];

// Typed send(). Returns null when the background is unreachable or rejects.
// The data argument is optional exactly for the no-request actions:
// send("tabs") is legal, send("activateTab") without data is a compile error.
type ReqOf<K extends keyof BgApi> = BgApi[K]["req"];
type HasReq<K extends keyof BgApi> = [ReqOf<K>] extends [Record<string, never>] ? false : true;

export async function send<K extends keyof BgApi>(
  action: K,
  ...args: HasReq<K> extends true ? [data: ReqOf<K>] : [data?: ReqOf<K>]
): Promise<BgResult<K> | null> {
  const data = (args[0] || {}) as ReqOf<K>;
  try {
    const res = await browser.runtime.sendMessage({ action: action, data: data });
    return res as BgResult<K>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The relay channel's contract (chrome helper <-> background): a SECOND bus
// from BgApi, once untyped (`requestBg(action: string)` + a 30-branch string
// matcher in the background). A typo then was a silent runtime no-op, not a
// compile error — measured: `openDiagnostics` was sent and handled by
// nobody, so `;T` did nothing unless the CONTENT script owned the keypress.
//
// Every relay action now declares its request and response, `RelayHandlers`
// is built with `satisfies Record<keyof RelayApi, ...>` so the background
// must cover every action, and args are structured values, not packed
// strings — the U+0001 separator hack in assignSessionMarker/sessionTabCopy
// is gone.
// ---------------------------------------------------------------------------
export interface RelayApi {
  // The helper's announce: version, active profile display name and raw
  // directory leaf, whether the content-process bridge came up. Retried on a
  // timer until ACKNOWLEDGED — a fire-and-forget request only proves queued.
  alive: {
    req: {
      version: string;
      profileName?: string;
      profileDir?: string;
      bridge?: "1" | "0";
      // The loader's console lines (Services.console, "lazyfox"-tagged),
      // relayed on the one channel that provably works and filed in storage:
      // the browser console is an observer nobody watches, and the snapshot
      // channel dies in exactly the situations the lines exist for.
      errs?: string[];
    };
    res: { ok: true };
  };
  // Flip the "press the key to reach the chrome layer" preference on both
  // copies: the helper flips its cache, the background flips storage.
  toggleWhichKey: { req: Record<string, never>; res: null };
  // Ask the active tab's content script to start hinting / focus its first
  // field. Best-effort: a tab with no content script is a normal outcome.
  startHints: { req: Record<string, never>; res: null };
  focusFirstInput: { req: Record<string, never>; res: null };
  openOptions: { req: Record<string, never>; res: null };
  openSetup: { req: Record<string, never>; res: null };
  openDiagnostics: { req: Record<string, never>; res: null };
  quit: { req: Record<string, never>; res: null };
  // Open a new container window; the result comes back so the helper can
  // toast a failure instead of swallowing it.
  stealthOpen: { req: Record<string, never>; res: { ok: boolean; error?: string } };
  // Read-only pulls for the chrome-side UI.
  sessionState: { req: Record<string, never>; res: RelaySessionState };
  sessionTabs: { req: { name: string }; res: PopupItem[] };
  recentlyClosed: { req: Record<string, never>; res: PopupItem[] };
  reopenTab: { req: Record<string, never>; res: { ok: boolean } };
  // Session + tab mutations; the helper refreshes the status bar itself.
  saveSession: { req: { name: string }; res: null };
  newSession: { req: { name: string }; res: null };
  restoreSession: { req: { name: string }; res: null };
  // deleteSession ANSWERS, unlike its siblings: a deletion must be
  // observable before anything re-reads the list — the popup's refetch once
  // landed before the storage write, so `x x` left the deleted session
  // sitting in the list. An awaited reply is the only ordering guarantee
  // that does not rest on a timer.
  deleteSession: { req: { name: string }; res: { ok: boolean; note?: string } };
  switchSessionByMarker: { req: { marker: number }; res: null };
  assignSessionMarker: { req: { name: string; marker: number }; res: null };
  // Answer with a human-readable `note` on failure; fire-and-forget once
  // made a copy into a nonexistent session look exactly like a successful
  // one.
  sessionTabCopy: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  sessionTabMove: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  // THE SPLIT LAYOUT CHANGED, and nothing else will say so: a native split
  // does not touch the tab list (same tabs, re-paired), no `tabs.*` event
  // fires, and the tab-event-driven autosave never re-measured — a restart
  // brought tabs back without their pairings. The helper is the only side
  // that knows, so it says so here. Fire-and-forget: the reply would only
  // tell the helper what it already knows.
  layoutChanged: { req: Record<string, never>; res: null };
  // Tab strip / history actions the helper cannot do itself (they need the
  // background's storage view and its filtered reopen).
  alternateTab: { req: Record<string, never>; res: null };
  restoreClosedTab: { req: { key: string }; res: null };
  restoreAllClosed: { req: Record<string, never>; res: null };
  removeHistory: { req: { url: string }; res: null };
  clearHistory: { req: Record<string, never>; res: null };
}

// The session summary the chrome status bar renders. Structurally the same
// payload as BgApi["sessionState"], minus the extension-only fields —
// declared separately because the two travel over different buses and the
// chrome side never sees the extension's copy.
export interface RelaySessionState {
  name: string;
  marker: number;
  tabIndex: number;
  tabCount: number;
  inSplit: boolean;
  splitOrientation?: "horizontal" | "vertical";
  splitActive: number;
  splitPanes: number;
  sessions: SessionSummaryItem[];
  tabIds: number[];
  activeStealth: boolean;
  stealthFlags: boolean[];
}

export type RelayAction = keyof RelayApi;
export type RelayReq<K extends RelayAction> = RelayApi[K]["req"];
export type RelayRes<K extends RelayAction> = RelayApi[K]["res"];

// Background -> chrome pushes, typed the same way — what handleCmd
// dispatches, so a status-bar update finally type-checks against what the
// status bar accepts.
export interface ChromeApi {
  splitTab: { req: Record<string, never>; res: void };
  unsplit: { req: Record<string, never>; res: void };
  switchPane: { req: { dir: number }; res: void };
  swapSplitPanes: { req: { dir: number }; res: void };
  moveToSplit: { req: { index: number; split?: number }; res: void };
  // Pull one tab out of its split group (1-based pane position inside the
  // selected group); nothing else changes.
  pullFromSplit: { req: Record<string, never>; res: void };
  // Session restore finished opening tabs: re-create the native split
  // groupings, 1-based positions over the SAVED tab list. `expect` is the
  // number of real tabs the restore produced: a tab's element appears in the
  // parent process a tick or two after `tabs.create` resolves, and pairing
  // early pairs the tabs being torn down.
  restoreSplits: { req: { groups: number[][]; expect?: number }; res: void };
  sessionState: { req: RelaySessionState; res: void };
  // Clear the bar's download notification(s) — pushed, because the page
  // that pressed `;D` has nothing left to do once the bar is told.
  dismissDownload: { req: Record<string, never>; res: void };
  // A download APPEARED (or finished) — pushed by the background from
  // `browser.downloads` events. The bar reads Firefox's download list on a
  // timer, and that timer is deliberately slow while nothing is downloading
  // (see statusbar.pollDownloads); this push is what makes the first second of
  // a new download show up immediately instead of up to an idle period late.
  downloadsChanged: { req: Record<string, never>; res: void };
  leaderState: {
    req: { index: number; signal: LeaderSignal; panel?: LeaderPanelHtml | null };
    res: void;
  };
  // `doc` is the reporting document's own nonce. The URL rides along to
  // DESCRIBE the page but cannot IDENTIFY the document: an SPA navigation
  // rewrites the URL without replacing the document, so a URL-keyed record
  // goes stale on the first pushState (keystate.noteContentPresent).
  contentState: { req: { index: number; active: boolean; url: string; doc?: string }; res: void };
  findState: { req: { index: number; count: number; cur: number }; res: void };
  darkState: { req: { index: number; on: boolean; mode: string; engine: string }; res: void };
  // Firefox's native Screenshots for the selected tab (see screenshots.ts):
  // shot is "full" | "visible".
  screenshot: { req: { shot: string }; res: void };
  cacheGlobal: { req: { mode: CacheMode }; res: void };
  cachePolicy: { req: { mode: CacheMode; tabIds: number[] }; res: void };
  // The stored config changed in the background (a `;q` from a web page, an
  // options-page save). The helper caches its own copy in prefs, so without
  // this push a toggle made from a CONTENT script never reached the panes the
  // helper owns — which-key kept painting there after it was turned off.
  cfg: { req: { config: Partial<Config> }; res: void };
}

export type ChromeAction = keyof ChromeApi;
export type ChromeReq<K extends ChromeAction> = ChromeApi[K]["req"];

// The argument a request carries on the wire. No-request actions are sent
// with an empty object, so the encoder never special-cases "no argument".
export type RelayArg = { [K in RelayAction]: RelayReq<K> }[RelayAction];
