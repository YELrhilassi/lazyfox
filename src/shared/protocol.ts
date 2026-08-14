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
  closeTab: { req: { id?: number }; res: { ok: boolean } };
  newTab: { req: Record<string, never>; res: { ok: boolean } };
  reopenTab: { req: Record<string, never>; res: { ok: boolean } };
  duplicateTab: { req: Record<string, never>; res: { ok: boolean } };
  reload: { req: Record<string, never>; res: { ok: boolean } };
  back: { req: Record<string, never>; res: { ok: boolean } };
  forward: { req: Record<string, never>; res: { ok: boolean } };
  openUrl: { req: { url: string; newTab?: boolean }; res: { ok: boolean } };
  openPage: { req: { url: string }; res: { ok: boolean } };
  openUI: { req: { which: string }; res: { ok: boolean } };
  search: { req: { query: string }; res: { ok: boolean; engine?: string; reused?: boolean } };
  windowSize: { req: Record<string, never>; res: WindowSize };
  resizeWindow: { req: { dx: number; dy: number }; res: { width: number; height: number; state: string } };
  moveWindow: { req: { dx: number; dy: number }; res: { left: number; top: number; state: string } };
  maximize: { req: Record<string, never>; res: { maximized: boolean; state: string } };
  history: { req: { q: string }; res: { items: PopupItem[] } };
  bookmarks: { req: { q: string }; res: { items: PopupItem[] } };
  downloads: { req: Record<string, never>; res: { items: PopupItem[] } };
  openDownload: { req: { id: number }; res: { ok: boolean } };
  zen: { req: Record<string, never>; res: { zen: boolean } };
  mute: { req: Record<string, never>; res: { muted: boolean } };
  pin: { req: Record<string, never>; res: { pinned: boolean } };
  copyUrl: { req: Record<string, never>; res: { url: string; title: string } };
  zoom: { req: { delta: number; factor?: number }; res: { factor?: number } };
  getConfig: { req: Record<string, never>; res: { config?: Record<string, unknown> } };
  setConfig: { req: { config: Config }; res: { ok: boolean } };
  syncTyping: { req: { typing: boolean }; res: { ok: boolean } };
  sessionList: { req: Record<string, never>; res: { sessions: Session[] } };
  sessionSave: { req: { name: string }; res: { ok: boolean; session?: Session } };
  sessionRestore: { req: { name: string }; res: { ok: boolean } };
  sessionDelete: { req: { name: string }; res: { ok: boolean } };
  sessionSwitchByMarker: { req: { marker: number }; res: { ok: boolean; name?: string } };
  sessionSplit: { req: Record<string, never>; res: { ok: boolean; note?: string } };
  sessionUnsplit: { req: Record<string, never>; res: { ok: boolean; note?: string } };
  sessionSwitchPane: { req: Record<string, never>; res: { ok: boolean; note?: string } };
  sessionState: {
    req: Record<string, never>;
    res: {
      name: string;
      marker: number;
      tabIndex: number;
      tabCount: number;
      inSplit: boolean;
      sessions: SessionSummaryItem[];
    };
  };
}

export type BgAction = {
  [K in keyof BgApi]: { action: K; data: BgApi[K]["req"] };
}[keyof BgApi];

export type BgResult<K extends keyof BgApi> = BgApi[K]["res"];

// Chrome helper -> background requests, carried by the #lfc=req.<action> tab.
export type ReqAction = "alive" | "startHints" | "focusFirstInput" | "openOptions";

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
