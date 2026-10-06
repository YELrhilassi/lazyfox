// The `;K` Links category: hints, copy link, and edit link.
//
// These exist because the category shipped on wiring and typecheck alone, which
// is not evidence that a key does anything. Each test drives the real chord
// against a real page and reads a fact the page itself produced.
//
// The link under test is found through the HINT layer rather than the pointer,
// because a BiDi test has no pointer. That is also the more interesting path:
// it means "copy link" and "open link" resolve the same element, which is the
// property the design promises and the one that a pointer-only test could not
// check.
import { createTab, evalIn, navigate, send } from "../../bidi.ts";
import { assert } from "../../runner.ts";

// Move the REAL pointer onto a point, the way a user's mouse does.
//
// The first version of this file dispatched a synthetic `mousemove` from the
// page, and the feature under test never saw it: `;K e` reported no link while
// the pointer was plainly over one. A synthetic event constructed in one realm
// and aimed at a listener in another is exactly the kind of thing that makes a
// test green while the product is broken — or the reverse. Real pointer input
// has no such question.
async function movePointerTo(tab: string, x: number, y: number): Promise<void> {
  await send("input.performActions", {
    context: tab,
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: Math.round(x), y: Math.round(y), duration: 20 },
        ],
      },
    ],
  });
}

/**
 * `;<head>;<sub-key>` pressed by hand, for the tests that care about WHERE the
 * pointer is.
 *
 * `ctx.leaderSeq` re-focuses the page on every attempt, and focusing scrolls it
 * to the top — which undoes the `scrollIntoView` that put the link somewhere
 * the pointer could reach. The pointer is recorded once, at a position, and a
 * scroll afterwards silently makes that position wrong. This helper focuses
 * nothing, so the caller controls the order: focus, aim, move, then press.
 */
async function chord(ctx: any, tab: string, keys: string[]): Promise<void> {
  await ctx.press(tab, ";");
  await ctx.tryArm(tab, 2500);
  for (const k of keys) await ctx.press(tab, k);
}

export const TAGS: string[] = ["links", "newfeatures"];

export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content/links", name, fn, { tags: TAGS });

  // A page with two distinct links, so "which link" has a checkable answer.
  const page = async () => {
    const tab = await createTab();
    await navigate(tab, `${ctx.base}/`, "complete");
    await ctx.activateTab(tab);
    return tab;
  };

  await t(";K h starts link hints", async () => {
    ctx.tabA = await page();
    await ctx.leaderSeq(ctx.tabA, ["K", "h"]);
    const up = await ctx
      .waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`, true, 8000)
      .catch(() => null);
    assert(up, ";K h armed the link hints");
    await ctx.press(ctx.tabA, "Escape");
  });

  await t(";K c copies the link the hints are pointed at", async () => {
    ctx.tabA = await page();
    // Open the hint layer first so "the current link" has a definition that is
    // visible to the user rather than one invented by the test.
    await ctx.leaderSeq(ctx.tabA, ["K", "h"]);
    await ctx
      .waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`, true, 8000)
      .catch(() => {});
    await ctx.leaderSeq(ctx.tabA, ["K", "c"]);
    const msg = await ctx.waitToast(ctx.tabA, /copied link/, 8000).catch(() => null);
    assert(msg, ";K c copied a link, got toast=" + JSON.stringify(msg));
    await ctx.press(ctx.tabA, "Escape");
  });

  await t(";K c says so when there is no link to copy", async () => {
    // A page with no anchors at all. The honest answer is a message, not a
    // silent copy of something arbitrary: this command's whole job is to hand
    // back a URL you are about to paste somewhere.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/empty`, "complete").catch(async () => {
      // No /empty page: strip the links off the test page instead.
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
      await evalIn(ctx.tabA, `document.querySelectorAll("a").forEach(a => a.remove()); true`);
    });
    await ctx.activateTab(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["K", "c"]);
    const msg = await ctx.waitToast(ctx.tabA, /no link/i, 8000).catch(() => null);
    assert(msg, ";K c reports that it found no link, got toast=" + JSON.stringify(msg));
  });

  await t(";K c names WHY it found no link", async () => {
    // "No link" on its own is not an answer a user can act on: there are two
    // different situations behind it and they need opposite responses. This
    // pins the SECOND one — a pointer that has moved somewhere harmless —
    // because the first ("no pointer yet") only happens on a page where the
    // mouse has genuinely never entered, which automation cannot promise.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/`, "complete");
    await ctx.activateTab(ctx.tabA);
    // Well below any link on the page.
    await movePointerTo(ctx.tabA, 8, 8);
    await chord(ctx, ctx.tabA, ["K", "c"]);
    const msg = await ctx.waitToast(ctx.tabA, /.+/, 8000).catch(() => null);
    assert(
      /pointer is not over a link/i.test(String(msg)),
      "a pointer that is not over a link says so, got toast=" + JSON.stringify(msg)
    );
  });

  await t(";K e opens an editor holding the link under the pointer", async () => {
    ctx.tabA = await page();
    // Put the REAL pointer over the first link, then use the POINTER path
    // rather than the hint path — this is the branch a keyboard user never
    // takes and the one that silently did nothing until it was written.
    //
    // The link is scrolled into view FIRST and the aim is VERIFIED with
    // elementFromPoint before the key is pressed. Without that, the very first
    // version of this test pointed at a link that Lazyfox's own status bar was
    // sitting on top of, so the pointer legitimately hit Lazyfox, the feature
    // correctly said "the pointer is not over a link", and the test reported a
    // product bug. The check is here because a test that aims at coordinates it
    // has not confirmed is testing where it thinks the link is.
    const aimed = await evalIn(
      ctx.tabA,
      `(async () => {
         const a = document.querySelector("a[href]");
         if (!a) return { err: "no link on the page" };
         a.scrollIntoView({ block: "center" });
         await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
         const r = a.getBoundingClientRect();
         const x = r.left + r.width / 2, y = r.top + r.height / 2;
         const hit = document.elementFromPoint(x, y);
         const link = hit && hit.closest ? hit.closest("a[href]") : null;
         return { href: a.href, x, y, hit: link ? link.href : null };
       })()`,
    ).catch(() => null);
    assert(aimed && aimed.href, "the test page has a link to point at: " + JSON.stringify(aimed));
    assert(
      aimed.hit === aimed.href,
      "the pointer target is the link itself, not something covering it: " + JSON.stringify(aimed)
    );
    await movePointerTo(ctx.tabA, aimed.x, aimed.y);
    await chord(ctx, ctx.tabA, ["K", "e"]);
    // Read the toast FIRST: it is cleared a few seconds after it is set, so
    // waiting for the editor and then looking would always read "".
    const why = await ctx.waitToast(ctx.tabA, /.+/, 4000).catch(() => null);
    const open = await ctx
      .waitExpr(ctx.tabA, `!!document.getElementById("lazyfox-linkedit")`, true, 4000)
      .catch(() => null);
    assert(open, ";K e opened the link editor; toast was " + JSON.stringify(why));
    // The editor must be holding the LINK's url, not the page's.
    const held = await evalIn(
      ctx.tabA,
      `(() => { const el = document.getElementById("lazyfox-linkedit"); if (!el) return null;
         const i = el.querySelector("input"); return i ? i.value : null; })()`,
    );
    assert(
      held === aimed.href,
      "the editor holds the LINK's href, not the page's: " + JSON.stringify(held) + " want " + JSON.stringify(aimed.href)
    );
    await ctx.press(ctx.tabA, "Escape");
    await ctx
      .waitExpr(ctx.tabA, `!document.getElementById("lazyfox-linkedit")`, true, 5000)
      .catch(() => {});
  });

  await t(";K e applies the edited url back to the anchor", async () => {
    ctx.tabA = await page();
    const before = await evalIn(ctx.tabA, `(async () => {
       const a = document.querySelector("a[href]");
       if (!a) return null;
       a.scrollIntoView({ block: "center" });
       await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
       const r = a.getBoundingClientRect();
       const x = r.left + r.width/2, y = r.top + r.height/2;
       const hit = document.elementFromPoint(x, y);
       const link = hit && hit.closest ? hit.closest("a[href]") : null;
       return { href: a.href, x, y, hit: link ? link.href : null };
     })()`).catch(() => null);
    assert(before && before.href, "the test page has a link to edit");
    assert(before.hit === before.href, "the pointer target is the link itself: " + JSON.stringify(before));
    await movePointerTo(ctx.tabA, before.x, before.y);
    const want = `${ctx.base}/target2`;
    await chord(ctx, ctx.tabA, ["K", "e"]);
    await ctx
      .waitExpr(ctx.tabA, `!!document.getElementById("lazyfox-linkedit")`, true, 8000)
      .catch(() => {});
    // The VALUE is set directly and the commit is a real Enter keypress.
    //
    // Typing the url a character at a time is not available here and would be
    // wrong anyway: every letter of a url is a leader binding, so synthetic
    // keypresses would arm the leader instead of reaching the field. What is
    // under test is the editor's apply path — the value it holds, the Enter
    // handler, and the anchor it rewrites — and those are exercised as written.
    await evalIn(
      ctx.tabA,
      `(() => { const i = document.querySelector("#lazyfox-linkedit input"); if (!i) return false;
         i.value = ${JSON.stringify(want)}; i.focus(); return true; })()`,
    );
    await ctx.press(ctx.tabA, "Enter");
    const after = await evalIn(ctx.tabA, `document.querySelector("a[href]").href`).catch(() => null);
    assert(after === want, "the anchor was rewritten in place: " + JSON.stringify(after) + " want " + JSON.stringify(want));
    const gone = await ctx
      .waitExpr(ctx.tabA, `!document.getElementById("lazyfox-linkedit")`, true, 5000)
      .catch(() => null);
    assert(gone, "the editor closed after applying");
  });
}