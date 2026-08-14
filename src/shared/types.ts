// Shared types across all Lazyfox contexts (chrome helper, content script,
// background, command center, options).

export interface Config {
  leader: string;
  hintChars: string;
  scrollKeys: boolean;
  openInNewTab: boolean;
  hoverReveal: boolean;
  whichKey: boolean;
  statusBar: boolean;
  statusBarPosition: "top" | "bottom";
  autoRestore: boolean;
}

export interface ChromeHotkeys {
  preferences: string;
  addons: string;
  history: string;
  downloads: string;
}

export interface WkItem {
  key: string;
  label: string;
  group: string;
  native: boolean;
}

export interface WkRow {
  key: string;
  label: string;
  group: string;
  groupStart: boolean;
  native: boolean;
  lazyIndex: number;
}

export interface WkPage {
  items: WkRow[];
  selFirst: number;
  selLast: number;
}

export interface VisitedItem {
  url: string;
  title: string;
  time: number;
}

export interface Lfc {
  kind: "open" | "cfg" | "req" | "ok" | "err" | "";
  target: string;
  close: boolean;
  action: string;
  arg: string;
  nonce: string;
  payload: string;
}

// A tab row as returned by the background (and mirrored by the chrome helper).
export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  muted: boolean;
  favIconUrl: string;
}

// A generic selectable row returned by a popup's search function.
export interface PopupItem {
  kind?: string;
  id?: number;
  url?: string;
  title?: string;
  subtitle?: string;
  filename?: string;
  state?: string;
  active?: boolean;
  pinned?: boolean;
  muted?: boolean;
  query?: string;
  time?: number;
  favIconUrl?: string;
  marker?: number;
}

// A saved session: a named, marker-addressed snapshot of a window's tabs and
// their split layout (tmux-style session).
export interface SessionTab {
  url: string;
  title: string;
  pinned: boolean;
  // Present iff this tab is a custom split-view container. The tab's `url` is
  // the splitview page (which encodes the pane URLs); this mirrors the layout
  // so capture/restore and the status bar never have to re-parse the URL.
  split?: SplitView;
}

// A custom i3-style split view: a tab that shows two (or more) pages at once.
// "horizontal" = side by side; "vertical" = stacked top/bottom.
export type SplitOrientation = "horizontal" | "vertical";

export interface SplitPane {
  url: string;
  title: string;
}

export interface SplitView {
  // Stable identity of this split container. Generated once at creation and
  // preserved through every URL-hash persist, so pane-focus messages can be
  // routed to exactly the right splitview page even after the active pane (and
  // therefore the hash) changes.
  id?: string;
  orientation: SplitOrientation;
  panes: SplitPane[];
  activePane: number;
}

export interface Session {
  name: string;
  marker: number; // 1-9, 0 = unassigned
  tabs: SessionTab[];
  active: number;
  windowState: string;
  updatedAt: number;
}

// One row of the status bar's session list. Carries only names, markers and
// cheap counts — the bar never loads every session's tabs.
export interface SessionSummaryItem {
  marker: number;
  name: string;
  current: boolean;
  tabCount: number;
  splitCount: number;
}
