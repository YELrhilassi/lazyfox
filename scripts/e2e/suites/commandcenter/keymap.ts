// keymap tests (commandcenter). The KEYBOARD CONTRACT itself, in a real
// browser: case is a difference, modifiers are part of the chord, a chord the
// keymap does not know is REPORTED, and the searchable reference indexes the
// leaf keys of a category.
//
// These are the properties the key system is judged on, and they are exactly
// the ones a unit test cannot settle: a synthetic event is whatever the test
// author wrote down, while a real keystroke is what Firefox decides `e.key`,
// `shiftKey` and the rest are. The three regressions that prompted this
// suite — case folded away, modifiers ignored, a mistyped chord swallowed in
// silence — all looked correct in code review and could only be *seen* here.
//
// Run on the command-center page on purpose: it is the page whose own leader
// answers `;` (chrome defers on an extension page), so it exercises the
// page-side dispatch path with real BiDi input, end to end — keymap fetched
// from the wasm core included.
import { evalIn } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "commandcenter/keymap";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const popupOpen = (ms = 8000) => ctx.waitPopup(ctx.tabA, ms);
  const popupClosed = (ms = 8000) => ctx.waitPopupGone(ctx.tabA, ms);
  const titleIs = (want: string, ms = 8000) => ctx.waitPopupTitle(ctx.tabA, want, ms);
  const noPopup = async (what: string) => {
    const title = await ctx.popupTitle(ctx.tabA);
    assert(title === null || title === undefined, `${what} opened a popup (${JSON.stringify(title)})`);
  };
  const closePopup = async () => {
    await ctx.press(ctx.tabA, "Escape");
    await popupClosed();
  };

  await t(";P opens Sessions; ;p is a different chord and is reported", async () => {
    // The reported bug: `;p` and `;P` did the same thing, because the matcher
    // folded Shift into the character and then matched on a table that had one
    // entry for both. A capital is a different chord now — and the lowercase
    // letter is not silently swallowed either, which is what made a wrong key
    // feel like a key that had to be pressed twice.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["P"], { shift: true });
    await popupOpen();
    await titleIs("Sessions");
    await closePopup();
    // Lowercase p: the leader accepts the key (it owns the keyboard while
    // armed) and says what it got, instead of doing nothing at all.
    await ctx.leaderPress(ctx.tabA, "p");
    await ctx.waitToast(ctx.tabA, /no binding for ;p\b/, 8000);
    await noPopup(";p");
    // The leader must not have stayed armed through the miss: the next key
    // belongs to the page again. (An armed leader eats the first keystroke of
    // whatever the user types next, which is its own flavour of "press it
    // twice".)
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("a category head is a capital: ;w is not ;W", async () => {
    // `;W` is Window & layout and `;w` is nothing. Registering a category must
    // not make its lowercase letter a second way in — the old matcher's
    // case-folding "did what you probably meant", which is how two keys ended
    // up sharing one action.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "w");
    await ctx.waitToast(ctx.tabA, /no binding for ;w\b/, 8000);
    await noPopup(";w");
    // The real head still works, and it is a MENU rather than a popup: it arms,
    // nothing opens, and the next key is a sub-key of that menu. `9` is not a
    // Window key, so the menu says which chord it got instead of passing it on
    // to the page — the same "never swallow in silence" rule, one level down.
    await ctx.leaderSeq(ctx.tabA, ["W"], { shift: true });
    await noPopup(";W");
    await ctx.press(ctx.tabA, "9");
    await ctx.waitToast(ctx.tabA, /no binding for ;9\b/, 8000);
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitLeaderGone();
  });

  await t("a modifier is part of the chord, not decoration", async () => {
    // `;Ctrl+Alt+r` is not `;r`. The proof that `;r` did NOT run is that the
    // page was not reloaded: the marker survives. A chord the keymap does not
    // know is named in a toast and consumed — it never falls through to the
    // page as a stray character either.
    await ctx.openCC(ctx.tabA);
    await evalIn(ctx.tabA, `window.__kmapMark = "alive"; true`);
    await ctx.leaderPress(ctx.tabA, "r", { ctrl: true, alt: true });
    await ctx.waitToast(ctx.tabA, /no binding for ;ctrl\+alt\+r\b/, 8000);
    const mark = await evalIn(ctx.tabA, `window.__kmapMark || ""`).catch(() => "");
    assert(mark === "alive", "the plain ;r binding ran on a Ctrl+Alt chord (the page reloaded)");
    // And the plain chord is still there: `;r` DOES reload, which is what makes
    // the line above a statement about the modifier rather than about `;r`
    // being broken.
    await ctx.leaderPress(ctx.tabA, "r");
    await ctx
      .waitExpr(ctx.tabA, `window.__kmapMark === undefined`, true, 15000)
      .catch(() => {
        throw new Error(";r did not reload the page (the marker survived a plain reload chord)");
      });
    await ctx.openCC(ctx.tabA);
  });

  await t(";? indexes the leaf keys inside a category", async () => {
    // The which-key overlay shows `;W` as ONE row — that is its job. The
    // searchable reference has the opposite job: it is the flat index of
    // everything pressable, so a word that only exists on a leaf ("unsplit",
    // "zoom reset") must find it. It did not, which made the reference lie by
    // omission about everything a category holds.
    await ctx.openCC(ctx.tabA);
    await ctx.watchList(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["?"], { shift: true });
    await popupOpen();
    await titleIs("Keybindings");
    await ctx.typeIn(ctx.tabA, "unsplit");
    await ctx.waitListEvent(ctx.tabA, { q: "unsplit", count: { ge: 1 } }, 15000).catch(() => {
      throw new Error("searching \"unsplit\" in ;? found nothing — the leaf keys are not indexed");
    });
    await closePopup();
  });

  await t("Enter on a leaf row runs the leaf's action, not its head's", async () => {
    // The row prints a chord (`;W w`) and runs an ACTION ID. Conflating the two
    // — handing the printed chord to a table keyed by id — closes the popup and
    // runs nothing at all, which is the most expensive kind of broken: it looks
    // like a bug in the popup rather than in the lookup. "Resize window" exists
    // ONLY as a leaf now, so a popup opening here proves the whole path.
    await ctx.openCC(ctx.tabA);
    await ctx.watchList(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["?"], { shift: true });
    await popupOpen();
    await titleIs("Keybindings");
    await ctx.typeIn(ctx.tabA, "resize");
    await ctx.waitListEvent(ctx.tabA, { q: "resize", count: { ge: 1 } }, 15000).catch(() => {
      throw new Error("the leaf row for \"resize\" is not in the reference");
    });
    await ctx.press(ctx.tabA, "Enter");
    await popupOpen();
    await titleIs("Resize window");
    await closePopup();
  });
}
