// The FIRST leader chord on a freshly opened home page.
//
// The page fetches its keymap at construction, and the wasm source used to be
// installed at the END of boot — after the leader existed. So that first fetch
// always failed; the leader buffered the chord and its only queue reader had
// already returned, leaving the chord in the buffer and the leader armed. The
// reported shape: "leader + action doesn't work right away, I have to press the
// action twice". One press must be enough, and it must be on a COLD page: a
// page whose core is already warm cannot reproduce this.
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  const FILE = "commandcenter/firstchord";
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest(FILE, name, fn);

  await t("the first leader chord after the home page opens runs on one press", async () => {
    // A fresh document: openCC navigates the tab, so the keymap fetch starts
    // from nothing every time.
    await ctx.openCC(ctx.tabA);
    // leaderPress arms with `;` and presses the binding ONCE. Its internal
    // retries cover arming only — it never re-sends the action, which is the
    // half that used to be swallowed.
    await ctx.leaderPress(ctx.tabA, "P", { shift: true });
    await ctx.waitPopup(ctx.tabA, 8000);
    const title = await ctx.waitPopupTitle(ctx.tabA, "Sessions", 8000);
    assert(title === "Sessions", "the first ;P did not open Sessions (got " + JSON.stringify(title) + ")");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 8000);
  });
}
