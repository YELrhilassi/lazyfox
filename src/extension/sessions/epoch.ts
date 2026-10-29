// A counter that changes whenever a restore starts or ends.
//
// WHY THIS EXISTS. Autosave is asynchronous: it queries every window, then
// writes. A session switch can begin AND finish inside that query. The
// checkpoint then holds the window as it looked mid-rebuild — a mix of the
// outgoing session's tabs and the incoming one's — and it names whichever
// session is current by the time the write happens, so it lands in the wrong
// record. This was not theoretical: switching twice quickly rewrote the session
// being left with tabs it never had.
//
// Reading the epoch before the query and comparing it before the write turns
// "a restore happened under me" into a dropped write. Dropping is always safe:
// the switch checkpoints the outgoing window itself, before it rebuilds
// anything, and re-arms autosave once it is done.

let epoch = 0;

/** Mark a restore boundary (called on both begin and end). */
export function bumpRestoreEpoch(): void {
  epoch++;
}

/** The number a snapshot reader should re-check before persisting. */
export function currentRestoreEpoch(): number {
  return epoch;
}
