// Held-leader tests.
//
// Holding the leader key used to be impossible: the OS re-fires keydown at
// the auto-repeat rate, and every repeat re-armed the leader, so the sequence
// was torn apart several times a second and two actions in a row could never
// be chained. The leader now registers a repeat once and stays armed while the
// key is physically down, so `;` (hold) g l runs back then forward without a
// second leader press.
//
// The trap these tests exist to catch is release: a leader that stays armed
// after the key comes up swallows every subsequent key. That is invisible on
// a page with the overlay off, which is why it needs an explicit check.
//
// What is NOT here, and why. A keyup can also be LOST rather than never sent:
// press `;`, switch away before releasing, and the release is delivered
// wherever focus ended up, so this page never sees it. Both hosts therefore
// drop the hold on blur. That half cannot be driven from here: BiDi releases a
// key source when its action list ends, so a keydown with no keyup is
// unreachable through real input (the source teardown delivers the keyup), and
// the only path that can produce one — the synthetic #lfc=keys channel with
// `up: false` — reaches the chrome dispatch alone, with no page-realm way to
// blur a chrome window. scripts/test-keyhold.ts pins the property instead,
// against the same flag both hosts clear.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/held";
  // Tags: `--tags newfeatures` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["newfeatures","keys"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  await t("holding the leader runs back then forward without a second press", async () => {
    // Start from a DISARMED leader, and prove it rather than assume it.
    //
    // This test passes in isolation and fails when it runs after the other
    // leader tests, which is exactly the kind of order-dependence that makes a
    // suite untrustworthy. The cause is a real property of the dispatch: a
    // keydown for the leader key is only a press that ARMS the leader when the
    // leader is not already up — an armed leader treats every key, the leader
    // key included, as a binding. So a leftover armed leader from a previous
    // test swallows the `;` and the hold simply never starts.
    //
    // Disarming first is the honest way to test this rather than working around
    // it: the user pressing `;` to begin a sequence is starting from a
    // disarmed leader, and the precondition is asserted so a failure here says
    // "the suite left the leader up" instead of "the hold is broken".
    await ctx.press(ctx.tabA, "Escape");
    const clean = await waitFor(async () =>
      (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(() => false))
        ? null
        : true, 5000
    ).catch(() => null);
    assert(clean, "the leader starts disarmed");

    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Past eleven tabs, `;1` is a PREFIX rather than a jump: the content
    // script opens the chooser and waits for a second digit. That makes a pair
    // of digits the ideal probe - both keys resolve inside the page, with no
    // background round trip and no navigation between them.
    await ctx.ensureTabCount(12);
    const startTab = await ctx.activeTabInfo();
    assert(startTab, "the page is the active tab to begin with");

    // A genuine hold: the key goes down, two bindings run while it is still
    // down, then it comes up — as ONE action list, because BiDi releases a key
    // source when the list ends, so a hold split across two performActions
    // calls is not a hold at all.
    //
    // Digits, and specifically NOT the pairs that looked obvious first:
    //
    //  - `;g ;l` (back / forward) navigate, and navigation is ASYNCHRONOUS.
    //    performActions dispatches the two keys back to back with no gap, so
    //    the forward was issued while the back had not committed and Firefox
    //    dropped it — a human-impossible timing that flapped the test.
    //  - `;m ;m` (mute / unmute) is a background round trip per key, and with
    //    no gap between them one of the two is swallowed the same way.
    //
    // The control run first is what stops the assertion being vacuous: on its
    // own `;1` does not move, it opens the chooser. So "the chooser opened"
    // and "the second digit turned that into a jump" are only both true if the
    // leader stayed armed across both keys of one hold.
    await ctx.holdSequence(ctx.tabA, ";", ["1"]);
    const chooser = await waitFor(async () =>
      (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 10000
    ).catch(() => null);
    assert(chooser, "a held leader ran one binding (`;1` opened the chooser)");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.activateTab(ctx.tabA).catch(() => {});
    await ctx.holdSequence(ctx.tabA, ";", ["1", "1"]);
    const jumped = await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.id !== startTab.id ? a : null;
    }, 10000).catch(() => null);
    assert(jumped, "`;1` then `;1` off a SINGLE held leader jumped to tab 11 (wanted a tab other than " +
      startTab.id + ", active is " +
      JSON.stringify(await ctx.activeTabInfo().catch(() => "?")) + ")");
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });

  // The tap-then-release case needs no separate test: the one below presses
  // ; (which is a keydown AND a keyup), releases, and then proves a fresh
  // binding still runs. That is exactly the invariant that would break if
  // release disarmed the leader, and it is asserted through the binding
  // actually running rather than through the mirror attribute, which is only
  // a flag the product sets and not the behaviour itself.

  await t("a held leader that ran actions stands down when the key comes up", async () => {
    // THE REPORTED GESTURE, and the state it left behind: hold `;`, press a key
    // or two (the user's `;ggggg`), let go — and be LEFT WITH AN ARMED LEADER
    // and a which-key overlay still holding the keyboard, so the next keys run
    // as bindings instead of reaching the page. "The which-key and the leader
    // key stay active and then the actions don't respond accurately."
    //
    // A hold that ran something is a FINISHED GESTURE when the key comes up; a
    // TAP is not, and must stay armed for the chord that follows (the case
    // below is what proves release did not simply start disarming everything).
    //
    // The held keys are digits for the reason the first test spells out:
    // `;1` opens a chooser when the tab count is past nine, so a pair of digits
    // is two actions that resolve inside the page with no navigation to race.
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () =>
      (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(() => false))
        ? null
        : true, 5000
    ).catch(() => null);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.ensureTabCount(12);
    await ctx.activateTab(ctx.tabA).catch(() => {});

    // ONE ACTION OFF A HELD LEADER, and WHICH action is not arbitrary.
    //
    // The observable has to be (a) produced by the binding and (b) NOT produced
    // by anything else the binding does — no popup, no navigation, no focus
    // change — because the assertion below is about the leader's state, and an
    // action that hides the leader for its own reasons makes it vacuous. Two
    // versions of this test were GREEN with the fix disabled for exactly that
    // reason: `;1` opens the chooser popup (which hides the leader), and `;v`
    // only reopens when there is something to reopen (there was not).
    //
    // `;m` (mute this tab) is the one that satisfies both: it opens nothing and
    // under a hold it runs while the leader stays armed — which is the state
    // under test.
    //
    // ITS EFFECT IS READ OFF THE CHROME HELPER'S MUTE COUNT, not off the tab's
    // own `muted` flag. An extension-page realm does not expose `tabs.Tab.muted`
    // (see commandcenter/tabs.ts, which reads the count for exactly this reason),
    // so `browser.tabs.get(id).muted` is `undefined` before AND after a mute that
    // worked: the assertion could never pass, and it read as "the hold is broken"
    // while the hold was doing its job. The count is also the honest observable
    // for `;m`, which mutes the ACTIVE tab — a fact about the window, not about
    // whichever tab the harness happens to hold a handle on.
    const mutedCount = async (): Promise<number | null> => {
      const s = await ctx.chromeState().catch(() => null);
      return s && typeof s.mutedCount === "number" ? s.mutedCount : null;
    };
    const mutedBefore = await mutedCount();
    assert(mutedBefore !== null, "the window's muted-tab count is readable to begin with");

    await ctx.holdSequence(ctx.tabA, ";", ["m"]);
    // 15s rather than 8: `chromeState()` is the heaviest read in the harness
    // (probe tab -> #lfc=state relay -> background -> re-activate the active
    // tab) and this is a round trip per poll, so a tight budget reports the
    // clock as "the product did not run the binding".
    const ranWhileHeld = await waitFor(async () => {
      const m = await mutedCount();
      return m !== null && m !== mutedBefore ? m : null;
    }, 15000).catch(() => null);
    assert(
      ranWhileHeld !== null,
      "a held leader ran a binding (`;m` changed the window's muted-tab count from " +
        mutedBefore +
        " to " +
        (await mutedCount()) +
        ")"
    );
    // The tab is left muted: nothing after this reads mute state, and undoing it
    // through the product would be a second test inside this one.

    // THE CLAIM: the key came up, so the gesture is over. Before this rule the
    // leader stayed ARMED with the which-key overlay still up, and the next keys
    // ran as `;x` bindings — "the which-key and the leader key stay active and
    // then the actions don't respond accurately".
    const stoodDown = await waitFor(async () =>
      (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(() => true))
        ? null
        : true, 8000
    ).catch(() => null);
    assert(
      stoodDown,
      "the leader must stand down when a hold that ran an action is released"
    );

    // AND THE KEYBOARD IS THE PAGE'S AGAIN: `j` scrolls the document instead of
    // running the `;j` binding (which switches tabs). Both halves are asserted,
    // because either one alone is satisfiable by a keyboard that is simply dead.
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000).catch(() => null);
    await ctx.activateTab(ctx.tabA).catch(() => {});
    const tabNow = await ctx.activeTabInfo();
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`).catch(() => {});
    await ctx.press(ctx.tabA, "j");
    await ctx.press(ctx.tabA, "j");
    const scrolled = await waitFor(async () => {
      const y = await evalIn(ctx.tabA, `window.scrollY`).catch(() => 0);
      return Number(y) > 0 ? Number(y) : null;
    }, 8000).catch(() => null);
    assert(scrolled, "the next plain key reached the page (j scrolled, got " + scrolled + ")");
    const after = await ctx.activeTabInfo();
    assert(
      after && tabNow && after.id === tabNow.id,
      "and it was not eaten as a `;j` binding (active tab stayed " + (tabNow && tabNow.id) + ")"
    );
  });

  await t("a released leader does not swallow the next key", async () => {
    // The user-visible consequence of the previous test: if the leader were
    // left armed, this `j` would be eaten as a binding instead of scrolling or
    // navigating. ;t opening the tabs popup proves the key reached the leader.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.press(ctx.tabA, ";"); // a full tap: keydown AND keyup
    await ctx.press(ctx.tabA, "Escape");
    await ctx.leaderPress(ctx.tabA, "t");
    const open = await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 8000)
      .catch(() => null);
    assert(open, "the leader accepted a fresh binding after the previous press was released");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("a hold that crossed a document stands down on the page it landed on", async () => {
    // THE REPORTED SHAPE: hold `;`, press `g` (back). The document that saw the
    // press is gone by the time the key comes up, so the document that replaced
    // it is told the key is still down and restores the hold — that IS the
    // feature, and it is why `;` held + `g g g` works at all.
    //
    // What must not survive is the GESTURE. When the key comes up, the page gets
    // its keyboard back. Before that rule a restored hold ended like a TAP — a
    // fresh document has no memory of a binding having run — so the leader
    // stayed ARMED on a page nobody had armed it on, and every keystroke after
    // it was dispatched as a `;x` binding instead of reaching the page: "I can
    // do `;g` to go back but the which-key and the leader key stay active".
    //
    // HOW THE CROSS-DOCUMENT HOLD IS CONSTRUCTED, and why it is not a key hold.
    // BiDi releases a key source when its action list ends, so a press whose
    // release is delivered AFTER a navigation cannot be expressed through real
    // input at all (see the header). What a hold leaves behind when its document
    // dies, however, IS expressible: the per-tab claim the content script
    // publishes to the background (`lfHold` / `lfHoldAt`, written by the
    // syncHold handler). Writing that claim and then navigating is exactly the
    // state a human's still-down `;` leaves behind — and unlike the timing of a
    // real release across a navigation, it is deterministic, which is the only
    // reason this is worth asserting end to end.
    // The fixture's main page, because the last assertion needs a document tall
    // enough that `j` visibly scrolls it. The second navigation differs only in
    // its query string, which is still a NEW DOCUMENT (`#` would not be) and
    // still the same route, since the fixture's server ignores the query.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.activateTab(ctx.tabA).catch(() => {});
    const tab = await ctx.activeTabInfo();
    assert(tab, "the landed page is an active tab to hold the claim on");

    // The claim, written the way the product writes it: the flag, and WHEN it was
    // made (only the writer knows, and only a recent claim may be restored). Any
    // lfHoldState tombstone left by an earlier test is cleared with it: that
    // state shape is read by preference, so a legacy claim laid over it would
    // never be consulted.
    const writeClaim = () =>
      ctx
        .probeEval(
          `browser.sessions.removeTabValue(${tab.id}, "lfHoldState").catch(() => {})` +
            `.then(() => browser.sessions.setTabValue(${tab.id}, "lfHold", "1"))` +
            `.then(() => browser.sessions.setTabValue(${tab.id}, "lfHoldAt", String(Date.now())))` +
            `.then(() => true).catch(() => false)`,
        )
        .catch(() => false);
    const wrote = await writeClaim();
    assert(wrote === true, "the hold claim is written for this tab");

    // A NEW DOCUMENT, which is what reads the claim on boot.
    //
    // The restore is decided ONCE, at the new document's boot handshake, and
    // only claims younger than HOLD_RESTORE_GRACE_MS (2.5s) count. On a busy
    // full-suite run the gap between writing the claim and the new boot can
    // exceed that, so a refused restore reads as a product bug. The suite
    // controls its own clock: if the first landing missed the grace, re-land
    // the same way the product's restored hold would be re-armed on a real
    // crossing — a fresh claim a fresh document reads fresh.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/?crossed=1`);
    let restored = await waitFor(async () => {
      const armed = await evalIn(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-leader") === "1"`
      ).catch(() => false);
      return armed ? true : null;
    }, 4000).catch(() => null);
    if (restored === null) {
      await writeClaim();
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/?crossed=2`);
      restored = await waitFor(async () => {
        const armed = await evalIn(
          ctx.tabA,
          `document.documentElement.getAttribute("data-lf-leader") === "1"`
        ).catch(() => false);
        return armed ? true : null;
      }, 10000).catch(() => null);
    }
    assert(
      restored !== null,
      "the new document restores the hold: the leader is armed there without a second `;`"
    );

    // THE KEY COMES UP — a plain tap on the leader key, which is a keydown AND a
    // keyup, i.e. exactly what the restored hold has been waiting for.
    await ctx.press(ctx.tabA, ";");
    const stoodDown = await waitFor(async () => {
      const armed = await evalIn(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-leader") === "1"`
      ).catch(() => true);
      return armed ? null : true;
    }, 8000).catch(() => null);
    assert(
      stoodDown !== null,
      "a restored hold must stand down when the key comes up — the overlay may not " +
        "stay up on a page the user never armed it on"
    );

    // AND THE KEYBOARD IS THE PAGE'S AGAIN. Both halves are asserted, because
    // either one alone is satisfiable by a keyboard that is simply dead.
    await ctx.activateTab(ctx.tabA).catch(() => {});
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`).catch(() => {});
    await ctx.press(ctx.tabA, "j");
    await ctx.press(ctx.tabA, "j");
    const scrolled = await waitFor(async () => {
      const y = await evalIn(ctx.tabA, `window.scrollY`).catch(() => 0);
      return Number(y) > 0 ? Number(y) : null;
    }, 8000).catch(() => null);
    assert(scrolled, "the next plain key reached the page (j scrolled, got " + scrolled + ")");

    // The claim is cleared rather than left for the next test: it is a real
    // per-tab session value, and a later test that navigates this tab would
    // otherwise inherit a hold nobody is holding (which is correct behaviour
    // for the product, and a trap for a suite).
    await ctx
      .probeEval(
        `browser.sessions.setTabValue(${tab.id}, "lfHold", "0").then(() => true).catch(() => false)`
      )
      .catch(() => {});
  });

}
