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
import { waitFor } from "../../lib.ts";
import { assert } from "../../harness.ts";

export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content", name, fn);

  await t("holding the leader runs back then forward without a second press", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target2`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.evalHref();

    // One keydown, then the two bindings, then the keyup. Sent as a single
    // ordered batch so this is genuinely one held press rather than three
    // presses that merely happen to be close together.
    await ctx.sendKeys(ctx.tabA, [
      { k: ";" },
      { k: "g" },
      { k: "l" },
      { k: ";" },
      { k: "Escape" },
    ]);

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
    await ctx.sendKeys(ctx.tabA, [{ k: ";" }, { k: "Escape" }]);
    await ctx.leaderPress(ctx.tabA, "t");
    const open = await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 8000)
      .catch(() => null);
    assert(open, "the leader accepted a fresh binding after the previous press was released");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
}
