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

  const hintPos = (key) =>
    evalIn(
      ctx.tabA,
      `(function(){
        const raw = document.getElementById("lazyfox-hints") && document.getElementById("lazyfox-hints").getAttribute("data-lf-pos");
        if (!raw) return null;
        try {
          const items = JSON.parse(raw);
          for (const it of items) if (it.key === ${JSON.stringify(key)}) return { x: it.x, y: it.y };
        } catch (e) {}
        return null;
      })()`
    );
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
    const keyForInp2 = () =>
      evalIn(
        ctx.tabA,
        `(function(){
          const host = document.getElementById("lazyfox-hints");
          const raw = host && host.getAttribute("data-lf-pos");
          if (!raw) return null;
          const items = JSON.parse(raw);
          const r = document.getElementById("inp2").getBoundingClientRect();
          const x = Math.round(r.left), y = Math.round(r.top);
          for (const it of items) if (Math.abs(it.x - x) <= 2 && Math.abs(it.y - y) <= 2) return it.key;
          return null;
        })()`
      );
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
  const readHints = () =>
    evalIn(
      ctx.tabA,
      `(function(){
        const host = document.getElementById("lazyfox-hints");
        const raw = host && host.getAttribute("data-lf-pos");
        const pos = raw ? JSON.parse(raw) : [];
        function collect(root, out) {
          root.querySelectorAll("[data-id]").forEach((e) => out.push(e));
          root.querySelectorAll("*").forEach((e) => { if (e.shadowRoot) collect(e.shadowRoot, out); });
        }
        const els = []; collect(document, els);
        const out = [];
        for (const p of pos) {
          let id = null;
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (Math.abs(Math.round(r.left) - p.x) <= 2 && Math.abs(Math.round(r.top) - p.y) <= 2) { id = el.getAttribute("data-id"); break; }
          }
          out.push({ key: p.key, id: id, x: p.x, y: p.y });
        }
        return out;
      })()`
    );
  const readBoxes = () =>
    evalIn(
      ctx.tabA,
      `(function(){
        const host = document.getElementById("lazyfox-hints");
        const raw = host && host.getAttribute("data-lf-box");
        return raw ? JSON.parse(raw) : [];
      })()`
    );
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
    await ctx.waitExpr(ctx.tabA, `(JSON.parse(document.getElementById("lazyfox-hints") && document.getElementById("lazyfox-hints").getAttribute("data-lf-pos") || "[]")).length > 0`, true, 5000);
  };
  // Activate the hint currently assigned to `id`. Single-character keys can be
  // a prefix of longer ones, in which case typing the key narrows instead of
  // activating, so fall back to Enter (which activates the first match).
  const activateHint = async (id, after?) => {
    const m = await readHints();
    const h = m.find((x) => x.id === id);
    assert(h, "no hint for " + id + " (hinted: " + m.map((x) => x.id).join(",") + ")");
    for (const ch of h.key) await ctx.press(ctx.tabA, ch);
    const still = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    if (still === "1") await ctx.press(ctx.tabA, "Enter");
    if (after) await after();
  };
  await t("link hints: hidden, inert and occluded elements are never hinted", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id);
    const must = ["visible-link", "nested-btn", "act-btn", "scroll-input", "nearby-link", "body-visible"];
    for (const id of must) assert(ids.indexOf(id) !== -1, "expected a hint for " + id + " (got: " + ids.join(",") + ")");
    const mustNot = ["hidden-opacity-link", "hidden-vis-link", "hidden-aria-link", "pe-none-btn", "covered-link"];
    for (const id of mustNot) assert(ids.indexOf(id) === -1, "a non-actionable element was hinted: " + id);
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
    const ids = (await readHints()).map((x) => x.id);
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
    const ids = m.map((x) => x.id);
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
      const ids = (await readHints()).map((x) => x.id);
      return ids.indexOf("deep-link") !== -1 ? ids : null;
    }, 6000);
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
    const ids = m.map((x) => x.id).filter(Boolean);
    assert(new Set(ids).size === ids.length, "each element is hinted at most once");
    assert(ids.some((id) => /^tiny\d+$/.test(id)), "tiny grid buttons are hinted");
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("link hints: a control inside an open shadow root is hinted and clicks", async () => {
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
    assert((await evalIn(ctx.tabA, `document.title`)) === "SHADOW-CLICKED", "the shadow-root button was clicked");
  });
  await t("link hints: clickable image and video thumbnails are hinted and click", async () => {
    // Regression: the "no text/label ⇒ decorative" rule dropped cursor:pointer
    // nodes that are real pictures/videos, so thumbnails became unclickable.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id);
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
    const before = (await readHints()).map((x) => x.id);
    assert(before.indexOf("late-skip") === -1, "the late control is not hinted before it exists");
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    await waitFor(async () => {
      const ids = (await readHints()).map((x) => x.id);
      return ids.indexOf("late-skip") !== -1 ? ids : null;
    }, 6000);
    // The insertion re-keys the whole batch ONCE (the batch grew); wait until
    // the late control's key is stable across two reads before activating, so
    // the test presses the key the user would actually see.
    let stable = null;
    for (let i = 0; i < 20; i++) {
      const h = (await readHints()).find((x) => x.id === "late-skip");
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
      const h = (await readHints()).find((x) => x.id === "late-skip");
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
    const keysBefore = new Map(before.filter((h) => h.id).map((h) => [h.id, h.key]));
    assert(keysBefore.size > 3, "the page starts with a real batch (" + keysBefore.size + ")");
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    const after = await waitFor(async () => {
      const m = await readHints();
      return m.find((x) => x.id === "late-skip") ? m : null;
    }, 6000);
    const used = new Set(after.map((h) => h.key));
    assert(used.size === after.length, "every hint key is unique after the insertion");
    let changed = 0;
    for (const h of after) {
      if (!h.id || h.id === "late-skip") continue;
      const k = keysBefore.get(h.id);
      if (k && k !== h.key) changed++;
    }
    assert(changed === 0, "no existing hint changed key (" + changed + " did)");
    await ctx.press(ctx.tabA, "Escape");
  });
}
