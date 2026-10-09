// downloads tests (sessions). Split verbatim from the original
// sessions.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "sessions/downloads";
  // Tags: `--tags slow` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["slow"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });
  await t("downloads: r retries a failed download, y copies its link", async () => {
    // Sweep leftovers, then start a download that always fails so the popup
    // has a failed entry to retry.
    await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => Promise.all(rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1).map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
    const id = await evalIn(ctx.probe, `browser.downloads.download({ url: ${JSON.stringify(ctx.base + "/failfile")}, filename: "lf-fail.bin", saveAs: false }).then(d => d).catch(e => "ERR:" + e)`);
    assert(typeof id === "number", "failed download started: " + id);
    // The bar shows the failed entry (red indicator).
    const failed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && (s.dlActive || []).some((n) => String(n).indexOf("lf-fail") !== -1 && String(n).indexOf("failed") !== -1) ? s : null;
    }, 15000).catch(() => null);
    assert(failed, "failed download shows on the bar: " + JSON.stringify(failed && failed.dlActive));
    // ;d opens the downloads popup. `r` retries the failed download (its
    // startTime moves — Firefox restarts it from the source, same entry); `y`
    // copies the link and keeps the popup open; Esc closes.
    //
    // The popup is the PAGE's own (the command center runs the shared key
    // engine, and its popups live in a closed shadow root in the page), so it
    // is observed through the page's title mirror and list event rather than
    // through the chrome helper's popup state, which stays empty here.
    await ctx.openCC(ctx.tabA);
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "d");
    await ctx.waitPopupTitle(ctx.tabA, "Downloads", 8000);
    await ctx.waitListEvent(ctx.tabA, { count: { ge: 1 } }, 8000).catch(() => {
      throw new Error("the downloads popup never listed the failed download");
    });
    const t0 = await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => { const d = rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1)[0]; return d && d.startTime ? d.startTime : ""; })`);
    // Keys inside an OPEN popup go straight to it (a leading `;` would be
    // typed into the popup's search box and empty the list).
    await ctx.press(ctx.tabA, "r");
    const retried = await waitFor(async () => {
      const t = await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => { const d = rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1)[0]; return d && d.startTime ? d.startTime : ""; })`);
      return t && t !== t0 ? t : null;
    }, 10000).catch(() => null);
    assert(retried, "retry restarted the download (new startTime): before=" + t0 + " after=" + retried);
    await ctx.press(ctx.tabA, "y");
    assert(
      await ctx.hasHost(ctx.tabA, "lazyfox-popup"),
      "copy link keeps the popup open"
    );
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 5000);
    // Sweep the failed downloads so the suite stays repeatable.
    await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => Promise.all(rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1).map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
}
