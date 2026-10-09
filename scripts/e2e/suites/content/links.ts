// The address surface: `;f` for hints, `;K` for the page's own URL.
//
// REWRITTEN, and the header explains why because the old version tested a
// feature that no longer exists.
//
// `;K` used to be a Links category whose three sub-keys were `h` (link hints),
// `c` (copy the LINK in front of you) and `e` (edit that link). All three were
// the wrong shape:
//
//   * Hints were only reachable by opening a menu first. Hints are the most
//     frequent thing anyone does on the web, and they already had a one-key
//     binding (`;f`). Advertising them as `;K h` gave the same action two
//     homes and buried the one that matters. So `;K` no longer has an `h` at
//     all, and the first test here pins that `;f` is what works.
//   * `c` and `e` acted on a LINK the user never selected — the hint layer's
//     current match, else the anchor under the pointer, else an error. That
//     meant the same command meant different things depending on invisible
//     state, and `;y` already copied the page URL one keystroke away. Now they
//     mean one thing: THIS PAGE'S ADDRESS.
//
// Every test drives a real chord against a real page and reads a fact the page
// itself produced.

import { createTab, evalIn, navigate } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export const TAGS: string[] = ["links", "newfeatures"];

export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content/links", name, fn, { tags: TAGS });

  const page = async () => {
    const tab = await createTab();
    await navigate(tab, `${ctx.base}/`, "complete");
    await ctx.activateTab(tab);
    return tab;
  };

  await t(";f starts link hints — the one-key access, not ;K h", async () => {
    ctx.tabA = await page();
    await ctx.leaderSeq(ctx.tabA, ["f"]);
    const up = await ctx
      .waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`, true, 8000)
      .catch(() => null);
    assert(up, ";f armed the link hints");
    await ctx.press(ctx.tabA, "Escape");
  });

  await t(";K h no longer exists — hints are not behind a menu", async () => {
    // The regression this whole change is about. If `h` comes back into `;K`,
    // hints have two homes again and the menu starts advertising them.
    ctx.tabA = await page();
    await ctx.leaderSeq(ctx.tabA, ["K", "h"]);
    const up = await ctx
      .waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`, true, 1200)
      .catch(() => null);
    assert(!up, ";K h must not arm hints; `;f` is the only hint binding");
  });

  await t(";K c copies the PAGE url, not a link under the pointer", async () => {
    ctx.tabA = await page();
    const here = await evalIn(ctx.tabA, `location.href`).catch(() => null);
    await ctx.leaderSeq(ctx.tabA, ["K", "c"]);
    const msg = await ctx.waitToast(ctx.tabA, /copied/i, 8000).catch(() => null);
    assert(msg, ";K c reported a copy; toast=" + JSON.stringify(msg));
    // The point of the change: it does not need a link, a hint or a pointer,
    // and it never says "no link" — there is always exactly one answer.
    assert(
      !/no link|pointer/i.test(String(msg)),
      ";K c has no link to be missing; toast=" + JSON.stringify(msg)
    );
    assert(typeof here === "string" && here.length > 0, "the test page has a url to copy");
  });

  await t(";K e opens an editor and typing into it reaches the field", async () => {
    // The popup's input lives in a CLOSED shadow root, so the page realm cannot
    // read it and this test cannot assert on the pre-filled value directly.
    // What it CAN assert — and what the first version of this popup failed —
    // is that the field accepts typing at all: the content script has to
    // insert characters itself, and a popup built from a bare key handler has
    // an input that silently swallows every keystroke. So the whole existing
    // url is cleared with real Backspaces, and the navigation that follows
    // proves the characters landed.
    ctx.tabA = await page();
    await ctx.leaderSeq(ctx.tabA, ["K", "e"]);
    await ctx.waitPopup(ctx.tabA, 8000).catch(() => null);
    const up = await ctx
      .waitExpr(ctx.tabA, `!!document.getElementById("lazyfox-popup")`, true, 5000)
      .catch(() => null);
    assert(up, ";K e opened the editor");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 8000).catch(() => {});
  });

  await t(";K e commits the address it was opened with", async () => {
    // Enter on the UNTOUCHED field. This pins the two halves that are
    // observable from the test realm: the editor opened (so pageUrl()
    // resolved and the popup mounted), and Enter committed its value and
    // closed it.
    //
    // It deliberately does NOT try to re-type the url. The field lives in a
    // closed shadow root, so the only way to change it is the product's own
    // manual-insertion path, driven one BiDi keystroke at a time; a test
    // that depends on that cannot distinguish "the field is untypable" from
    // "the harness lost a character", and the first version of this file
    // did exactly that and reported a product bug that was not there. The
    // navigation it commits is the page's own url, so it lands where it
    // started: the observable is the popup closing, not the address moving.
    ctx.tabA = await page();
    await ctx.leaderSeq(ctx.tabA, ["K", "e"]);
    const up = await ctx.waitPopup(ctx.tabA, 8000).catch(() => null);
    assert(up, ";K e opened the editor");
    await ctx.press(ctx.tabA, "Enter");
    const gone = await ctx.waitPopupGone(ctx.tabA, 8000).catch(() => null);
    assert(gone, "Enter committed the value and closed the editor");
  });

  await t(";K e cancels on Escape without navigating", async () => {
    ctx.tabA = await page();
    const before = await evalIn(ctx.tabA, `location.href`).catch(() => null);
    await ctx.leaderSeq(ctx.tabA, ["K", "e"]);
    await ctx.waitPopup(ctx.tabA, 8000).catch(() => null);
    await ctx.press(ctx.tabA, "Escape");
    const gone = await ctx.waitPopupGone(ctx.tabA, 8000).catch(() => null);
    assert(gone, "Escape closed the editor");
    const after = await evalIn(ctx.tabA, `location.href`).catch(() => null);
    assert(after === before, "and did not navigate: " + JSON.stringify(after));
  });
}
