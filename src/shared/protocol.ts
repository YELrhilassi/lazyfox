// Typed message contracts between the extension contexts:
//   - content script / command center / popup / options  ->  background
//     (browser.runtime.sendMessage, handled in background.ts)
//   - chrome helper -> background via the #lfc=req.<action> tab channel
//   - background -> content script (startHints / focusFirstInput)
// One table, typed request and response per action, so the send() helper and
// the background handler cannot drift.
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
  back: { req: Record<string, never>; res: { ok: boolean } };
  forward: { req: Record<string, never>; res: { ok: boolean } };
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
  stealthOpen: { req: Record<string, never>; res: { ok: boolean; error?: string } };
  openSetup: { req: Record<string, never>; res: { ok: boolean } };
  // Open the diagnostics & performance page (the "special page": live page
  // diagnosis, framework-site detection report, efficiency metering).
  openDiagnostics: { req: Record<string, never>; res: { ok: boolean } };
  // Live page report from a tab's content script. With no tabId it reports the
  // active tab (or the last real page tab, since the diagnostics page is
  // itself an extension tab); pass a tabId to diagnose any specific tab. null
  // means the tab has no content script at all (about:/error pages, restricted
  // domains, extension pages) — which is itself the diagnostic answer.
  pageReport: { req: { tabId?: number }; res: { report: PageReport | null; tabId: number | null } };
  // Every tab in the current window the diagnostics page can target, in strip
  // order, so the page can offer a tab picker.
  diagnoseTabs: { req: Record<string, never>; res: { tabs: { id: number; title: string; url: string; active: boolean }[] } };
  // Page-cache policy: the diagnostics page reads the current policy here and
  // changes it through cacheSet. See CacheState for what each scope can do.
  cacheState: { req: Record<string, never>; res: CacheState };
  cacheSet: { req: { scope: CacheScope; mode: CacheMode }; res: { ok: boolean; state?: CacheState; error?: string } };
  // Reload the active tab bypassing its HTTP cache (Firefox's "hard reload").
  hardReload: { req: Record<string, never>; res: { ok: boolean } };
  quit: { req: Record<string, never>; res: { ok: boolean } };
  zen: { req: Record<string, never>; res: { zen: boolean } };
  mute: { req: Record<string, never>; res: { muted: boolean } };
  copyUrl: { req: Record<string, never>; res: { url: string; title: string } };
  components: {
    req: Record<string, never>;
    res: { extension: string; wasm: string; nativeHost: string | null; nativeProtocol: string | null; chromeHelper: string | null };
  };
  zoom: { req: { delta: number; factor?: number }; res: { factor?: number } };
  setConfig: { req: { config: Config }; res: { ok: boolean } };
  toggleWhichKey: { req: Record<string, never>; res: { whichKey: boolean } };
  syncTyping: { req: { typing: boolean }; res: { ok: boolean } };
  // Content script -> background: the content-script leader armed/disarmed.
  // The background relays it to the chrome helper (whose window-level status
  // bar shows the pulsing LEADER chevron on web pages, where the content
  // script owns the leader key and the chrome helper's own leader never
  // arms).
  syncLeader: { req: { active: boolean }; res: { ok: boolean } };
  // Content script -> background: live find-in-page state (1-based current
  // match, 0 = nothing walked to yet; total matches). The background relays it
  // to the chrome helper so its window-level status bar shows the find count
  // on web pages (where the content script owns the find widget).
  syncFind: { req: { cur: number; count: number }; res: { ok: boolean } };
  sessionList: { req: Record<string, never>; res: { sessions: Session[] } };
  sessionSave: { req: { name: string }; res: { ok: boolean; session?: Session } };
  sessionNew: { req: { name: string }; res: { ok: boolean; note?: string } };
  sessionRestore: { req: { name: string }; res: { ok: boolean } };
  sessionDelete: { req: { name: string }; res: { ok: boolean } };
  sessionSwitchByMarker: { req: { marker: number }; res: { ok: boolean; name?: string } };
  sessionAssignMarker: { req: { name: string; marker: number }; res: { ok: boolean; note?: string } };
  sessionTabCopy: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  sessionTabMove: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  sessionSplit: { req: { orientation: "horizontal" | "vertical" }; res: { ok: boolean; note?: string } };
  sessionUnsplit: { req: Record<string, never>; res: { ok: boolean; note?: string } };
  sessionSwitchPane: { req: { dir: number }; res: { ok: boolean; note?: string } };
  sessionSwapPane: { req: { dir: number }; res: { ok: boolean; note?: string } };
  sessionSplitAddTabByIndex: { req: { index: number }; res: { ok: boolean; note?: string } };
  splitPanelTabs: {
    req: Record<string, never>;
    res: { tabs: { index: number; id: number; url: string; title: string; active: boolean; inSplit: boolean }[] };
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

// Typed send() used by the content script, command center, popup and options.
// Returns null when the background is unreachable or rejects. The data argument
// is optional exactly for the no-request actions, so `send("tabs")` is legal
// while `send("activateTab")` without data is a compile error.
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
// The relay channel's contract (chrome helper <-> background).
//
// This is a SECOND, separate message bus from BgApi above, and it used to have
// no types at all: `requestBg(action: string, arg?: string)` and a background
// `handleRelayReq(action: string, arg: any)` that string-matched its way down a
// 30-branch if-chain. Nothing checked that the two ends agreed, so a typo was a
// silent no-op at runtime rather than a compile error — and that is not
// hypothetical: `openDiagnostics` was sent by the chrome side and handled by
// nobody, so `;T` did nothing unless the CONTENT script happened to own the
// keypress.
//
// The table below is the fix. Every relay action has a declared request and
// response, so:
//   - `bg("openDiagnostics")` compiles only if that action exists
//   - `bg("restoreClosedTab", key)` only accepts a string
//   - the background's handler table must cover every action, because
//     `RelayHandlers` is built from `satisfies Record<keyof RelayApi, ...>`
//
// Args are structured values, not packed strings. The wire already
// JSON-encodes replies and commands; requests were the last stringly-typed
// direction, which is what forced the U+0001 separator hack in
// assignSessionMarker/sessionTabCopy. Those are gone.
export interface RelayApi {
  // The chrome helper's announce. It carries the helper's version, the active
  // profile's display name and raw directory leaf, and whether the
  // content-process bridge came up. Sent on a timer until it is ACKNOWLEDGED,
  // because a fire-and-forget request can only prove it was queued.
  alive: {
    req: { version: string; profileName?: string; profileDir?: string; bridge?: "1" | "0" };
    res: { ok: true };
  };
  // Flip the "press the key to reach the chrome layer" preference. The helper
  // flips its own cached copy; the background flips storage so every other
  // context agrees.
  toggleWhichKey: { req: Record<string, never>; res: null };
  // Ask the active tab's content script to start hinting / focus its first
  // field. Best-effort: a tab with no content script is a normal outcome.
  startHints: { req: Record<string, never>; res: null };
  focusFirstInput: { req: Record<string, never>; res: null };
  openOptions: { req: Record<string, never>; res: null };
  openSetup: { req: Record<string, never>; res: null };
  openDiagnostics: { req: Record<string, never>; res: null };
  quit: { req: Record<string, never>; res: null };
  // Open a new container window. The result comes back so the helper can toast
  // a failure instead of swallowing it.
  stealthOpen: { req: Record<string, never>; res: { ok: boolean; error?: string } };
  // Read-only pulls for the chrome-side UI.
  sessionState: { req: Record<string, never>; res: RelaySessionState };
  sessionTabs: { req: { name: string }; res: PopupItem[] };
  recentlyClosed: { req: Record<string, never>; res: PopupItem[] };
  reopenTab: { req: Record<string, never>; res: { ok: boolean; restored?: number | null } | null };
  // Session + tab mutations. Each is fire-and-forget; the helper refreshes the
  // status bar itself once the action has landed.
  saveSession: { req: { name: string }; res: null };
  newSession: { req: { name: string }; res: null };
  restoreSession: { req: { name: string }; res: null };
  deleteSession: { req: { name: string }; res: null };
  switchSessionByMarker: { req: { marker: number }; res: null };
  assignSessionMarker: { req: { name: string; marker: number }; res: null };
  // These two answer with a human-readable `note` on failure ("no such tab",
  // "same session", ...) and the chrome side toasts it. They used to be
  // fire-and-forget, which meant a copy into a session that did not exist
  // looked exactly like one that worked.
  sessionTabCopy: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  sessionTabMove: { req: { from: string; index: number; to: string }; res: { ok: boolean; note?: string } };
  // Tab strip / history actions the helper cannot do itself (they need the
  // background's storage view and its filtered reopen).
  alternateTab: { req: Record<string, never>; res: null };
  restoreClosedTab: { req: { key: string }; res: null };
  restoreAllClosed: { req: Record<string, never>; res: null };
  removeHistory: { req: { url: string }; res: null };
  clearHistory: { req: Record<string, never>; res: null };
}

// The session summary the chrome status bar renders. Structurally the same
// payload as BgApi["sessionState"], minus the extension-only fields — declared
// separately because the two travel over different buses and the chrome side
// never sees the extension's copy.
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

// Background -> chrome pushes, typed the same way. These are the actions
// handleCmd dispatches, and the reason a status-bar update could not be
// type-checked against what the status bar actually accepts.
export interface ChromeApi {
  splitTab: { req: Record<string, never>; res: void };
  unsplit: { req: Record<string, never>; res: void };
  switchPane: { req: { dir: number }; res: void };
  swapSplitPanes: { req: { dir: number }; res: void };
  moveToSplit: { req: { index: number }; res: void };
  // Session restore finished opening tabs: re-create the native split
  // groupings. 1-based positions over the SAVED tab list.
  restoreSplits: { req: { groups: number[][] }; res: void };
  sessionState: { req: RelaySessionState; res: void };
  leaderState: { req: { index: number; active: boolean }; res: void };
  findState: { req: { index: number; count: number; cur: number }; res: void };
  cacheGlobal: { req: { mode: CacheMode }; res: void };
  cachePolicy: { req: { mode: CacheMode; tabIds: number[] }; res: void };
}

export type ChromeAction = keyof ChromeApi;
export type ChromeReq<K extends ChromeAction> = ChromeApi[K]["req"];

// The argument a request carries on the wire. Actions that declare no request
// are sent with an empty object, so the encoder never has to special-case
// "no argument" — the shape is uniform and total.
export type RelayArg = { [K in RelayAction]: RelayReq<K> }[RelayAction];
