// Typed message contracts between the extension contexts:
//   - content script / command center / popup / options  ->  background
//     (browser.runtime.sendMessage, handled in background.ts)
//   - chrome helper -> background via the #lfc=req.<action> tab channel
//   - background -> content script (startHints / focusFirstInput)
// One table, typed request and response per action, so the send() helper and
// the background handler cannot drift.
import type { Config, PopupItem, Session, SessionSummaryItem, TabInfo } from "./types";

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
  stealthOpen: { req: Record<string, never>; res: { ok: boolean; error?: string } };
  openSetup: { req: Record<string, never>; res: { ok: boolean } };
  quit: { req: Record<string, never>; res: { ok: boolean } };
  zen: { req: Record<string, never>; res: { zen: boolean } };
  mute: { req: Record<string, never>; res: { muted: boolean } };
  copyUrl: { req: Record<string, never>; res: { url: string; title: string } };
  components: {
    req: Record<string, never>;
    res: { extension: string; wasm: string; nativeHost: string | null; nativeProtocol: string | null; chromeHelper: string | null };
  };
  zoom: { req: { delta: number; factor?: number }; res: { factor?: number } };
  getConfig: { req: Record<string, never>; res: { config?: Record<string, unknown> } };
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
  // Content script -> background: is the chrome layer (userChrome helper)
  // authoritatively alive? The content script must ONLY draw its standalone bar
  // when the background confirms the chrome layer is absent — never trust a
  // racy storage read. This is the single source of truth for the one-bar
  // guarantee.
  chromeLayer: { req: Record<string, never>; res: { alive: boolean } };
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

// Chrome helper -> background requests, carried by the #lfc=req.<action> tab.
export type ReqAction = "alive" | "startHints" | "focusFirstInput" | "openOptions" | "openSetup";

// background -> content script actions.
export type ContentAction = "startHints" | "focusFirstInput";

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
