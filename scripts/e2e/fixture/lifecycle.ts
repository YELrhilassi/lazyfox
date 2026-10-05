// Per-test lifecycle: preconditions and reset — part of the e2e fixture.
//
// What the harness GUARANTEES before a test runs, asserted rather than
// // assumed: the probe is live, the config is back to its pre-run value, the
// // window has stopped churning, tabA is a live page, and the leader is
// // DISARMED. An armed leader treats `;` itself as a binding, so any test
// // starting with `;` silently inherits the previous test's last action.
// //
// // Everything repaired on the way is recorded in ctx.repaired and printed in
// // the report, so a failure says whether it happened after a repair.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  evalIn,
  attempt,
} from "../bidi.ts";

export function installLifecycle(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
  /**
   * Make the leader DISARMED, and prove it.
   *
   * The single most valuable line in this file. An armed leader treats every
   * key — including `;` itself — as a binding, so any test that starts with
   * `;` inherits the previous test's last action and silently does the wrong
   * thing. The held-leader suite file documents exactly this: its test passes
   * alone and fails after the other leader tests.
   *
   * Escape is the cancel key, so it is the honest way to disarm. If the
   * leader is already down this costs one keypress and changes nothing.
   */
  ctx.disarmLeader = async function disarmLeader(): Promise<void> {
    if (!ctx.tabA) return;
    // Only send Escape if the leader is ACTUALLY armed.
    //
    // This was unconditional at first, and it cost eight command-center tests:
    // the command center uses Escape to move between command and insert mode,
    // so a stray Escape at the start of every test silently changed the mode
    // the next test expected to find. Cancelling a disarmed leader is
    // harmless in a content page and destructive on the CC — so ask first.
    const armed = await ctx.isLeaderArmed();
    if (!armed) return;
    await ctx.press(ctx.tabA, "Escape").catch(() => {});
    await ctx.waitLeaderGone().catch(() => {});
  };

  /**
   * Is the leader currently armed, in either host?
   *
   * Checks the content script's mirror first (a web page with the content
   * script loaded), then the chrome host (extension and about: pages, where
   * there is no content script and therefore no mirror).
   */
  ctx.isLeaderArmed = async function isLeaderArmed(): Promise<boolean> {
    if (!ctx.tabA) return false;
    const on = await attempt(() =>
      evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`, {
        signal: ctx.signal,
      }),
    );
    if (on.ok && on.value !== undefined && on.value !== null) return on.value === true;
    if (!on.ok) return false;
    // No mirror on this page: fall back to the chrome host.
    return await ctx.hasHost(ctx.tabA, "lazyfox-leader").then((v) => !!v).catch(() => false);
  };

  /**
   * The test's declared starting state, asserted before it runs.
   *
   * Everything here is a PRECONDITION, not a cleanup. A test may assume all of
   * it holds; the harness guarantees it and the guarantee is visible in the
   * runner's report (`ctx.repaired`).
   *
   * Steps that need the chrome layer are best-effort and recorded rather than
   * fatal: a group that never touches chrome (the options page, say) should
   * not fail its first test because the chrome helper is not answering.
   */
  ctx.reset = async function reset(): Promise<void> {
    ctx.repaired = [];

    // 1. The probe first — every later step reads state through it, so a dead
    //    probe has to be repaired before anything else can work.
    await ctx.ensureProbe();

    // 1b. Config back to its pre-run value. Same reasoning as the probe: this
    //     is shared state that outlives a test, and it is the one kind that
    //     fails somewhere else entirely (the options group reading whichKey
    //     three groups after a `;q`). Best-effort and recorded, because a group
    //     that never reads the moved key must not be failed by repairing it.
    await ctx.restoreConfig().catch(() => {});

    // 2. The window has stopped churning. A destructive operation (session
    //    restore, marker hot-swap) replaces tabs asynchronously, and a tab
    //    created while that is still running is itself replaced and dies with
    //    its context — which surfaces much later as an unrelated "no such
    //    frame". Waiting first turns four doomed attempts into one.
    await ctx.waitWindowStable().catch(() => {});

    // 3. Re-check the probe: step 2 is exactly when it gets swept away.
    await ctx.ensureProbe();

    // 4. A live page for tabA. Some tests deliberately close it, and the next
    //    test needs somewhere to put its keys.
    if (!(await ctx.contextIsLive(ctx.tabA))) {
      ctx.repaired.push("tabA was dead; replaced");
      ctx.tabA = await ctx.newPageTab(`${ctx.base}/`);
    }

    // 5. Disarm the leader, in both places that can own it.
    await ctx.disarmLeader();

    // 6. The tab list is NOT reconciled, and must not be. The measurement that
    //    settled it is in docs/TESTING.md:
    //
    //        reconcile on every test    104/182    42 broken, 0 fixed
    //        reconcile off              146/182
    //
    //    Reconciling mutates SHARED state to satisfy an assertion ABOUT shared
    //    state, which is the wrong direction. A test that needs a known tab
    //    count DECLARES it as a precondition and waits for the product to get
    //    there:
    //
    //        await ctx.expectTabs(3);     // declared, not forced
    //        ...
    //        await ctx.expectTabs(4);     // asserted, by the same call
    //
    //    That leaves the window alone (so it is order-independent), it never
    //    touches Lazyfox plumbing (the relay tab is the ONE carrier for every
    //    chrome<->background message -- closing it does not fail loudly, it
    //    just makes every later `browser.*` round-trip from the chrome helper
    //    never arrive), and its failure names the observed count instead of
    //    blaming the reconciler for closing the wrong tab.
  };
}
