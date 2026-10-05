// READING BACK THE SPLIT, a few frames AFTER the call that was supposed to
// make it.
//
// Split out of splitview.ts. Every split operation here ends in a trail of
// messages, and this is what makes a trail describe an OUTCOME rather than an
// attempt: `addTabs` returning ok only says it did not throw, and what a reader
// actually needs to know is whether the tab ended up inside the view. That
// answer is not available in the same tick — Firefox finishes the glue on a
// later turn — which is exactly why the trail used to stop at "returned ok"
// and leave the real question unanswered.
//
// It is delayed on purpose, and that delay is the whole design, so it is its
// own module rather than a helper buried among the operations: the passes, the
// intervals and what they are each waiting for are one decision, made once,
// with a comment explaining it. Every pane is named by the same idOf() the strip
// reconciliation uses, so "pane b12" here and "b12" in a strip snapshot are the
// same tab and can be compared by eye without a lookup table.

import type { ChromeTab, SplitViewWrapper } from "./tabs";

export interface SplitReadbackDeps {
  // Deferred work, from the injected environment.
  setTimeout(fn: () => void, ms: number): void;
  // The window's tabs, for the target's strip position.
  stripIndexOf(tab: ChromeTab): number;
  // The live split view, or null if there is none right now.
  activeSplitView(): SplitViewWrapper | null;
  // The last split the user interacted with, kept alive by splitview so
  // `;W m` still works while the selected tab is outside the split.
  lastSplit(): SplitViewWrapper | null;
  // The stable pane id, shared with the strip reconciliation.
  idOf(tab: ChromeTab): string;
  tabUrl(tab: ChromeTab | null): string;
}

export interface SplitReadback {
  /**
   * Observe the split twice and report what it contains.
   *
   * @param mv appends one line to the operation's trail
   * @param want the tab the operation was about; when given, the trail also
   *   says whether it ended up inside the view and where it sits in the strip
   */
  (mv: (msg: string) => void, want?: ChromeTab | null): void;
}

export function createSplitReadback(deps: SplitReadbackDeps): SplitReadback {
  return function readbackSplit(mv: (msg: string) => void, want?: ChromeTab | null): void {
    const read = (attempt: number) => {
      let panes = "gone";
      try {
        const remembered = deps.lastSplit();
        const live =
          deps.activeSplitView() ||
          (remembered && remembered.isConnected ? remembered : null);
        if (live && Array.isArray(live.tabs)) {
          panes =
            live.tabs.map((p: ChromeTab) => deps.idOf(p) + ":" + deps.tabUrl(p)).join(" ") ||
            "(empty)";
        }
        if (want) {
          const inIt = !!(want.splitview && live && want.splitview === live);
          mv(
            "readback#" +
              attempt +
              " target=" +
              deps.idOf(want) +
              " inView=" +
              (inIt ? "yes" : "no") +
              " stripAt=" +
              String(deps.stripIndexOf(want)) +
              " panes=[" +
              panes +
              "]"
          );
        } else {
          mv("readback#" + attempt + " panes=[" + panes + "]");
        }
      } catch (e) {
        mv("readback#" + attempt + " threw " + String(e));
      }
      // Two passes: the first catches a late-unsplit, the second catches
      // Firefox re-parking the pair after the re-pin loop has finished. Three
      // would outlive the 2.5s the harness is willing to wait for a trail.
      if (attempt < 2) deps.setTimeout(() => read(attempt + 1), 400);
    };
    deps.setTimeout(() => read(1), 250);
  };
}