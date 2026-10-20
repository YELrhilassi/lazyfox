// Chat-shaped rows, and whether the hint engine can see them.
//
// The report this file exists for: on WhatsApp Web "hints don't show for all the
// important elements — they might show for some but not the rest of similar
// items". The rows are similar in every way that matters and differ in one that
// does not: how long the last message happens to be. The discovery bounds used to
// be "at most 3 element children, at most 120 characters of text", so a row with
// four columns, or with a long message behind its ellipsized single line, had no
// key while the row above it did.
//
// The assertion is on the PRODUCT — which row has which key — not on the rule:
// the fixture rows are the shapes the rule has to keep, and the test names them.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  const FILE = "content/rows";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const settled = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.readyState`, "complete", ms);
  const hintsOn = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`, "1", ms);

  // Positions come from the content script (the only thing that knows them); the
  // elements come from the page. Matching one to the other names a ROW instead of
  // a key it happened to be given — the same helper the field suite uses.
  const hintMap = async (): Promise<Array<{ key: string; id: string }>> => {
    const snap = await ctx.hintSnapshot(ctx.tabA);
    const pos = (snap && snap.positions) || [];
    const els = await evalIn(
      ctx.tabA,
      `(function () {
         const out = [];
         document.querySelectorAll("[data-id]").forEach((e) => out.push(e));
         return out.map((el) => {
           const b = el.getBoundingClientRect();
           return { id: el.getAttribute("data-id"), x: Math.round(b.left), y: Math.round(b.top) };
         });
       })()`
    );
    return pos.map((p: any) => {
      const el = (els || []).find(
        (c: any) => Math.abs(c.x - p.x) <= 2 && Math.abs(c.y - p.y) <= 2
      );
      return { key: p.key, id: el ? el.id : "" };
    });
  };

  await t("a chat row with a short preview has a key", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/chatrows`);
    await settled();
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    const map = await hintMap();
    assert(
      map.some((m) => m.id === "row-short"),
      "the plain row must be hinted (hinted: " + map.map((m) => m.id).join(", ") + ")"
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("a row whose last message is long is a row too, not a container", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/chatrows`);
    await settled();
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    const map = await hintMap();
    const ids = map.map((m) => m.id);
    assert(
      ids.includes("row-long"),
      "a row carrying a long, ellipsized message must still get a key — that is the " +
        "reported 'some of these are hinted and the rest are not' (hinted: " +
        ids.join(", ") +
        ")"
    );
    assert(
      ids.includes("row-short") && ids.includes("row-many"),
      "and its neighbours must not lose their keys to it (hinted: " + ids.join(", ") + ")"
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("the long row's key activates that row", async () => {
    // The point of a key is that it works: covering the rows is only half the
    // claim, and a rule that collected them but could not resolve them back would
    // look identical from the hint positions alone.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/chatrows`);
    await settled();
    await evalIn(
      ctx.tabA,
      `window.__rowClicks = 0;
       document.getElementById("row-long").addEventListener("click", function () { window.__rowClicks++; });
       true`
    );
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    const map = await hintMap();
    const row = map.find((m) => m.id === "row-long");
    assert(!!row, "the long row must be hinted");
    for (const ch of String(row!.key)) await ctx.press(ctx.tabA, ch);
    if ((await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1") {
      await ctx.press(ctx.tabA, "Enter");
    }
    await waitFor(
      async () => ((await evalIn(ctx.tabA, `window.__rowClicks`)) === 1 ? true : null),
      5000,
      120,
      { what: "the long row's own click handler" }
    );
  });
}
