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
    opts: { tags?: string[]; keepTabs?: string[]; reconcile?: boolean } = {},
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
        await ctx.leaderPress(ctx.tabA, "\\"); // ;\ via the chrome helper (tabA is the active CC)
        await waitNoSplit();
      }
    }
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true }); // ;| side-by-side
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

  // ;+ arms the move-to-split DIGIT CAPTURE, which expires after 3s. The digit
  // must land well inside that window, so this wait is deliberately CHEAP:
  //
  //   * On a web page the content script owns the leader and paints the which-key
  //     overlay — a single cheap evalIn on the tab sees it. This is the normal
  //     case and resolves in one round-trip.
  //   * chromeState() is only consulted as a fallback, and it is HEAVY (it
  //     round-trips through the probe tab and re-activates the active tab).
  //     Polling it in a loop used to burn the whole 3s capture window, so the
  //     digit landed after the leader had already disarmed and the move never
  //     happened — a silent no-op that read as a product bug.
  //
  // The whole thing is hard-bounded so a missing signal degrades to a short
  // pace rather than a timeout.
  const waitPlusPopup = async (tab) => {
    await waitFor(async () => {
      // data-lf-leader is the content script's own armed mirror; the
      // which-key host is useless here (closed shadow root, host persists).
      if (await ctx.waitLeader(tab, false, 1).then(() => true).catch(() => false)) return true;
      if (await ctx.hasHost(tab, "lazyfox-popup").catch(() => false)) return true;
      return null;
    }, 400).catch(() => {});
    await ctx.chromeState().then((st) => {
      if (st && (st.leaderPending || (st.popup && st.popup.current))) return;
    }).catch(() => {});
  };

  return { t, nativeSplit, waitNoSplit, waitPlusPopup };
}
