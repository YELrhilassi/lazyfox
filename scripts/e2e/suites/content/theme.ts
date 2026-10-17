// Theme suite: dark mode and reader mode, asserted on what the page actually
// RENDERS in a real Firefox.
//
// The plan for this slice named the missing e2e suite as its largest gap, and the
// reason is structural rather than tidiness: everything decidable without a DOM is
// already unit-tested (`dark/color.ts`, `dark/theme.ts`, `dark-rules.ts`,
// `reader/extract.ts` — 116 cases), and BOTH features are otherwise "paint": a
// stylesheet the page's own computed colours go through, and an overlay that has to
// become the thing the scroll keys move. Neither can be proven by a unit test, and
// a claim about them that is only ever stated in a doc is a claim nobody has
// checked. Writing this file is what turned two of those claims into a check —
// `j`/`k` did not move the article at all (the scroller was inside a CLOSED shadow
// root, invisible to the region scan), and the host was never promoted to the top
// layer even though READER.md said it was.
//
// Everything is asserted through the product's own mirrors on <html>
// (`data-lf-dark*`, `data-lf-scheme`, `data-lf-reader*`), which exist precisely so
// that a shadow-root-internal state is legible from outside — plus the one thing a
// mirror cannot fake, `getComputedStyle` on the page's own elements.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  const FILE = "content/theme";
  const TAGS: string[] = ["theme", "newfeatures"];
  const t = (name: string, fn: () => Promise<void>, opts: { tags?: string[] } = {}) =>
    ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  // --- the mirrors -------------------------------------------------------

  // A MISSING ATTRIBUTE IS `null`, and it has to be spelled that way: the wire
  // serialises a JS `null` as nothing at all, so a raw
  // `getAttribute(...)` read comes back as `undefined` and an assertion written
  // against `null` is an assertion that can never pass. Reading through
  // `String(...)` makes the "absent" case one comparable value.
  const attr = async (name: string): Promise<string | null> => {
    const v = await evalIn(
      ctx.tabA,
      `String(document.documentElement.getAttribute(${JSON.stringify(name)}))`
    ).catch(() => "null");
    const s = v === undefined || v === null ? "null" : String(v);
    return s === "null" ? null : s;
  };

  // Wait for an attribute to be ABSENT — the shape an overlay's teardown has, and
  // one `waitExpr(expr, "")` cannot express (it would compare against the empty
  // string and burn its whole timeout on a mirror that is correctly gone).
  const waitAttrGone = (name: string, ms = 6000) =>
    ctx.waitExpr(ctx.tabA, `!document.documentElement.hasAttribute(${JSON.stringify(name)})`, true, ms)
      .catch(() => null);

  // Wait for a mirror to hold a VALUE, not for a sleep to elapse. `want` omitted
  // matches any truthy value, which is what a mirror that may be "" needs.
  const waitAttr = (name: string, want?: string, ms = 10000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute(${JSON.stringify(name)})`, want, ms)
      .catch(() => null);

  const host = (): Promise<string> => evalIn(ctx.tabA, `location.hostname`).catch(() => "");

  // The per-site rules the product STORED. Read through the extension realm (the
  // probe tab), not from the page: storage is the record, and the point of these
  // assertions is that a key wrote one.
  const siteRules = async (): Promise<any[]> => {
    if (!ctx.probe) await ctx.bootstrap();
    const raw = await evalIn(
      ctx.probe,
      `browser.storage.local.get("config").then(r => JSON.stringify(((r.config || {}).dark || {}).sites || []))`
    ).catch(() => null);
    return raw ? JSON.parse(raw as string) : [];
  };

  // Wait for the rule for `match` to satisfy `ok`. The write crosses content →
  // background → storage, so "press and read" would race it.
  const waitRule = async (match: string, ok: (rule: any) => boolean, ms = 8000): Promise<any> => {
    return waitFor(async () => {
      const rules = await siteRules();
      const rule = rules.find((r) => r && r.match === match);
      return rule && ok(rule) ? rule : null;
    }, ms).catch(() => null);
  };

  // The colour the page's own body RENDERS. This is the assertion that the engine
  // did something to the page rather than merely recording an intention: the sheet
  // it injects sets `html,body{background-color:… !important}`.
  const bodyBg = (): Promise<string> =>
    evalIn(ctx.tabA, `getComputedStyle(document.body).backgroundColor`).catch(() => "");

  // --- dark mode ---------------------------------------------------------

  await t("a light page is darkened on load, and the page's colours go through the configured theme", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    const on = await waitAttr("data-lf-dark", "on");
    assert(
      on !== null,
      `the mirror says the page is dark: got ${JSON.stringify(await attr("data-lf-dark"))} (${await attr(
        "data-lf-dark-reason"
      )})`
    );
    assert((await attr("data-lf-scheme")) === "dark", "the scheme marker follows the decision");
    const sheet = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-dark")`);
    assert(sheet, "the engine installed its stylesheet");
    // The engine is a per-page MEASUREMENT (`chooseEngine`: dynamic for a page whose
    // colours are mostly one canvas, filter for a page it cannot read). Both are
    // correct answers; what would be wrong is the mirror naming neither, because the
    // rule corpus and the escape-hatch key are both keyed on it.
    const engine = await attr("data-lf-dark-engine");
    assert(
      engine === "dynamic" || engine === "filter",
      "the engine mirror names an engine, got " + JSON.stringify(engine)
    );
    // #16161e, the shipped `dark.background`.
    const bg = await bodyBg();
    assert(bg === "rgb(22, 22, 30)", "the page renders the configured background colour, got " + bg);
    console.log(`       (cold dark decision: engine=${engine}, reason=${await attr("data-lf-dark-reason")})`);
  });

  await t("a page that already ships a dark theme is left alone", async () => {
    // THE smart-dark case, and the one a blanket invert gets wrong. No key is
    // pressed: the verdict has to come from the rendered colours, because that is
    // the whole claim.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/dark`);
    const off = await waitAttr("data-lf-dark", "off");
    assert(off !== null, "the mirror says the page is NOT darkened, got " + JSON.stringify(await attr("data-lf-dark")));
    const reason = (await attr("data-lf-dark-reason")) || "";
    assert(/already dark/i.test(reason), "the reason names the verdict, got " + JSON.stringify(reason));
    const sheet = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-dark")`);
    assert(!sheet, "no stylesheet is installed on a page that is already dark");
    const scheme = await attr("data-lf-scheme");
    assert(!scheme, "no scheme marker is written either, got " + JSON.stringify(scheme));
    // And the page's own colour is untouched: #0f1115.
    const bg = await bodyBg();
    assert(bg === "rgb(15, 17, 21)", "the page keeps its own canvas, got " + bg);
  });

  // THE SITE'S OWN DARK THEME, which is a different question from "is it already
  // dark?". `/nativetheme-light` forces itself light with `color-scheme: light`
  // on the root while declaring both schemes in a meta tag, so it renders the
  // same on any machine; the engine must ASK it for dark (one `color-scheme`
  // write) and then stand down, leaving the site's own theme on screen.
  await t("a page that ships its own dark theme is asked for it, not recoloured", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/nativetheme-light`);
    // The fixture is light on arrival, but the engine's ask is allowed to land
    // before this line reads it (it is the thing under test, and it is one write
    // at config time). So the evidence that the ASK flipped the page — rather
    // than our sheet recolouring it — is the colour that comes out: #0f1115 is
    // the fixture's own dark canvas, while the shipped theme's background is
    // #16161e and a remapped white canvas would come out as exactly that.
    const off = await waitAttr("data-lf-dark", "off");
    assert(
      off !== null,
      "the mirror says nothing of ours is painted, got " +
        JSON.stringify(await attr("data-lf-dark")) +
        " (" +
        (await attr("data-lf-dark-reason")) +
        ")"
    );
    const reason = (await attr("data-lf-dark-reason")) || "";
    assert(/dark theme/i.test(reason), "the reason names the site's theme, got " + JSON.stringify(reason));
    const engine = await attr("data-lf-dark-engine");
    assert(engine === "native", "the engine mirror says the theme is the site's, got " + JSON.stringify(engine));
    const sheet = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-dark")`);
    assert(!sheet, "no stylesheet of ours is installed");
    // And the page really IS dark now, in its own colours: #0f1115, not our
    // #16161e. That difference is the whole point — the site's theme, not ours.
    const after = await bodyBg();
    assert(after === "rgb(15, 17, 21)", "the page paints its OWN dark canvas, got " + after);
    const scheme = await evalIn(ctx.tabA, `getComputedStyle(document.documentElement).colorScheme`);
    assert(String(scheme).indexOf("dark") >= 0, "the page was asked for dark, got " + scheme);
  });

  // THE STATE SWITCH. A single-page app throws its view away and renders a new
  // one; for a few frames there is no surface at all, and the new view's colours
  // were never sampled. The report: "it breaks when I switch state and shows
  // blank dark overlay, it doesn't render dark elements properly".
  //
  // Both halves are asserted here: the theme is never given up during the
  // teardown (no filter takeover of a blank document), and the colour that only
  // exists AFTER the switch is themed too.
  await t("a page that switches state keeps its theme, and the new view is themed too", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/spa`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the first view is darkened");
    const firstEngine = await attr("data-lf-dark-engine");
    // Wait for the fixture's own switch, then give the engine its gated pass.
    await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-fixture-switched") === "1"`, true, 8000);
    const lateThemed = await waitFor(async () => {
      const bg = await evalIn(
        ctx.tabA,
        `(() => { const el = document.getElementById("late"); return el ? getComputedStyle(el).backgroundColor : null; })()`
      ).catch(() => null);
      return bg && bg !== "rgb(221, 227, 236)" ? (bg as string) : null;
    }, 8000).catch(() => null);
    assert(
      lateThemed !== null,
      "the view rendered after the state switch was left light (the engine never re-measured)"
    );
    console.log(`       (state switch: first engine=${firstEngine}, #late now ${lateThemed})`);
    // The verdict itself must not have changed underneath the page: no takeover
    // by the filter engine, which is what an empty mid-switch measurement used to
    // produce (a page-wide inversion of a blank document).
    assert(
      (await attr("data-lf-dark")) === "on",
      "the theme survived the switch, got " + JSON.stringify(await attr("data-lf-dark")) + " (" + (await attr("data-lf-dark-reason")) + ")"
    );
    assert(
      (await attr("data-lf-dark-engine")) === firstEngine,
      "the engine did not flip to a different one mid-switch: " + firstEngine + " → " + (await attr("data-lf-dark-engine"))
    );
  });

  await t(";Y d turns the theme off for this site and back on, and writes the per-site rule", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page starts darkened");
    const h = await host();

    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    assert((await waitAttr("data-lf-dark", "off")) !== null, "the key turned it off for this page");
    const off = await bodyBg();
    assert(off === "rgb(255, 255, 255)", "the page's own canvas came back, got " + off);
    const offRule = await waitRule(h, (r) => r.mode === "off");
    assert(offRule !== null, `the off decision was stored for ${h}, rules: ` + JSON.stringify(await siteRules()));

    // The same key again: the entry the first press created is REUSED (an entry
    // with no fields would be dropped, which is the documented reason the two
    // toggles write onto each other's rule).
    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the key turned it back on");
    const onRule = await waitRule(h, (r) => r.mode === "dark");
    assert(onRule !== null, `the on decision replaced it, rules: ` + JSON.stringify(await siteRules()));
    const rules = await siteRules();
    assert(
      rules.filter((r) => r.match === h).length === 1,
      "one rule per host, not one per press: " + JSON.stringify(rules)
    );
  });

  await t(";Y e switches to the filter engine on this site, and the root really carries the inversion", async () => {
    // The escape hatch, and the reason it is a key rather than a setting: the
    // dynamic engine cannot see a colour that reaches the screen through an image
    // or a canvas, and this is what a user does about it. `auto → dynamic → filter`
    // from the shipped default, so two presses land on filter by construction.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page starts darkened");
    const h = await host();

    await ctx.leaderSeq(ctx.tabA, ["Y", "e"]);
    await ctx.leaderSeq(ctx.tabA, ["Y", "e"]);
    assert((await waitAttr("data-lf-dark-engine", "filter")) !== null, "the mirror names the filter engine");
    const filter = await evalIn(ctx.tabA, `getComputedStyle(document.documentElement).filter`).catch(() => "");
    assert(
      typeof filter === "string" && /invert/.test(filter),
      "the root element really renders inverted in filter mode, got " + JSON.stringify(filter)
    );
    const rule = await waitRule(h, (r) => r.engine === "filter");
    assert(rule !== null, `the engine choice was stored for ${h}, rules: ` + JSON.stringify(await siteRules()));
  });

  await t(";Y x clears this site's rules and hands the page back to the global default", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page starts darkened");
    const h = await host();
    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]); // writes a rule for this host
    assert((await waitRule(h, (r) => !!r.mode)) !== null, "a rule exists to be cleared");

    await ctx.leaderSeq(ctx.tabA, ["Y", "x"]);
    // Wait for the stored list to STOP naming the host rather than for a toast:
    // the toast is emitted before the write crosses content → background →
    // storage, so a toast is not evidence that the record changed.
    const cleared = await waitFor(async () => {
      const rules = await siteRules();
      return rules.every((r) => r.match !== h) ? true : null;
    }, 8000).catch(() => null);
    assert(cleared !== null, "the rules for this host are gone, rules: " + JSON.stringify(await siteRules()));
    // Back on the global default, which darkens a light page — so the page is dark
    // again, but now for the other reason.
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the global default took the page back over");
    assert(
      !/already dark/i.test((await attr("data-lf-dark-reason")) || ""),
      "and the reason no longer mentions a stored rule"
    );
  });

  // --- reader mode -------------------------------------------------------

  await t(";R opens the article, and the article is what the scroll keys move", async () => {
    // The integration claim, measured: the overlay must become the target of the
    // SAME scroll controller the page uses, with no reader-specific key handling.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open");
    // THE PAGE STILL HAS THE KEYBOARD. The overlay hides `body`, which takes away
    // the element the caret was in, and a document that loses the focus loses the
    // keyboard with it: every key is then delivered to the browser window, so the
    // article cannot be scrolled, cannot be left with Escape and cannot be driven
    // by the leader — a live article behind a dead keyboard. This is the assertion
    // that caught exactly that, so it is kept as the guard (see render.ts).
    const hasFocus = await evalIn(ctx.tabA, `document.hasFocus()`).catch(() => null);
    assert(hasFocus === true, "the page still has the keyboard while the article is up, got " + hasFocus);

    const blocks = Number(await attr("data-lf-reader-blocks"));
    const words = Number(await attr("data-lf-reader-words"));
    assert(blocks >= 8, "the extractor collected the article's blocks, got " + blocks);
    assert(words >= 200, "and its words, got " + words);
    // The page is hidden, not merely covered: the reader decision documented in
    // reader/render.ts (a body-anchored overlay would hide itself).
    const bodyDisplay = await evalIn(ctx.tabA, `getComputedStyle(document.body).display`);
    assert(bodyDisplay === "none", "body is hidden while the reader is up, got " + bodyDisplay);
    const readerHost = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-reader")`);
    assert(readerHost, "the host is in the document");

    // The article must be taller than the viewport, or "the scroll keys move it"
    // proves nothing: a fixture that fits on one screen passes this test while
    // being unable to fail it.
    const box = await evalIn(
      ctx.tabA,
      `(() => { const h = document.getElementById("lazyfox-reader"); const r = h.getBoundingClientRect(); return JSON.stringify({ top: r.top, left: r.left, w: r.width, hgt: r.height, sh: h.scrollHeight, ch: h.clientHeight, vw: innerWidth, vh: innerHeight }); })()`
    );
    const b = JSON.parse(box);
    assert(b.sh > b.ch + 40, `the article overflows its pane (scrollHeight ${b.sh} vs ${b.ch})`);
    assert(Math.abs(b.vw - b.w) < 3 && Math.abs(b.vh - b.hgt) < 3, `the pane fills the viewport, got ${b.w}x${b.hgt}`);

    await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop = 0; true`);
    await ctx.press(ctx.tabA, "j");
    const jTop = await waitFor(
      async () =>
        (await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`).catch(() => 0)) > 0
          ? await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`)
          : null,
      6000
    ).catch(() => null);
    assert(jTop !== null, "j scrolled the article");
    const docY = await evalIn(ctx.tabA, `window.scrollY`).catch(() => -1);
    assert(docY === 0, "the document itself stayed put, got window.scrollY=" + docY);

    // A page turn is the same controller's other half: `d` moves by a viewport.
    await ctx.press(ctx.tabA, "d");
    const dTop = await waitFor(async () => {
      const top = await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`).catch(() => 0);
      return top > Number(jTop) + 100 ? top : null;
    }, 6000).catch(() => null);
    assert(dTop !== null, `d paged the article further than j left it (${jTop} → ${dTop})`);
    console.log(`       (article: ${blocks} blocks, ${words} words, ${b.sh}px in a ${b.ch}px pane)`);
  });

  await t("Escape leaves the article and gives the page back", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open");

    await ctx.press(ctx.tabA, "Escape");
    const mirrorsGone = await waitAttrGone("data-lf-reader");
    assert(
      mirrorsGone !== null,
      "every reader mirror is gone, got " + JSON.stringify(await attr("data-lf-reader"))
    );
    const hostGone = await waitFor(
      async () => ((await evalIn(ctx.tabA, `!document.getElementById("lazyfox-reader")`)) ? true : null),
      6000
    ).catch(() => null);
    assert(hostGone !== null, "the overlay left the document");
    const bodyDisplay = await evalIn(ctx.tabA, `getComputedStyle(document.body).display`);
    assert(bodyDisplay !== "none", "the page is visible again, body display is " + bodyDisplay);
  });

  await t("reader mode on a page that transforms the root still fills the viewport", async () => {
    // A transform on <html> — an off-canvas drawer, a scroll lock, a page
    // transition — makes the root the containing block for `position:fixed`, so a
    // host that is merely a child of <html> is measured against the DOCUMENT box.
    // Measured on the previous slice's fix for the same class of bug: a host
    // positioned that way sits a scroll offset away, which for a full-viewport
    // article means it is drawn mostly outside the screen. The reader host is
    // promoted to the top layer for this, and this is the test that says so.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await evalIn(ctx.tabA, `document.documentElement.style.transform = "translateZ(0)"; window.scrollTo(0, 900); true`);
    await ctx.waitExpr(ctx.tabA, `window.scrollY`, 900, 6000).catch(() => {});

    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open on the transformed page");
    const box = await evalIn(
      ctx.tabA,
      `(() => { const r = document.getElementById("lazyfox-reader").getBoundingClientRect(); return JSON.stringify({ top: r.top, left: r.left, w: r.width, hgt: r.height, vw: innerWidth, vh: innerHeight, y: scrollY }); })()`
    );
    const b = JSON.parse(box);
    assert(
      Math.abs(b.top) < 3 && Math.abs(b.left) < 3 && Math.abs(b.vw - b.w) < 3 && Math.abs(b.vh - b.hgt) < 3,
      `the article pane is the viewport even with the root transformed and scrolled ${b.y}px: ${JSON.stringify(b)}`
    );
    await ctx.press(ctx.tabA, "j");
    const moved = await waitFor(
      async () =>
        (await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`).catch(() => 0)) > 0
          ? true
          : null,
      6000
    ).catch(() => null);
    assert(moved !== null, "and the scroll keys still move it there");

    await ctx.press(ctx.tabA, "Escape");
    await evalIn(ctx.tabA, `document.documentElement.style.transform = ""; window.scrollTo(0, 0); true`);
  });

  await t("the article is real document text, so find works inside the reader", async () => {
    // The other half of "the keyboard is the integration": extraction renders
    // ordinary elements, not a canvas or an iframe, so the find widget's own
    // walker sees the article's sentences.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open");

    await ctx.leaderSeq(ctx.tabA, ["/"]);
    await ctx.waitPopup(ctx.tabA, 8000);
    await ctx.typeIn(ctx.tabA, "extractor");
    const count = await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`).catch(() => null);
      const m = v && /^(\d+)\/(\d+)$/.exec(v);
      return m && Number(m[2]) >= 1 ? v : null;
    }, 8000).catch(() => null);
    assert(count !== null, "find counted the article's matches, saw " + (await attr("data-lf-find")));
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 8000);
    await ctx.press(ctx.tabA, "Escape");
  });
}
