// order tests (split). Split verbatim from the original
// split.ts monolith — behavior unchanged, timing fixed separately.
import { createTab, evalIn, navigate, waitFor } from "../../lib.ts";
import { assert } from "../../harness.ts";
import { makeSplitHelpers } from "./_shared.ts";
export async function run(ctx: any): Promise<void> {
  const { t, waitNoSplit, waitPlusPopup } = makeSplitHelpers(ctx);
  await t("split: ;+N auto-split keeps the other tabs' order", async () => {
    // Regression: addTabSplitView used to park a freshly glued pair at the
    // END of the strip, renumbering every tab between the pair and the tail —
    // so ;1-9 could silently point at a different tab after a split. Splitting
    // a MIDDLE tab must keep the anchor at its own slot, seat the partner
    // right next to it, and leave every other tab exactly where it was.
    await waitNoSplit();
    const a = await createTab();
    await navigate(a, `${ctx.base}/orderA`, "complete");
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    const c = await createTab();
    await navigate(c, `${ctx.base}/target1`, "complete");
    // Wait for all three fresh tabs to be listed in the strip.
    await ctx.waitTabUrl("/target1", { timeoutMs: 10000 });
    const ids = await ctx.tabsInfo();
    const urlOf = (t) => (t.url || "").split("?")[0].split("#")[0];
    const short = (u) => String(u).replace(ctx.base, "");
    const realIds = ids.filter((t) => !(t.url || "").includes("commandcenter.html"));
    const aRow = realIds.find((t) => short(urlOf(t)) === "/orderA");
    const bRow = realIds.find((t) => short(urlOf(t)) === "/hello");
    const cRow = realIds.find((t) => short(urlOf(t)) === "/target1");
    assert(aRow && bRow && cRow, "found the three fresh tabs: " + JSON.stringify(ids));
    // Activate A (a MIDDLE tab, not the last) and auto-split A with C.
    await evalIn(ctx.probe, `browser.tabs.update(${aRow.id}, { active: true })`).catch(() => {});
    await waitFor(async () => ((await ctx.activeTabInfo() || {}).id === aRow.id ? true : null), 5000).catch(() => {});
    // ;+N numbers REAL tabs exactly like the chrome helper's realTabs(): skip
    // only splitpanel/#lfc transients (commandcenter tabs count).
    const chromeReal = ids.filter((t) => ctx.isRealTab(t));
    const cRealIndex = chromeReal.findIndex((t) => t.id === cRow.id) + 1;
    assert(cRealIndex <= 9, "C index within 1-9: " + cRealIndex);
    await ctx.leaderSeq(a, ["W", "m"]); // ;W m -> move tab into split
    await waitPlusPopup(a);
    await ctx.press(a, String(cRealIndex));
    try {
      await waitFor(async () => {
        const now = await ctx.tabsInfo();
        const split = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        return split.length === 2 ? split : null;
      }, 10000);
    } catch (e) {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("auto-split keeps: pair never formed; state=" + JSON.stringify(st && { strip: st.strip, lastAction: st.lastAction }) + " tabs=" + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR")));
    }
    // The achievable invariant: the ANCHOR (A) stays first among the web
    // tabs, the partner (C) sits right next to it, and B keeps its relative
    // position — the old bug flung B to the strip end and moved A too. The
    // strip settles a moment after the split forms, so wait for it.
    const settled = await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const realAfter2 = now.filter((t) => ctx.isRealTab(t));
      const webOnly = realAfter2.filter((t) => !(t.url || "").includes("commandcenter.html"));
      const wA = webOnly.findIndex((t) => t.id === aRow.id);
      const wC = webOnly.findIndex((t) => t.id === cRow.id);
      const wB = webOnly.findIndex((t) => t.id === bRow.id);
      if (wA !== 0 || wC !== 1 || wB !== 2) return null;
      const sv2 = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      if (sv2.length !== 2 || !sv2.every((t) => [aRow.id, cRow.id].includes(t.id))) return null;
      return webOnly;
    }, 4000);
    assert(settled != null, "pair pinned next to the anchor (A first, then C, then B): web=" + JSON.stringify((await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t) && !(t.url || "").includes("commandcenter.html")).map((t) => t.id)));
    // Clean up: unsplit and close the fresh tabs.
    await ctx.leaderPress(a, "\\");
    await waitNoSplit();
    for (const id of [aRow.id, bRow.id, cRow.id]) {
      await evalIn(ctx.probe, `browser.tabs.remove(${id}).catch(() => {})`);
      await waitFor(async () => {
        const ts = await ctx.tabsInfo();
        return ts.every((x) => x.id !== id) ? true : null;
      }, 5000).catch(() => {});
    }
  });
  await t("split: splitting a middle tab keeps the other tabs' order", async () => {
    // Regression for the shuffle: gBrowser.addTabSplitView used to move the
    // pair to the end, reordering every tab between the split root and the
    // panel. Three fresh tabs with distinct URLs; splitting the middle one
    // must leave the real tabs in their relative order.
    await waitNoSplit();
    const a = await createTab();
    await navigate(a, `${ctx.base}/`, "complete");
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    const c = await createTab();
    await navigate(c, `${ctx.base}/target1`, "complete");
    await ctx.waitTabUrl("/target1", { timeoutMs: 10000 });
    const ids = await ctx.tabsInfo();
    const urlOf = (t) => (t.url || "").split("?")[0].split("#")[0];
    const aId = ids.find((t) => urlOf(t) === `${ctx.base}/`)?.id;
    const bId = ids.find((t) => urlOf(t) === `${ctx.base}/hello`)?.id;
    const cId = ids.find((t) => urlOf(t) === `${ctx.base}/target1`)?.id;
    assert(aId != null && bId != null && cId != null, "found the three fresh tabs: " + JSON.stringify(ids));
    // Split the middle tab (B) via its content-script leader.
    await evalIn(ctx.probe, `browser.tabs.update(${bId}, { active: true })`).catch(() => {});
    await waitFor(async () => ((await ctx.activeTabInfo() || {}).id === bId ? true : null), 5000).catch(() => {});
    await ctx.leaderPress(b, "\\", { shift: true }); // ;| on B
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const sv = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000);
    const after = await ctx.tabsInfo();
    const realOrder = after
      .filter((t) => ctx.isRealTab(t))
      .map((t) => t.id)
      .filter((id) => id === aId || id === bId || id === cId);
    assert(
      realOrder.join(",") === [aId, bId, cId].join(","),
      "real tabs kept their order after a middle split: want=" + JSON.stringify([aId, bId, cId]) + " got=" + JSON.stringify(realOrder)
    );
    // Clean up: unsplit and close the fresh tabs + panel.
    await ctx.leaderPress(b, "\\"); // ;\
    await waitNoSplit();
    const leftovers = await ctx.tabsInfo();
    for (const id of [aId, bId, cId]) {
      await evalIn(ctx.probe, `browser.tabs.remove(${id})`).catch(() => {});
    }
    const panel = leftovers.find((t) => (t.url || "").includes("splitpanel.html"));
    if (panel) await evalIn(ctx.probe, `browser.tabs.remove(${panel.id})`).catch(() => {});
    await waitNoSplit();
  });
}
