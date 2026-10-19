// Getting OUT of a field, and getting INTO the hard ones.
//
// Every test here exists because of one of four reports:
//
//   * Escape is the wrong key to use when all the user wants is to stop typing:
//     a site that binds it (this fixture's dialog, with a form in it) closes its
//     own UI, and the second cancel chord did nothing at all while the caret was
//     in a field;
//   * the hint focus route reported SUCCESS as failure on a field inside a
//     closed shadow root, because document.activeElement is the host there;
//   * `;i` chose the FIRST input in document order, which on a real app is a
//     tiny utility field rather than the composer the user is looking at;
//   * a large video was not hinted at all, so the only clickable surface of a
//     player could not be reached by key;
//   * a hint batch that answered nothing kept the keyboard, so the leader key
//     appeared DEAD until the layer was dismissed by the right letter.
//
// The assertions read the PRODUCT: hint geometry for "which control has which
// key", the content script's own report for "was that activation judged a
// success", and page-side counters for "did the page actually receive what it
// received".
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  const FILE = "content/field";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const settled = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.readyState`, "complete", ms);
  const hintsOn = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`, "1", ms);
  const hintsFlag = async () =>
    await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);

  // Positions come from the content script (the only thing that knows them);
  // the elements come from the page. Matching one to the other is how every
  // assertion below names a CONTROL instead of a key it happened to be given.
  const hintMap = async (): Promise<Array<{ key: string; id: string }>> => {
    const snap = await ctx.hintSnapshot(ctx.tabA);
    const pos = (snap && snap.positions) || [];
    const els = await evalIn(
      ctx.tabA,
      `(function () {
         const out = [];
         function collect(root) {
           root.querySelectorAll("[data-id], [data-id-owner]").forEach((e) => out.push(e));
           root.querySelectorAll("*").forEach((e) => {
             if (e.shadowRoot) collect(e.shadowRoot);
             else if (typeof e.innerBounds === "function") out.push(e);
           });
         }
         collect(document);
         return out.map((el) => {
           const b = typeof el.innerBounds === "function" ? el.innerBounds() : el.getBoundingClientRect();
           return {
             id: el.getAttribute("data-id") || el.getAttribute("data-id-owner") || el.id,
             x: Math.round(b.left),
             y: Math.round(b.top)
           };
         });
       })()`
    );
    return pos.map((p: any) => {
      const el = (els || []).find(
        (c: any) => Math.abs(c.x - p.x) <= 2 && Math.abs(c.y - p.y) <= 2
      );
      return { key: p.key, id: el ? el.id : "" };
    });
  };

  // Activate a hinted control by the id it belongs to — never by assuming a key
  // (a single character can be a prefix of a longer key, in which case it
  // narrows and Enter commits the first match).
  const activate = async (id: string) => {
    const m = await hintMap();
    const h = m.find((x) => x.id === id);
    assert(
      h,
      "no hint for " + id + " (hinted: " + m.map((x) => x.id || "?").join(",") + ")"
    );
    for (const ch of h!.key) await ctx.press(ctx.tabA, ch);
    if ((await hintsFlag()) === "1") await ctx.press(ctx.tabA, "Enter");
    return h!;
  };

  // The content script's own report for the tab showing `fragment` — the same
  // data the diagnostics page reads, so "was this activation judged a failure"
  // is answered by the product rather than by the test's expectations.
  const reportFor = async (fragment: string) => {
    const raw = await evalIn(
      ctx.probe,
      `(async function () {
         var tabs = await browser.tabs.query({});
         for (const t of tabs) {
           try {
             var res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
             var r = res && res.report;
             if (r && r.url && r.url.indexOf(${JSON.stringify(fragment)}) !== -1) {
               return { act: r.hints.lastActivation, url: r.url };
             }
           } catch (e) { /* no content script in that tab */ }
         }
         return null;
       })()`
    );
    return raw || null;
  };

  // The page-side facts the field fixtures record.
  const fieldState = async () =>
    JSON.parse(
      String(
        await evalIn(
          ctx.tabA,
          `JSON.stringify({
             active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
             escapes: window.__escapes,
             dialogUp: window.__dialogUp
           })`
        )
      )
    );

  const focusField = async () => {
    await evalIn(ctx.tabA, `document.getElementById("field").focus(); true`);
    await ctx.waitExpr(
      ctx.tabA,
      `document.activeElement && document.activeElement.id`,
      "field",
      5000
    );
  };

  await t(
    "Ctrl+G leaves a field without telling the page to close its dialog",
    async () => {
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/field`);
      await settled();
      await focusField();
      await ctx.press(ctx.tabA, "g", { ctrl: true });
      const st = await fieldState();
      assert(
        st.active !== "field",
        "the cancel chord must take the caret OUT of the field — that is what it is for (active: " +
          st.active +
          ")"
      );
      assert(
        st.escapes === 0,
        "the page must NOT receive an Escape: its dialog would close (saw " +
          st.escapes +
          " escapes)"
      );
      assert(
        st.dialogUp === true,
        "the site's dialog — with its form — must still be there after leaving the field"
      );
      // ...and the keyboard came back with the caret: the leader arms immediately.
      await ctx.press(ctx.tabA, ";");
      await ctx.waitExpr(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-leader")`,
        "1",
        5000
      );
      await ctx.press(ctx.tabA, "Escape");
      await ctx.waitLeaderGone();
    }
  );

  await t(
    "Escape is the master cancel: the page still sees it and the caret leaves the field",
    async () => {
      // ESCAPE DOES EVERYTHING, AND STILL LETS THE PAGE ACT.
      //
      // It is the key every site, every popup and every muscle memory already
      // expects, so it also does the whole of what the cancel chord does:
      // overlays cleared, caret out of the field. It is deliberately NOT
      // consumed, which is the one difference from Ctrl+G — a page that binds
      // Escape (this fixture's dialog, a cookie wall, a player) still gets it,
      // and that is the trade the user asked for: Ctrl+G is the key to reach for
      // when the page's own UI must survive.
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/field`);
      await settled();
      await focusField();
      await ctx.press(ctx.tabA, "Escape");
      const st = await fieldState();
      assert(st.escapes === 1, "Escape must reach the page (saw " + st.escapes + ")");
      assert(st.dialogUp === false, "the page's own Escape action must run");
      assert(
        st.active !== "field",
        "Escape must ALSO leave the field — it is the master cancel (active: " +
          st.active +
          ")"
      );
    }
  );

  await t(
    "a hint on a field inside a closed shadow root focuses it and reports success",
    async () => {
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/field`);
      await settled();
      await ctx.leaderPress(ctx.tabA, "f");
      await hintsOn();
      await activate("shadow-in");
      await ctx.waitExpr(
        ctx.tabA,
        `document.getElementById("closedfield").innerFocusId()`,
        "shadow-in",
        5000
      );
      const host = await evalIn(
        ctx.tabA,
        `document.activeElement && document.activeElement.id`
      );
      assert(
        host === "closedfield",
        "document.activeElement reports the shadow HOST for a closed root (got " +
          host +
          ")"
      );
      const rep = await reportFor("/field");
      assert(rep && rep.act, "the page report must carry the activation");
      assert(
        rep.act.ignored === false,
        "a focus that landed must not be reported as a failure: " + JSON.stringify(rep.act)
      );
      assert(
        /took focus/i.test(rep.act.signal || ""),
        "the report must record that focus landed (got " +
          JSON.stringify(rep.act.signal) +
          ")"
      );
    }
  );

  await t(";i focuses the composer, not the first small field", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/field`);
    await settled();
    await ctx.leaderPress(ctx.tabA, "i");
    await ctx.waitExpr(
      ctx.tabA,
      `document.activeElement && document.activeElement.id`,
      "composer",
      5000
    );
    // The caret is in the composer, not just the focus: the next keystroke types
    // where the user was.
    assert(
      (await evalIn(
        ctx.tabA,
        `(document.activeElement.id === "composer")`
      )) === true,
      ";i must aim at the field the user is looking at (the largest one)"
    );
  });

  await t("a large video surface is hinted, and its key reaches the player", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await settled();
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    await activate("surface");
    const clicks = await waitFor(
      async () => {
        const n = await evalIn(ctx.tabA, `window.__videoClicks || 0`);
        return n > 0 ? n : null;
      },
      5000
    ).catch(() => null);
    assert(
      clicks,
      "the video surface must be hinted and its key must reach the player's own click handling"
    );
  });

  await t(
    "a busy page still attempts the privileged press for a trust-gated control",
    async () => {
      // The player shape: the page never goes quiet, so "the page updated itself"
      // said nothing about the control. The old trigger was total silence, which
      // meant the privileged retry never ran here — the exact page it was
      // written for. The stub listener stands in for the window actor: it
      // records that the content script ASKED for a privileged press.
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/busy`);
      await settled();
      const first = await evalIn(ctx.tabA, `document.getElementById("ticker").textContent`);
      await waitFor(async () => {
        const now = await evalIn(ctx.tabA, `document.getElementById("ticker").textContent`);
        return now !== first ? true : null;
      }, 3000);
      await ctx.leaderPress(ctx.tabA, "f");
      await hintsOn();
      await activate("gated");
      // The report is the honest observable here: BiDi runs WITHOUT the chrome
      // layer, so `trustedRetry: false` means the trigger DID fire and no
      // privileged path was available. Absent would mean the trigger never
      // fired — which is the bug this test exists for.
      const rep = await waitFor(async () => {
        const r = await reportFor("/busy");
        return r && r.act ? r : null;
      }, 6000).catch(() => null);
      assert(rep && rep.act, "the page report must carry the activation");
      assert(
        rep.act.trustedRetry === false,
        "a silent target on a busy page must still trigger the privileged retry: " +
          JSON.stringify(rep.act)
      );
      assert(
        rep.act.ignored === false,
        "the page's own activity must still count as a response: " +
          JSON.stringify(rep.act)
      );
    }
  );

  await t(
    "a control that reacts is not re-pressed through the privileged path",
    async () => {
      // The other direction of the same rule, and the reason the trigger is the
      // TARGET's state rather than the page's: a control that visibly reacted
      // must never be clicked a second time. `#pressy` flips its own
      // aria-pressed on click, so the verdict is its own change — and the report
      // must carry no `trustedRetry` at all (absent = no escalation warranted).
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/press`);
      await settled();
      await ctx.leaderPress(ctx.tabA, "f");
      await hintsOn();
      await activate("pressy");
      await ctx.waitExpr(
        ctx.tabA,
        `document.getElementById("pressy").getAttribute("aria-pressed")`,
        "true",
        5000
      );
      const rep = await reportFor("/press");
      assert(rep && rep.act, "the activation must be reported");
      assert(
        rep.act.ignored === false,
        "the working activation must be recorded as a success: " + JSON.stringify(rep.act)
      );
      assert(
        !("trustedRetry" in rep.act),
        "a control whose own state changed must not get the privileged retry: " +
          JSON.stringify(rep.act)
      );
    }
  );

  await t("the leader key is never blocked by a hint layer", async () => {
    // The third report, and the worst of the three because it is a LOCKOUT: the
    // hint layer claimed the keyboard, so the leader key and every scroll key
    // were dead until the user dismissed the layer they could not see. The rule
    // is explicit in onKeyDown now — the leader key tears the layer down and
    // arms, in ONE keystroke — and this pins it against the fall-through
    // coincidence ("the hint alphabet happens not to contain `;`") it used to
    // depend on.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await settled();
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    await ctx.press(ctx.tabA, ";");
    await ctx.waitExpr(
      ctx.tabA,
      `document.documentElement.getAttribute("data-lf-leader")`,
      "1",
      5000
    );
    assert(
      (await hintsFlag()) !== "1",
      "a hint layer must stand down when the leader takes the keyboard back"
    );
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitLeaderGone();
  });

  await t("Escape dismisses a hint layer and the keys come back", async () => {
    // The same lockout through its other exit. Escape is the key a user presses
    // when a layer is on screen, and it must both clear the layer and leave the
    // keyboard usable immediately — not require a second press of the key the
    // layer was eating.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await settled();
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => ((await hintsFlag()) !== "1" ? true : null), 5000).catch(
      () => null
    );
    assert((await hintsFlag()) !== "1", "Escape must dismiss the hint layer");
    // The very next keystroke is the leader's — no dead first key.
    await ctx.press(ctx.tabA, ";");
    await ctx.waitExpr(
      ctx.tabA,
      `document.documentElement.getAttribute("data-lf-leader")`,
      "1",
      5000
    );
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitLeaderGone();
  });

  await t("a chain of overlays leaves the next sentence typed into a field intact", async () => {
    // THE REPORT: "in text input I have to type some keys multiple times to make
    // them print", noticed after a run of overlays — a popup, then hint sessions
    // opened and cancelled in a row.
    //
    // A missed character is the hardest failure this product can have, because
    // nothing records it: the keydown reaches the page, the keypress is prevented
    // somewhere upstream, and the caret simply does not move. The user's only
    // evidence is the text on screen, and their only workaround is pressing the
    // key again — which is exactly what was reported. So the assertion has to be
    // the user's evidence: the field's value is EXACTLY the sentence typed,
    // every character once, in order. And the chain has to run BEFORE the typing
    // rather than beside it, because the whole claim is that a previous overlay
    // left something behind.
    const sentence = "dusk judge 4; g/G 'f' skip";
    const hintsGone = async () =>
      waitFor(async () => ((await hintsFlag()) !== "1" ? true : null), 5000).catch(() => null);
    const chain = async () => {
      // 1. A popup with an input of its own, dismissed with Esc.
      await ctx.leaderPress(ctx.tabA, "d");
      await ctx.waitPopup(ctx.tabA, 8000);
      await ctx.press(ctx.tabA, "Escape");
      await ctx.waitPopupGone(ctx.tabA, 8000);
      // 2. Hints opened and cancelled with Esc — once after the layer is up, and
      //    once with the Esc landing while the batch is still being built
      //    (`hints.starting`), which is the window the report is about and the
      //    one that used to leave a layer nothing could dismiss.
      await ctx.leaderPress(ctx.tabA, "f");
      await hintsOn();
      await ctx.press(ctx.tabA, "Escape");
      await hintsGone();
      await ctx.leaderPress(ctx.tabA, "f");
      await ctx.press(ctx.tabA, "Escape");
      await hintsGone();
    };
    const typeSentence = async (): Promise<string> => {
      // Focus the field the way a user does, then type. Esc above blurs a field,
      // so the caret is placed again before every attempt — the test is about the
      // keys that arrive, not about focus surviving an overlay.
      await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
      await focusField();
      await evalIn(ctx.tabA, `document.getElementById("field").value = ""; true`);
      await ctx.typeIn(ctx.tabA, sentence);
      return String(await evalIn(ctx.tabA, `document.getElementById("field").value`));
    };

    await ctx.gotoPage(ctx.tabA, `${ctx.base}/field`);
    await settled();

    for (let attempt = 1; attempt <= 2; attempt++) {
      await chain();
      const got = await typeSentence();
      assert(
        got === sentence,
        `after an overlay chain the field must hold exactly what was typed ` +
          `(attempt ${attempt}; typed ${JSON.stringify(sentence)}, got ${JSON.stringify(got)})`
      );
    }

    await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
  });
}
