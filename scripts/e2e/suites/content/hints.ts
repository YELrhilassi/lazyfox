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
      // `covered` rides through: it is the label's own state (dimmed), pulled
      // from the overlay's snapshot, and the occlusion test asserts on it.
      return { key: p.key, id: el ? el.id : null, dataId: el ? el.dataId : null, x: p.x, y: p.y, covered: !!p.covered };
    });
  };
  // WHERE THE LABELS ARE WHEN A SCROLLED-BUT-LABELS-SAT WAIT GIVES UP. Three
  // shapes with opposite fixes: no labels (the session stood down), all labels
  // up at the top (a debounced re-hint that never ran), or a label readHints()
  // could not name (the 2px coordinate match). Read at the moment of failure;
  // the state does not survive the next keystroke.
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
  // A visible aria-hidden element IS a target (it used to be in the must-not
  // list, which made YouTube thumbnails unhintable): aria-hidden excludes a
  // node from the ACCESSIBILITY tree, not from the page — duplicate affordances
  // wear it while the accessible twin sits beside it. `hidden`/`inert` still
  // stay unpinned, together with the CSS and occlusion cases.
  // Occlusion is no longer a veto: covered-link gets a DIMMED label (plan A —
  // withholding it was the one failure the layer cannot recover from; the act
  // clicks the ELEMENT, not the point under the label). Un-hinted stays what
  // nobody can use at all: hidden, inert, visibility:hidden, opacity:0,
  // pointer-events:none.
  await t("link hints: a visible aria-hidden link is hinted; hidden, inert and pointer-dead ones are not", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await scrollDone(0);
    await beginHints();
    const rows = await readHints();
    const ids = rows.map((x) => x.id || x.dataId);
    const must = ["visible-link", "nested-btn", "act-btn", "scroll-input", "nearby-link", "body-visible", "thumbnail-link", "covered-link"];
    for (const id of must) assert(ids.indexOf(id) !== -1, "expected a hint for " + id + " (got: " + ids.join(",") + ")");
    const mustNot = ["hidden-opacity-link", "hidden-vis-link", "inert-link", "hidden-link", "hidden-shadow-inner", "pe-none-btn"];
    for (const id of mustNot) assert(ids.indexOf(id) === -1, "a non-actionable element was hinted: " + id);
    // The FLAG is the observable half of the new rule: the batch says the
    // control is covered, and that is what draws its label dimmed. A row that
    // is merely present would not distinguish "kept and dimmed" from "kept and
    // pretending nothing is over it".
    const coveredRow = rows.find((x) => (x.id || x.dataId) === "covered-link");
    assert(coveredRow && coveredRow.covered === true, "the covered control's label is flagged as dimmed");
    const plainRow = rows.find((x) => (x.id || x.dataId) === "nearby-link");
    assert(plainRow && !plainRow.covered, "an uncovered control's label is NOT dimmed: " + JSON.stringify(plainRow));
    // ...and the dimmed hint is not decoration: the key has to ACT. Activation
    // clicks the element itself, so a control under a scrim is still reachable by
    // key — which is the whole reason it is kept rather than withheld.
    await activateHint("covered-link");
    await ctx.waitExpr(ctx.tabA, `location.hash`, "#cov", 8000);
    assert(
      (await evalIn(ctx.tabA, `location.hash`)) === "#cov",
      "a covered control's key still activated it"
    );
    await ctx.press(ctx.tabA, "Escape");
  });
  // THE LEAK REPORT: "hints show from behind the elements in front of them".
  //
  // A label is drawn in the top layer, above every page stacking context, so a
  // label for a control BEHIND a dialog is painted ON the dialog. That is a
  // different case from a covered control on the same surface (the scrim band
  // above, which stays dimmed and clickable): here a separate surface replaced
  // the screen, and the control is not part of what the user is looking at.
  //
  // Both states live on one page, so the assertion cannot pass by the page
  // simply having no controls: the closed run proves they ARE hintable.
  await t("link hints: a dialog's own controls are hinted and the ones behind it are not", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/dialog`);
    await pageSettled();
    await beginHints();
    const before = (await readHints()).map((x) => x.id || x.dataId);
    for (const id of ["under1", "under2", "opener"])
      assert(before.indexOf(id) !== -1, "expected a hint for " + id + " with nothing open (got: " + before.join(",") + ")");
    await ctx.press(ctx.tabA, "Escape");
    // Open the panel, then hint again: the batch must be the dialog's, only.
    await evalIn(ctx.tabA, `window.__showDialog(); true`);
    await ctx.waitExpr(
      ctx.tabA,
      `getComputedStyle(document.getElementById("modal")).display`,
      "block",
      5000,
    );
    await beginHints();
    const after = (await readHints()).map((x) => x.id || x.dataId);
    for (const id of ["in1", "in2", "closer"])
      assert(after.indexOf(id) !== -1, "the dialog's own control must be hinted: " + id + " (got: " + after.join(",") + ")");
    for (const id of ["under1", "under2", "opener"])
      assert(after.indexOf(id) === -1, "a control BEHIND the dialog must not be hinted: " + id + " (got: " + after.join(",") + ")");
    // And it is not enough for the key to be absent: the LABEL must be absent.
    // A leaked label is the report, and it would show up as a hint row whose
    // position sits over the page content rather than inside the dialog.
    const modal = await evalIn(
      ctx.tabA,
      `(function(){ var r = document.getElementById("modal").getBoundingClientRect(); return {l:r.left,t:r.top,r:r.right,b:r.bottom}; })()`,
    );
    const rows = await readHints();
    for (const row of rows)
      assert(
        row.x >= modal.l - 2 && row.x <= modal.r + 2 && row.y >= modal.t - 2 && row.y <= modal.b + 2,
        "a hint label is drawn outside the dialog that is in front of the page: " + JSON.stringify(row),
      );
    await ctx.press(ctx.tabA, "Escape");
  });
  // The same leak, arriving late: the user is already in hints mode and the page
  // opens a dialog under them. The session sweeps the batch on DOM changes, so
  // the labels for the covered controls have to go without a new `;f`.
  await t("link hints: a dialog opened under a live batch takes its labels away", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/dialog`);
    await pageSettled();
    await beginHints();
    const keys = (await readHints()).length;
    assert(keys >= 3, "the page starts with a batch to lose (got " + keys + ")");
    await evalIn(ctx.tabA, `window.__showDialog(); true`);
    const gone = await waitFor(async () => {
      const ids = (await readHints().catch(() => [])).map((x) => x.id || x.dataId);
      const leaked = ids.filter((id) => ["under1", "under2", "opener"].indexOf(id) !== -1);
      return leaked.length === 0 && ids.length > 0 ? ids : null;
    }, 6000);
    assert(
      gone,
      "after the dialog opened, its own controls keep labels and the ones behind it lose theirs",
    );
    await ctx.press(ctx.tabA, "Escape");
  });
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
  // THE TRUST-GATED CONTROL, MEASURED against the real privileged press:
  // the #deaf control answers only event.isTrusted (YouTube's skip-button
  // behaviour) and the synthetic sequence can never satisfy it. The window
  // actor is exercised end to end — untrusted click refused, target silent,
  // privileged retry fires, and the control must actually ACT or this test
  // names the step that failed.
  await t("link hints: a trust-gated control is activated by the privileged real press", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await pageSettled();
    await beginHints();
    assert(
      (await readHints()).some((h) => h.id === "deaf"),
      "the isTrusted-gated control must be hinted"
    );
    const titleBefore = await evalIn(ctx.tabA, "document.title");
    await activateHint("deaf", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "DEAF-PRESSED", 6000);
    });
    assert(
      (await evalIn(ctx.tabA, "document.title")) === "DEAF-PRESSED",
      "a control that only answers a trusted press must be pressed for real " +
        "(title went " + JSON.stringify(titleBefore) + " -> " +
        JSON.stringify(await evalIn(ctx.tabA, "document.title")) + ")"
    );
    const act = await waitFor(async () => {
      const r = await playerReport();
      return r && r.act && "trustedRetry" in r.act ? r.act : null;
    }, 4000);
    assert(
      act && act.trustedRetry === true,
      "the report must say the privileged press WAS attempted (the actor is " +
        "listening): got " + JSON.stringify(act)
    );
    assert(
      act && act.ignored === false,
      "and the press that worked must be recorded as a success, not an ignore: " +
        JSON.stringify(act)
    );
  });
  // The same question with the forensics attached. /trustgate answers only a
  // trusted press AND records every pointer event it was offered, so a
  // failure names its own step: no entries means the real press never fired,
  // trusted:false entries means only the synthetic sequence ran, trusted:true
  // entries with no title change means the press landed at the wrong point —
  // and the recorded coordinates say where it went instead.
  await t("link hints: the privileged press reaches a trust-gated control with genuinely trusted events", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/trustgate`);
    await pageSettled();
    await beginHints();
    const rows = await readHints();
    assert(rows.some((x) => (x.id || x.dataId) === "gate"), "the gate button must be hinted");
    await activateHint("gate", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "GATE-OPEN", 6000);
    });
    assert(
      (await evalIn(ctx.tabA, `document.title`)) === "GATE-OPEN",
      "the trust-gated control must be activated for real"
    );
    const seen = JSON.parse(String(await evalIn(ctx.tabA, `JSON.stringify(window.__gate || [])`)));
    const trusted = (seen || []).filter((e: { trusted: boolean }) => e.trusted);
    assert(
      trusted.length >= 3,
      "the page must be offered the real pointer sequence (down+up and the click " +
        "it derives), not only untrusted synthetic events: " + JSON.stringify(seen)
    );
    assert(
      trusted.some((e: { type: string }) => e.type === "mousedown") &&
        trusted.some((e: { type: string }) => e.type === "mouseup"),
      "the trusted press must be a down-and-up pair: " + JSON.stringify(trusted)
    );
    await ctx.press(ctx.tabA, "Escape");
  });
  // THE AD'S SKIP CONTROL, in the shape the site actually has (pages.ts
  // /adplayer, measured on youtube.com): the button flips a PRESSED CLASS for any
  // press at all, and only the ad going away is gated on a trusted one, on a page
  // that is mutating continuously. Both halves of the verdict are satisfied by the
  // cosmetic flip and the player's own clock, so the privileged retry never fired
  // and the press was reported as a success while the ad kept playing.
  await t("link hints: the ad's Skip control is pressed for real, not just given a pressed class", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/adplayer`);
    await pageSettled();
    await beginHints();
    // The control is addressed by its ID, because that is what the real widget
    // carries (`skip-button:2`) and what the label maps to.
    const rows = await readHints();
    assert(
      rows.some((x) => (x.id || x.dataId) === "skip-button:2" || (x.id || x.dataId) === "skip-ad"),
      "the Skip control must be hinted (got: " + rows.map((x) => x.id || x.dataId).join(",") + ")"
    );
    assert(
      (await evalIn(ctx.tabA, `window.__adOn()`)) === true,
      "the fixture must start with the ad playing"
    );
    await activateHint((rows.find((x) => (x.id || x.dataId) === "skip-button:2" || (x.id || x.dataId) === "skip-ad") || {}).id || "skip-ad", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "AD-SKIPPED", 6000);
    });
    assert(
      (await evalIn(ctx.tabA, `document.title`)) === "AD-SKIPPED",
      "one press on the Skip hint must skip the ad: the control acts only on a " +
        "trusted press, and it flips a cosmetic class on every press so the " +
        "target's own signal is not evidence"
    );
    const seen = JSON.parse(String(await evalIn(ctx.tabA, `JSON.stringify(window.__skipSeen || [])`)));
    assert(
      (seen || []).some((e: { trusted: boolean }) => e.trusted === true),
      "the page must be offered a genuine press, not only the synthetic sequence: " + JSON.stringify(seen)
    );
    await ctx.press(ctx.tabA, "Escape").catch(() => {});
  });
  // AND ONCE, which is the hazard the real press trades against: a toggle in the
  // player's overlay must end up flipped, not flipped twice back to where it was.
  await t("link hints: a player toggle in the same overlay is pressed exactly once", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/adplayer`);
    await pageSettled();
    await beginHints();
    const rows = await readHints();
    const mute = rows.find((x) => (x.id || x.dataId) === "mute-button:3" || (x.id || x.dataId) === "mute");
    assert(mute, "the player's own toggle must be hinted (got: " + rows.map((x) => x.id || x.dataId).join(",") + ")");
    await activateHint(mute.id || "mute", async () => {
      await waitFor(async () =>
        (await evalIn(ctx.tabA, `document.getElementById("mute-button:3").getAttribute("aria-pressed")`)) === "true"
          ? true
          : null, 4000);
    });
    const presses = Number(await evalIn(ctx.tabA, `window.__mutePresses`));
    assert(
      presses === 1,
      "one hint press must be one press on the control (got " + presses + "): the real press replaces the synthetic one, it is not added to it"
    );
    assert(
      (await evalIn(ctx.tabA, `document.getElementById("mute-button:3").getAttribute("aria-pressed")`)) === "true",
      "a toggle must end up flipped, not flipped twice"
    );
    await ctx.press(ctx.tabA, "Escape").catch(() => {});
  });
  // The negative branch, in the same environment: a control NO press reaches
  // (#stone has no listener at all, so even a genuinely trusted press does
  // nothing) is still reported to the user rather than swallowed in silence.
  // The retry is attempted and the page stays silent — “trustedRetry: true,
  // ignored: true” is exactly the “not a control” diagnosis the tri-state
  // trustedRetry exists to carry.
  await t("link hints: a click the page ignores is reported, not silent", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await pageSettled();
    await beginHints();
    assert(
      (await readHints()).some((h) => h.id === "stone"),
      "the unlistenened control must be hinted"
    );
    await activateHint("stone", async () => {
      // The escalation adds one extra watch window after the real press.
      await waitFor(async () => {
        const r = await playerReport();
        return r && r.act && r.act.ignored && r.act.trustedRetry === true ? r.act : null;
      }, 6000);
    });
    const act = await waitFor(async () => {
      const r = await playerReport();
      return r && r.act && r.act.ignored ? r.act : null;
    }, 4000);
    assert(
      /no listener/i.test(act.target),
      "the report must name the control that was ignored (got: " + JSON.stringify(act) + ")"
    );
    assert(
      act.trustedRetry === true,
      "with the actor listening the report must say the trusted press was " +
        "attempted and STILL got nothing — that is the “not a control” verdict " +
        "(got: " + JSON.stringify(act) + ")"
    );
  });
  // THE PRESS THAT UNDID ITSELF. A control whose effect lands elsewhere — a
  // search field, a modal opener, a sidebar's collapse button — leaves its own
  // class and ARIA state alone, so "the target was silent" says nothing about
  // whether the press worked. Judged on that alone, the privileged retry fired a
  // watch window later and toggled the control BACK: the field opened and
  // closed, the modal appeared and vanished, the sidebar shrank and grew again.
  // One press, counted twice, is the whole bug.
  const awayReport = async () =>
    await evalIn(
      ctx.probe,
      `(async function () {
         var tabs = await browser.tabs.query({});
         for (const t of tabs) {
           try {
             var res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
             var r = res && res.report;
             if (r && r.url && r.url.indexOf("/toggleaway") !== -1) return r.hints.lastActivation || null;
           } catch (e) { /* no content script in that tab */ }
         }
         return null;
       })()`,
    );
  await t("link hints: a control whose effect is elsewhere is pressed once, not twice", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/toggleaway`);
    await pageSettled();
    await beginHints();
    await activateHint("open");
    // The verdict is written when the watch window closes, which is the last
    // moment a retry could be sent. Waiting for IT (rather than sleeping) is
    // what makes "no second press" a measurement instead of a race.
    const act = await waitFor(async () => await awayReport(), 6000).catch(() => null);
    assert(act, "the activation must be reported");
    const presses = Number(await evalIn(ctx.tabA, `window.__away.open`));
    assert(
      presses === 1,
      "one hinted press must reach the control exactly once (got " + presses +
        "): the retry must not fire after a press the page already acted on — " +
        JSON.stringify(act),
    );
    const off = await evalIn(ctx.tabA, `document.getElementById("bar").classList.contains("off")`);
    assert(off === false, "the revealed panel must STAY revealed (it was toggled back)");
    assert(
      act.ignored === false,
      "a press the page acted on is a success, not an ignore: " + JSON.stringify(act),
    );
  });
  // The same rule where the whole reaction is ONE class flip on <body>, which is
  // the least visible page change there is — and therefore the one most easily
  // mistaken for "nothing happened".
  await t("link hints: a sidebar collapse driven by a class flip is pressed once", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/toggleaway`);
    await pageSettled();
    await beginHints();
    await activateHint("side-btn");
    const act = await waitFor(async () => await awayReport(), 6000).catch(() => null);
    assert(act, "the activation must be reported");
    const presses = Number(await evalIn(ctx.tabA, `window.__away.side`));
    assert(
      presses === 1,
      "one hint press must be one press on a class-only toggle (got " + presses + ") — " + JSON.stringify(act),
    );
    assert(
      (await evalIn(ctx.tabA, `document.body.classList.contains("side-min")`)) === true,
      "the sidebar must stay collapsed, not shrink and grow back",
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
  // What the page actually receives, measured rather than assumed:
  // the click's trust origin, mouseup buttons:0 (a real release), and
  // mousedown/click sharing an event.target — a fix differs completely
  // between a trust problem (needs a privileged path) and a press-state
  // problem (needs correct event state).
  //
  // MEASURED ON A CONTROL OUTSIDE THE PLAYER'S BOX (#plain), because that is
  // where the synthetic sequence is still the route. Inside the player's video
  // box the press is a real one by policy (escalate.pressForReal), which is the
  // /adplayer test's subject and would make the trust fact below unobservable —
  // exactly the mistake this test exists to avoid making about the product.
  await t("link hints: the page receives a trusted, well-formed click", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await pageSettled();
    await beginHints();
    await activateHint("plain");
    // Wait for the full pointer sequence to land on the page instead of
    // sleeping: the fixture records every event into window.__clicks.
    const seen = await waitFor(async () => {
      const log = JSON.parse(String(await evalIn(ctx.tabA, `JSON.stringify(window.__clicks || [])`)) || "[]");
      return log.some((e) => e.type === "click") && log.some((e) => e.type === "mouseup") && log.some((e) => e.type === "mousedown") ? log : null;
    }, 5000);
    assert(seen.length >= 8, "expected the full pointer/mouse sequence, got " + JSON.stringify(seen));
    const click = seen.find((e) => e.type === "click");
    assert(!!click, "no click reached the page: " + JSON.stringify(seen));  // MEASURED, not assumed: the click arrives UNTRUSTED even though it comes
  // from HTMLElement.click() — Gecko does not synthesise .click() with
  // isTrusted true in a content script, contrary to the usual folklore. So
  // YouTube's skip button is not fixed by trust here (that needs the actor's
  // privileged path); what this pins is the event STATE: mouseup buttons:0,
  // mousedown buttons:1, and down/up sharing an event.target. If trusted
  // ever becomes true, the actor path in actor-child.ts can be dropped —
  // and this assertion would need updating.
    assert(
      click.trusted === false,
      "the click is expected to arrive UNTRUSTED. If this ever becomes " +
        "true, the privileged path in actor-child.ts can be dropped as " +
        "unnecessary — and this assertion will need updating, because the " +
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
  // The press-state-machine case: a widget that commits only when it has seen
  // a pointer go down AND released — decided from event.buttons. The old
  // sequence passed buttons:1 to mouseup too, so the release never read as one
  // and the control silently did nothing (the player-overlay shape).
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
    // The grid is 100 buttons and most of them are in view, so this is also the
    // page where the batch cap binds: `;f` must SAY so instead of silently
    // leaving the rest without keys. Start listening before the press, because
    // the toast lives for about a second and `beginHints` waits for the batch.
    const capToast = ctx.waitToast(ctx.tabA, /more in view/, 8000).catch(() => "");
    await beginHints();
    const said = await capToast;
    assert(
      /^80 hints \u2014 \d+ more in view, ] for the next batch$/.test(said),
      "the cap is reported with both numbers, got: " + JSON.stringify(said)
    );
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

  // THE FEED-SIZE SHAPE. "A control in a closed root is found" is covered
  // above; this covers "found in time": a feed-sized DOM (the /carousel fixture
  // carries 17 000 light-DOM rows) exhausts the discovery budget before it
  // reaches the tail, and the per-root query cannot see into a shadow root, so
  // the walk must survive to the hosts. Real pages: Reddit image carousel and X
  // viewer prev/next arrows inside closed-shadow custom elements.
  await t("link hints: carousel prev/next in closed shadow roots late in a feed-sized DOM are hinted and click", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/carousel`);
    await pageSettled();
    await beginHints();
    const rows = await readHints();
    const ids = rows.map((x) => x.id || x.dataId);
    // The rows are keyed by the HOSTS: a closed root hides its button's
    // data-id from the page realm, and what is observable is the host element —
    // which innerBounds() reproduces the button's box for. A hint on the host
    // IS a hint on the button: the label sits on the one element the page can
    // name for a control it cannot reach itself.
    for (const id of ["caro-prev", "caro-next"]) {
      const row = rows.find((x) => (x.id || x.dataId) === id);
      assert(row, "the " + id + " button got a hint (hinted: " + ids.join(",") + ")");
    }
    // And it is a working key, not just a label: activate the next-arrow and
    // wait for the click the closed-root button reports through document.title.
    await activateHint("caro-next", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "CAROUSEL-NEXT", 5000);
    });
    assert((await evalIn(ctx.tabA, `document.title`)) === "CAROUSEL-NEXT", "the closed-root carousel button was clicked");
    await ctx.press(ctx.tabA, "Escape");
  });

  // THE HIDDEN-UNTIL-SKIPPABLE SHAPE. The late-inserted Skip button test (below)
  // covers a control that ARRIVES by mutation; YouTube's skip control is the
  // other shape: present in the DOM from the start — inside a display:none slot
  // that un-hides when the skip window opens, an attribute change only. Nothing
  // childList can observe; the pool built by ;f rejected it while its box was
  // empty unless the pool refresh is owed even without a mutation.
  await t("link hints: a Skip button hidden in the ad slot until the skip window opens still gets a key (attribute-only reveal)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/adskip`);
    await pageSettled();
    // Open hints while the button is still un-presentable, exactly the real
    // sequence: the user presses ;f while the countdown is running.
    await beginHints();
    const before = await readHints();
    assert(before.every((x) => (x.id || x.dataId) !== "skip-ad"), "the hidden Skip button got no hint while its slot is display:none");
    const row = await waitFor(async () => {
      const r = await readHints();
      return r.find((x) => (x.id || x.dataId) === "skip-ad") || null;
    }, 10000);
    assert(row, "the Skip button got a hint after its attribute-only un-hide");
    await activateHint("skip-ad", async () => {
      await ctx.waitExpr(ctx.tabA, `document.title`, "AD-SKIPPED", 5000);
    });
    assert((await evalIn(ctx.tabA, `document.title`)) === "AD-SKIPPED", "the revealed Skip button was clicked by its key");
    await ctx.press(ctx.tabA, "Escape");
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
  // THE REPEAT REPORT, VERBATIM: ";f -> esc ;f -> esc repeatedly breaks the
  // hints or the whole software". One session is not the claim — the claim is
  // that a session LEAVES SOMETHING BEHIND. Every cycle is asked the same two
  // questions (does the batch draw; does it still read a key) and the run ends
  // on the one a drawn-but-deaf layer cannot answer: does a key ACT.
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
  // PAGING MOVES WHAT THE USER IS LOOKING AT: `]` / `[` / Tab scroll the
  // region the scroll keys target, not `window`. A shell page with an inner
  // pane (never moves) reported "no more links" over a pane full of them
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
  // THE LAYER MUST NOT OUTLIVE THE KEYBOARD. The content script is
  // top-frame-only, so once focus moves into a frame every key goes to the
  // FRAME's document: the batch cannot be typed into and Escape cannot reach
  // it — the report "hints got stuck and I can't get rid of them". The test
  // drives the frame itself and logs the parent's focus events.
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
  // exclude anything. `inert` is the stronger fixture: it
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
  // `;W m` arms a digit capture whose handler DECLINES non-digit keys. Hosts
  // used to consume the key anyway, hiding the decline. The observable proof
  // is the leader key itself: after a declined `;`, `;` must still arm.
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
      // "The hints got stuck and unresponsive" is a main-thread claim, and the
      // fixture's own 50ms timer is the honest way to test it. THE GAP IS THE
      // TEST: rebuilding the cards in ONE task made this untestable (the
      // replacements were already in the pool at the same coordinates before
      // any pass ran), so the fixture washes out and re-hydrates on a LATER
      // task, like a virtual list does — in that window every hinted node is
      // gone, forcing re-resolution back to the document once per item
      // per-frame unless collection is opt-in.
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
      // A FIXED WINDOW of wall time, measured on the page's own clock —
      // waiting for "N beats" absorbed the symptom (a starved timer reaches N,
      // just slowly). CALIBRATED on this fixture:
      //   resolution re-collects per item per frame: 37-40 ticks, 336-358ms gap
      //   re-collection is opt-in (shipped):         51 ticks,  61ms max gap
      // 90% of the expected ticks sits above the broken range and below the
      // shipped number; the gap bound below is the second, independent signal.
      const CHURN_MS = 2500;
      const BEATS_EXPECTED = Math.floor(CHURN_MS / 50); // 50 ticks
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
      // showing up". This is the case the snapshot's `held` rows exist for: a
      // label whose control has gone is NOT re-anchored and NOT torn down — it
      // stays where it was drawn (the control did not move, only its node) and
      // stays TYPEABLE. The page cannot see its own closed shadow root, so the
      // diagnostic pull reports held rows and this test reads them.
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

  // A TRUNCATED RE-COLLECT MUST NOT TAKE A LABEL THE PAGE IS STILL SHOWING.
  // The live sweep measured the reported case A on github.com pressed mid-load:
  // a `<video>` that only the expensive collection tier can collect was hinted
  // at `;f`, still on screen seconds later, and its label was gone. The reason
  // was the REFRESH, not the page: every re-collect walks on a wall-time budget
  // and a node cap, and once something walk-slow sits before the video in the
  // DOM the pool drops it — and the old viewport swap adopted that partial pool
  // wholesale, tearing the label off a control the page had never moved, hidden
  // or removed.
  //
  // /truncrefresh makes the shape deterministic: the video is hinted while the
  // document is cheap, then a 46k-node cursor:pointer wall is inserted BEFORE it
  // in document order — beyond the walk's own MAX_SCAN cap — so every refreshed
  // pool is truncated before it can reach the video. What must still hold: the
  // label, its key, and the rest of the batch.
  await t(
    "link hints: a truncated re-collect must not take a label the page is still showing",
    async () => {
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/truncrefresh`);
      await pageSettled();
      await beginHints();
      const first = await readHints();
      const video0 = first.find((x) => (x.id || x.dataId) === "bigvideo");
      assert(
        video0,
        "the video is hinted before the wall exists (got: " +
          first.map((x) => x.id || x.dataId).join(",") + ")"
      );
      const keys0 = new Map(first.map((x) => [x.id || x.dataId, x.key]));

      // The wall goes in; the page does not move the video (it is fixed) and
      // does not hide it — the only thing that changed is that the REFRESH has
      // to walk 46k nodes to reach it.
      const inserted = await evalIn(ctx.tabA, `window.__bulkUp()`);
      assert(inserted === 3000, "the fixture inserted its wall (got " + inserted + ")");

      // The first re-batch window: DOM_RESYNC_DELAY is 300ms with a 1s cap.
      await new Promise((r) => setTimeout(r, 1250));
      const rows1 = await readHints();
      const video1 = rows1.find((x) => (x.id || x.dataId) === "bigvideo");
      assert(
        video1 && video1.key === video0!.key,
        "the video's label survived the first truncated re-collect, under the key it had " +
          "(got: " + rows1.map((x) => (x.id || x.dataId) + "=" + x.key).join(",") + ", key was " + video0!.key + ")"
      );

      // ...and the SECOND refresh (POOL_RESYNC_MS window): a truncation is not
      // a one-frame accident, so it must hold across every refresh, not just
      // the first.
      await new Promise((r) => setTimeout(r, 2200));
      const rows2 = await readHints();
      const video2 = rows2.find((x) => (x.id || x.dataId) === "bigvideo");
      assert(
        video2 && video2.key === video0!.key,
        "the video's label survived the pool-resync window too " +
          "(got: " + rows2.map((x) => (x.id || x.dataId) + "=" + x.key).join(",") + ")"
      );
      // The rest of the batch was never reshuffled by the merge: the same hints
      // under the same keys, which is what a refresh owes the user who read
      // them.
      let reshuffled = 0;
      for (const row of rows2) {
        const id = row.id || row.dataId;
        if (!id || id === "bigvideo") continue;
        const k = keys0.get(id);
        if (k && k !== row.key) reshuffled++;
      }
      assert(reshuffled === 0, "the existing hints never changed key (" + reshuffled + " did)");
      // And the layer stays up and typeable: a batch that survives must still be
      // a batch, not a frozen shell.
      assert(
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`)) === "1",
        "the hint layer must still be armed after the truncated refreshes"
      );
      await ctx.press(ctx.tabA, "Escape");
    }
  );
}
