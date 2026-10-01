// sequences tests (content). Split verbatim from the original
// content.ts monolith — behavior unchanged, timing fixed separately.
import { waitFor } from "../../lib.ts";
export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content", name, fn);
  /* ==================== two-key leader sequences ==================== */
  await t(";Gk opens the navigation-stack popup and Esc closes it", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.press(ctx.tabA, ";");
    await ctx.press(ctx.tabA, "G");
    await ctx.press(ctx.tabA, "k");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
  await t(";Lk opens the navigation-stack popup too (both entry keys)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target2`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.press(ctx.tabA, ";");
    await ctx.press(ctx.tabA, "L");
    await ctx.press(ctx.tabA, "k");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // The popup groups Back/Current/Forward — the current entry is marked.
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
  await t(";b alone still opens bookmarks (sequences never shadow plain bindings)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "b");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
}
