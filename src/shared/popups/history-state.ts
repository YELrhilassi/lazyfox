// The history popup's state, and the pure reads over it.
//
// Split out of openHistoryPopup (popups/history.ts). Everything the popup
// MUTATES lives on one object here, and everything it DERIVES from that object
// is a pure function of it. That split is what lets the renderer and the
// intent dispatcher be separate modules: they read the same state and neither
// owns it, so the popup itself is left with the wiring — load, organize,
// dispatch, hand back the controller.
//
// The rules themselves (which rows are visible, which hint letter names which
// group) live in history-groups.ts and are tested there; what is here is the
// binding of those rules to this popup's state.

import type { HistoryRow, PopupItem } from "../types";
import { groupHints as groupHintsFor, visibleRowIndices } from "./history-groups";
import type { RelatedRow } from "./history-related";

export interface HistoryState {
  // Every history item the popup was handed, as fetched.
  all: PopupItem[];
  // The Go core's organized rows (host, bucket, relative time), re-derived on
  // every filter keystroke.
  rows: HistoryRow[];
  /** Selection index among VISIBLE rows (collapsed groups are skipped). */
  idx: number;
  /** Virtual mode: the input stays focused, so the mode is not the DOM's. */
  mode: "cmd" | "insert";
  /** Which pane has focus: the grouped list, or details + related. */
  pane: "L" | "R";
  /** bucket -> collapsed. */
  collapsed: Record<string, boolean>;
  /** Armed `x`: the row a second `x` would delete, and when it lapses. */
  armDelete: { url: string; timer: ReturnType<typeof setTimeout> | null } | null;
  /** Armed `X`: a second `X` would clear ALL history. */
  armClear: boolean;
  armClearTimer: ReturnType<typeof setTimeout> | null;
  /**
   * `c` arms a group toggle: the next key picks the group by its hint char
   * (shown next to each header), `c` again toggles the group under the
   * cursor, Esc cancels, and any other key falls through to normal handling.
   */
  armGroup: boolean;
  /** The right pane's rows for the current selection. */
  relatedRows: RelatedRow[];
  /** Selection within the related pane. */
  relIdx: number;
  /** The primary row the related list was last built for; -1 = none yet. */
  lastPrimary: number;
}

export function createHistoryState(): HistoryState {
  return {
    all: [],
    rows: [],
    idx: 0,
    mode: "cmd",
    pane: "L",
    collapsed: {},
    armDelete: null,
    armClear: false,
    armClearTimer: null,
    armGroup: false,
    relatedRows: [],
    relIdx: 0,
    lastPrimary: -1,
  };
}

/** Indices into `state.rows` that are currently shown (collapsed groups skipped). */
export function visibleRows(state: HistoryState): number[] {
  return visibleRowIndices(state.rows, state.collapsed);
}

/** bucket -> the hint letter that names it in the armed group toggle. */
export function groupHints(state: HistoryState): Record<string, string> {
  return groupHintsFor(state.rows);
}

/**
 * Which bucket does this hint letter name? Null for any other key, which is how
 * the armed group toggle tells "toggle this group" from "that letter named
 * nothing, so drop the arm and let the key through".
 */
export function hintBucketFor(state: HistoryState, key: string): string | null {
  const hs = groupHints(state);
  const kc = key.toLowerCase();
  for (const b of Object.keys(hs)) {
    if (hs[b] === kc) return b;
  }
  return null;
}

/** The row index under the cursor, or -1 when nothing is visible. */
export function currentRowIndex(state: HistoryState): number {
  const vis = visibleRows(state);
  return vis.length ? (vis[state.idx] ?? -1) : -1;
}

/** The row under the cursor, or null. */
export function currentRow(state: HistoryState): HistoryRow | null {
  const ri = currentRowIndex(state);
  return ri >= 0 ? state.rows[ri] || null : null;
}

/**
 * Clear every armed destructive action and its expiry timer.
 *
 * The cancelled timer HANDLES are nulled as well as cleared. Nothing reads them
 * (the only writers are the arm sites themselves), so nulling changes no
 * behaviour — but leaving a cancelled handle on the state is the kind of thing
 * the next reader treats as "still armed", and it makes a second disarm try to
 * cancel an id that may since have been reused.
 */
export function disarmAll(state: HistoryState): void {
  if (state.armDelete && state.armDelete.timer) clearTimeout(state.armDelete.timer);
  state.armDelete = null;
  if (state.armClearTimer) clearTimeout(state.armClearTimer);
  state.armClearTimer = null;
  state.armClear = false;
}