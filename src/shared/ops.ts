// The ops adapter interface: every capability the shared leader actions,
// popups and help need, abstracted per execution context. The chrome helper
// implements it with chrome APIs (gBrowser, Services, Places); the content
// script implements it by messaging the background. This single interface is
// what kills the old chrome/content duplication of popups and actions.
import type { PopupItem } from "./types";

// The shape both hosts answer `navStack` with: the same one the protocol's
// navStack carries, so the popup cannot tell (or care) which host replied.
export interface NavStackReply {
  canBack: boolean;
  canForward: boolean;
  index: number;
  entries: { url: string; title: string }[];
}

export interface ActionOps {
  // ---- popup data sources (all async; the selector engine requires Promises) ----
  searchSuggest(q: string): Promise<PopupItem[]>;
  urlSuggest(q: string): Promise<PopupItem[]>;
  listTabs(q: string): Promise<PopupItem[]>;
  history(q: string): Promise<PopupItem[]>;
  bookmarks(q: string): Promise<PopupItem[]>;
  downloads(q: string): Promise<PopupItem[]>;

  // ---- actions ----
  // newTab: true forces a new tab, false forces the current tab (replace),
  // undefined defers to the openInNewTab config.
  openUrl(url: string, newTab?: boolean): void;
  search(query: string, newTab?: boolean): void;
  newTab(): void;
  closeTab(id?: number): void;
  moveTab(id: number, dir: number): void;
  moveActiveTab(dir: number): void;
  reopenTab(): void;
  duplicateTab(): void;
  reload(): void;
  back(): void;
  forward(): void;
  // The tab's navigation stack, oldest-first, with the current entry's index.
  // Read through the HOST rather than the protocol: the chrome helper can read
  // the browser's real session history, which is exact, while a content script
  // can only get the background's reconstructed track (see shared/navtrack.ts
  // for why the privileged API is not an option).
  navStack(): Promise<NavStackReply | null>;
  // Walk the stack by `steps` entries: negative is back, positive forward.
  navGoto(steps: number): void;
  activateTab(id: number): void;
  tabNav(dir: number): void;
  tabJump(n: number): void;
  // How many real tabs the window holds. Kept apart from listTabs because the
  // multi-digit tab jump needs only this to decide whether a digit is
  // ambiguous, and it is asked on every digit press.
  tabCount(): Promise<number>;
  // Jump to the previously-active tab; pressing it again jumps back (a
  // two-tab toggle like Vim's Ctrl+^).
  alternateTab(): void;
  // Recently closed tabs: list, restore one (by its stable key), restore all.
  recentlyClosed(): Promise<PopupItem[]>;
  restoreClosedTab(key: string): void;
  restoreAllClosed(): void;
  // History: delete one entry or clear the whole history.
  removeHistory(url: string): void;
  clearHistory(): void;
  zoom(delta: number, factor?: number): void;
  openDownload(key: string): void;
  removeDownload(key: string): void;
  openDownloadLocation(key: string): void;
  retryDownload(key: string): void;
  dismissDownload(key?: string): void;
  // Open the current page in a stealth (isolated, self-wiping) tab.
  stealthOpen(): void;
  copyUrl(): void;
  // The current page's address, for `;K e` to pre-fill its editable field.
  // Resolved through the HOST (the chrome helper reads the window's URI, the
  // content script reads location) so both contexts answer from the same fact
  // `copyUrl` copies, and the field can never disagree with what `;K c` gave.
  pageUrl(): Promise<string>;
  muteTab(): void;
  zen(): void;
  toggleReveal(): void;
  toggleWhichKey(): void;
  // ;Q: persist the current window into its session, then quit Firefox.
  quit(): void;
  focusFirstInput(): void;
  startHints(): void;
  openTarget(which: string): void;
  // Open an arbitrary URL natively (switchToTabHavingURI / addTab) — the only
  // path that can load about: pages (the tabs API rejects them).
  openUrlNative(url: string): boolean;

  // Popups whose chrome is context-specific (native find bar vs in-page find,
  // window resize via chrome window APIs vs background messages).
  openFind(): void;
  openResize(): void;
  // Open the "complete the installation" page (store add-on -> profile patch).
  openSetup(): void;
  // Open the diagnostics & performance page: live page diagnosis, the
  // framework-site detection report, efficiency metering and resource use.
  openDiagnostics(): void;

  // ---- sessions (tmux-style) ----
  listSessions(q: string): Promise<PopupItem[]>;
  // The tabs inside one named session (for the sessions popup's right pane).
  listSessionTabs(name: string): Promise<PopupItem[]>;
  saveSession(name: string): void;
  newSession(name: string): void;
  restoreSession(name: string): void;
  // Resolves once the deletion has LANDED, so a caller that re-reads the
  // session list right afterwards cannot race the storage write.
  deleteSession(name: string): Promise<void>;
  switchSessionByMarker(marker: number): void;
  assignSessionMarker(name: string, marker: number): void;
  // Copy / move a tab (by its index in the source session's saved tabs) into
  // another session. Edits the stored snapshots; the live window is untouched
  // until the target session is restored.
  sessionTabCopy(from: string, index: number, to: string): void;
  sessionTabMove(from: string, index: number, to: string): void;
  splitTab(orientation: "horizontal" | "vertical"): void;
  unsplitTab(): void;
  switchSplitPane(dir: number): void;
  swapSplitPane(dir: number): void;
  splitAddTabByIndex(n: number): void;
  sessionState(): Promise<{
    name: string;
    marker: number;
    tabIndex: number;
    tabCount: number;
    inSplit: boolean;
    splitOrientation?: "horizontal" | "vertical";
    sessions: { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[];
  }>;
}
