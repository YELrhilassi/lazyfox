// find tests (content). Deterministic: every step waits on the product signal
// (data-lf-find count, data-lf-cur, scroll position, popup hosts) instead of
// fixed sleeps.
import { evalIn } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/find";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[]; keepTabs?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  // --- small composable helpers local to this feature file ---
  const openFind = async (page: string, query: string) => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/${page}`);
    await ctx.leaderPress(ctx.tabA, "/");
    await ctx.waitPopup(ctx.tabA, 8000);
    await ctx.typeIn(ctx.tabA, query);
  };
  // The widget mirrors its state on <html data-lf-find="cur/count">. Wait
  // until the finder has counted and settled to exactly this string.
  const waitCount = (want: string, ms = 8000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`, want, ms);
  // data-lf-cur mirrors the current match's source text (visual-order walk).
  const waitCur = (want: string, ms = 8000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-cur")`, want, ms);
  const closeFind = async () => {
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 8000);
  };

  await t("find restores the previous scroll position on close and Ctrl+o walks back", async () => {
    // The first match of a fresh search is often at the very top of the page,
    // so jumping yanks the user away from where they were reading. Esc must
    // bring them back, and Ctrl+o must walk back one jump at a time.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 900); true`);
    await ctx.waitExpr(ctx.tabA, `window.scrollY`, 900);
    await ctx.leaderPress(ctx.tabA, "/");
    await ctx.waitPopup(ctx.tabA, 8000);
    await ctx.typeIn(ctx.tabA, "Lazyfox");
    await ctx.press(ctx.tabA, "Enter"); // h1 sits at the top: page scrolls there
    await ctx.waitExpr(ctx.tabA, `window.scrollY < 100`, true);
    const atTop = await evalIn(ctx.tabA, `window.scrollY`);
    assert(atTop < 100, "find scrolled to the top match, got " + atTop);
    // Ctrl+o returns to the position the jump left from.
    await ctx.press(ctx.tabA, "o", { ctrl: true });
    await ctx.waitExpr(ctx.tabA, `Math.abs(window.scrollY - 900) < 40`, true);
    // Jump again, then Esc: the popup closes and the original position returns.
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitExpr(ctx.tabA, `window.scrollY < 100`, true);
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 8000);
    await ctx.waitExpr(ctx.tabA, `Math.abs(window.scrollY - 900) < 40`, true);
    const after = await evalIn(ctx.tabA, `window.scrollY`);
    assert(Math.abs(after - 900) < 40, "Esc restored the original position, got " + after);
  });

  await t("find counts matches live, walks with Enter, and selects the match", async () => {
    // The mini widget shows a live N/M count (data-lf-find: cur/count; 0 =
    // query typed but nothing walked to). Enter jumps to the next match
    // (starting at the viewport, not the top of the page) and selects it.
    await openFind("", "Lazyfox");
    await waitCount("0/1");
    // While typing, the first match is already highlighted live.
    const liveHl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(liveHl, "first match highlighted while typing");
    await ctx.press(ctx.tabA, "Enter");
    await waitCount("1/1");
    // The match is highlighted with our own overlay (window.getSelection
    // cannot cross shadow boundaries, so the old native highlight failed on
    // Reddit-style pages).
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "walked match highlighted by the find overlay");
    await closeFind();
  });

  await t("find pierces open shadow roots (Reddit-style custom elements)", async () => {
    // window.find cannot see text inside shadow DOM — the old widget found
    // "nothing" on Reddit-style pages. The finder walks open shadow roots, so
    // text living only inside <lf-shadow-editable>'s shadow tree must count.
    await openFind("", "shadow editable");
    await waitCount("0/1");
    await ctx.press(ctx.tabA, "Enter");
    await waitCount("1/1");
    await closeFind();
  });

  await t("find matches text split across element boundaries", async () => {
    // Framework pages split words across nodes ("forked " + <b>river</b>);
    // the old per-text-node indexOf never saw a match spanning two nodes.
    // The flat search text glues them, so "forked river" counts and walks.
    await openFind("", "forked river");
    await waitCount("0/1");
    await ctx.press(ctx.tabA, "Enter");
    await waitCount("1/1");
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "cross-node match highlighted");
    await closeFind();
  });

  await t("find cleans the query: whitespace runs and nbsp match like one space", async () => {
    // The page renders "double&nbsp;&nbsp;space here" (two nbsp). The query
    // is cleaned (trim + collapse + nbsp -> space) the same way the page text
    // is, so sloppy typing still hits.
    await openFind("", " double  space "); // leading/trailing + double space
    await waitCount("0/1");
    await ctx.press(ctx.tabA, "Enter");
    await waitCount("1/1");
    await closeFind();
  });

  await t("find sees text nested 40+ levels deep (Google-style framework pages)", async () => {
    // Google's AI Overview nests content dozens of divs deep; the old walker
    // dropped anything past a fixed recursion depth, so words like "blood"
    // were silently invisible to search. The walk is now iterative (no depth
    // cap), so deeply nested text must count, walk, and highlight.
    await openFind("deep", "blood");
    await waitCount("0/1");
    await ctx.press(ctx.tabA, "Enter");
    await waitCount("1/1");
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "deeply nested match highlighted");
    await closeFind();
  });

  await t("find walks in visual reading order, not DOM order (Google-style CSS reordering)", async () => {
    // Google reorders SERP blocks with CSS (URL, breadcrumb, snippet), so the
    // flat-text/DOM order zigzags visually and Enter bounces up and down. The
    // hit list is sorted by each match's on-screen position, so the walk must
    // follow reading order: ALPHA (top-left), BETA (top-right), DELTA
    // (bottom-left), ZETA (bottom-right) — not the DOM order ZETA, ALPHA,
    // BETA, DELTA. data-lf-cur mirrors the current match's source text.
    await openFind("reorder", "MATCH");
    await waitCount("0/4");
    const want = ["MATCH ALPHA", "MATCH BETA", "MATCH DELTA", "MATCH ZETA"];
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await ctx.press(ctx.tabA, "Enter");
      await waitCur(want[i]);
      seen.push(await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-cur")`));
    }
    assert(
      seen.join("|") === "MATCH ALPHA|MATCH BETA|MATCH DELTA|MATCH ZETA",
      "walk follows visual reading order, got " + seen.join("|")
    );
    await closeFind();
  });

  await t("yank selection follows the component tree: chrome is not selectable, deep content is", async () => {
    // A multi-line visual selection must only ever contain real content — not
    // the nav chips, buttons, header/footer, or aria-hidden chrome that sits
    // between two cursor positions. The yank model builds from the page's
    // content tree (chrome excluded) and reaches text nested far past the old
    // recursion limit. The dev probe mirrors the flat yank text onto <html>.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/deep`);
    await evalIn(ctx.tabA, `document.documentElement.setAttribute("data-lf-yank-probe", "1"); true`);
    await ctx.leaderPress(ctx.tabA, "/");
    await ctx.waitPopup(ctx.tabA, 8000);
    await ctx.typeIn(ctx.tabA, "blood");
    await waitCount("0/1");
    await ctx.press(ctx.tabA, "Enter"); // walk -> command mode
    await waitCount("1/1");
    await ctx.press(ctx.tabA, "Y"); // enter yank mode (cursor at the match)
    await ctx.waitExpr(ctx.tabA, `(document.documentElement.getAttribute("data-lf-yank-text")||"").indexOf("blood") !== -1`, true);
    const txt = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-yank-text")`);
    assert(txt != null, "yank probe wrote the flat yank text");
    assert(txt.indexOf("main content here") !== -1, "content paragraph included in the yank model");
    assert(txt.indexOf("NAV_CHROME") === -1, "nav chrome excluded from the yank model");
    assert(txt.indexOf("BTN_CHROME") === -1, "button chrome excluded from the yank model");
    assert(txt.indexOf("HEADER_CHROME") === -1, "header chrome excluded from the yank model");
    assert(txt.indexOf("FOOTER_CHROME") === -1, "footer chrome excluded from the yank model");
    await ctx.press(ctx.tabA, "Escape"); // back to find command mode
    await ctx.press(ctx.tabA, "Escape"); // close the widget
    await ctx.waitPopupGone(ctx.tabA, 8000);
  });

  await t("find yanks the current match with a neovim-style flash", async () => {
    // In command mode (after walking), y copies the selected match and shows
    // the amber yank flash over the copied text.
    await openFind("", "Lazyfox");
    await waitCount("0/1");
    await ctx.press(ctx.tabA, "Enter");
    await waitCount("1/1");
    await ctx.press(ctx.tabA, "y");
    await ctx.waitHost(ctx.tabA, "lazyfox-flash", 4000);
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "match highlight stays after yank");
    await closeFind();
  });

  await t("yank mode: visual selection shows exactly what will be yanked; yy and y+motion+y copy with flash", async () => {
    // Y opens the yank mode: the page text is parsed by the Go core, the block
    // caret tracks the cursor (seeded at the current match). The widget lives
    // in a closed shadow root, so it mirrors its state onto <html data-lf-yank>
    // like data-lf-find: idle:<L>:<C> or sel:<N chars>:<preview>. We wait on
    // that attribute as the single source of truth instead of sleeping.
    await openFind("", "Lazyfox");
    await waitCount("0/1");
    await ctx.press(ctx.tabA, "Enter"); // walk to the match -> command mode
    await waitCount("1/1");
    await ctx.press(ctx.tabA, "Y"); // enter yank mode (cursor at the match)
    await ctx.waitHost(ctx.tabA, "lazyfox-caret", 4000);
    const caret = await ctx.hasHost(ctx.tabA, "lazyfox-caret");
    assert(caret, "block caret shown in yank mode");
    // yy yanks the whole line the cursor sits on (the h1) with the flash.
    await ctx.press(ctx.tabA, "y");
    await ctx.press(ctx.tabA, "y");
    await ctx.waitHost(ctx.tabA, "lazyfox-flash", 4000);
    // y then e starts a selection anchored at the cursor (the whole word).
    await ctx.press(ctx.tabA, "y");
    await ctx.press(ctx.tabA, "e");
    await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute('data-lf-yank')`, "sel:7 chars:Lazyfox");
    // y copies the highlighted range with the flash and leaves selection mode.
    await ctx.press(ctx.tabA, "y");
    await ctx.waitHost(ctx.tabA, "lazyfox-flash", 4000);
    // Esc exits yank mode back to find command mode; Esc again closes.
    await ctx.press(ctx.tabA, "Escape");
    const stillOpen = await ctx.hasHost(ctx.tabA, "lazyfox-popup");
    assert(stillOpen, "Esc exits yank mode but keeps the find widget open");
    await closeFind();
  });
}
