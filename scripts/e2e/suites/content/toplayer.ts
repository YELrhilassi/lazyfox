// THE OVERLAYS VERSUS THE PAGE'S OWN LAYOUT.
//
// Every Lazyfox overlay is a host element appended to <html> and positioned with
// `position:fixed`, because a viewport-anchored corner panel and a centred popup
// are what those surfaces are. That is a fact about the PAGE's style, not about
// CSS: a transform (or a filter, or `will-change`) on an element makes it the
// containing block for every fixed descendant, and the ROOT ELEMENT is no
// exception. One `translateZ(0)` on <html> — a drawer, a scroll-lock, a page
// transition, a smooth-scroll library, a plain GPU hint — and every overlay is
// measured against the DOCUMENT box instead of the viewport:
//
//   * the hint labels are placed at getBoundingClientRect() coordinates, which
//     are VIEWPORT coordinates, and land a scroll-height away from the links
//     they name (or off-screen entirely) — "hints stopped working";
//   * the which-key panel's `right:24px;bottom:30px` resolves against the
//     document, i.e. below the fold on any page taller than the screen, so
//     pressing the leader key appears to do nothing;
//   * the popup's full-viewport backdrop sheet is sized to the DOCUMENT
//     (measured: 418x936 on an 805px-tall viewport) and its card is centred on
//     the middle of the page, so it covers the page, swallows every click and
//     routes every keystroke into a panel nobody can see. That is the report
//     "everything stopped working — hints, the popups, the leader, even typing —
//     and only reloading the page brought it back".
//
// The fix is the TOP LAYER (see src/shared/toplayer.ts), and these tests are why
// it may not regress: they run on /transformed, a fixture whose root carries the
// transform, and they assert on what the user would see rather than on whether
// anything was drawn at all.
//
// Each one fails on the pre-fix build, which is the only thing that makes a
// regression test worth its runtime.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same name in
  // different files of one group cannot collide.
  const FILE = "content/toplayer";
  const TAGS: string[] = ["newfeatures", "layout"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {}
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  const pageState = () =>
    evalIn(
      ctx.tabA,
      `JSON.stringify({
        popup: document.documentElement.getAttribute("data-lf-popup-title"),
        onScreen: document.documentElement.getAttribute("data-lf-popup-onscreen"),
        leader: document.documentElement.getAttribute("data-lf-leader"),
        hints: document.documentElement.getAttribute("data-lf-hints"),
        scrollY: Math.round(window.scrollY),
        vh: window.innerHeight
      })`
    ).catch((e) => "unreadable: " + String((e && e.message) || e));

  // Every question about a MIRROR is asked as a BOOLEAN IN THE PAGE.
  //
  // `evalIn` maps BiDi's null to `undefined`, so a comparison written here as
  // "=== null" can never be true and the wait it guards times out with the
  // product sitting in the right state all along — which is exactly how these
  // two tests first read as product failures.
  const popupOnScreen = () =>
    evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-popup-onscreen") === "1"`);

  const popupOpen = () =>
    evalIn(ctx.tabA, `!!document.documentElement.getAttribute("data-lf-popup-title")`);

  const popupGone = () =>
    evalIn(ctx.tabA, `!document.documentElement.getAttribute("data-lf-popup-title")`);

  // "IS A POPUP OPEN" AND "WHICH POPUP" ARE TWO DIFFERENT QUESTIONS, and the
  // second one cannot be asked of every popup.
  //
  // `data-lf-popup-title` is the mirror of the panel's TITLE, so it is absent
  // for a popup that has no title element — the find popup is built as
  // `<style>…</style><div class='lf-panel'><div class='lf-frow'>…`, with no
  // `.lf-title` anywhere. Waiting on it there timed out with the popup open and
  // on screen (`onScreen:"1"`, `popup:null`), which read as "the popup never
  // opened" and hid the thing the test is about. The HOST is the honest answer
  // to "is a popup up": it exists exactly while one owns the keyboard.
  const popupHost = () =>
    evalIn(ctx.tabA, `!!document.getElementById("lazyfox-popup")`);

  const leaderArmed = async () =>
    (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader")`)) === "1";

  // Open the fixture SCROLLED, deliberately: at the top of the page the document
  // box and the viewport box share an origin, so a mis-placed overlay lands
  // where it belongs by coincidence and the bug hides. Scroll is what turns the
  // two coordinate systems into different answers.
  //
  // `toBottom` scrolls as far as the page goes, and the popup case needs that:
  // a sheet measured against the document puts its centred card at the MIDDLE OF
  // THE DOCUMENT, which on a short page scrolled a little is still inside the
  // viewport — the assertion would then pass on the broken build too, which is
  // the one thing a regression test may not do.
  const openFixture = async (scrollY = 0) => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/transformed`);
    await evalIn(ctx.tabA, `window.scrollTo(0, ${scrollY}); true`);
    const landed = await waitFor(async () => {
      const y = await evalIn(ctx.tabA, `window.scrollY`);
      return Math.abs(Number(y) - scrollY) <= 5 ? true : null;
    }, 5000).catch(() => null);
    assert(landed, "the fixture would not scroll to " + scrollY + " (page=" + (await pageState()) + ")");
  };

  await t("a page that transforms <html> cannot move the hint labels off their links", async () => {
    await openFixture(300);
    await ctx.leaderPress(ctx.tabA, "f");
    // The snapshot's `boxes` are the LABEL boxes as the browser currently paints
    // them, read from outside the closed shadow root by the content script
    // itself — i.e. exactly "where would the user see this badge".
    const snap = await waitFor(async () => {
      const s = await ctx.hintSnapshot(ctx.tabA).catch(() => null);
      return s && (s.boxes || []).length ? s : null;
    }, 8000).catch(() => null);
    assert(
      snap && (snap.boxes || []).length,
      "no hint labels were drawn on the transformed page (page=" + (await pageState()) + ")"
    );
    const boxes = snap.boxes || [];
    const positions = snap.positions || [];
    // THE ASSERTION IS SELF-CONTAINED, AND THAT IS THE POINT.
    //
    // One snapshot reports BOTH halves for the same key: where the element is
    // (viewport coordinates, from getBoundingClientRect) and where the badge was
    // actually painted. On a page that transforms the root those two disagree by
    // exactly the scroll offset — the badge is drawn a scroll-height away from
    // the link it names — and on a healthy page they agree, because a badge is
    // placed on its element's top-left corner. Reading only one half (or reading
    // the page's own rects separately) would leave the test able to pass while
    // the user sees nothing on the links.
    const off: unknown[] = [];
    for (const b of boxes) {
      const p = positions.find((q: any) => q.key === b.key) as any;
      if (!p) off.push({ label: b, why: "no position row for this key" });
      else if (Math.abs(p.x - b.l) > 30 || Math.abs(p.y - b.t) > 30) {
        off.push({ key: b.key, element: { x: p.x, y: p.y }, label: { l: b.l, t: b.t } });
      }
    }
    assert(
      off.length === 0,
      off.length +
        " of " +
        boxes.length +
        " hint labels are not on the elements they name: " +
        JSON.stringify(off[0]) +
        " (page=" +
        (await pageState()) +
        ")"
    );
    const els = await evalIn(
      ctx.tabA,
      `document.querySelectorAll("[data-id]").length`
    );
    assert(els >= 3, "the fixture lost its elements: " + els);
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("a popup opened on a page that transforms <html> is on screen, and moves nothing", async () => {
    // NO SCROLL, deliberately, and this is the case that discriminates.
    //
    // A popup's card is centred in whatever box its sheet is measured against,
    // and FOCUS IS ENOUGH TO REVEAL THE DIFFERENCE: focusing a control inside a
    // document-anchored sheet scrolls the page to it, so the broken build does
    // not leave a wedged popup behind — it jumps the user's page to the middle
    // of the document and draws the panel there. What the user loses is their
    // place on the page, which is the assertion below: opening a popup must
    // move nothing.
    //
    // The precondition is checked rather than assumed, because a fixture
    // trimmed back to a screenful would quietly turn this test into one that
    // passes on both builds (a document of height H has its centre at H/2, and
    // the reachable scroll positions are 0..H-V, so the centre is off-screen —
    // and therefore worth jumping to — only while H > 2V).
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/transformed`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    const tall = await evalIn(
      ctx.tabA,
      `document.documentElement.scrollHeight > 2 * window.innerHeight`
    );
    assert(
      tall === true,
      "the fixture is not taller than twice the viewport, so a document-anchored popup would still be on screen and this test could not fail"
    );
    await ctx.leaderPress(ctx.tabA, "d");
    const open = await waitFor(async () => ((await popupOpen()) ? true : null), 8000).catch(
      () => null
    );
    assert(open, "the downloads popup never opened (page=" + (await pageState()) + ")");
    // The panel is in a CLOSED shadow root, so "is it on screen" cannot be read
    // from the page — the host publishes its own answer, from the same
    // measurement the product uses to decide whether it may hold the keyboard.
    const on = await waitFor(async () => ((await popupOnScreen()) ? true : null), 5000).catch(
      () => null
    );
    assert(
      on,
      "the popup that owns the keyboard is not on screen (page=" + (await pageState()) + ")"
    );
    const moved = await evalIn(ctx.tabA, `Math.round(window.scrollY)`);
    assert(
      Math.abs(Number(moved)) <= 2,
      "opening a popup moved the page: scrollY went from 0 to " + moved + " (page=" + (await pageState()) + ")"
    );
    // ...and it is still a popup: Escape hands the keyboard back.
    await ctx.press(ctx.tabA, "Escape");
    const closed = await waitFor(async () => ((await popupGone()) ? true : null), 5000).catch(
      () => null
    );
    assert(closed, "Escape did not close the popup (page=" + (await pageState()) + ")");
  });

  await t("a popup that ships its own stylesheet is measured by its panel, not its <style>", async () => {
    // The find and resize popups build their markup as
    // `<style>…</style><div class='lf-panel'>…`, so their FIRST element child is
    // a stylesheet — display:none, zero-sized, and, measured naively, "not on
    // screen". The watchdog then closed a popup that was plainly in front of the
    // user: `;/` and `;W w` opened and vanished about a second later, which is
    // the kind of self-inflicted wound a test has to be able to catch.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    const open = await waitFor(async () => ((await popupHost()) ? true : null), 8000).catch(
      () => null
    );
    assert(open, "the find popup never opened (page=" + (await pageState()) + ")");
    // Past the watchdog's own two-strike window, so a popup that mis-measures
    // itself has had every chance to close itself.
    await new Promise((r) => setTimeout(r, 2500));
    assert(await popupHost(), "the find popup closed itself (page=" + (await pageState()) + ")");
    assert(
      await popupOnScreen(),
      "the find popup reports itself off screen (page=" + (await pageState()) + ")"
    );
    await ctx.press(ctx.tabA, "Escape");
    const closed = await waitFor(async () => ((await popupHost()) ? null : true), 5000).catch(
      () => null
    );
    assert(closed, "Escape did not close the find popup (page=" + (await pageState()) + ")");
  });

  await t("a popup whose panel the page removes stands down without eating a key", async () => {
    // The other way a popup loses the keyboard: not mis-placed, but GONE. A page
    // that re-renders the root (a hydration swap, `documentElement.replaceChildren()`)
    // takes the node away without ever calling close(), and the popup flag then
    // says "a popup owns the keys" while nothing is drawn.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "d");
    await waitFor(async () => ((await popupOpen()) ? true : null), 8000).catch(() => null);
    const removed = await evalIn(
      ctx.tabA,
      `(function(){ var h = document.getElementById("lazyfox-popup"); if (!h) return false; h.remove(); return true; })()`
    );
    assert(removed === true, "the fixture never had a popup host to remove");
    // THE PRODUCT'S OWN RECOVERY, not the harness's: the popup re-asks on a
    // timer, so the keyboard comes back without the user spending a keystroke
    // discovering the problem. Before this existed, the only cure was the first
    // key after the break — which was swallowed — or a reload.
    const cleared = await waitFor(async () => ((await popupGone()) ? true : null), 6000).catch(
      () => null
    );
    assert(
      cleared,
      "the popup did not stand down after the page removed its host (page=" + (await pageState()) + ")"
    );
    // And the very next key is answered by the leader, which is the point: the
    // user's next keystroke goes where they meant it to.
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(async () => ((await leaderArmed()) ? true : null), 4000).catch(
      () => null
    );
    assert(armed, "the leader key was dead after the popup stood down (page=" + (await pageState()) + ")");
    await ctx.press(ctx.tabA, "Escape");
  });
}
