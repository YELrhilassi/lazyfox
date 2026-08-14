// The ops adapter interface: every capability the shared leader actions,
// popups and help need, abstracted per execution context. The chrome helper
// implements it with chrome APIs (gBrowser, Services, Places); the content
// script implements it by messaging the background. This single interface is
// what kills the old chrome/content duplication of popups and actions.
import type { PopupItem } from "./types";

export interface ActionOps {
  // ---- popup data sources (all async; the selector engine requires Promises) ----
  searchSuggest(q: string): Promise<PopupItem[]>;
  urlSuggest(q: string): Promise<PopupItem[]>;
  listTabs(q: string): Promise<PopupItem[]>;
  history(q: string): Promise<PopupItem[]>;
  bookmarks(q: string): Promise<PopupItem[]>;
  downloads(q: string): Promise<PopupItem[]>;

  // ---- actions ----
  openUrl(url: string, newTab?: boolean): void;
  search(query: string): void;
  newTab(): void;
  closeTab(id?: number): void;
  moveTab(id: number, dir: number): void;
  reopenTab(): void;
  duplicateTab(): void;
  reload(): void;
  back(): void;
  forward(): void;
  activateTab(id: number): void;
  tabNav(dir: number): void;
  tabJump(n: number): void;
  zoom(delta: number, factor?: number): void;
  openDownload(id: number): void;
  copyUrl(): void;
  muteTab(): void;
  pinTab(): void;
  zen(): void;
  toggleReveal(): void;
  focusFirstInput(): void;
  startHints(): void;
  openTarget(which: string): void;

  // Popups whose chrome is context-specific (native find bar vs in-page find,
  // window resize via chrome window APIs vs background messages).
  openFind(): void;
  openResize(): void;

  // ---- sessions (tmux-style) ----
  listSessions(q: string): Promise<PopupItem[]>;
  saveSession(name: string): void;
  restoreSession(name: string): void;
  deleteSession(name: string): void;
  switchSessionByMarker(marker: number): void;
  splitTab(): void;
  unsplitTab(): void;
  sessionState(): Promise<{
    name: string;
    marker: number;
    tabIndex: number;
    tabCount: number;
    sessions: { marker: number; name: string; current: boolean }[];
  }>;
}
