// "At most one overlay" — the chrome helper and the content script must never
// both paint, on any page, at any moment.
//
// The bug this pins was visible rather than subtle: the which-key overlay is a
// PERSISTENT host that only loses its `on` class when something explicitly
// hides it, and nothing stood it down when ownership moved. Arm the leader on
// the command center (chrome paints), switch to a web page (the content script
// paints), and the chrome panel stayed lit for the life of the window — the
// user saw two which-key modals, one of them permanently stale, opening and
// closing behind a working one.
//
// Two transitions are covered because they are different code paths:
//   - a TAB SWITCH (fires TabSelect), and
//   - a NAVIGATION WITHIN the selected tab (fires nothing, which is why the
//     500ms ownership poll exists).
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

// How many which-key overlays the CHROME document currently has lit.
async function chromeOverlays(ctx: any): Promise<number> {
  const s = await ctx.chromeState().catch(() => null);
  return s && s.popup ? Number(s.popup.wkOn) : -1;
}

// Whether the PAGE currently has its own overlay lit. The overlay lives in a
// closed shadow root, so the only honest signal from the page realm is the
// content script's own data-lf-leader mirror — which is set from the leader's
// onChange, i.e. at exactly the moment the overlay would be shown. Note the
// mirror is the ARMED state, not "a host node exists": the host is persistent
// by design (that is the whole bug), so its mere presence says nothing.
async function contentOverlayLit(tab: any): Promise<boolean> {
  const on = await evalIn(
    tab,
    `document.documentElement.getAttribute("data-lf-leader") === "1"`
  ).catch(() => false);
  return !!on;
}

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/surfaces";
  // Tags: `--tags newfeatures` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["newfeatures","chrome"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[]; keepTabs?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS, keepTabs: opts.keepTabs });

  await t("switching from a chrome page to a web page leaves no stale overlay", async () => {
    // Arm the leader somewhere the CHROME helper owns it, so its overlay is
    // genuinely on screen before the switch.
    await ctx.gotoPage(ctx.tabA, "about:blank");
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(async () => {
      const n = await chromeOverlays(ctx);
      return n >= 1 ? n : null;
    }, 8000).catch(() => null);
    assert(armed !== null, "the chrome which-key overlay was lit on about:blank");

    // Now move to a web page, where the content script owns everything.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const gone = await waitFor(async () => {
      const n = await chromeOverlays(ctx);
      // `0` is falsy and waitFor only resolves on a truthy value, so the
      // "nothing is lit" answer has to be reported as something truthy. This
      // is the same trap that once made a setting flip look like it timed out.
      return n === 0 ? "clean" : null;
    }, 8000).catch(() => null);
    assert(
      gone !== null,
      "the chrome overlay stood down after the switch, still lit: " + (await chromeOverlays(ctx))
    );

    // And now the content one is the only overlay: exactly one, never two.
    await ctx.press(ctx.tabA, ";");
    const contentArmed = await waitFor(async () => {
      return (await contentOverlayLit(ctx.tabA)) ? true : null;
    }, 8000).catch(() => null);
    assert(contentArmed, "the content overlay is up after ;");
    assert(
      (await chromeOverlays(ctx)) === 0,
      "the chrome overlay must stay down while the content one is up, was " + (await chromeOverlays(ctx))
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("navigating the same tab away stands the chrome overlay down", async () => {
    // The same failure WITHOUT a TabSelect: one tab, two documents. Nothing
    // announces an ownership change here except the poll, so this is the case
    // that proves the catch-all works rather than the event handler.
    await ctx.gotoPage(ctx.tabA, "about:blank");
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(async () => ((await chromeOverlays(ctx)) >= 1 ? true : null), 8000).catch(
      () => null
    );
    assert(armed, "the chrome overlay was lit on about:blank");

    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const gone = await waitFor(async () => ((await chromeOverlays(ctx)) === 0 ? true : null), 8000).catch(
      () => null
    );
    assert(
      gone,
      "the chrome overlay stood down after an in-tab navigation, still " + (await chromeOverlays(ctx))
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("only one which-key overlay is ever on screen", async () => {
    // The invariant, asserted directly rather than inferred from the two cases
    // above: whatever the page, the two contexts never both paint.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.press(ctx.tabA, ";");
    await waitFor(async () => ((await contentOverlayLit(ctx.tabA)) ? true : null), 8000).catch(() => null);
    const chrome = await chromeOverlays(ctx);
    const content = (await contentOverlayLit(ctx.tabA)) ? 1 : 0;
    assert(
      !(chrome > 0 && content > 0),
      "two which-key overlays at once: chrome=" + chrome + " content=" + content
    );
    await ctx.press(ctx.tabA, "Escape");
  });
}