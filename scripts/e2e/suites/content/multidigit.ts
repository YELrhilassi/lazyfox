// Multi-digit tab addressing, end to end.
//
// `;1`-`;9` used to mean "the tab in this position", which is a complete
// answer in any window with nine or fewer tabs and an ambiguous one past that.
// The digits are now prefixes: `;11` is tab 11, and the ONLY thing that ever
// appears on screen is a chooser listing the tabs a prefix could mean — shown
// exactly when the keystroke is genuinely ambiguous and never otherwise.
//
// What these tests pin is that split, in both directions:
//   - a window of ten or fewer tabs must be completely unchanged (one
//     keystroke, no popup, the right tab), because that is the case almost
//     every session hits;
//   - past nine, the same digit must open the chooser and NOT guess;
//   - a digit whose two-digit range does not exist must stay a plain jump,
//     because the ambiguity is per digit and not global.
//
// Every assertion about "which tab is number N" asks the BACKGROUND for the
// list rather than reading the raw tab query. The harness's own plumbing is
// not invisible to the product — the probe tab carries a momentary #lfc= hash
// while a key is synthesized, and a command center tab is a real user tab as
// far as numbering goes — so a test that numbered tabs itself would disagree
// with the binding it is testing. That disagreement is not hypothetical: it
// is what this file's first draft got wrong.
import { waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

async function activeId(ctx: any): Promise<any> {
  const ts = await ctx.tabsInfo();
  return (ts.find((x: any) => x.active) || {}).id;
}

// Open tabs until the window numbers at least `want` of them, and hand back
// the product's own numbering.
async function padTo(ctx: any, want: number): Promise<any[]> {
  for (let guard = 0; guard < 40; guard++) {
    if ((await ctx.numberedTabs()).length >= want) break;
    await ctx.probeEval(
      `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/target2`)}, active: false }).then(t => t.id)`
    );
  }
  return waitFor(async () => {
    const ts = await ctx.numberedTabs();
    return ts.length >= want ? ts : null;
  }, 20000);
}

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/multidigit";
  // Tags: `--tags newfeatures` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["newfeatures","tabs"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  await t(";1 in a small window jumps with no popup", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const tabs = await ctx.numberedTabs();
    assert(tabs.length <= 9, "the window numbers at most nine tabs to start with, got " + tabs.length);
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "1");
    const landed = await waitFor(async () => ((await activeId(ctx)) === tabs[0].id ? tabs[0].id : null), 10000)
      .catch(() => null);
    assert(landed, ";1 activated tab 1");
    // Nothing was shown. Absence has no signal to wait on, so this is a
    // bounded observation window rather than a settle guess.
    await new Promise((r) => setTimeout(r, 500));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), ";1 opened no popup in a small window");
  });

  await t("an ambiguous ;1 lists the candidates instead of guessing", async () => {
    await padTo(ctx, 12);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await activeId(ctx);

    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "1");
    const st = await ctx.waitListEvent(ctx.tabA, { count: { ge: 2 } }, 8000).catch(() => null);
    assert(st, "the chooser listed its candidates");

    // 1, 10, 11 and 12 in a twelve-tab window — and the exact match first, so
    // Enter on a freshly opened chooser takes the tab the user typed first.
    assert(st!.count === 4, "the chooser listed 1/10/11/12, got " + st!.count);
    assert(st!.idx === 0, "the exact match (tab 1) is highlighted, idx=" + st!.idx);
    assert(st!.q === "", "the chooser has no search text, q=" + JSON.stringify(st!.q));

    // The digit that could have meant four different tabs did not move.
    assert((await activeId(ctx)) === before, "an ambiguous digit must not move the tab");
  });

  await t(";1 then 1 goes to tab 11 and closes the chooser", async () => {
    // Self-contained on purpose: a test that inherits the previous test's open
    // popup is testing two things at once, and a failure in either reads as a
    // failure in both.
    const tabs = await padTo(ctx, 12);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "1");
    await ctx.waitListEvent(ctx.tabA, { count: { ge: 2 } }, 8000).catch(() => null);
    // ctx.press, NOT ctx.sendKeys: the latter drives the key through the
    // chrome window and the probe tab, which blurs the page — and the content
    // script (correctly) closes a popup when its window blurs. press() picks
    // the right path from ownership, which is the whole point of having it.
    await ctx.press(ctx.tabA, "1");
    const landed = await waitFor(async () => ((await activeId(ctx)) === tabs[10].id ? tabs[10].id : null), 10000)
      .catch(() => null);
    assert(landed, ";1 then 1 activated tab 11");
    await new Promise((r) => setTimeout(r, 300));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), "the chooser closed after the jump");
  });

  await t("Escape backs out of the chooser without moving", async () => {
    // `;1` only opens a chooser when a tab in the 10-19 range exists to be
    // ambiguous with. Without one it is a plain jump to tab 1, there is no
    // chooser to back out of, and the test measured whatever the previous
    // tests happened to leave in the window. Declare the shape: past ten
    // tabs, `;1` is a prefix.
    await ctx.ensureTabCount(11);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await activeId(ctx);
    await ctx.leaderPress(ctx.tabA, "1");
    await ctx.waitListEvent(ctx.tabA, { count: { ge: 2 } }, 8000).catch(() => null);
    await ctx.press(ctx.tabA, "Escape");
    await new Promise((r) => setTimeout(r, 300));
    assert((await activeId(ctx)) === before, "Escape from the chooser leaves the tab alone");
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), "Escape closed the chooser");
  });

  await t(";9 in a twelve-tab window is still a plain jump", async () => {
    // Only a digit whose two-digit range overlaps a real tab is ambiguous:
    // nothing in the twenties starts with 9, so `;9` must not open a list.
    // The ambiguity is per digit, not global — and a keymap that made it
    // global would be the most surprising possible behaviour.
    //
    // The twelve-tab window is DECLARED, not inherited. The old assertion
    // ("the window still numbers at least nine tabs") documented the
    // order-dependence instead of removing it.
    await ctx.ensureTabCount(12);
    const tabs = await ctx.numberedTabs();
    assert(tabs.length >= 9, "the window numbers at least nine tabs, saw " + tabs.length);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "9");
    const landed = await waitFor(async () => ((await activeId(ctx)) === tabs[8].id ? tabs[8].id : null), 10000)
      .catch(() => null);
    assert(landed, ";9 activated tab 9");
    await new Promise((r) => setTimeout(r, 500));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), ";9 opened no chooser");
  });

  await t("a jump leaves no prefix behind for the next one", async () => {
    // The prefix is per-press state, and a stale one is the classic bug this
    // feature invites: after an ambiguous `;1` is resolved by typing another
    // digit, the NEXT `;1` must behave exactly like the first one did. If the
    // chooser or the accumulated digits survived the jump, the second press
    // would silently address a different tab — and the user would have no way
    // to tell a browser from a broken keymap.
    const tabs = await padTo(ctx, 12);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.watchList(ctx.tabA);
    // First: the ambiguous chooser, resolved with a second digit.
    await ctx.leaderPress(ctx.tabA, "1");
    await ctx.waitListEvent(ctx.tabA, { count: { ge: 2 } }, 8000).catch(() => null);
    await ctx.press(ctx.tabA, "1");
    await waitFor(async () => ((await activeId(ctx)) === tabs[10].id ? tabs[10].id : null), 10000)
      .catch(() => null);
    assert((await activeId(ctx)) === tabs[10].id, ";1 then 1 reached tab 11");
    // Second: the same prefix again, from the new tab, with nothing carried
    // over. It must open the chooser again rather than jumping straight to
    // whatever the leftover digits happened to spell.
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "1");
    const again = await ctx.waitListEvent(ctx.tabA, { count: { ge: 2 } }, 8000).catch(() => null);
    assert(again, "the second ;1 opened the chooser again instead of jumping");
    assert(again!.q === "", "the second chooser starts from an empty query, q=" + JSON.stringify(again!.q));
    await ctx.press(ctx.tabA, "Escape");
    await new Promise((r) => setTimeout(r, 300));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), "Escape closed the second chooser");
  });
}
