// Pure helpers for the history popup's grouped list.
//
// Extracted from history.ts because the popup is a 600-line interactive
// function and these two are the part of it that has nothing to do with the
// DOM, the keyboard or the modal state machine: they are pure functions over
// the row list. Keeping them here means the grouping rules — which rows are
// visible when a group is collapsed, and which letter selects a group — can be
// read and tested without driving a browser, and history.ts keeps only the
// wiring that actually needs one.

import type { HistoryRow } from "../types";

/**
 * The row indices the user can actually land on, skipping collapsed groups.
 *
 * Selection is tracked against THIS list rather than against the raw rows, so
 * collapsing a group cannot leave the cursor on a row that is no longer drawn —
 * which is what used to make `j` appear to skip a row after a `c` toggle.
 */
export function visibleRowIndices(
  rows: HistoryRow[],
  collapsed: Record<string, boolean>
): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!collapsed[rows[i]!.bucket]) out.push(i);
  }
  return out;
}

/**
 * Stable per-bucket hint letters for the `c` + char group toggle, in display
 * order.
 *
 * Prefer the bucket's own first letter (Today→t, Yesterday→y, This week→w,
 * ...); fall back to the next free letter if two bucket names ever collide.
 * Stability is the point: the letter beside a header must mean the same group
 * on every keystroke, or the `c`-then-letter chord becomes a guessing game.
 */
export function groupHints(rows: HistoryRow[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    const b = r.bucket;
    if (!b || seen.has(b)) continue;
    seen.add(b);
    let ch = "";
    for (let i = 0; i < b.length; i++) {
      const c = b[i]!.toLowerCase();
      if (/^[a-z]$/.test(c) && !used.has(c)) {
        ch = c;
        break;
      }
    }
    if (!ch) {
      for (const c of "abcdefghijklmnopqrstuvwxyz") {
        if (!used.has(c)) {
          ch = c;
          break;
        }
      }
    }
    if (ch) {
      used.add(ch);
      out[b] = ch;
    }
  }
  return out;
}
