// Shared types across all Lazyfox contexts (chrome helper, content script,
// background, command center, options).

export interface Config {
  leader: string;
  hintChars: string;
  scrollKeys: boolean;
  openInNewTab: boolean;
  hoverReveal: boolean;
  whichKey: boolean;
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
}
