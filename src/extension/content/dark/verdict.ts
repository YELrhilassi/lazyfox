// What the window bar is told about dark mode, and WHEN it is told.
//
// WHY THIS IS A MODULE. Two rules here are rules rather than incidental code:
//
//   * the bar renders `native` for a page that is using the SITE's own theme,
//     and for a page we stood down from because it was already dark. That second
//     case is recognisable only from the decision's REASON, so the mapping from a
//     controller state to what the bar shows lives here — once — instead of
//     inside the callback that also owns the message transport;
//   * the verdict is re-decided on every pass, and the bar is a second surface
//     for a verdict that has usually not moved. MEASURED (real Firefox, quiet
//     fixture, dark mode on): the controller ran ~22 passes a second and sent the
//     same verdict every time — each send a content -> background -> relay ->
//     helper round trip that ended in the same store write and the same repaint.
//     A page being measured is not news; only a verdict that CHANGED is. The
//     latch makes re-deciding free, so the message rate follows how often the
//     meaning changes instead of how often the page is walked.
//
// Both are pure and pinned without a browser (scripts/test/dark-verdict.test.ts):
// the mapping decides what the user reads, and the latch decides what crosses a
// process boundary.

export interface BarVerdict {
  /** Whether a theme of OURS is painting this page. */
  on: boolean;
  /** auto | dark | light | off — the mode in force. */
  mode: string;
  /** dynamic | filter | native | auto — what the bar's tone is derived from. */
  engine: string;
}

/**
 * The verdict as the bar renders it.
 *
 * `native` means "the site's own theme is what you are looking at", and there are
 * two ways to arrive there: the controller took the site's theme (`engine:
 * "native"`), or it stood down because the page was ALREADY dark — in which case
 * nothing of ours is installed and the honest label is still the site's. The
 * second is only visible in the reason, which is why this mapping is not a
 * two-line cast at the call site.
 */
export function barVerdict(state: { on: boolean; mode: string; engine: string; reason: string }): BarVerdict {
  const native = state.engine === "native" || /already dark/i.test(state.reason);
  return { on: state.on, mode: state.mode, engine: native ? "native" : state.engine };
}

/** The comparison key: exactly the fields the segment is built from. */
export function verdictKey(v: BarVerdict): string {
  return (v.on ? "on" : "off") + "|" + v.mode + "|" + v.engine;
}

export interface VerdictLatch {
  /**
   * True when the bar has not been told this verdict yet, and remembers it.
   *
   * False means "nothing to do": the bar is already showing exactly this, and a
   * second message would only cost a round trip and a repaint.
   */
  send(v: BarVerdict): boolean;
  /**
   * Forget what the bar was told, so the next verdict is published even if it
   * repeats the last one.
   *
   * For the moments when the SURFACE may have gone: a config write re-decides
   * every page in every tab at once (and is the same event that follows a helper
   * restart), so the verdict is re-asserted rather than assumed to have survived.
   */
  reset(): void;
}

export function createVerdictLatch(): VerdictLatch {
  // One string, because "has anything moved" is a question about the whole
  // verdict: `on`, the mode in force and the engine that decided it are read
  // together by the segment, and a latch that tracked them separately could
  // report a change twice or not at all.
  let last: string | null = null;
  return {
    send(v: BarVerdict): boolean {
      const key = verdictKey(v);
      if (key === last) return false;
      last = key;
      return true;
    },
    reset(): void {
      last = null;
    },
  };
}
