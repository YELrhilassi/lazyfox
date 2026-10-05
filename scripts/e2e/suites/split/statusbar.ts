// statusbar tests (split). Deterministic: every wait targets a product signal
// (status bar mount state, per-pane bar hosts, split view ids) instead of
// fixed sleeps.
import { closeContext, createTab, evalIn, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
import { makeSplitHelpers } from "./_shared.ts";
export async function run(ctx: any): Promise<void> {
  // Tags: `--tags split` selects these. "destructive" marks tests
  // that dissolve and rebuild splits, so a quick subset can skip them.
  const TAGS: string[] = ["split"];
  const { t, waitNoSplit, waitPlusPopup } = makeSplitHelpers(ctx, "split/statusbar", TAGS);

  await t("split: one window-level status bar (not one per pane)", async () => {
    // During a native split the chrome helper shows the single window bar and
    // the web panes hide their per-tab bars, so there is exactly ONE bar for
    // the whole window instead of one rendered in each pane.
    await waitNoSplit();
    const a = await createTab();
    await ctx.openCC(a);
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    await ctx.waitTabUrl("/hello", { timeoutMs: 10000 });
    await ctx.openCC(a); // re-activate the CC tab
    await ctx.leaderSeq(a, ["W", "|"]); // ;W | -> CC + panel
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0).length === 2 ? true : null;
    }, 8000);
    const real = (await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t));
    const helloRow = real.find((t) => (t.url || "").includes("/hello"));
    // The PRODUCT's numbering, not the strip index this test happens to see,
    // and not clamped into 1-9. The clamp was a silent wrong-target bug: in a
    // full run the strip carries tabs from three earlier groups, so a hello
    // sitting at position 11 was addressed as 9 and some OTHER tab was moved
    // into the split. productNumberOf asks the product which digit means
    // /hello, and pressNumber types it a digit at a time so a two-digit answer
    // works exactly like a single keystroke.
    const helloNumber = await ctx.productNumberOf(helloRow, real);
    assert(
      helloNumber >= 1,
      "the product's numbering knows the /hello tab: " + helloNumber + " of " + real.length,
    );
    await ctx.leaderSeq(a, ["W", "m"]); // ;W m -> move tab into split
    await waitPlusPopup(a);
    await ctx.pressNumber(a, helloNumber);
    // Wait for the move to land (hello is IN the split) and then for the
    // per-pane bar to actually disappear (the content poll hides it) instead
    // of a fixed sleep.
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 && sv.some((t) => (t.url || "").includes("/hello")) ? true : null;
    }, 10000);
    await waitFor(async () =>
      evalIn(b, `!document.getElementById("lazyfox-status")`).then((v) => (v ? true : null)).catch(() => null)
    , 8000).catch(() => {});
    const st = await ctx.chromeState();
    assert(st && st.statusMounted === true, "chrome window bar mounted during the split");
    // The window bar must reserve its height out of the browser content area
    // (margin-bottom on #browser), so the panes reflow above it instead of
    // rendering behind it.
    assert(
      st && st.browserReserve && st.browserReserve.mb === "18px",
      "#browser reserved 18px for the bar during the split: " + JSON.stringify(st && st.browserReserve)
    );
    // The hello pane (b) must have hidden its per-tab bar.
    const host = await evalIn(b, `!!document.getElementById("lazyfox-status")`).catch(() => null);
    assert(host === false, "web pane has no per-tab bar during the split (got " + host + ")");
    // Clean up: unsplit and drop the two fresh tabs.
    await ctx.leaderSeq(a, ["W", "u"]);
    await waitNoSplit();
    await closeContext(b).catch(() => {});
    await closeContext(a).catch(() => {});
    await ctx.waitTabUrl("/hello", { gone: true, timeoutMs: 8000 }).catch(() => {});
  });
}
