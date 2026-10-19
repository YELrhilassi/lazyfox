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
  waitFor,
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
   * Clear the two KEY TRAPS a failed test can leave behind: an open popup, and
   * an armed one-shot capture. Both eat keystrokes, which is how one broken
   * test gets reported as eight unrelated failures.
   *
   * AN OPEN POPUP is the expensive one. `chromeKeyDown` consumes every key it
   * sees while a popup is open unless the key is aimed inside that popup, so a
   * popup which outlived a test that threw swallows the next test's `;` and
   * every binding after it. The commandcenter group is where this shows: the
   * leader keys "stop working" on a product that is working perfectly, on
   * every test after the one that failed. Escape is the product's OWN close
   * key — both hosts route it through the same `isCancel` predicate the
   * dispatcher uses — so the harness presses it rather than reaching into the
   * DOM to remove the overlay. It is sent only when a popup is actually open,
   * for the reason `disarmLeader` documents: a stray Escape on the command
   * center silently changes the mode the next test expects to find.
   *
   * AN ARMED CAPTURE (the `;f` hint-pick letter, a digit target) is NOT
   * cleared with Escape, and that asymmetry is deliberate: `handlePending`
   * always RUNS the capture's function, so Escape through an armed digit
   * capture would switch sessions. The capture expires on its own (3s for a
   * digit, 10s for a hint-pick letter), so the repair waits it out rather than
   * injecting a key whose meaning it cannot predict. It is bounded, and it
   * costs nothing at all in the normal case, because nothing is armed.
   */
  ctx.repairKeyTraps = async function repairKeyTraps(): Promise<void> {
    const before = await ctx.chromeState().catch(() => null);
    if (!before) return;
    if (before.popup && before.popup.current) {
      ctx.repaired.push("closed a popup the previous test left open");
      await ctx.press(ctx.tabA, "Escape").catch(() => {});
      await waitFor(async () => {
        const s = await ctx.chromeState().catch(() => null);
        return s && s.popup && !s.popup.current ? true : null;
      }, 8000).catch(() => {});
    }
    if (!before.leaderPending) return;
    ctx.repaired.push("waited out a one-shot key capture the previous test armed");
    await waitFor(async () => {
      const s = await ctx.chromeState().catch(() => null);
      return s && !s.leaderPending ? true : null;
      // 12s: the longest capture the product arms is the 10s hint-pick letter
      // forward, so anything still armed after that is not going to expire.
    }, 12000).catch(() => {});
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

    // 5b. No popup and no armed one-shot capture left over from the previous
    //     test — see repairKeyTraps for why a leftover of either turns ONE
    //     failure into eight, and why the repair lives here rather than at the
    //     end of each test: a test that throws is not around to clean up.
    await ctx.repairKeyTraps();

    // 5c. NO SPLIT left armed — the precondition fixture.ts has always
    //     DECLARED ("a test may assume: … no split is armed") but never
    //     enforced, until its absence produced a failure that read like a
    //     product bug. `sessions › split layout is saved and restored` waits
    //     for exactly two split-view tabs after `;W m N`; a split restored by
    //     the PREVIOUS test (restore-with-split leaves its pair on tabs that
    //     predate the next test, so the leak sweep must not close them) makes
    //     that wait see four and fail — even though the move under test had
    //     worked, both readbacks agreed, and the pair it cared about was
    //     correct. Declaring a precondition and not establishing it is worse
    //     than not declaring it: every test then pays for a guarantee it
    //     cannot use. `;W u` is the product's own dissolve, pressed only when
    //     a split actually exists, so the normal case stays free.
    try {
      const ts: any[] = (await ctx.tabsInfo().catch(() => [])) || [];
      const inSplit = (t: any) => typeof t.splitViewId === "number" && t.splitViewId >= 0;
      if (ts.some(inSplit)) {
        await ctx.leaderSeq(ctx.tabA, ["W", "u"]).catch(() => {});
        const gone = await waitFor(async () => {
          const t2: any[] = (await ctx.tabsInfo().catch(() => [])) || [];
          return t2.some(inSplit) ? null : true;
        }, 8000).catch(() => null);
        ctx.repaired.push(
          gone
            ? "dissolved a split the previous test left open"
            : "a split the previous test left open would not dissolve",
        );
      }
    } catch (e) {
      // The split check is best-effort: a group that cannot read the tab list
      // must not lose its whole precondition pass over it.
    }

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
