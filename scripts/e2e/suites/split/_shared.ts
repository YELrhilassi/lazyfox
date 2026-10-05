// Shared split-view helpers, hoisted verbatim from the original split.ts
// monolith: every test in this folder starts by dissolving leftover splits
// and/or creating a fresh native split pair.
import { evalIn, waitFor } from "../../bidi.ts";

export function makeSplitHelpers(ctx: any, file: string, tags: string[] = []) {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide. `file` is the
  // CALLER's id, not this helper's — the helper is only where the
  // registration function happens to live.
  const FILE = file;
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? tags });

  // Create a native split of the command center + a fresh split-panel tab and
  // wait until two tabs share a splitViewId. Returns the tab pair (extension
  // tab ids/urls/active + splitViewId). Dissolves any split left over from a
  // previous test first (a pane may be a remote web page the chrome helper
  // cannot unsplit, so closing its partner panes auto-unsplits it).
  const nativeSplit = async () => {
    await ctx.openCC(ctx.tabA);
    for (let i = 0; i < 3; i++) {
      const pre = await ctx.tabsInfo();
      const sv = pre.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      if (!sv.length) break;
      const act = pre.find((t) => t.active);
      for (const p of sv.filter((t) => !t.active)) {
        await evalIn(ctx.probe, `browser.tabs.remove(${p.id})`).catch(() => {});
      }
      // Wait for the removals to land instead of sleeping.
      await waitFor(async () => {
        const ts = await ctx.tabsInfo();
        return sv.every((p) => p.active || ts.every((x) => x.id !== p.id)) ? true : null;
      }, 5000).catch(() => {});
      if (act && sv.some((t) => t.id === act.id)) {
        await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u via the chrome helper (tabA is the active CC)
        await waitNoSplit();
      }
    }
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]); // ;W | side-by-side
    return waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const pair = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return pair.length === 2 ? pair : null;
    }, 8000);
  };

  // Wait until no tab is in a split view.
  const waitNoSplit = async () =>
    waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)) ? true : null;
    }, 8000);

  // ;+ arms the move-to-split DIGIT CAPTURE, which expires after 3s. The caller
  // types a digit the instant this returns, so everything about this function
  // is a judgement about what is worth waiting for.
  //
  // WHAT IS NOT OBSERVABLE, measured rather than assumed. This used to claim it
  // was waiting for the capture to arm. It was not: it polled two signals that
  // cannot see this particular state, swallowed the timeout, and the digit was
  // typed into whatever the leader happened to be doing. Turning the swallow
  // into a `throw` — "wait properly or fail honestly" — was tried and measured,
  // and it took the isolated split group from 13/13 to 7/13, because the
  // capture's arming is only visible through `leaderPending` in the #lfc=state
  // reply, and every one of these tests was pressing its digit after a wait
  // that had already proven the signal is not there. The throw was removed.
  //
  //  * `data-lf-leader` is the CONTENT SCRIPT's mirror. Every caller is a
  //    command-center tab, which has no content script, so the attribute is
  //    absent and the read falls back to the `lazyfox-leader` host — which
  //    PERSISTS after the capture closes, so it cannot mean "armed" either.
  //  * `lazyfox-popup` is a different popup engine. ;+ does not open one.
  //  * `leaderPending` IS the right field (src/chrome/stateapi.ts) but reading it
  //    means chromeState(), and chromeState() briefly removes the probe tab from
  //    `state.realTabs` — which shifts the user numbering by one. Consulting it
  //    in the middle of a numbering-sensitive press is the documented way this
  //    harness has broken tab targeting three separate times. See
  //    scripts/e2e/chrome-state.ts.
  //
  // So what is left is a short, best-effort pace on the two cheap signals —
  // enough to cover the ordinary case, never enough to cost the 3s window — plus
  // the chromeState() call the file has always made, kept deliberately for its
  // side effect of re-activating the active tab rather than for its value.
  const CHEAP_SIGNAL_WINDOW_MS = 400;
  const waitPlusPopup = async (tab) => {
    await waitFor(async () => {
      if (await ctx.waitLeader(tab, false, 1).then(() => true).catch(() => false)) return true;
      if (await ctx.hasHost(tab, "lazyfox-popup").catch(() => false)) return true;
      return null;
    }, CHEAP_SIGNAL_WINDOW_MS, 50).catch(() => {});
    // Value discarded on purpose — see above. The activation is the point.
    await ctx.chromeState().catch(() => {});
  };

  return { t, nativeSplit, waitNoSplit, waitPlusPopup };
}
