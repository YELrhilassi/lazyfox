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
  // Quick-launch web apps shown on the command-center home grid. Each entry
  // is one tile (site favicon + name); togglable and editable in the options
  // page. `enabled=false` hides the tile without deleting its definition.
  apps: QuickApp[];
}

// One quick-launch web app tile on the command-center home grid.
export interface QuickApp {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
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

// One organized history row as returned by the Go core: host / time bucket /
// relative time precomputed so the popup only renders.
export interface HistoryRow {
  url: string;
  title: string;
  time: number;
  host: string;
  bucket: string;
  rel: string;
}

// One organized recovery row (closed tab or window) from the Go core.
export interface RecoveryRow {
  key: string;
  kind: string;
  title: string;
  url: string;
  tabCount: number;
  host: string;
  rel: string;
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
  // True when the tab lives in one of our stealth containers (isolated
  // cookie jar, wiped on close) — drives the tab popup's stealth badge.
  stealth: boolean;
}

// A generic selectable row returned by a popup's search function.
export interface PopupItem {
  kind?: string;
  id?: number;
  // The true Firefox tab id, for display in the tab switcher (the chrome
  // helper's `id` is its internal strip index, which is what its actions
  // address — the real id is carried here so the popup can show it).
  realId?: number;
  // The tab's jump number (1-based strip position), the same identity `;1`-`;9`
  // use. Set by the tab list in both contexts; the tab popup shows it and its
  // digit keys jump to it.
  number?: number;
  url?: string;
  title?: string;
  subtitle?: string;
  filename?: string;
  state?: string;
  active?: boolean;
  pinned?: boolean;
  muted?: boolean;
  stealth?: boolean;
  query?: string;
  time?: number;
  favIconUrl?: string;
  marker?: number;
  // The index of a sessionTab row within its session's saved tabs array (the
  // identity session copy/move actions address).
  sessionIndex?: number;
  // Downloads: stable identity for actions (open / delete / reveal).
  key?: string;
  path?: string;
  received?: number;
  total?: number;
  speed?: number;
  progress?: number;
  // Recently-closed sessions: how many tabs a closed window held.
  tabCount?: number;
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

// One hinted element in a page report: enough for a human to see WHY a control
// was or was not detected and whether a click would land, without ever firing a
// click (which would have side effects).
export interface HintProbe {
  tag: string;
  role: string;
  name: string;
  href: boolean;
  cursor: string;
  reachable: boolean;
  reason: string;
}

// A scroll region as the scroll controller sees it.
export interface ScrollRegionInfo {
  label: string;
  clientHeight: number;
  scrollHeight: number;
}

// What the content script knows about the page it is running in. Produced on
// demand by the diagnostics page — never collected in the background.
// The outcome of the last link-hint activation, mirrored from the content
// script's hint engine (see hints.ts). Kept here so the diagnostics page and
// the browser tests can both read it.
export interface HintActivation {
  target: string;
  signal: string;
  watchedMs: number;
  ignored: boolean;
}

export interface PageReport {
  ok: boolean;
  url: string;
  title: string;
  readyState: string;
  // Hint pipeline: how many candidates were found and how many survived each
  // filter, then a sample of survivors with the reason they are (or are not)
  // clickable. This is the "why isn't this button detected" answer.
  hints: {
    candidates: number;
    hinted: number;
    rejected: { hidden: number; covered: number; duplicate: number };
    probes: HintProbe[];
    shadowRoots: number;
    pointerControls: number;
    // What the last hint activation actually did. This is the answer to "I
    // pressed the key and nothing happened": it names the target and says
    // whether the page reacted at all, so "the hint found the wrong element"
    // and "the hint found the right one and the page ignored it" stop looking
    // identical from the outside.
    lastActivation: HintActivation | null;
  };
  scroll: {
    target: string;
    custom: boolean;
    regions: ScrollRegionInfo[];
  };
  editor: string;
  perf: {
    domNodes: number;
    fps: number;
    heapMB: number | null;
    resources: number;
    transferKB: number;
    // Resources the browser answered from a cache (no bytes on the wire) vs.
    // fetched over the network — a real, page-level cache-hit picture.
    cachedResources: number;
    networkResources: number;
    loadMs: number;
    domContentLoadedMs: number;
  };
}

// Page-cache policy Lazyfox can impose, per scope. Firefox's own cache is
// global, so only the "global" scope maps to a real browser setting; the
// narrower scopes are enforced by the privileged chrome helper, which can add
// `Cache-Control: no-cache` to the requests of specific tabs. That is why a
// per-tab policy can only work when the chrome layer is installed.
export type CacheScope = "global" | "session" | "tab";
export type CacheMode = "normal" | "fresh" | "off";

export interface CacheState {
  // The scope/mode currently in force.
  scope: CacheScope;
  mode: CacheMode;
  // Whether the browser exposes the global cache switch (browserSettings).
  globalSupported: boolean;
  // Whether the chrome helper is alive and can enforce the per-tab scopes.
  chromeSupported: boolean;
  // Tabs the current session/tab policy covers (empty for a global policy).
  tabIds: number[];
  // Short human sentence describing exactly what is in force right now.
  note: string;
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
