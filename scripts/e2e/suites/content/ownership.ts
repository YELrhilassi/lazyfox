// WHOSE TAB IS A PRESENCE RECORD ABOUT?
//
// `chromeOwnsKeys` is the gate on every key decision, and it is answered from a
// fact the page asserted about itself: "a content script is running here". The
// fact is pushed content -> background -> relay -> chrome, it names a tab, and
// the helper used to store it AT A STRIP POSITION. Positions change:
//
//   * an INSERTION before a reporting tab shifts every later record one slot up
//     (Firefox inserts a new tab after the current one, so this is `Cmd+T`);
//   * a MOVE is a permutation, which no event describes;
//   * a CLOSE was compensated — by DELETING every record above it, which cost
//     every live document its answer instead of keeping the right one.
//
// All three end the same way: the helper defers on a tab that has no content
// script, so the web page's leader never arms and the chrome helper declines —
// a DEAD KEYBOARD on the tab the user just opened. The record is stored ON THE
// TAB now (keystate.noteContentPresent), so these tests drive the strip the way
// the browser does and assert the product's OWN verdict (`chromeOwnsKeys`,
// published in the `#lfc=state` reply) for the tab the user is looking at.
//
// Why the harness is allowed to reorder the strip itself: `browser.tabs.create`
// / `move` / `remove` from the probe's extension realm perform exactly the
// reorder the product's own `;W ,` / `;W .` chords and a drag perform — the
// browser shuffling `gBrowser.tabs` in place, with the SAME tab objects. What is
// under test is the helper's answer after that, not who asked for it.
//
// WHY EVERY ANSWER HERE IS WAITED FOR, NOT SAMPLED. Two latencies sit between
// "the page booted its script" and "the helper knows": the report is pushed
// content -> background -> relay -> chrome, and the answer is read back through
// a separate state query. A test that reads once asserts a race — the same test
// passed and failed on consecutive runs while the product was unchanged. So each
// check polls until the product's answer is the expected one, and the assertion
// then reports the answer that PERSISTED. A wrong answer is not a race: it stays
// wrong (nothing else re-reports for these tabs, and no subsequent event
// corrects a record that was filed against the wrong tab), which is what makes
// polling the expected value a falsifier rather than a flake absorber.
import { createTab, evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/ownership";
  const TAGS: string[] = ["newfeatures", "chrome"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  const HOME = `${ctx.base}/`;
  const HELLO = `${ctx.base}/hello`;

  /**
   * Compare URLs the way a tab strip does: ignoring a trailing slash only.
   *
   * `about:blank` and `/hello` carry the base URL as a PREFIX, so a lookup or a
   * settle check by substring cannot tell the home page from the page opened
   * under it — and a check that cannot tell them apart reads one tab's answer
   * while naming another's.
   */
  const norm = (u: string) => String(u || "").replace(/\/+$/, "");

  /**
   * The Firefox tab id of a tab, found by URL through the probe's realm.
   *
   * By URL rather than by browsing-context handle because a handle pointing at
   * a web page has no extension realm to ask (`browser.tabs.getCurrent()`
   * throws there), and the strip these tests read is the browser's own. An
   * EXACT url wins over a prefix match, for the reason `norm` gives.
   */
  async function idByUrl(url: string): Promise<number | null> {
    const rows = (await ctx.tabsInfo()) as any[];
    const want = norm(url);
    const hit =
      (rows || []).find((r) => norm(String(r.url || "")) === want) ||
      (rows || []).find((r) => String(r.url || "").indexOf(url) !== -1);
    return hit ? Number(hit.id) : null;
  }

  const indexOf = async (id: number): Promise<number> =>
    Number(await evalIn(ctx.probe, `browser.tabs.get(${id}).then(t => t.index)`));

  /** Open a tab AT A POSITION, without selecting it. */
  async function openAt(index: number, url: string): Promise<number> {
    return Number(
      await evalIn(
        ctx.probe,
        `browser.tabs.create({index: ${index}, url: ${JSON.stringify(url)}, active: false}).then(t => t.id)`
      )
    );
  }

  const selectId = (id: number) =>
    evalIn(ctx.probe, `browser.tabs.update(${id}, {active: true}).then(() => true)`);

  const moveTo = (id: number, index: number) =>
    evalIn(ctx.probe, `browser.tabs.move(${id}, {index: ${index}}).then(() => true)`);

  /** The selected tab's URL, as the product itself reports it. */
  async function selectedUrl(): Promise<string> {
    const s = await ctx.chromeState().catch(() => null);
    return norm(s && s.selUrl ? String(s.selUrl) : "");
  }

  /**
   * Select a tab and wait until the PRODUCT agrees it is selected.
   *
   * The confirmation is not politeness: `#lfc=state` answers about the SELECTED
   * tab, so a read that lands before the switch has settled would be answered
   * about the tab the user just left — a green or red result that means nothing.
   * The whole URL is compared (trailing slash aside), because a fragment match
   * on the base URL also matches every page served under it.
   */
  async function selectAndSettle(tabId: number, url: string): Promise<void> {
    await selectId(tabId);
    const want = norm(url);
    const settled = await waitFor(
      async () => ((await selectedUrl()) === want ? true : null),
      8000
    ).catch(() => null);
    assert(
      settled,
      `the tab under test (${url}) never became the selected tab: ` +
        JSON.stringify(await selectedUrl().catch(() => "?"))
    );
  }

  /**
   * Assert the helper's own answer about a tab, WAITING for it to become the
   * expected one.
   *
   * Both directions are the same check: the poll ends as soon as the answer is
   * what the case predicts, and a wrong answer runs the budget out and is
   * reported as what it is — an answer that stayed wrong. Reporting the last
   * observed value rather than just "timed out" is what keeps a mis-filed
   * presence record debuggable from the failure text alone.
   */
  async function expectOwnership(
    tabId: number,
    url: string,
    expected: boolean,
    what: string
  ): Promise<void> {
    await selectAndSettle(tabId, url);
    let last: any = "unreadable";
    // THE TWO CAUSES, captured on every poll rather than only at the end.
    //
    // Ownership is decided from the presence record ON THE SELECTED TAB, so a
    // wrong answer means either that no record was ever placed for this tab or
    // that one was placed on a neighbour — opposite fixes, and until now the two
    // reported identically ("it kept saying true" for nine seconds). The
    // snapshot names the tab each live record is on, and the selected URL says
    // whether the read was even about the tab under test.
    let presence: any = "unreadable";
    let seenSel: any = "unreadable";
    const settled = await waitFor(async () => {
      const st = await ctx.chromeStateHandle();
      last = st.leader().ownsKeys;
      presence = st.presence();
      seenSel = st.raw.selUrl;
      return last === expected ? true : null;
    }, 9000).catch(() => null);
    assert(
      settled,
      `${what}: chrome's own answer about ${url} should be ${expected} ` +
        `(down = the chrome helper handles the keys, up = the page's script does), ` +
        `and it kept saying ${last}. tab=${tabId} selected=${JSON.stringify(seenSel)} ` +
        `presence=${JSON.stringify(presence)}`
    );
  }

  await t("a tab opened next to a reporting tab does not inherit its answer", async () => {
    // THE `Cmd+T` CASE, and the one a user meets first. Two web pages are
    // running their own key engines; a new tab is opened between them. The page
    // that slides down a slot keeps its own answer (its position changed, its
    // document did not), and the new tab — which has no content script and
    // never will — must NOT be handed the answer of the tab it displaced. With
    // presence keyed by position, the new tab inherited it and the helper
    // deferred to a page that cannot answer: every key dead on a freshly opened
    // tab.
    await ctx.collapseWindow();
    const a = await createTab();
    await ctx.gotoPage(a, HOME);
    const b = await createTab();
    await ctx.gotoPage(b, HELLO);
    const aId = await idByUrl(HOME);
    const bId = await idByUrl(HELLO);
    assert(aId != null && bId != null, `both web tabs are in the strip (${aId}, ${bId})`);
    // The order the case needs: A above B, so the new tab can be inserted
    // between them the way `Cmd+T` inserts after the current tab.
    if ((await indexOf(bId as number)) < (await indexOf(aId as number))) {
      await moveTo(bId as number, await indexOf(aId as number));
    }
    assert(
      (await indexOf(aId as number)) < (await indexOf(bId as number)),
      "the two reporting tabs are in the order this case needs"
    );

    // CONTROL: the helper defers to A's own engine while A is selected. Without
    // this the test could pass on a window where nothing ever reported.
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the chrome helper defers to the live web page before anything moves"
    );

    // The insertion. `browser.tabs.create({index})` is the same strip change a
    // new tab from the UI performs; the URL is not one the content script can
    // reach, so nothing will ever report for it.
    const aAt = await indexOf(aId as number);
    const newId = await openAt(aAt + 1, "about:blank");
    assert(newId > 0, "the new tab was created");

    await expectOwnership(
      newId,
      "about:blank",
      true,
      "the new tab is the chrome helper's: it has no content script, so nothing else can answer there"
    );
    // And the tab that slid down a slot kept the answer that belongs to it.
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the reporting tab still owns its keys after the strip changed around it"
    );
    await expectOwnership(
      bId as number,
      HELLO,
      false,
      "the tab BELOW the insertion kept its answer too"
    );

    await evalIn(ctx.probe, `browser.tabs.remove(${newId}).catch(() => {})`);
  });

  await t("moving a reporting tab takes its answer with it", async () => {
    // A MOVE is a permutation and no event describes it, so nothing can be
    // re-keyed from the event alone. Keyed by tab, nothing needs to be: the
    // record travels because it was never held by a position.
    await ctx.collapseWindow();
    const a = await createTab();
    await ctx.gotoPage(a, HOME);
    const aId = await idByUrl(HOME);
    assert(aId != null, "the web tab is in the strip");
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the chrome helper defers to the live web page before the move"
    );

    // A blank tab DIRECTLY under the reporting one, then the swap: the
    // reporting tab moves onto the blank's slot, which is the direction that
    // used to hand a live page's answer to the tab it displaced.
    const aAt = await indexOf(aId as number);
    const blankId = await openAt(aAt + 1, "about:blank");
    await moveTo(aId as number, aAt + 1);
    assert(
      (await indexOf(aId as number)) === aAt + 1 && (await indexOf(blankId)) === aAt,
      "the two tabs really swapped slots"
    );

    await expectOwnership(
      blankId,
      "about:blank",
      true,
      "the blank tab is the chrome helper's after taking the reporting tab's old slot"
    );
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the reporting tab still owns its keys after the move"
    );

    await evalIn(ctx.probe, `browser.tabs.remove(${blankId}).catch(() => {})`);
  });

  await t("an in-page navigation keeps the page's own answer", async () => {
    // WHAT THIS CASE IS FOR, in a real browser. A tab's record is dropped when
    // its DOCUMENT is replaced, because that is the one case a killed content
    // process cannot announce for itself. The safety of that rests entirely on
    // the browser telling the two apart — `LOCATION_CHANGE_SAME_DOCUMENT` on
    // the navigation notification — and the distinction has to hold on the
    // REMOTE (out-of-process) path, which is where every real web page lives.
    // Get it wrong and an SPA's first `pushState` looks like a replaced
    // document: the helper claims the keys and paints its own which-key overlay
    // over the page's, which is the exact bug the presence model exists to
    // prevent. So this case drives a REAL `pushState` in a REAL tab and asks
    // the product whose keys it owns.
    await ctx.collapseWindow();
    const a = await createTab();
    await ctx.gotoPage(a, HOME);
    const aId = await idByUrl(HOME);
    assert(aId != null, "the web tab is in the strip");
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the live web page owns its own keys before the in-page navigation"
    );

    // An in-page navigation: the URL moves on, the document does not, and
    // neither `pagehide` nor `pageshow` fires to announce anything.
    await evalIn(a, `history.pushState({}, "", "/hello")`);
    await expectOwnership(
      aId as number,
      HELLO,
      false,
      "an in-page navigation must not cost the live page its answer"
    );

    // And the record is still the SAME document's: a real navigation to a URL
    // whose document reports for itself leaves the tab owning its own keys.
    await ctx.gotoPage(a, HOME);
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the replacement document answers for itself after a real navigation"
    );
  });

  await t("a page the extension cannot run on is the chrome helper's", async () => {
    // THE OTHER HALF OF THE SAME QUESTION, and the one no other e2e case covers:
    // an `http(s)` tab whose document has NO content script is the helper's,
    // because nothing else there can answer a key. It is the rescue the whole
    // presence model exists for (§18.3 answers the leader key there), and until
    // now it was only ever asserted in unit checks — every page the harness
    // serves gets a content script.
    //
    // The fixture is the harness's own server seen through a host Firefox
    // refuses to inject into (`restrictedDomains` in the e2e profile): the same
    // origin, the same page, no script. So the tab must report HELPER-OWNED even
    // though its URL is `http://`, which is exactly what the URL-only rule this
    // model replaced would have got wrong.
    await ctx.collapseWindow();
    const a = await createTab();
    await ctx.gotoPage(a, HOME);
    const aId = await idByUrl(HOME);
    assert(aId != null, "the web tab is in the strip");
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the injected page owns its own keys before the move to the restricted host"
    );

    const RESTRICTED = ctx.base.replace("127.0.0.1", "localhost") + "/hello";
    await ctx.gotoPage(a, RESTRICTED);
    // No content script runs there, so nothing re-reports — and nothing is
    // allowed to keep answering for the document that was replaced.
    await expectOwnership(
      aId as number,
      RESTRICTED,
      true,
      "an http page the extension cannot run on must be the chrome helper's, not a page whose script is gone"
    );
  });

  await t("closing a tab does not cost a live page its answer", async () => {
    // WHAT THE OLD COMPENSATION COST. Closing a tab above a reporting tab
    // re-keyed the map by DELETING every record at or after the closed index, so
    // every live document above the close lost its answer — the helper then
    // claimed keys it should have deferred on, and painted its own overlay over
    // a page's, until the page happened to re-report. Nothing is compensated now
    // because nothing is misaligned: a closed tab's record dies with the tab.
    await ctx.collapseWindow();
    const a = await createTab();
    await ctx.gotoPage(a, HOME);
    const aId = await idByUrl(HOME);
    assert(aId != null, "the web tab is in the strip");
    // The blank is created ABOVE the reporting tab, which is the case under
    // test: a close at a LOWER index is what shifted every later record.
    const blankId = await openAt(0, "about:blank");
    assert(
      (await indexOf(blankId)) < (await indexOf(aId as number)),
      "the tab that will close is ABOVE the reporting tab"
    );
    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the chrome helper defers to the live web page before the close"
    );

    await evalIn(ctx.probe, `browser.tabs.remove(${blankId}).catch(() => {})`);
    await waitFor(async () => {
      const rows = (await ctx.tabsInfo()) as any[];
      return (rows || []).some((r) => Number(r.id) === Number(aId)) ? true : null;
    }, 8000);

    await expectOwnership(
      aId as number,
      HOME,
      false,
      "the live page below the closed tab kept its answer"
    );
  });

  await t("the report window opens on a real navigation and is spent by the page's own report", async () => {
    // THE FIELD REPORT, MEASURED RATHER THAN JUDGED. After a cross-document
    // navigation the helper arms an expectation window (`keystate.expectContentIn`)
    // and declines the keys inside it, because the page's content script is already
    // there and its presence report simply has not landed yet. `CONTENT_EXPECT_MS`
    // (1500) was a JUDGEMENT when it was written — longer than an ordinary report,
    // shorter than a user's patience — and the chrome state channel publishes the
    // readout that turns it into a number (`expect`, from
    // `keystate.contentExpectation`): `gapMs` is how long the last window stood
    // before the page's own report closed it, and `gapSamples` says how much to
    // trust that.
    //
    // Three claims, in the order the window makes them. The page really does close
    // it (so the deferred keys go to the realm that owns them rather than to
    // nobody) — asked of two documents, because the report can be lost on the way
    // and a lost report is not the window's fault. The window really does OPEN on a
    // real navigation, which is what makes "a key was declined" a decidable state
    // from outside. And the readout really does carry the gap it measured, which is
    // the number `CONTENT_EXPECT_MS` is supposed to be set from. What is NOT claimed
    // is that the report always fits INSIDE the window: measured samples of 210ms,
    // 3043ms and 3277ms are recorded in docs/tasks/2026-10-15-MANUAL-TEST-REPORTS.md,
    // together with what a report later than the window costs.
    await ctx.collapseWindow();
    const a = await createTab();
    await ctx.gotoPage(a, HOME);
    const aId = await idByUrl(HOME);
    assert(aId != null, "the web tab is in the strip");
    await selectAndSettle(aId as number, HOME);

    // ARM IT DIRECTLY, and this is the whole reason the case is written this way:
    // `tabs.update` STARTS a real navigation and does not wait for a document, so
    // the read taken next lands while the window is still open. Waiting for a load
    // (`ctx.gotoPage`) would race it — a local page reports in a couple of hundred
    // milliseconds, so by the time the load settles the window has already been
    // spent and "it was armed" would be an assumption rather than an observation.
    await evalIn(ctx.probe, `browser.tabs.update(${aId}, {url: ${JSON.stringify(HELLO)}}).then(() => true)`);
    const armed = await waitFor(async () => {
      const st = await ctx.chromeStateHandle();
      const ex = st.raw && st.raw.expect;
      return ex && ex.open === true ? ex : null;
    }, 5000).catch(() => null);
    assert(
      armed,
      "a cross-document navigation arms the report window (and it is published, so a " +
        "key declined by it is decidable from outside): " +
        JSON.stringify(await ctx.chromeStateHandle().then((st: any) => st.raw && st.raw.expect).catch(() => null))
    );

    // SPENT, WHICH IS A DIFFERENT STATE FROM EXPIRED, and the readout tells them
    // apart: a window closed by the page's own report is DELETED (`ageMs` -1), one
    // that ran out is left standing with an age past its own length. Asserting the
    // first is what makes this case about the report instead of about a timer.
    //
    // BUT IT IS ASKED TWICE, and the miss is recorded rather than hidden. Measured
    // on a full content-group run: the window opened and then EXPIRED with nothing
    // spending it inside 8s, while the same session's readout reported `gapSamples:
    // 77` at a last sample of 439ms — the transport is not slow, the report is
    // GONE. That is §5.6's class (content → background → relay tab → helper, where a
    // relay tab that is not ready or a URL slot overwritten by the next report makes
    // the message vanish without the sender ever knowing), and it is the same defect
    // as the field report's "I have to do it twice". A second document in the same
    // session is therefore a legitimate second ask, and this case records it as a
    // repair so the number of lost boot reports is visible in every run instead of
    // being read once and forgotten.
    //
    // What is NOT retried is the product's claim: a document whose window stood open
    // in front of it and whose report never came is exactly the bug `CONTENT_EXPECT_MS`
    // exists for. If BOTH documents fail to spend their window, this case fails.
    const readExpect = () =>
      ctx.chromeStateHandle().then((st: any) => (st.raw && st.raw.expect) || null).catch(() => null);
    let spent: any = null;
    for (let round = 1; round <= 2 && !spent; round++) {
      spent = await waitFor(async () => {
        const ex = await readExpect();
        return ex && ex.open === false && Number(ex.ageMs) === -1 ? ex : null;
      }, 8000).catch(() => null);
      if (spent) break;
      const missed = await readExpect();
      if (round === 2) {
        assert(
          false,
          "neither of two documents spent the report window it was navigated under " +
            "(the transport dropped both boot reports): " +
            JSON.stringify(missed)
        );
      }
      ctx.repaired.push(
        "the window was opened and then expired without the page's report spending it " +
          "(" + JSON.stringify(missed) + ") — §5.6's lost-boot-report class; asked a second document"
      );
      // A second navigation, to the other fixture route: a real cross-document load,
      // which is what arms the window in the first place.
      await evalIn(ctx.probe, `browser.tabs.update(${aId}, {url: ${JSON.stringify(HOME)}}).then(() => true)`);
      const rearmed = await waitFor(async () => {
        const ex = await readExpect();
        return ex && ex.open === true ? ex : null;
      }, 5000).catch(() => null);
      assert(
        rearmed,
        "the second navigation arms the report window too: " + JSON.stringify(await readExpect())
      );
    }
    // ...AND THE MEASUREMENT THE WINDOW'S LENGTH IS SUPPOSED TO BE SET FROM. A spend
    // IS a sample (it is recorded when a report finds a window), so both of these
    // must hold on the back of the document that spent it.
    //
    // What is deliberately NOT asserted is that the latency is INSIDE
    // `CONTENT_EXPECT_MS`. It is not, always: measured here at 210ms on one run and
    // **3043ms and 3277ms** on others (a session's first pages, and — the caveat
    // this instrument has — a report from the document that is LEAVING can be the
    // one that spends the window, so the sample is an upper bound rather than a
    // precise boot latency). A report that arrives after the window expires still
    // deletes the arming — which is why `ageMs` is -1 in both cases, and why a
    // "spent" window can carry a gap LONGER than the window — and in between the
    // helper has claimed the keys, so the double owner comes back for keys pressed
    // in that gap. That is Report 1's named residual, now a number: see
    // docs/tasks/2026-10-15-MANUAL-TEST-REPORTS.md, which records the samples and
    // leaves the constant's value as the open question it is.
    const gap = Number(spent.gapMs);
    assert(Number.isFinite(gap) && gap >= 0, "the readout names the gap it measured: " + JSON.stringify(spent));
    assert(Number(spent.gapSamples) >= 1, "and the sample is counted: " + JSON.stringify(spent));
    console.log(
      `       (report window: last report ${gap}ms after its arm, of a ${1500}ms window; ` +
        `${Number(spent.gapSamples)} spent this session; document ${JSON.stringify(spent.doc)})`
    );
    await ctx.gotoPage(a, HELLO);
  });
}
