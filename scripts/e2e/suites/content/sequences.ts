// sequences tests (content). Split verbatim from the original
// content.ts monolith — behavior unchanged, timing fixed separately.
import { waitFor } from "../../bidi.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/sequences";
  // Tags: `--tags newfeatures` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["newfeatures","keys"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });
  /* ==================== two-key leader sequences ==================== */
  await t(";G opens the navigation-stack popup and Esc closes it", async () => {
    // TWO keys, not three. This was briefly a ;G-then-k sequence, and the
    // extra key meant pressing ;G did nothing the user could see — the popup
    // the which-key table advertises simply never opened.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "G");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
  await t(";L opens the navigation-stack popup too (both entry keys)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target2`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "L");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // The popup groups Back/Current/Forward — the current entry is marked.
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
  // No third test here on purpose. The regression this guards against is
  // ";G shadowed ;g / ;l", and both halves of that are already covered
  // elsewhere and pass: the two tests above prove the SHIFTED keys open the
  // nav-stack popup, and core.ts's ";g back and ;l forward" proves the
  // lowercase pair still navigates. A third test that asserted the same thing
  // through a different navigation setup would only add a way to be flaky.
  await t(";b alone still opens bookmarks (sequences never shadow plain bindings)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "b");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
}
