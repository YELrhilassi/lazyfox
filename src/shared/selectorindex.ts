// Where the highlight lands after a selector re-reads its list.
//
// This is arithmetic over two arrays, and it lives in its own module because
// the bug it fixes could not be pinned any other way: `createSelector` needs a
// DOM, so the tab popup's cursor behaviour had no unit test at all — and the
// behaviour was wrong. `search()` reset the cursor to row 0 on every refresh,
// which is right for a fresh search (row 0 IS the answer) and wrong for the
// tab popup, which reuses a refresh to re-read a MUTATED list after closing or
// moving a tab. Closing a tab at row 12 lit up row 0, so deleting downwards
// walked the list back to the top every time and no two deletes in a row
// touched neighbouring tabs.
//
// The rule, in order:
//
//   1. No identity function -> row 0. The caller has told us nothing about
//      what the rows ARE, so we cannot claim the old highlight still exists.
//      This is the fresh-search case and it keeps its original answer.
//   2. The previously selected row is still present -> follow it, by
//      identity. A refresh that did not touch this row must not move it.
//   3. That row is GONE -> keep the INDEX, clamped. Closing the selected tab
//      is the action, so the neighbour that slid up into its place becomes the
//      selection. That is the natural deletion flow, and it is the whole point:
//      repeatedly closing walks steadily down the strip instead of resetting.
//   4. The list is empty -> 0, because there is nothing to select.

export interface RefreshIndexInput<T> {
  /** The cursor before the refresh. */
  prevIdx: number;
  /** The rows before the refresh. */
  prev: readonly T[];
  /** The rows after the refresh. */
  next: readonly T[];
  /** Stable identity, or undefined when the caller has none. */
  keyOf?: (item: T) => string | number | undefined;
}

export function resolveRefreshIndex<T>(input: RefreshIndexInput<T>): number {
  const { prevIdx, prev, next, keyOf } = input;
  if (!next.length) return 0;
  if (!keyOf) return 0;
  const prevItem = prev[prevIdx];
  if (prevItem === undefined) return 0;
  const prevKey = keyOf(prevItem);
  // An undefined identity is the same as having none: two rows we cannot tell
  // apart must not be treated as "the same row".
  if (prevKey === undefined) return 0;
  const at = next.findIndex((it) => keyOf(it) === prevKey);
  if (at >= 0) return at;
  // Gone. Stay where the user was looking, clamped to the new end.
  return Math.max(0, Math.min(prevIdx, next.length - 1));
}
