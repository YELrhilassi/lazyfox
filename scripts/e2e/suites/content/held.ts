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

    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target2`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.evalHref();

    // A genuine hold: the key goes down, two bindings run while it is still
    // down, then it comes up — as ONE action list, because BiDi releases a key
    // source when the list ends, so a hold split across two performActions
    // calls is not a hold at all.
    //
    // This is the real user path, not a stand-in for it: a web page's content
    // script runs in another process, so the synthetic #lfc=keys channel (which
    // can also express `up: false`) only reaches the chrome dispatch, and its
    // contentWindow fallback is null for a remote page.
    await ctx.holdSequence(ctx.tabA, ";", ["g", "l"]);

    // Back then forward returns to where we started; the important part is
    // that both ran off ONE leader press.
    const landed = await waitFor(async () => {
      const h = await ctx.evalHref();
      return h === before ? h : null;
    }, 10000).catch(() => null);
    assert(landed, "back+forward off a single held leader returned to the start (" +
      JSON.stringify(await ctx.evalHref().catch(() => "?")) + " vs " + JSON.stringify(before) + ")");
  });

  // The tap-then-release case needs no separate test: the one below presses
  // ; (which is a keydown AND a keyup), releases, and then proves a fresh
  // binding still runs. That is exactly the invariant that would break if
  // release disarmed the leader, and it is asserted through the binding
  // actually running rather than through the mirror attribute, which is only
  // a flag the product sets and not the behaviour itself.

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

}
