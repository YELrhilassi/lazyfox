// The slice of the document one pass walks, and what is left after it.
//
// WHY THIS IS A MODULE. The walk is a CURSOR over the whole document (see
// MAX_SCAN in apply.ts): each pass measures a window of it and the controller
// asks `pending()` afterwards to decide whether to ask for the next slice. That
// answer is `documentElements - passed`, and `passed` used to be reset to ZERO
// whenever the cursor wrapped — so on a page that fits in one window (every page
// smaller than the budget, which is nearly all of them) `passed` went back to 0,
// `pending()` reported the WHOLE DOCUMENT again, and the controller asked for
// another pass 60ms later. For ever.
//
// MEASURED in a real Firefox, quiet fixture page, dark mode on: ~22 passes a
// second and ~22 status-bar verdict reports a second (each one a
// content -> background -> relay -> helper round trip that ended in the same
// store write and the same repaint), with the same verdict every time. The
// colours were right, which is exactly why nobody had itemised the bill: the
// symptom was a busy machine and a status bar being poked 22 times a second
// about a verdict that had not moved.
//
// So the arithmetic is stated once, as a pure function, and pinned by a test
// that needs no browser (scripts/test/dark-scan.test.ts). `pending()` falls to
// zero exactly when the walk has covered the document, and a page that has
// settled stops being measured.

export interface ScanWindow {
  /** Where this pass starts, always inside the document. */
  from: number;
  /** How many elements this pass walks. May be 0 for an empty document. */
  take: number;
  /** Where the next pass starts: 0 once the walk has wrapped. */
  cursor: number;
  /**
   * Elements walked since the last wrap.
   *
   * `total` once the document has been covered — the value `pending()` subtracts
   * from the element count, and the one this module exists to get right.
   */
  passed: number;
}

/**
 * The next window of `total` elements, starting at `cursor`.
 *
 * The window never runs past the end of the document: the last slice is the
 * remainder, and it is the one that WRAPS (`cursor` back to 0, `passed` at
 * `total`). Wrapping is therefore the signal that the walk has reached the end of
 * the document — which is what makes `pending()` zero for a page that fits in a
 * single window and for a page whose last slice has just been walked.
 */
export function scanWindow(total: number, cursor: number, budget: number): ScanWindow {
  const n = Math.max(0, Math.floor(total) || 0);
  const limit = Math.max(1, Math.floor(budget) || 1);
  if (n === 0) return { from: 0, take: 0, cursor: 0, passed: 0 };
  // A negative or absurd cursor is normalised rather than trusted: it arrives
  // from a previous pass's arithmetic, and "one bad slice" must not put the walk
  // into a state where it can never finish.
  const start = (((Math.floor(cursor) || 0) % n) + n) % n;
  const take = Math.min(limit, n - start);
  const end = start + take;
  const wrapped = end >= n;
  return { from: start, take, cursor: wrapped ? 0 : end, passed: wrapped ? n : end };
}
