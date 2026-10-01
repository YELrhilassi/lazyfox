// tabsmodal tests (content). Split verbatim from the original
// content.ts monolith — behavior unchanged, timing fixed separately.
import { createTab, evalIn, waitFor } from "../../lib.ts";
import { assert } from "../../harness.ts";
export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content", name, fn);
  /* ==================== tabs modal favicons ==================== */
  await t(";t tab rows carry a favicon image on the right", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // The rows live in a closed shadow root the page cannot read, so the
    // harness listens for the popup's own composed "lazyfox:list" event
    // (dispatched on every render) — the same pattern the sessions suite
    // uses. The detail exposes a hasFav probe (whether the selected row
    // carries a .fav element) rather than row HTML, which would leak other
    // tabs' titles/URLs to the listening page.
    await evalIn(
      ctx.tabA,
      `window.__lfList = null; document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true); true`
    );
    await ctx.leaderPress(ctx.tabA, "t");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // NO typing: the tabs popup's digit keys jump tabs while the input is
    // empty (typing "127.0.0.1" would jump on the leading 1 and close the
    // popup), so selection is driven by keys alone. Walk every row via
    // ArrowDown and collect the event detail after each render — at least
    // one row (this very tab, an http page) must carry a favicon element.
    const detail = await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.count > 0 ? d : null;
    }, 8000);
    let sawFav = detail.hasFav === true;
    for (let i = 0; i < detail.count && !sawFav; i++) {
      await ctx.press(ctx.tabA, "ArrowDown");
      const d = await waitFor(async () => {
        const v = await evalIn(ctx.tabA, `window.__lfList`);
        return v && v.idx === (detail.idx + i + 1) % detail.count ? v : null;
      }, 5000).catch(() => null);
      if (d && d.hasFav === true) sawFav = true;
    }
    // Close the popup BEFORE asserting: a throw with the popup still open
    // would starve every later leader press (the popup eats the keys).
    await evalIn(ctx.tabA, `window.__lfList = null; true`);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    assert(detail.count > 0, "the tab popup has rows: " + JSON.stringify(detail));
    assert(sawFav, "at least one row (the http tab) carries a favicon element");
  });
  await t(";t tab modal refreshes after x on a row (the closed tab disappears)", async () => {
    // Two tabs: the modal shows both; x on the selected row closes it and
    // the modal must reflect the strip without re-opening. Row selection is
    // deterministic: rows are in strip order, tabB is created LAST, and
    // ArrowUp from row 0 wraps to the last row — tabB's. (x only works on an
    // EMPTY input, so a typed filter would be edited, not act.)
    // Track THIS test's tab by id. Several other tests legitimately leave
    // tabs on the shared /target2 page, so a URL-based "is it gone" check
    // would fail on their leftovers, not on a regression.
    const tabB = await createTab();
    const scratchUrl = `${ctx.base}/scratch?tabsmodal`;
    await ctx.gotoPage(tabB, scratchUrl);
    const tabBId = (
      await ctx.tabsInfo()
    ).find((t: any) => (t.url || "").includes("scratch?tabsmodal"))?.id;
    assert(tabBId, "located the scratch tab's Firefox id");
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Attach the render listener BEFORE opening the popup (the initial
    // render fires the moment the popup mounts).
    await evalIn(
      ctx.tabA,
      `window.__lfList = null; document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true); true`
    );
    await ctx.leaderPress(ctx.tabA, "t");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // Wait for the async list to actually render BEFORE selecting: move() on
    // an empty list is a no-op, so a racing End press would select nothing
    // and x would close the wrong row. Rows are in strip order and tabB was
    // created last, so End (last row) is exactly tabB. (x only works on an
    // EMPTY input, so a typed filter would be edited, not act.)
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.count > 0 ? d : null;
    }, 8000);
    await ctx.press(ctx.tabA, "End");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.idx === d.count - 1 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "x");
    try {
      const stillOpen = await ctx.hasHost(ctx.tabA, "lazyfox-popup");
      assert(stillOpen, "the modal stays open after x");
      // The close lands through the background async; poll instead of a
      // fixed sleep (a fixed 800ms raced under full-suite load).
      const gone = await waitFor(async () => {
        const now = await ctx.tabsInfo();
        return !now.some((t: any) => t.id === tabBId) ? now : null;
      }, 8000).catch(() => null);
      // tabsInfo reports Firefox tab ids; the ctx handles are BiDi context
      // UUIDs, so the comparison must go by the tabs' unique URLs.
      assert(gone, "the closed tab left the strip");
      assert(gone.some((t) => (t.url || "").includes(":" + ctx.port + "/")), "tabA itself is still open");
    } finally {
      // The popup must close even on a failed assertion: a leftover modal
      // eats every key and starves all later tests.
      await ctx.press(ctx.tabA, "Escape").catch(() => {});
      await waitFor(
        async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null,
        5000
      ).catch(() => {});
    }
  });
}
