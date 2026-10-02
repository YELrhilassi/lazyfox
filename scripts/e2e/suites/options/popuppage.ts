// popuppage tests (options). Split verbatim from the original
// options.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("options", name, fn);
  await t("popup page (action popup) renders", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "popup.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await waitFor(async () => {
      const ready = await evalIn(ctx.tabA, `!!document.body && document.body.innerText.length > 0`).catch(() => false);
      return ready ? true : null;
    }, 8000);
    const f = await evalIn(ctx.tabA, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        body: document.body ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 120) : "",
        links: [...document.querySelectorAll("a,button")].map((a) => a.textContent.trim()).filter(Boolean).slice(0, 8),
      };
    })()`);
    assert(f.body.length > 0, "popup body renders: " + f.body);
  });
}
