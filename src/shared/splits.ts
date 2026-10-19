// Validation for a session's encoded split layout.
//
// A session stores its split layout twice: as the compact "a:b,c:d" string the
// Go core computes, and as a per-tab `splitViewId` on each saved tab. Both are
// written from the same window snapshot, so they should always agree.
//
// They do not always agree. A session captured while the window is mid-flight —
// a tab re-created by a restore, a request-hash tab that reloads into a
// different URL — can leave the encoded string pointing at a position the tab
// list no longer has. Trusting it then pairs a position with nothing, and the
// restored window comes back with a silently FLAT strip: the split vanishes
// with no error anywhere. That is the worst possible failure for a layout
// feature, because it looks like the app forgot rather than like it computed
// something impossible.
//
// The per-tab ids are derived from the same list, so grouping them is always
// self-consistent. This predicate is what decides which of the two to believe.
//
// Positions here are 0-based, and they count the tabs a split can address (see
// splitTabsOf), not every tab in the strip.

/**
 * One 0-based pair of tab positions that belong to the same split view.
 *
 * A tuple, not an object, because that is exactly what the wasm binding
 * returns from `decodeSplits` — this predicate validates that output, so its
 * input type must not be a shape the caller has to translate first.
 */
export type SplitPositions = [number, number];

/** Enough of a saved or live tab to decide whether a split can address it. */
export type SplitTab = { pinned?: boolean; splitViewId?: number };

/**
 * The tabs a split can address, in strip order.
 *
 * A native split view never pairs a pinned tab, so pinned tabs are not part of
 * the coordinate space a saved layout is expressed in. Leaving them in was a
 * silent off-by-N: the snapshot numbered positions over ALL tabs (pinned ones
 * included, each carrying -1), while the restore resolved the same positions
 * over unpinned tabs only — so a restored session with pinned tabs at the front
 * paired the neighbours of the original pair and dropped the split.
 *
 * One definition, used by the save and by the restore, is the only way the two
 * can agree.
 */
export function splitTabsOf<T extends SplitTab>(tabs: T[] | null | undefined): T[] {
  return (tabs || []).filter((t) => !!t && !t.pinned);
}

/**
 * The window-local `splitViewId` of each addressable tab, in strip order, with
 * -1 for "not in a split". This is the exact input the Go core groups into
 * pairs, so its length IS the tab count those positions refer to.
 */
export function splitIdsOf(tabs: SplitTab[] | null | undefined): number[] {
  return splitTabsOf(tabs).map((t) =>
    typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : -1
  );
}

/**
 * Whether every pair addresses a real tab in a list of `count` tabs.
 *
 * `count` is the tab count, so an index is in range when it is
 * `0 <= index < count`. An empty or absent layout is NOT "in range" — there is
 * nothing to validate — so callers fall through to their own source; an empty
 * `splits` string never reaches here.
 */
export function splitPairsInRange(
  pairs: SplitPositions[] | null | undefined,
  count: number
): boolean {
  if (!pairs || !pairs.length) return false;
  if (!Number.isInteger(count) || count <= 0) return false;
  for (const p of pairs) {
    if (!p || p.length !== 2) return false;
    const [a, b] = p;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a < 0 || b < 0) return false;
    if (a >= count || b >= count) return false;
    if (a === b) return false;
  }
  return true;
}
