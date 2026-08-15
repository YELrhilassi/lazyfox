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
  // The true Firefox tab id, for display in the tab switcher (the chrome
  // helper's `id` is its internal strip index, which is what its actions
  // address — the real id is carried here so the popup can show it).
  realId?: number;
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
  // Downloads: stable identity for actions (open / delete / reveal).
  key?: string;
  path?: string;
  received?: number;
  total?: number;
  speed?: number;
  progress?: number;
}

// One download as tracked by the Go notification manager. `id` is a stable key
// (full target path in the chrome helper, numeric id in the background) so a
// dismissed flag survives across polls and the popup can act on it.
export interface DownloadEntry {
  id: string;
  filename: string;
  path: string;
  url: string;
  state: string; // in_progress | paused | complete | failed | canceled
  received: number;
  total: number;
  speed: number;
  dismissed: boolean;
  startTime: number;
  endTime: number;
}

// A saved session: a named, marker-addressed snapshot of a window's tabs and
// their split layout (tmux-style session).
export interface SessionTab {
  url: string;
  title: string;
  pinned: boolean;
  // Native (Firefox 149+) split view: tabs sharing a splitViewId are shown
  // side by side. Read-only on the tabs API today (bug 2016928), so capture
  // records it and the chrome helper is asked to recreate the pairing on
  // restore.
  splitViewId?: number;
  // A stealth tab lives in its own ephemeral container (isolated cookies /
  // storage) and is wiped when closed. Restore opens it in a fresh container.
  stealth?: boolean;
}

export interface Session {
  name: string;
  marker: number; // 1-9, 0 = unassigned
  tabs: SessionTab[];
  active: number;
  windowState: string;
  updatedAt: number;
  // Compact split layout computed by the Go core (core.EncodeSplits):
  // "a:b,c:d" pairs of 0-based tab indices. Authoritative for restore; the
  // per-tab splitViewId remains only as a fallback for pre-encoding sessions.
  splits?: string;
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
