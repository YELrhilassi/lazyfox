// hintpick tests (commandcenter). Split verbatim from the original
// commandcenter.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "commandcenter/hintpick";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });
  await t("leader ;f arms home-grid hint-pick (letters run tiles)", async () => {
    // ;f is link-hints on web pages; on the home grid it arms hint-PICK: each
    // tile shows a letter badge and the next key runs that tile (the home
    // equivalent of link hints), so a tile can be opened with ;f + a letter
    // instead of arrow keys + Enter.
    await ctx.openCC(ctx.tabA);
    const f0 = await ctx.ccFacts(ctx.tabA);
    assert(!f0.focused, "starts blurred (command mode)");
    await ctx.leaderPress(ctx.tabA, "f");
    const badges = await waitFor(async () => {
      const n = await evalIn(ctx.tabA, `document.querySelectorAll("#results.quick .result .hintkey").length`);
      return n > 0 ? n : null;
      // 15s, the standard for a chrome-window -> background -> content ->
      // page-DOM round trip in this suite. The Esc-clear wait below already
      // says so in a comment; this badge wait was the same relay left at 8s,
      // so under load the one that failed first was the one with the least
      // headroom, and its message named hint-pick rather than the clock.
    }, 15000);
    assert(badges > 0, "home-grid tiles show ;f hint badges");
    // Hint-pick is a one-key pick: the input stays blurred; a letter would run
    // that tile. Esc leaves it with nothing selected, back to command mode.
    const f1 = await ctx.ccFacts(ctx.tabA);
    assert(!f1.focused, ";f hint-pick does not focus the input");
    await ctx.press(ctx.tabA, "Escape");
    const gone = await waitFor(async () => {
      const n = await evalIn(ctx.tabA, `document.querySelectorAll(".hintkey").length`);
      return n === 0 ? true : null;
      // Generous bound, like the other cross-process waits in this suite: the
      // key has to travel chrome window -> background relay -> content script
      // -> page DOM before the badges clear. The comparable status-bar relay
      // waits allow 15s, so 5s here was the outlier rather than the standard.
    }, 15000);
    assert(gone, "Esc exits hint-pick");
    const f2 = await ctx.ccFacts(ctx.tabA);
    assert(f2.state === "cmd", "back to command mode after Esc, got " + f2.state);
  });
  await t("leader ;f hint-pick: a letter runs the tile (never types into the input)", async () => {
    // Regression: on a REAL new tab the page opens in command mode (input
    // blurred). If the input ever holds focus, ;f INSERTS the leader combo and
    // the hint letter types — hint-pick appears dead. This presses an actual
    // hint letter and asserts it is consumed as a pick, not inserted as text.
    await ctx.openCC(ctx.tabA);
    const f0 = await ctx.ccFacts(ctx.tabA);
    assert(!f0.focused, "home opens in command mode (input blurred)");
    await ctx.leaderPress(ctx.tabA, "f");
    await waitFor(async () => {
      const n = await evalIn(ctx.tabA, `document.querySelectorAll("#results.quick .result .hintkey").length`);
      return n > 0 ? n : null;
    }, 15000);
    // The chrome helper arms a one-shot capture for the pick: the next key is
    // intercepted at the window level and forwarded into the page, so a hint
    // letter works even when Firefox's (hidden) URL bar holds focus on a fresh
    // new tab. leaderPending must be true while hint-pick is armed.
    const s = await ctx.chromeState();
    assert(s && s.leaderPending, "chrome armed the hint-pick key capture (leaderPending)");
    // `k` is the hint letter for index 10 — the "History" tile with the default
    // 6 quick-launch apps (6 apps + 6 browser-access commands). Pressing it
    // sets the History mode IN PLACE (no navigation), which makes the pick
    // unambiguous: the key is INTERPRETED as a pick, so it must both clear the
    // badges (hint consumed), switch to history mode, and never land in the
    // input as text.
    await ctx.press(ctx.tabA, "k");
    const gone = await waitFor(async () => {
      const n = await evalIn(ctx.tabA, `document.querySelectorAll(".hintkey").length`);
      return n === 0 ? true : null;
      // Generous bound, like the other cross-process waits in this suite: the
      // key has to travel chrome window -> background relay -> content script
      // -> page DOM before the badges clear. The comparable status-bar relay
      // waits allow 15s, so 5s here was the outlier rather than the standard.
    }, 15000);
    assert(gone, "hint letter consumed the pick (badges cleared)");
    const f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "history", "hint letter switched to history mode, got " + f.modeTag);
    assert(f.inputVal === "", "hint letter did not type into the input, got " + JSON.stringify(f.inputVal));
    assert(!f.focused, "hint-pick left the input blurred after picking");
    await ctx.openCC(ctx.tabA);
  });
}
