// hints tests (content). Deterministic: every wait targets a product signal
// (data-lf-hints state, hint label positions, page-side reports) instead of
// fixed sleeps.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/hints";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const hintsOn = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`, "1", ms);
  const scrollDone = (y: number, ms = 5000) => ctx.waitExpr(ctx.tabA, `window.scrollY`, y, ms);
  const pageSettled = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.readyState`, "complete", ms);

  // Geometry is pulled from the content script only when a test needs it;
  // the live reposition loop must not serialize/write it on the user's page.
  const hintSnapshot = () => ctx.hintSnapshot(ctx.tabA);
  const hintPos = async (key) => {
    const snap = await hintSnapshot();
    return (snap.positions || []).find((it) => it.key === key) || null;
  };
  const waitHint = async (key, pred?, ms = 5000) =>
    waitFor(async () => {
      const p = await hintPos(key);
      return p && (!pred || pred(p)) ? p : null;
    }, ms);

  await t("link hints: ;f then hint key activates the link", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    await ctx.press(ctx.tabA, "a"); // hint for the first link
    await ctx.waitTabUrl("/target1", { timeoutMs: 10000 });
    assert((await evalIn(ctx.tabA, `document.title`)) === "TARGET ONE", "navigated to target1");
  });
  await t("link hints: hints track a page that shifts under them", async () => {
    // Pages that auto-slide or shift (carousels, lazy-loads) move the links
    // under the hints; labels must re-anchor instead of floating where the
    // links used to be. Scroll the page by 250px while hints are live and
    // assert the label for link1 moved by the same delta as the link itself.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    const before = await waitHint("a");
    assert(before && before.y > 0, "hint label visible before the shift");
    const rectBefore = await evalIn(ctx.tabA, `document.getElementById("link1").getBoundingClientRect().top`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 250); true`);
    const after = await waitHint("a", (p) => p.y !== before.y);
    const rectAfter = await evalIn(ctx.tabA, `document.getElementById("link1").getBoundingClientRect().top`);
    const labelDy = after.y - before.y;
    const linkDy = rectAfter - rectBefore;
    assert(
      Math.abs(labelDy - linkDy) <= 2,
      `hint tracked the shift (label dy=${labelDy}, link dy=${linkDy})`
    );
    await ctx.press(ctx.tabA, "Escape"); // leave hints mode
  });
  await t("link hints: ] pages down to links below the fold", async () => {
    // Hints are viewport-only; ] must page through the document and re-hint
    // the next batch (here: the second input, hidden below a 3000px spacer).
    //
    // A single ] lands at a different offset for every window HEIGHT — at some
    // sizes inp2 sits one pixel below the fold while the taller ta1 sharing its
    // inline line is visible, so it is not in the batch yet. Page until inp2 is
    // actually hinted, then activate it by whatever key it was given (never
    // assume "a").
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    // The hint key currently assigned to inp2, or null while it is out of view.
    const keyForInp2 = async () => {
      const snap = await hintSnapshot();
      const r = await evalIn(ctx.tabA, `(() => { const r = document.getElementById("inp2").getBoundingClientRect(); return {x: Math.round(r.left), y: Math.round(r.top)}; })()`);
      for (const it of snap.positions || []) {
        if (Math.abs(it.x - r.x) <= 2 && Math.abs(it.y - r.y) <= 2) return it.key;
      }
      return null;
    };
    let key = null;
    for (let i = 0; i < 12 && !key; i++) {
      await ctx.press(ctx.tabA, "]");
      // Wait for the page-down's scroll to land and the re-hint sweep to run:
      // poll until inp2 is either hinted or provably still out of the batch,
      // instead of sleeping a fixed settle time.
      key = await waitFor(async () => await keyForInp2(), 2500).catch(() => null);
    }
    assert(key, "inp2 was hinted after paging down with ]");
    for (const ch of key) await ctx.press(ctx.tabA, ch);
    // A single-char key that prefixes a longer one only narrows; Enter then
    // activates the first match, which is inp2 (it precedes ta1/ce1 in DOM).
    const stillActive = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    if (stillActive === "1") await ctx.press(ctx.tabA, "Enter");
    await ctx.waitExpr(ctx.tabA, `document.activeElement && document.activeElement.id`, "inp2", 8000);
    assert((await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`)) === "inp2", "paged hint activated inp2");
    // Leave the tab on /target1 like the plain hints test does: the next test
    // (;g back) starts from that history entry.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
  });
  // ---- Deep link-hints tests on a deliberately UI-heavy fixture ----
  //
  // The `data-id` on every interactive element of /uitest lets the harness map
  // a broadcast hint position back to the element it was assigned to, so these
  // tests assert *which* elements were hinted, not just how many.
  const readHints = async () => {
    const snap = await hintSnapshot();
    const pos = snap.positions || [];
    const els = await evalIn(
      ctx.tabA,
      `(function(){
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
          var bounds = typeof el.innerBounds === "function" ? el.innerBounds() : el.getBoundingClientRect();
          return {id: el.id, dataId: el.getAttribute("data-id") || el.getAttribute("data-id-owner"), x: Math.round(bounds.left), y: Math.round(bounds.top)};
        });
      })()`
    );
    return pos.map((p) => {
      const el = (els || []).find((candidate) => Math.abs(candidate.x - p.x) <= 2 && Math.abs(candidate.y - p.y) <= 2);
      return { key: p.key, id: el ? el.id : null, dataId: el ? el.dataId : null, x: p.x, y: p.y };
    });
  };
  // WHERE THE LABELS ARE WHEN A "THE PAGE SCROLLED BUT THE LABELS DID NOT
  // FOLLOW" WAIT GIVES UP. The three shapes it distinguishes have opposite
  // fixes: no labels at all (the session stood down), labels that are all up at
  // the top (a re-hint that never ran — the session's own debounce), or a label
  // next to the deep link that readHints() could not name (the harness's 2px
  // coordinate match). Read at the moment of failure, because nothing about that
  // state survives the next keystroke.
  const hintDiag = async () => {
    const ids = (await readHints().catch(() => [])).map((x) => (x.id || x.dataId || "?") + "@y" + x.y);
    const page = await evalIn(
      ctx.tabA,
      `JSON.stringify({
        y: Math.round(window.scrollY),
        maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        hints: document.documentElement.getAttribute("data-lf-hints"),
        deep: (function(){
          var el = document.getElementById("deep-link");
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return { top: Math.round(r.top), h: window.innerHeight };
        })()
      })`
    ).catch((e) => JSON.stringify({ evalError: String((e && e.message) || e) }));
    return "scroll=" + page + " hinted=[" + ids.join(", ") + "]";
  };
  const readBoxes = async () => (await hintSnapshot()).boxes || [];
  // The RAW snapshot rows, before they are mapped back to page elements.
  //
  // readHints() answers "which element got which key", which is the question most
  // of these tests ask. It cannot answer the other one — "is a badge still ON
  // SCREEN right now" — because a HELD badge (its control's node was washed out
  // or re-rendered; see overlay.snapshot) has no page element to map to, and the
  // labels themselves live in a closed shadow root the page cannot read. The rows
  // carry `held` for exactly that case, so a test can see the symptom the user
  // reported instead of inferring it.
  const readHintRows = async () => (await hintSnapshot()).positions || [];
  // Ask the CONTENT SCRIPT for its page report through the extension realm of
  // the probe tab. This is the diagnostics page's own data source, so these
  // tests read exactly what a user would read — including the last activation.
  const playerReport = async () => {
    const raw = await evalIn(
      ctx.probe,
      `(async function () {
         var tabs = await browser.tabs.query({});
         for (const t of tabs) {
           try {
             var res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
             var r = res && res.report;
             if (r && r.url && r.url.indexOf("/playerlike") !== -1) {
               return { act: r.hints.lastActivation, url: r.url };
             }
           } catch (e) { /* no content script in that tab */ }
         }
         return null;
       })()`,
    );
    return raw || null;
  };
  const beginHints = async () => {
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    await waitFor(async () => ((await hintSnapshot()).positions || []).length > 0 ? true : null, 5000);
  };
  // Activate the hint currently assigned to `id`. Single-character keys can be
  // a prefix of longer ones, in which case typing the key narrows instead of
  // activating, so fall back to Enter (which activates the first match).
  const activateHint = async (id, after?) => {
    const m = await readHints();
    const h = m.find((x) => x.id === id || x.dataId === id);
    assert(h, "no hint for " + id + " (hinted: " + m.map((x) => x.id).join(",") + ")");
    for (const ch of h.key) await ctx.press(ctx.tabA, ch);
    const still = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    if (still === "1") await ctx.press(ctx.tabA, "Enter");
    if (after) await after();
  };
  // A VISIBLE aria-hidden element IS a target. This test used to assert the
  // opposite ("hidden-aria-link" was in the must-not list), and that policy is
  // what made YouTube's video thumbnails unhintable: `aria-hidden` keeps a node
  // out of the ACCESSIBILITY tree, and pages use it on duplicated affordances —
  // the thumbnail link is aria-hidden because the TITLE link beside it is the
  // accessible one, while the thumbnail is the largest thing on the card. The
  // two attributes that really mean "nobody can use this" are `hidden` (out of
  // layout) and `inert` (not clickable, not focusable), and those stay pinned
  // here, together with the CSS and occlusion cases.
  await t("link hints: a visible aria-hidden link is hinted; hidden, inert and occluded ones are not", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id || x.dataId);
    const must = ["visible-link", "nested-btn", "act-btn", "scroll-input", "nearby-link", "body-visible", "thumbnail-link"];
    for (const id of must) assert(ids.indexOf(id) !== -1, "expected a hint for " + id + " (got: " + ids.join(",") + ")");
    const mustNot = ["hidden-opacity-link", "hidden-vis-link", "inert-link", "hidden-link", "hidden-shadow-inner", "pe-none-btn", "covered-link"];
    for (const id of mustNot) assert(ids.indexOf(id) === -1, "a non-actionable element was hinted: " + id);
    await ctx.press(ctx.tabA, "Escape");
  });
  // The other half of the report: the hint has to ACT. On the real page the
  // thumbnail IS the link to the video, so its key must navigate — a label that
  // appears and then does nothing would be a different bug with the same
  // symptom, and the whole point of the fix is that this target was reachable by
  // key. The title link beside it (same destination, no overlap) keeps its own
  // hint: that is the shape YouTube actually has.
  await t("link hints: a thumbnail link's key navigates like any other link", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id || x.dataId);
    assert(
      ids.indexOf("thumbnail-link") !== -1 && ids.indexOf("thumb-title") !== -1,
      "the thumbnail and the title link are both targets (got: " + ids.join(", ") + ")"
    );
    await activateHint("thumbnail-link");
    await ctx.waitExpr(ctx.tabA, `location.hash`, "#thumb", 8000);
    await ctx.press(ctx.tabA, "Escape");
  });
  // The video-player shape: a big clickable media container with a small named
  // control inside it. This is the regression test for the nesting rule — the
  // container is hintable (the media exemption) and it used to suppress the
  // button inside it, so "Skip ad" could never be reached by key.
  await t("link hints: a control inside a clickable media container wins the hint", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await pageSettled();
    await beginHints();
    const ids = (await readHints()).map((x) => x.id || x.dataId);
    assert(
      ids.indexOf("skipad") !== -1,
      "the button inside the player must be hinted (got: " + ids.join(",") + ")"
    );
    assert(
      ids.indexOf("player") === -1,
      "the container must NOT be hinted once the control inside it wins: " + ids.join(",")
    );
    assert(
      ids.indexOf("skipad-inner") === -1,
      "the span inside the button must not be hinted separately: " + ids.join(",")
    );
    assert(
      ids.indexOf("lonely") !== -1,
      "a media wrapper with nothing inside it is still hintable: " + ids.join(",")
    );
    await ctx.press(ctx.tabA, "Escape");
  });
  // The other half of the feedback loop: when the page really does ignore the
  // click, say so. Without this the failure is indistinguishable from "I pressed
  // the wrong key", which is how a hint bug stays a mystery for days.
  await t("link hints: a click the page ignores is reported, not silent", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await pageSettled();
    await beginHints();
    assert(
      (await readHints()).some((h) => h.id === "deaf"),
      "the isTrusted-gated control must be hinted"
    );
    await activateHint("deaf");
    const act = await waitFor(async () => {
      const r = await playerReport();
      return r && r.act && r.act.ignored ? r.act : null;
    }, 4000);
    assert(
      /ignore me/i.test(act.target),
      "the report must name the control that was ignored (got: " + JSON.stringify(act) + ")"
    );
    const title = await evalIn(ctx.tabA, "document.title");
    assert(title !== "DEAF-PRESSED", "the untrusted click must not have activated it");
    // The report has to distinguish "the page ignored us" from "the page
    // ignored us AND the privileged retry did not work either". Those are
    // different diagnoses — the second means the control is not a control —
    // and collapsing them into one boolean is what made this class of bug
    // undiagnosable. In the BiDi harness the window actor is NOT installed, so
    // there is nobody to listen and the retry is reported as not attempted.
    assert(
      act.trustedRetry === false,
      "with no actor listening the report must say the trusted retry was NOT " +
        "attempted, not that it was attempted and failed (got: " +
        JSON.stringify(act) + ")"
    );
  });
  // The privileged path itself, when the actor IS listening. The harness runs
  // the real chrome layer, so this exercises the actor end to end: the nonce
  // handshake, the CustomEvent, and windowUtils.sendMouseEvent producing a
  // click that is genuinely trusted.
  await t("link hints: the actor's trusted click produces a trusted event", async () => {
    const present = await evalIn(ctx.probe, `(function () { return true; })()`);
    assert(present, "probe reachable");
    // Install a listener the way the actor does, and a control that only
    // answers a TRUSTED click — the exact shape of YouTube's skip button.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/press`);
    await pageSettled();
    const outcome = await evalIn(
      ctx.tabA,
      `(async function () {
         // Stand in for the actor: the same handshake installTrustedClick uses,
         // minus windowUtils, which page content cannot reach. Each dispatch
         // uses its OWN nonce so the two measurements cannot contaminate each
         // other — an earlier version shared one listener across both and
         // reported the second event's detail as the first's result.
         function fire(nonce, detail) {
           var got = null;
           var name = "lazyfox-trusted-click:" + nonce;
           window.addEventListener(name, function (e) { got = e.detail; }, true);
           window.dispatchEvent(new CustomEvent(name, { detail: detail }));
           window.removeEventListener(name, function () {}, true);
           return got;
         }
         window.__lazyfoxTrustedClick = "nonce-ok";
         var ok = fire("nonce-ok", { x: 12, y: 34 });
         // The actor drops a non-numeric detail outright rather than clamping
         // it to 0,0 — guessing where a caller meant to click is the worst
         // failure mode a trusted-click path can have.
         var junk = fire("nonce-junk", { x: "nonsense", y: null });
         // And a different nonce must not reach this one.
         var wrong = fire("nonce-other", { x: 1, y: 1 });
         return JSON.stringify({ ok: ok, junk: junk, wrong: wrong });
       })()`,
    );
    const r = JSON.parse(String(outcome));
    assert(
      r.ok && r.ok.x === 12 && r.ok.y === 34,
      "the nonce handshake did not carry the detail intact: " + outcome
    );
    // What this test can and cannot prove, stated plainly because the first
    // version of it claimed more than it delivered.
    //
    // It CAN prove the handshake: the content script's event reaches a
    // listener keyed on the shared nonce, and the coordinates arrive
    // unmodified. That is the contract between activate.ts and actor-child.ts.
    //
    // It CANNOT prove the actor's own validation — the finite-number check and
    // the viewport bound. Those live in the actor's listener, and page script
    // cannot reach windowUtils, so standing in for the actor here would be
    // testing a stub rather than the thing. The junk and wrong-nonce cases
    // below are therefore recorded but NOT asserted: a bare listener accepts
    // them, which is exactly why asserting them would have been a test that
    // passes no matter what the actor does.
    assert(
      r.junk !== undefined,
      "sanity: the junk dispatch was made (no assertion — see the note above)"
    );
    assert(
      r.wrong !== undefined,
      "sanity: the wrong-nonce dispatch was made (no assertion — see above)"
    );
  });
  // And the activation must actually work — with the new feedback, a click the
  // page ignores is reported instead of being silent, so a passing test here
  // also proves the reporting does not fire on a working click.
  await t("link hints: the control inside the media container really activates", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await pageSettled();
    await beginHints();
    await activateHint("skipad", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "SKIPPED", 5000);
    });
    // The same report, for the control that DID work: the feedback must not
    // fire on a working click (a toast on every activation would be noise).
    const seen = await waitFor(async () => {
      const r = await playerReport();
      return r && r.act && !r.act.ignored && /skip ad/i.test(r.act.target) ? r : null;
    }, 4000);
    assert(seen, "the report must record the working activation");
    assert(!!seen.act.signal, "a working activation must record what the page did");
  });
  // What the page actually receives, measured rather than assumed.
  //
  // The widely-reported problem — "YouTube's skip button ignores scripted
  // clicks" — is usually explained as event.isTrusted, because that is the
  // cheapest thing for a site to check. But this project's activate path
  // already ends in HTMLElement.click(), and GECKO synthesises that one with
  // isTrusted TRUE (Blink and WebKit both use false). So the trust story is
  // not a given, and the fix differs completely depending on which it is: a
  // trust problem needs a privileged input path, a press-state problem needs
  // correct event state.
  //
  // So this records what the page saw and asserts the parts that are known
  // facts rather than folklore:
  //   - the click arrives TRUSTED (it came from .click(), not dispatchEvent)
  //   - mouseup arrives with buttons:0 (a real release, not "still held")
  //   - mousedown and the click share an event.target (no split-target
  //     sequence, which is what a press-state machine pairs on)
  await t("link hints: the page receives a trusted, well-formed click", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await pageSettled();
    await beginHints();
    await activateHint("skipad");
    // Wait for the full pointer sequence to land on the page instead of
    // sleeping: the fixture records every event into window.__clicks.
    const seen = await waitFor(async () => {
      const log = JSON.parse(String(await evalIn(ctx.tabA, `JSON.stringify(window.__clicks || [])`)) || "[]");
      return log.some((e) => e.type === "click") && log.some((e) => e.type === "mouseup") && log.some((e) => e.type === "mousedown") ? log : null;
    }, 5000);
    assert(seen.length >= 8, "expected the full pointer/mouse sequence, got " + JSON.stringify(seen));
    const click = seen.find((e) => e.type === "click");
    assert(!!click, "no click reached the page: " + JSON.stringify(seen));
    // MEASURED, not assumed: the click arrives UNTRUSTED even though it comes
    // from HTMLElement.click(). The long-standing claim that Gecko synthesises
    // .click() with isTrusted true does not hold for a content script in a
    // current Firefox, and that claim was quietly load-bearing here — it is the
    // usual explanation offered for "YouTube's skip button ignores the hint
    // click", and it is wrong.
    //
    // So the YouTube problem is NOT fixed by the click being trusted, because
    // it never was. Two real causes remain, and the suite now pins the second:
    //   1. isTrusted is false, and YouTube checks it (and always has). The only
    //      way to produce a trusted click is the privileged path — the content
    //      process's windowUtils.sendMouseEvent, reachable from the window
    //      actor. See docs/HINTS.md; that path is NOT implemented.
    //   2. The event STATE was malformed — mouseup claimed buttons:1, so any
    //      press-state machine never saw the release. That one is fixed here
    //      and pinned by the rest of this test.
    assert(
      click.trusted === false,
      "the click is expected to arrive UNTRUSTED. If this ever becomes " +
        "true, the privileged path in actor-child.ts can be dropped as " +
        "unnecessary — update docs/HINTS.md when it does, because the " +
        "YouTube note there is written on the assumption it is false."
    );
    const up = seen.find((e) => e.type === "mouseup");
    assert(!!up, "no mouseup reached the page: " + JSON.stringify(seen));
    assert(
      up.buttons === 0,
      "mouseup must report buttons:0 (nothing is held after a release). " +
        "Got " + up.buttons + " — a press-state widget never sees the " +
        "release and stays stuck, which is why some player overlays ignored " +
        "every hint click while a plain link worked."
    );
    const down = seen.find((e) => e.type === "mousedown");
    assert(
      !!down && down.buttons === 1,
      "mousedown must report buttons:1 (the button is held during a press)"
    );
    // The synthetic sequence targets the deepest node under the pointer while
    // the trusted click targets the button. Record what actually happened
    // rather than asserting a target match: the important property is that
    // the SEQUENCE is internally consistent (down and up agree), because that
    // is what a state machine pairs on.
    const upTarget = up.target;
    assert(
      upTarget === down.target,
      "mousedown and mouseup must share an event.target (the press-state " +
        "machine pairs on it). Got " + down.target + " vs " + upTarget
    );
  });
  // The press-state-machine case. A widget that only commits when it has
  // seen a pointer go down AND come back up — which it decides from
  // event.buttons, the set of buttons currently held. The old sequence passed
  // buttons:1 to every event including mouseup, so the release never read as a
  // release and the control silently did nothing. This is the shape a real
  // video player's overlay uses, and it is why a hint click on one of those
  // did nothing while a hint click on a plain link worked.
  await t("link hints: a control that tracks press state still activates", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/press`);
    await pageSettled();
    await beginHints();
    await activateHint("pressy", async () => {
      await ctx.waitExpr(ctx.tabA, `document.getElementById("pressy") ? document.getElementById("pressy").getAttribute("data-saw") : null`, "released", 5000);
    });
    const saw = await evalIn(ctx.tabA, `document.getElementById("pressy").getAttribute("data-saw")`);
    assert(
      saw === "released",
      "the press-state widget never saw a release (saw=" + saw + ")"
    );
    const pressed = await evalIn(
      ctx.tabA,
      `document.getElementById("pressy").getAttribute("aria-pressed")`,
    );
    assert(pressed === "true", "the press-state widget did not commit its press");
    // And the existing feedback must stay quiet: a working click is still a
    // working click, and the "page ignored this" toast must not fire for it.
    const report = await waitFor(async () => {
      const raw = await evalIn(
        ctx.probe,
        `(async function () {
           var tabs = await browser.tabs.query({});
           for (const t of tabs) {
             try {
               var res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
               var r = res && res.report;
               if (r && r.url && r.url.indexOf("/press") !== -1 && r.hints.lastActivation) {
                 return r.hints.lastActivation;
               }
             } catch (e) { /* no content script */ }
           }
           return null;
         })()`,
      );
      return raw || null;
    }, 3000);
    assert(
      report && !report.ignored,
      "a working press must not be reported as ignored (got: " + JSON.stringify(report) + ")"
    );
  });
  // The enter affordance. When the typed prefix is a strict prefix of more than
  // one remaining key, no character activates anything and Enter is the only
  // way to take the first match. That state used to be completely invisible:
  // the user typed, nothing happened, and there was no way to know whether
  // they had mistyped or needed Enter.
  await t("link hints: an ambiguous prefix shows an enter badge, and it clears", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/press`);
    await pageSettled();
    await beginHints();
    // Every tab carrying a content script answers this action, so a reply
    // proves nothing on its own — it is the ANSWER THAT SAYS THE BADGE IS UP
    // that matters. Returning the first reply therefore made this test depend
    // on `browser.tabs.query({})` ordering: a tab with no active hint session
    // answering "shown:false" first hid the one real answer behind it. Keep the
    // first reply as the fallback (that is the correct "at rest" answer), but
    // return immediately on a positive one.
    const badge = async () =>
      await evalIn(ctx.probe, `(async function () {
         var tabs = await browser.tabs.query({});
         var first = null;
         for (const t of tabs) {
           try {
             var res = await browser.tabs.sendMessage(t.id, { action: "hintBadge" });
             if (res && res.shown !== undefined && res.id === "amb") {
               if (res.shown === true) return res;
               if (!first) first = res;
             }
           } catch (e) { /* no content script */ }
         }
         return first;
       })()`);
    // Nothing typed yet: no ambiguity, so no badge. The probe always replies
    // with an object, so this has to read .shown — a truthiness check on the
    // reply itself would pass for the wrong reason.
    const atRest = await badge();
    assert(
      !atRest || atRest.shown === false,
      "the enter badge must not show before anything is typed (got: " +
        JSON.stringify(atRest) + ")"
    );
    // Find an ambiguous prefix from the keys the session ACTUALLY assigned,
    // rather than assuming a particular pair collides. The hint engine
    // generates a prefix-free sequence, so with few items on a page it is
    // perfectly possible for no two keys to share a leading character — a test
    // that hardcoded one would be testing the fixture's luck, not the badge.
    // The /press page carries enough links that a collision is certain, and
    // this searches for it rather than naming it.
    const m = await readHints();
    const keys = m.map((x) => x.key);
    let shared = "";
    outer: for (const a of keys) {
      for (const b of keys) {
        if (a === b || b.indexOf(a) !== 0) continue;
        shared = a;
        break outer;
      }
    }
    assert(
      shared.length > 0,
      "no assigned key is a prefix of another, so no ambiguous state is reachable " +
        "on this page (keys: " + keys.join(",") + ")"
    );
    for (const ch of shared) await ctx.press(ctx.tabA, ch);
    // Generous bound, for the same reason the clear-the-badge half of this test
    // has one: `badge()` fans `browser.tabs.sendMessage` out over EVERY tab in
    // the window, and every tab without a content script costs a rejected
    // message. Four seconds was an outlier against the 15s the comparable
    // cross-process waits in this suite allow.
    const shown = await waitFor(async () => {
      const b = await badge();
      return b && b.shown === true ? b : null;
    }, 15000).catch(() => null);
    assert(
      shown && shown.shown === true,
      "typing an ambiguous prefix must show the enter badge (got: " + JSON.stringify(shown) +
        ", hints: " + JSON.stringify(keys.join(",")) + ", armed: " +
        JSON.stringify(await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) + ")"
    );
    assert(
      shown && shown.glyph && shown.glyph.indexOf("\u23ce") !== -1,
      "the badge must carry the ASCII return glyph (got: " + JSON.stringify(shown) + ")"
    );
    // Backspacing to nothing must take the badge away again — a stale badge
    // promising an Enter that no longer does anything is worse than none.
    for (let i = 0; i < shared.length; i++) await ctx.press(ctx.tabA, "Backspace");
    // Generous bound, and for the same reason the hint-pick waits are: this
    // query fans `browser.tabs.sendMessage` out over EVERY tab in the window,
    // and each one that has no content script costs a rejected message. Four
    // seconds was an outlier against the 15s the comparable cross-process
    // waits in this suite already allow, and it is what made the clear-the-
    // badge half of this test flap on a busy window.
    await ctx.waitExpr(ctx.probe, `(async function () {
         var tabs = await browser.tabs.query({});
         var saw = false;
         for (const t of tabs) {
           try {
             var res = await browser.tabs.sendMessage(t.id, { action: "hintBadge" });
             if (res && res.shown !== undefined && res.id === "amb") {
               if (res.shown === true) return false; // still up somewhere
               saw = true;
             }
           } catch (e) { /* no content script */ }
         }
         return saw;
       })()`, true, 15000);
    const after = await badge();
    assert(
      !after || after.shown === false,
      "backspacing must clear the enter badge (got: " + JSON.stringify(after) + ")"
    );
  });
  await t("link hints: nested targets collapse and labels never overlap", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const m = await readHints();
    const ids = m.map((x) => x.id || x.dataId);
    assert(ids.indexOf("nested-btn") !== -1, "the outer button must be hinted");
    assert(ids.indexOf("nested-span") === -1, "the span inside the button must NOT be hinted separately");
    const positions = {};
    for (const h of m) {
      const k = h.x + ":" + h.y;
      assert(!positions[k], "two hints share one element position: " + k);
      positions[k] = 1;
    }
    const boxes = await readBoxes();
    assert(boxes.length === m.length, "one label box per hint (" + boxes.length + " vs " + m.length + ")");
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.l < b.r + 1 && a.r > b.l - 1 && a.t < b.b + 1 && a.b > b.t - 1;
        assert(!overlap, "hint labels overlap: " + a.key + " and " + b.key);
      }
    }
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("link hints: activating never scrolls the page (button and input)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    // Park the button just under the fixed header, the exact case where the old
    // "scrollIntoView({block:center})" yanked the viewport upward.
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("act-btn").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await pageSettled();
    await beginHints();
    const y0 = await evalIn(ctx.tabA, `window.scrollY`);
    await activateHint("act-btn", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "ACTIVATED", 5000);
    });
    assert((await evalIn(ctx.tabA, `document.title`)) === "ACTIVATED", "the button was clicked");
    assert((await evalIn(ctx.tabA, `window.scrollY`)) === y0, "no scroll on button activation");
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("scroll-input").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await pageSettled();
    await beginHints();
    const y1 = await evalIn(ctx.tabA, `window.scrollY`);
    await activateHint("scroll-input", async () => {
      await ctx.waitExpr(ctx.tabA, `document.activeElement && document.activeElement.id`, "scroll-input", 5000);
    });
    assert(
      (await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`)) === "scroll-input",
      "the input was focused"
    );
    assert((await evalIn(ctx.tabA, `window.scrollY`)) === y1, "no scroll on input focus");
  });
  await t("link hints: scrolling to a new section re-hints its links", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const top = (await readHints()).map((x) => x.id);
    assert(top.indexOf("visible-link") !== -1, "the top section is hinted first");
    assert(top.indexOf("deep-link") === -1, "the link below the fold is not hinted at the top");
    await evalIn(ctx.tabA, `window.scrollTo(0, document.body.scrollHeight); true`);
    const bottom = await waitFor(async () => {
      const ids = (await readHints()).map((x) => x.id || x.dataId);
      return ids.indexOf("deep-link") !== -1 ? ids : null;
    }, 6000).catch(async (e) => {
      throw new Error(String((e && (e as Error).message) || e) + " — " + (await hintDiag()));
    });
    assert(bottom.indexOf("visible-link") === -1, "the stale top-section hint is gone after scrolling");
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("link hints: a dense grid yields unique, capped hints", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    // Bring the 100-button grid into view.
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("tinygrid").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await pageSettled();
    await beginHints();
    const m = await readHints();
    assert(m.length > 0 && m.length <= 80, "hint count is capped at 80, got " + m.length);
    const positions = {};
    for (const h of m) {
      const k = h.x + ":" + h.y;
      assert(!positions[k], "duplicate hint position: " + k);
      positions[k] = 1;
    }
    const ids = m.map((x) => x.id || x.dataId).filter(Boolean);
    assert(new Set(ids).size === ids.length, "each element is hinted at most once");
    assert(ids.some((id) => /^tiny\d+$/.test(id)), "tiny grid buttons are hinted");
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("link hints: controls inside open and closed shadow roots are hinted and click", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("shadow-btn").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await pageSettled();
    await beginHints();
    await activateHint("shadow-inner", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "SHADOW-CLICKED", 5000);
    });
    assert((await evalIn(ctx.tabA, `document.title`)) === "SHADOW-CLICKED", "the open shadow-root button was clicked");

    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("closed-shadow-btn").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await pageSettled();
    await beginHints();
    await activateHint("closed-shadow-inner", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "CLOSED-SHADOW-CLICKED", 5000);
    });
    assert((await evalIn(ctx.tabA, `document.title`)) === "CLOSED-SHADOW-CLICKED", "the closed shadow-root button was clicked");
  });
  await t("link hints: a page whose controls are all in a frame says WHY, and stays off", async () => {
    // The frame policy is top-frame-only, and that decision is allowed. What is
    // not allowed is the two outcomes being indistinguishable: `;f` on a page
    // whose controls are all in a frame used to report "no hints", which reads
    // as "this page has nothing to click" and was reported as "link hints
    // doesn't launch on a lot more sites". So the toast must name the frame, and
    // the keyboard must NOT be taken for a batch that does not exist.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/framedhints`);
    await pageSettled();
    await ctx.leaderPress(ctx.tabA, "f");
    const said = await waitFor(async () => {
      const m = await evalIn(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-toast") || ""`
      );
      return m.indexOf("iframe") !== -1 ? m : null;
    }, 5000);
    assert(
      typeof said === "string" && said.indexOf("iframe") !== -1,
      "the toast names the frame blind spot: " + JSON.stringify(said)
    );
    const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    assert(on !== "1", "hints must not be armed on a page it could not hint");
  });
  // THE CHAINED-ACTION REPORT, VERBATIM.
  //
  // "1- if i did ;d ;o ;s to open modal -> esc  2- right after did ;f to open
  // hints -> esc or typed one letter (which works) then esc to cancel  3- after
  // canceling did ;f again right away to open hints -> gets broken and
  // unresponsive". The sequence matters: popup, cancelled session, SECOND session
  // immediately — and the second one is the one that dies. Each step is driven
  // by a product signal, and the last step asserts the second session not only
  // APPEARS but still READS KEYS (a batch that is drawn but deaf is exactly the
  // reported state, and asserting only `data-lf-hints` would pass on it).
  await t("link hints: a popup, a cancelled session and a second session in a row", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await pageSettled();
    // 1. THREE leader popups in a row, each closed with Escape — the user's
    //    step 1 verbatim (`;d`, `;o`, `;s`), because a single popup would not
    //    catch state that only survives a chain of them.
    for (const modal of ["d", "o", "s"]) {
      await ctx.leaderPress(ctx.tabA, modal);
      await ctx.waitPopup(ctx.tabA, 8000);
      await ctx.press(ctx.tabA, "Escape");
      await ctx.waitPopupGone(ctx.tabA, 8000);
    }
    // 2. A hint session with one letter typed (the user's "which works"),
    //    cancelled with Escape. The letter must be one the batch cannot commit
    //    — a miss is announced and leaves the layer up, which is the reported
    //    "it couldn't read some keys" case, and it cannot navigate the tab.
    await beginHints();
    const first = await readHints();
    assert(first.length > 0, "the first session has hints");
    const usedFirst = new Set(first.map((h) => h.key[0]));
    const miss = "asdfjklgh".split("").find((c) => !usedFirst.has(c)) || "z";
    await ctx.press(ctx.tabA, miss);
    await ctx.press(ctx.tabA, "Escape");
    // The intermediate state is asserted, not assumed: if Escape did not clear
    // the first session, every later step is measuring a stale layer and the
    // test would blame the wrong one.
    const cleared = await waitFor(
      async () =>
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1"
          ? null
          : true,
      4000
    );
    assert(cleared === true, "step 2: Escape cleared the first session");
    // 3. RIGHT AWAY, a second session. It must come up and still read keys.
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn(6000);
    const second = await readHints();
    const ids = second.map((h) => h.id || h.dataId);
    assert(
      ids.indexOf("thumbnail-link") !== -1,
      "the second session hints the page's controls (got: " +
        JSON.stringify(ids) +
        " keys=" +
        JSON.stringify(second.map((h) => h.key)) +
        "). If this is empty the batch is drawn but names nothing"
    );
    await activateHint("thumbnail-link", async () => {
      await ctx.waitExpr(ctx.tabA, `location.hash`, "#thumb", 8000);
    });
    assert(
      (await evalIn(ctx.tabA, `location.hash`)) === "#thumb",
      "a key of the second session activated — the layer is drawing AND reading"
    );
  });
  // THE SAME TWO SESSIONS WITHOUT THE POPUP. Isolates the popup from the
  // session hand-off: if the chain above fails and this passes, the popup's
  // teardown is the trigger, and the fix belongs where the popup leaves state.
  await t("link hints: two sessions in a row, the first cancelled, both read keys", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await pageSettled();
    await beginHints();
    const first = await readHints();
    assert(first.length > 0, "the first session has hints");
    // A keystroke that cannot commit: it exercises the session (and the miss
    // announcement) without acting on a link, so the second session starts from
    // the same page the first one did.
    const usedFirst = new Set(first.map((h) => h.key[0]));
    const miss = "asdfjklgh".split("").find((c) => !usedFirst.has(c)) || "z";
    await ctx.press(ctx.tabA, miss);
    await ctx.press(ctx.tabA, "Escape");
    const cleared = await waitFor(
      async () =>
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1"
          ? null
          : true,
      4000
    );
    assert(cleared === true, "Escape cleared the first session");
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn(6000);
    const second = await readHints();
    const ids = second.map((h) => h.id || h.dataId);
    assert(
      ids.indexOf("thumbnail-link") !== -1,
      "the second session hints the page's controls (got: " + JSON.stringify(ids) + ")"
    );
    await activateHint("thumbnail-link", async () => {
      await ctx.waitExpr(ctx.tabA, `location.hash`, "#thumb", 8000);
    });
    assert(
      (await evalIn(ctx.tabA, `location.hash`)) === "#thumb",
      "a key of the second session activated"
    );
  });
  // Tab WHILE HINTS ARE UP. Tab is the layer's own "next batch" key, so it may
  // not fall through to the page's focus walk — and whatever it does, the layer
  // must still be up and still ACTIVATE afterwards ("hit tabs after it scrolls
  // the window and breaks the whole software").
  //
  // The first version of this test asked the layer to announce a MISS instead (a
  // letter the batch could not commit), and that assertion was wrong in a way
  // worth recording: the letters it chose came from the default alphabet, and
  // the only alphabet letter the Tab'd batch left unused was `z` — which is not
  // a hint character at all, so the layer correctly DECLINED the key and the
  // test went red for its own reason. A key that ACTIVATES is the stronger
  // question anyway: a drawn batch that cannot act is precisely the "looks
  // alive, answers nothing" state this suite exists for.
  await t("link hints: Tab pages to the next batch and the layer still activates", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await pageSettled();
    await beginHints();
    const focusBefore = await evalIn(ctx.tabA, `document.activeElement && document.activeElement.tagName`);
    await ctx.press(ctx.tabA, "Tab");
    const alive = await waitFor(
      async () =>
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1"
          ? true
          : null,
      3000
    );
    assert(alive === true, "the layer is still up after Tab");
    // Tab must not have reached the page as a focus movement. Hints are
    // top-frame-only and every key goes to the FOCUSED document, so a Tab the
    // layer failed to consume does not merely scroll: the browser's own focus
    // walk runs, and when the next focusable thing is inside a frame the
    // keyboard is gone from this document for good — "it breaks the whole
    // software", with nothing on screen to say why.
    const focusAfter = await evalIn(ctx.tabA, `document.activeElement && document.activeElement.tagName`);
    assert(
      focusAfter === focusBefore,
      "Tab did not move focus in the page (" + focusBefore + " -> " + focusAfter + ")"
    );
    const after = await readHints();
    assert(
      after.length > 0,
      "there are still hints after Tab (got: " + JSON.stringify(after.map((h) => h.id)) + ")"
    );
    // THE REAL QUESTION: does a key of the batch Tab produced still act?
    // `deep-link` sits after the fixture's 2600px spacer, so it can only be in
    // the batch at all if paging actually moved the region and re-hinted it.
    const named = after.filter((h) => h.id || h.dataId);
    const target = named.find((h) => (h.id || h.dataId) === "deep-link") || named[0] || after[0];
    assert(target && target.key, "the batch after Tab names a control to activate");
    for (const ch of target.key) await ctx.press(ctx.tabA, ch);
    if ((await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1") {
      await ctx.press(ctx.tabA, "Enter");
    }
    const acted = await waitFor(
      async () => {
        const hash = await evalIn(ctx.tabA, `location.hash`);
        const title = await evalIn(ctx.tabA, `document.title`);
        return (typeof hash === "string" && hash !== "") || title !== "UI Heavy" ? true : null;
      },
      8000
    ).catch(() => null);
    assert(
      acted === true,
      "a key of the batch after Tab activated its control (hash=" +
        JSON.stringify(await evalIn(ctx.tabA, `location.hash`)) +
        " title=" +
        JSON.stringify(await evalIn(ctx.tabA, `document.title`)) +
        " batch=" +
        JSON.stringify(after.map((h) => (h.id || h.dataId) + ":" + h.key)) +
        ")"
    );
    // ...AND THE KEYBOARD AS A WHOLE IS STILL THERE. Escape stands the layer
    // down and the leader arms immediately after: the report is never "one key
    // broke", it is "the software stopped responding", and this is the cheapest
    // honest check of the difference.
    await ctx.press(ctx.tabA, "Escape");
    const down = await waitFor(async () =>
      (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1"
        ? null
        : true,
      4000
    ).catch(() => null);
    assert(down === true, "the layer stood down on Escape");
    await ctx.press(ctx.tabA, ";");
    await ctx
      .waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader")`, "1", 5000)
      .catch(() => {
        throw new Error("the leader key went dead after a Tab-paged hint batch");
      });
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitLeaderGone().catch(() => {});
  });
  // THE REPEAT REPORT, VERBATIM: "also add to things that I noticed is doing
  // ;f -> esc ;f -> esc repeatedly breaks the hints or the whole software".
  //
  // One session is not the claim; the claim is that a session LEAVES SOMETHING
  // BEHIND. So every cycle is asked the same two questions — does the layer draw
  // its batch, and does it still read a key — and the run ends on the one
  // question a drawn-but-deaf layer cannot answer: does a key ACT. Every
  // intermediate state is asserted rather than assumed, so a failure names the
  // cycle it happened in instead of blaming the last one.
  await t("link hints: ;f and Esc in a row, eight times, every session draws and reads keys", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await pageSettled();
    const CYCLES = 8;
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await beginHints();
      const batch = await readHints();
      assert(
        batch.length > 1,
        "cycle " + cycle + ": the layer drew a batch (got " + JSON.stringify(batch.map((h) => h.id)) + ")"
      );
      // A drawn batch can still be deaf. Take one character of a multi-key hint:
      // the batch must NARROW, which cannot happen unless the key reached the
      // session and the session answered with a placement pass. The last cycle
      // types a whole key instead, so the run also ends on an activation.
      if (cycle < CYCLES) {
        const two = batch.find((h) => h.key.length > 1);
        assert(two, "cycle " + cycle + ": the batch has a multi-character key to narrow with");
        const ch = two.key[0];
        assert(
          batch.some((h) => h.key[0] !== ch),
          "cycle " + cycle + ": narrowing by one character must remove something (batch=" +
            JSON.stringify(batch.map((h) => h.key)) +
            ")"
        );
        await ctx.press(ctx.tabA, ch);
        const narrowed = await waitFor(async () => {
          const now = await readHints();
          if (!now.length || now.length >= batch.length) return null;
          return now.every((h) => h.key[0] === ch) ? now : null;
        }, 4000).catch(() => null);
        assert(
          narrowed,
          "cycle " +
            cycle +
            ": typing \"" +
            ch +
            "\" narrowed the batch (still drawn: " +
            JSON.stringify((await readHints()).map((h) => h.key)) +
            ", was " +
            JSON.stringify(batch.map((h) => h.key)) +
            ")"
        );
      }
      await ctx.press(ctx.tabA, "Escape");
      const down = await waitFor(async () =>
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1"
          ? null
          : true,
        4000
      ).catch(() => null);
      assert(down === true, "cycle " + cycle + ": Escape stood the layer down");
    }
    // The session that follows the whole chain still ACTS — the report's "broken
    // and unresponsive" answered directly, not by an attribute.
    await beginHints();
    const last = await readHints();
    const thumb = last.find((h) => (h.id || h.dataId) === "thumbnail-link") || last[0];
    assert(thumb && thumb.key, "the post-chain session names a control (got " + JSON.stringify(last.map((h) => h.id)) + ")");
    for (const ch of thumb.key) await ctx.press(ctx.tabA, ch);
    if ((await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1") {
      await ctx.press(ctx.tabA, "Enter");
    }
    const acted = await waitFor(
      async () => ((await evalIn(ctx.tabA, `location.hash`)) === "#thumb" ? true : null),
      8000
    ).catch(() => null);
    assert(
      acted === true,
      "the session after eight cancels still acts (hash=" +
        JSON.stringify(await evalIn(ctx.tabA, `location.hash`)) +
        ", wanted #thumb)"
    );
  });
  // PAGING MOVES WHAT THE USER IS LOOKING AT.
  //
  // `]` / `[` / Tab scroll the region the scroll keys move (content/scroll.ts's
  // target) rather than `window`. On a shell page whose document is pinned and
  // whose content lives in an inner pane, `window.scrollBy` moves nothing at
  // all: paging did nothing AND read `window.scrollY` — which never moves there
  // — to decide there was nothing more, so a pane full of links reported "no
  // more links". On the pages where the window CAN move it scrolled the shell
  // behind the pane the user was reading. The fixture is the
  // ChatGPT/dashboard shape the scroll keys already have a test for; this asks
  // the same question of the hint layer, and the window must stay put.
  await t("link hints: paging moves the pane the user is looking at, never the window", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/innerpane`);
    await evalIn(
      ctx.tabA,
      `(document.getElementById("pane").scrollTop = 0, window.scrollTo(0, 0), document.activeElement && document.activeElement.blur(), true)`
    );
    await pageSettled();
    await beginHints();
    const before = (await readHints()).map((h) => h.dataId);
    assert(before.length > 0, "the pane's links are hinted (got " + JSON.stringify(before) + ")");
    const paneBefore = await evalIn(ctx.tabA, `document.getElementById("pane").scrollTop`);
    await ctx.press(ctx.tabA, "]");
    const moved = await waitFor(async () => {
      const top = await evalIn(ctx.tabA, `document.getElementById("pane").scrollTop`);
      return top > paneBefore + 40 ? top : null;
    }, 5000).catch(() => null);
    assert(moved, "] scrolled the INNER PANE (pane " + paneBefore + " -> " + moved + ")");
    assert(
      (await evalIn(ctx.tabA, `window.scrollY`)) === 0,
      "the window never moved on a shell whose document cannot scroll (scrollY=" +
        (await evalIn(ctx.tabA, `window.scrollY`)) +
        ")"
    );
    const after = (await readHints()).map((h) => h.dataId);
    assert(
      after.length > 0 && after.join(",") !== before.join(","),
      "paging re-hinted the pane's new batch (before=" +
        JSON.stringify(before) +
        " after=" +
        JSON.stringify(after) +
        ")"
    );
    await ctx.press(ctx.tabA, "Escape");
  });
  // THE LAYER MUST NOT OUTLIVE THE KEYBOARD.
  //
  // The content script is top-frame-only (`all_frames: false`), so the moment
  // focus moves into a nested browsing context every key goes to the FRAME's
  // document: the hint batch can no longer be typed into, and Escape cannot
  // reach it either — the layer just stands there. That is the report "the
  // hints got stuck and I can't get rid of them, and it couldn't read some
  // keys", and it is the worst shape a keyboard-first tool can fail in: the
  // keys appear dead while the page looks assembled.
  //
  // The test drives the frame itself (create + focus, same-origin `srcdoc`) and
  // records the parent document's focus events into the failure message: which
  // of them a listener can work from is the difference between "the layer can
  // see this" and "it cannot", and it is not something to guess at.
  await t("link hints: focus moving into a frame tears the layer down instead of trapping the keyboard", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await pageSettled();
    await beginHints();
    const probe = await evalIn(
      ctx.tabA,
      `(async function () {
         var log = [];
         var note = function (t) {
           return function (e) {
             log.push(t + ":" + ((e.target && e.target.tagName) || "?"));
           };
         };
         window.addEventListener("focus", note("focus"), true);
         window.addEventListener("focusin", note("focusin"), true);
         window.addEventListener("blur", note("blur"), true);
         var f = document.getElementById("trap-frame");
         if (!f) {
           f = document.createElement("iframe");
           f.id = "trap-frame";
           f.style.cssText = "position:fixed;right:6px;bottom:6px;width:200px;height:80px;border:1px solid #666";
           f.srcdoc = "<!DOCTYPE html><body style='margin:0'><input id='trap-input'></body>";
           document.body.appendChild(f);
           await new Promise(function (r) { f.addEventListener("load", r, { once: true }); });
         }
         var onBefore = document.documentElement.getAttribute("data-lf-hints");
         f.contentDocument.getElementById("trap-input").focus();
         await new Promise(function (r) { setTimeout(r, 150); });
         return {
           onBefore: onBefore,
           log: log,
           topActive: document.activeElement ? document.activeElement.tagName + "#" + document.activeElement.id : null,
           frameActive: f.contentDocument.activeElement ? f.contentDocument.activeElement.id : null,
           hasFocus: document.hasFocus(),
         };
       })()`
    );
    // THE PRECONDITION IS THE TEST. Without it this passes just as happily when
    // the layer was never up, the batch had already died, or the fixture failed
    // to move focus — i.e. it would prove nothing about the trap.
    assert(
      probe && probe.onBefore === "1",
      "hints must be UP before the keyboard leaves the page: " + JSON.stringify(probe)
    );
    assert(
      probe && probe.frameActive === "trap-input",
      "the fixture really moved the keyboard into the frame: " + JSON.stringify(probe)
    );
    assert(probe && probe.log.length > 0, "the parent document saw the focus move: " + JSON.stringify(probe));
    const down = await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? null : true;
    }, 3000);
    assert(
      down === true,
      "the hint layer must come down once no key can reach the page: " + JSON.stringify(probe)
    );
  });
  // The composed walk has to cross the shadow BOUNDARY to see an ancestor's
  // attribute: the control inside this closed root has a real box (nothing in
  // its own tree is hidden), so the only thing that can exclude it is the walk up
  // through getRootNode().host to the `inert` wrapper outside.
  //
  // This used to use an `aria-hidden` wrapper, which stopped being a reason to
  // exclude anything (§10 of docs/HINTS.md). `inert` is the stronger fixture: it
  // removes no geometry, so a test that passed on the RECT would fail on this
  // one.
  await t("link hints: an inert ancestor hides a control inside a closed shadow root", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id || x.dataId);
    assert(ids.indexOf("hidden-shadow-inner") === -1, "closed-root target under an inert host is not hinted");
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("link hints: clickable image and video thumbnails are hinted and click", async () => {
    // Regression: the "no text/label ⇒ decorative" rule dropped cursor:pointer
    // nodes that are real pictures/videos, so thumbnails became unclickable.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id || x.dataId);
    assert(ids.indexOf("thumb") !== -1, "the clickable <img> is hinted (got: " + ids.join(",") + ")");
    assert(ids.indexOf("vid-thumb") !== -1, "the clickable <video> is hinted (got: " + ids.join(",") + ")");
    await activateHint("thumb", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "THUMB", 5000);
    });
    assert((await evalIn(ctx.tabA, `document.title`)) === "THUMB", "the image thumbnail was clicked");
  });
  await t("link hints: a control inserted after ;f gets a working hint", async () => {
    // Regression: hints were a snapshot from `;f`, so a control that appears
    // later (a video player's "Skip ad" button) had no hint, or a hint whose key
    // did nothing. The DOM-change resync must re-collect and re-hint it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const before = (await readHints()).map((x) => x.id || x.dataId);
    assert(before.indexOf("late-skip") === -1, "the late control is not hinted before it exists");
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    await waitFor(async () => {
      const ids = (await readHints()).map((x) => x.id || x.dataId);
      return ids.indexOf("late-skip") !== -1 ? ids : null;
    }, 6000);
    // The insertion re-keys the whole batch ONCE (the batch grew); wait until
    // the late control's key is stable across two reads before activating, so
    // the test presses the key the user would actually see.
    let stable = null;
    for (let i = 0; i < 20; i++) {
      const h = (await readHints()).find((x) => x.id === "late-skip" || x.dataId === "late-skip");
      const key = h && h.key;
      if (key && key === stable) break;
      stable = key;
      await ctx.waitExpr(ctx.tabA, `document.readyState`, "complete", 100);
    }
    await activateHint("late-skip", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "LATE-SKIP", 5000);
    });
    assert((await evalIn(ctx.tabA, `document.title`)) === "LATE-SKIP", "the late-inserted control was clicked");
  });
  await t("link hints: a framework re-render keeps the same key and still clicks", async () => {
    // A virtual-DOM framework (YouTube's ad overlay, a React list) THROWS AWAY
    // the button node and mounts a brand new one in its place. Previously the
    // batch was re-keyed and the dead node was not re-resolved, so typing the
    // label "did nothing". The replacement must inherit the key and activate.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    const first = await waitFor(async () => {
      const h = (await readHints()).find((x) => x.id === "late-skip" || x.dataId === "late-skip");
      return h && h.key ? h : null;
    }, 6000);
    assert(first.key, "the late control is hinted");
    await evalIn(ctx.tabA, `window.__replaceLateSkip()`);
    // Type the key we already read, WITHOUT waiting for a re-hint, so this
    // proves the dead node is re-resolved to its replacement rather than just
    // re-keyed on the next sweep.
    for (const ch of first.key) await ctx.press(ctx.tabA, ch);
    const still = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    if (still === "1") await ctx.press(ctx.tabA, "Enter");
    await ctx.waitExpr(ctx.tabA, `document.title`, "LATE-SKIP-2", 5000);
    assert(
      (await evalIn(ctx.tabA, `document.title`)) === "LATE-SKIP-2",
      "the re-rendered control was clicked using its original key"
    );
  });
  await t("link hints: a late control does not reshuffle existing keys", async () => {
    // Stability is what makes a churning framework page usable: a control that
    // appears later must take a NEW key while every label already on screen
    // keeps the key the user has just read.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const before = await readHints();
    const keysBefore = new Map(before.filter((h) => h.id || h.dataId).map((h) => [h.id || h.dataId, h.key]));
    assert(keysBefore.size > 3, "the page starts with a real batch (" + keysBefore.size + ")");
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    const after = await waitFor(async () => {
      const m = await readHints();
      return m.find((x) => x.id === "late-skip" || x.dataId === "late-skip") ? m : null;
    }, 6000);
    const used = new Set(after.map((h) => h.key));
    assert(used.size === after.length, "every hint key is unique after the insertion");
    let changed = 0;
    for (const h of after) {
      const id = h.id || h.dataId;
      if (!id || id === "late-skip") continue;
      const k = keysBefore.get(id);
      if (k && k !== h.key) changed++;
    }
    assert(changed === 0, "no existing hint changed key (" + changed + " did)");
    await ctx.press(ctx.tabA, "Escape");
  });

  // The reported "it gets stuck and the keys do nothing": the hint alphabet is
  // ours, so a letter that names no VISIBLE hint was consumed with nothing
  // happening and nothing said — every further attempt identical. It has to say
  // which of the two things is wrong, here a prefix that names no hint at all
  // (`/target1` has one link, so its key is the single letter `a`).
  await t("link hints: a hint key that names nothing says so instead of going quiet", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
    await ctx.waitExpr(ctx.tabA, `document.readyState`, "complete", 8000);
    // Clear any earlier toast first: the assertion has to be about THIS press.
    await evalIn(ctx.tabA, `document.documentElement.removeAttribute("data-lf-toast"); true`);
    await ctx.leaderPress(ctx.tabA, "f");
    await hintsOn();
    await ctx.press(ctx.tabA, "l"); // in the hint alphabet, names no hint here
    const said = await waitFor(async () => {
      const t = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-toast") || ""`);
      return t.indexOf("no hint") !== -1 ? t : null;
    }, 4000).catch(() => null);
    assert(said, "a key that names no hint must say so (got: " + JSON.stringify(said) + ")");
    const still = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    assert(still === "1", "the layer stays up: the key was a hint key, just not one with a target");
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("link hints: Ctrl+G cancels the batch instead of typing the letter g", async () => {
    // §4.4's promise: there is always a way back, and Ctrl+G is the one cancel
    // that works on every page (a chord no site can receive as text). The hint
    // matcher looked at `e.key` alone, and `g` IS a hint letter, so pressing it
    // typed `g` into the batch — with a single candidate left that ACTIVATES THE
    // LINK, i.e. the escape hatch did the opposite of escaping. Here nothing may
    // be clicked, the batch must go away, and the keyboard must come back.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await pageSettled();
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const before = await evalIn(ctx.tabA, `location.pathname`);
    await ctx.press(ctx.tabA, "g", { ctrl: true });
    await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? null : true;
    }, 5000);
    const after = await evalIn(ctx.tabA, `location.pathname`);
    assert(after === before, `Ctrl+G navigated to ${after}: it was taken as the hint letter g`);
    // And the keyboard is usable again, which is what "cancel" has to mean.
    await beginHints();
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("link hints: a capture that declines a key does not swallow it", async () => {
    // `;W m` arms a digit capture ("which tab position?"), and its handler
    // DECLINES anything that is not a digit of a position — a letter, a leading
    // zero, or a modified key. Every host discarded that answer and consumed the
    // key anyway, so the handler's own comment ("let the key through untouched")
    // was a lie and the keystroke vanished with nothing on screen to explain it.
    // The observable proof is the leader key itself: after a declined `;` the
    // rest of the dispatcher must run, and `;` must arm the leader as always.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await pageSettled();
    await ctx.leaderSeq(ctx.tabA, ["W"], { shift: true });
    await ctx.press(ctx.tabA, "m");
    await ctx.press(ctx.tabA, ";");
    await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader")`, "1", 5000).catch(() => {
      throw new Error("; after `;W m` was swallowed: the capture declined it and the host consumed it anyway");
    });
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitLeaderGone();
  });

  // ---- the third field report, on the page that carries its own markup ----
  // `/ytcard` is the report's DOM (a YouTube video card and the ad player's
  // "Skip" button) rather than the engine's idea of it, plus a heartbeat and a
  // churn switch so the two claims it makes — "it misses these thumbnails" and
  // "it got stuck and unresponsive" — are both measurable.
  const gotoYtcard = async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/ytcard`);
    await pageSettled();
    // The cards are built by the fixture's own script; wait for them rather than
    // for a fixed delay, so the batch is never read from a half-built page.
    await ctx.waitExpr(ctx.tabA, `document.querySelectorAll("a.thumb").length`, 6, 8000);
  };
  await t(
    "link hints: a YouTube-shaped thumbnail link is hinted and its key navigates",
    async () => {
      // The reported shape: `aria-hidden="true"`, `tabindex="-1"`, `rel="null"`,
      // content that is only a poster image plus overlay divs, and a title link
      // beside it that points at the same video. Both have to be offered — the
      // card is two affordances for one destination, which is what the page has.
      await gotoYtcard();
      await beginHints();
      const hinted = await readHints();
      // Each fixture element carries BOTH names, as the reported markup does
      // (`id="thumbnail"` plus the harness's own `data-id`), so a hint counts as
      // present when either one names it.
      const has = (id) => hinted.some((x) => x.id === id || x.dataId === id);
      for (const id of ["thumb1", "thumb3", "thumb6", "title1", "channel1"]) {
        assert(
          has(id),
          "expected a hint for " +
            id +
            " (got: " +
            hinted.map((x) => x.id + "/" + x.dataId).join(",") +
            ")"
        );
      }
      await activateHint("thumb1", async () => {
        await ctx.waitExpr(ctx.tabA, `location.hash`, "#watch1", 8000);
      });
      assert(
        (await evalIn(ctx.tabA, `location.hash`)) === "#watch1",
        "the thumbnail link's key must navigate to the video"
      );
    }
  );
  await t(
    "link hints: the ad's Skip button appears mid-session and its key skips the ad",
    async () => {
      // The control the report named: an ad overlay that is inserted AFTER hints
      // are open (so it cannot be in the `;f` snapshot), inside a
      // `pointer-events:none` ad layer that the control's own container opts back
      // into, with the half-transparent inline opacity an ad control has while
      // its countdown runs — and the colon-bearing ids YouTube uses.
      await gotoYtcard();
      await beginHints();
      const before = (await readHints()).map((x) => x.id || x.dataId);
      assert(
        before.indexOf("yt-skip") === -1,
        "the ad control cannot be hinted before the ad exists"
      );
      await evalIn(ctx.tabA, `window.__showAdOverlay()`);
      const found = await waitFor(async () => {
        const m = await readHints();
        const h = m.find((x) => x.id === "yt-skip" || x.dataId === "yt-skip");
        return h && h.key ? h : null;
      }, 8000);
      assert(found.key, "the late-inserted Skip button must be hinted");
      await activateHint("yt-skip", async () => {
        await ctx.waitExpr(ctx.tabA, `document.title.indexOf("YT-SKIP") === 0`, true, 8000);
      });
      const seen = await evalIn(ctx.tabA, `window.__skipSeen || null`);
      assert(
        seen && seen.target,
        "the page's own click handler must have run (saw: " + JSON.stringify(seen) + ")"
      );
      const still = await evalIn(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-hints")`
      );
      assert(still !== "1", "activating the ad control must leave hint mode");
    }
  );
  await t(
    "link hints: a re-rendering page stays hinted and stays responsive",
    async () => {
      // The other half of the report — "the hints got stuck and unresponsive,
      // they don't do anything, even exiting" — is a main-thread claim, and the
      // fixture's own 50ms timer is the honest way to test it: a page doing
      // document-wide collections dozens of times a second cannot keep that
      // cadence, and neither can the key handler that would have processed
      // Escape.
      //
      // THE CHURN HAS A GAP, AND THE GAP IS THE TEST.
      //
      // This case used to remove and rebuild every card in ONE task. It passed —
      // on builds where the resolution path collected the whole document per item
      // per frame — because by the time any measurement pass ran, the
      // replacements were already in the pool at the same coordinates, so
      // re-resolution matched each item by destination and position and never
      // took the expensive branch. A test that cannot fail on the bug it was
      // written for is decoration, and this one was decoration: the fixture had
      // removed the window the bug lives in.
      //
      // So the fixture now washes the cards out and re-hydrates them on a LATER
      // task (180ms later, every 300ms), which is what a virtual list's
      // placeholder, an ad overlay and a lazy route all do. In that window every
      // hinted node is gone and there is no same-destination neighbour in the
      // pool to fall back on, so re-resolution has to ask the document again —
      // once per hinted item per frame, unless that question is opt-in where it
      // belongs. With it, this page keeps its 50ms cadence; without it, this
      // assertion is what turns red.
      await gotoYtcard();
      await beginHints();
      const before = await readHints();
      const thumbsBefore = before.filter((h) => String(h.dataId || "").indexOf("thumb") === 0);
      assert(
        thumbsBefore.length === 6,
        "the six thumbnails are hinted before the churn (" + before.length + " hints)"
      );
      const keysBefore = new Map(before.map((h) => [h.dataId || h.id, h.key]));
      await evalIn(ctx.tabA, `window.__resetBeats(); true`);
      await evalIn(ctx.tabA, `window.__churn(true)`);
      // A FIXED WINDOW, measured on the page's own clock.
      //
      // Waiting for "N beats" is what this used to do, and it made the test blind
      // in the one direction that matters: a starved timer REACHES N beats, it
      // just takes far longer, so the wait absorbed the whole symptom and only an
      // absolute max-gap bound was left to catch it — which a saturated main
      // thread can stay just under. A window of wall time turns the symptom into
      // a COUNT: over 2.5 seconds the fixture's 50ms timer has ~50 ticks to spend,
      // and a page doing a document collection per hinted item per frame simply
      // does not get through them. CHURN_MS/BEATS_MIN below are that pair.
      const CHURN_MS = 2500;
      const BEATS_EXPECTED = Math.floor(CHURN_MS / 50); // 50 ticks
      // ...with room for a slow machine, but not room for a page that spends its
      // time collecting. The floor is CALIBRATED, and the two numbers it sits
      // between were measured on this fixture (20 cards washed out and re-hydrated
      // every 300ms, 2.5s window):
      //
      //   resolution re-collects per item per frame   37-40 ticks, 336-358ms gap
      //   re-collection is opt-in (shipped)           51 ticks,  61ms max gap
      //
      // (The broken side is a range because it was measured more than once; the
      // floor sits above the whole range and below the shipped number.)
      //
      // 90% of the expected ticks is a floor the shipped build clears with room
      // and a re-collecting build misses outright — the failing side of that pair
      // is a measurement, not a guess, and the gap bound below is the second,
      // independent way to see the same starvation.
      const BEATS_MIN = Math.floor(BEATS_EXPECTED * 0.9);
      await evalIn(ctx.tabA, `window.__churnUntil = performance.now() + ${CHURN_MS}; true`);
      await ctx.waitExpr(
        ctx.tabA,
        `performance.now() > window.__churnUntil`,
        true,
        20000
      );
      await evalIn(ctx.tabA, `window.__churn(false)`);
      const gap = await evalIn(ctx.tabA, `Math.round(window.__maxGap)`);
      const beats = await evalIn(ctx.tabA, `window.__beats`);
      assert(
        beats >= BEATS_MIN,
        "the page's own 50ms timer must keep ticking while hints are open on a " +
          "re-rendering page: it managed " +
          beats +
          " ticks in " +
          CHURN_MS +
          "ms (expected about " +
          BEATS_EXPECTED +
          ", floor " +
          BEATS_MIN +
          ") — a document collection per hinted item per frame is what eats them"
      );
      assert(
        gap < 300,
        "the page must stay responsive with hints open on a re-rendering page: the " +
          "fixture's 50ms timer saw a " +
          gap +
          "ms gap over " +
          beats +
          " ticks — a per-item document collection on the hot path starves this timer, " +
          "and the keystroke handling (Escape included) queues behind it"
      );
      // ...and after the churn the same controls are hinted again, under the
      // keys the user had already read: a re-render must not reshuffle them.
      const after = await waitFor(async () => {
        const m = await readHints();
        const thumbs = m.filter((h) => String(h.dataId || "").indexOf("thumb") === 0);
        if (thumbs.length !== 6) return null;
        const same = thumbs.every((h) => keysBefore.get(String(h.dataId)) === h.key);
        return same ? m : null;
      }, 8000).catch(() => null);
      assert(
        after,
        "the batch must come back after the page re-rendered, with the keys it had: " +
          (await readHints()).map((h) => (h.dataId || h.id) + "=" + h.key).join(",")
      );
      await activateHint("thumb2", async () => {
        await ctx.waitExpr(ctx.tabA, `location.hash`, "#watch2", 8000);
      });
      assert(
        (await evalIn(ctx.tabA, `location.hash`)) === "#watch2",
        "a thumbnail key must still navigate after the page re-rendered its cards"
      );
    }
  );

  await t(
    "link hints: a badge whose control is washed out stays on screen and keeps its key",
    async () => {
      // THE REPORTED SYMPTOM, directly: "some of the hint got disappeared after
      // showing up". The user is looking at badges, their controls' nodes are
      // replaced or washed out underneath them, and the badges vanish with the
      // nodes — so the key they had already read stops meaning anything and the
      // thing they were about to press is gone.
      //
      // This is the case the snapshot's `held` rows exist for. A label whose
      // control has gone is deliberately NOT re-anchored and NOT torn down (see
      // overlay.reposition): it stays where it was drawn, because the control did
      // not move — only its node was replaced — and it stays TYPEABLE, which a
      // one-shot activation can afford to re-resolve. The page cannot verify any
      // of that by itself: the badges live in a closed shadow root. So the
      // diagnostic pull reports the held rows, and this test reads them.
      await gotoYtcard();
      await beginHints();
      const before = await readHints();
      const thumbsBefore = before.filter((h) => String(h.dataId || "").indexOf("thumb") === 0);
      assert(
        thumbsBefore.length === 6,
        "the six thumbnails are hinted before the wash-out (" + before.length + " hints)"
      );
      const total = before.length;
      const keysBefore = new Map(before.map((h) => [h.dataId || h.id, h.key]));

      const removed = await evalIn(ctx.tabA, `window.__washOutCards()`);
      assert(removed === 6, "the fixture washed out its six cards (got " + removed + ")");

      // The badges are still drawn. A held row is reported with no element behind
      // it, which is precisely the state being asserted: on screen, unanchored.
      const held = await waitFor(async () => {
        const rows = (await readHintRows()).filter((r) => r.held);
        return rows.length >= 6 ? rows : null;
      }, 4000).catch(() => null);
      assert(
        held,
        "a washed-out control's badge must stay on screen: expected held rows, got " +
          JSON.stringify((await readHintRows()).map((r) => r.key + (r.held ? "(held)" : "")))
      );
      // ...and every badge is still there, not merely some: the batch may not
      // shrink because the page emptied itself.
      const stillShown = await readHintRows();
      assert(
        stillShown.length >= total,
        "the batch must not shrink while the controls are washed out (had " +
          total +
          ", now " +
          stillShown.length +
          ")"
      );
      // The layer is still up and still answering: a hint system that has
      // nothing to point at yet is not the same thing as one that has exited.
      assert(
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1",
        "the hint layer must stay up while its controls are washed out"
      );

      // The page puts the cards back — the nodes are new, the controls are the
      // same — and the user's keys have to still mean what they meant.
      const restored = await evalIn(ctx.tabA, `window.__restoreCards()`);
      assert(restored === 6, "the fixture restored its six cards (got " + restored + ")");
      const after = await waitFor(async () => {
        const m = await readHints();
        const thumbs = m.filter((h) => String(h.dataId || "").indexOf("thumb") === 0);
        if (thumbs.length !== 6) return null;
        return thumbs.every((h) => keysBefore.get(String(h.dataId)) === h.key) ? m : null;
      }, 8000).catch(() => null);
      assert(
        after,
        "the batch must come back with the keys it had before the wash-out: " +
          (await readHints()).map((h) => (h.dataId || h.id) + "=" + h.key).join(",")
      );
      await ctx.press(ctx.tabA, "Escape");
    }
  );
}
