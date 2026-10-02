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
    opts: { tags?: string[]; keepTabs?: string[]; reconcile?: boolean } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS, keepTabs: opts.keepTabs, reconcile: opts.reconcile });
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
    await ctx.openCC(ctx.tabA);
    await ctx.chromeLeaderPress(ctx.tabA, "d");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.current && s.popup.items && s.popup.items.length ? true : null;
    }, 8000).catch(() => null);
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
    const stillOpen = await ctx.chromeState();
    assert(stillOpen && stillOpen.popup && stillOpen.popup.current, "copy link keeps the popup open");
    await ctx.press(ctx.tabA, "Escape");
    // Sweep the failed downloads so the suite stays repeatable.
    await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => Promise.all(rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1).map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
}
