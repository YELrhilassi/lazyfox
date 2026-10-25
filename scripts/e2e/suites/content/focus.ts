// "I have to click the page before Lazyfox responds."
//
// The opposite shape from stuck.ts (where NOBODY owns the keyboard and the
// fix is presence): here the page HAS a content script, but Firefox parks
// keyboard focus in its own chrome UI (the tab strip as a tab closes, the
// hidden URL bar on a fresh tab) in the middle of Lazyfox's own tab actions —
// ;x, ;v, ;n, ;t, ;1-;9 — and a document without focus receives no keydown
// at all. The user's own repair is a click.
//
// Both halves are asserted, and hasFocus() is the one that can carry the
// diagnosis: the BiDi harness delivers key events straight to a browsing
// context, so a key assertion can pass in exactly the broken state under
// test. document.hasFocus() fails with the bug and passes when fixed.
// Failure text carries the whole page state.
import { contextsOf, createTab, evalIn, getTree, keyTap, sleep, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same name
  // in different files of one group cannot collide.
  const FILE = "content/focus";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const state = async (tab: any): Promise<any> => {
    const raw = await evalIn(
      tab,
      `JSON.stringify({
        url: location.href,
        hasFocus: document.hasFocus(),
        active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
        content: document.documentElement && document.documentElement.getAttribute("data-lf-content"),
        leader: document.documentElement && document.documentElement.getAttribute("data-lf-leader")
      })`
    ).catch((e) => JSON.stringify({ unreadable: String((e && e.message) || e) }));
    try {
      return JSON.parse(String(raw));
    } catch (e) {
      return { unreadable: String(raw) };
    }
  };

  const hasKeyboard = (tab: any) =>
    evalIn(tab, `document.hasFocus() === true`).catch(() => false);

  const leaderArmed = (tab: any) =>
    evalIn(tab, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(
      () => false
    );

  /**
   * The browsing context of the SELECTED tab, resolved BY TAB ID.
   *
   * Not by URL: this window holds Lazyfox's own command-center pages — the home
   * tab under test and the harness's probe tab — and they share a URL. A
   * URL match then picks one of two tabs at random, and the measurement becomes
   * about a tab the user is not looking at (it happened: "the page does not
   * have the keyboard" while the SELECTED page reported that it did). An
   * extension page can name its own tab (`browser.tabs.getCurrent`), which is
   * exact; a web page cannot, so `null` is returned and the caller falls back to
   * a URL match that REFUSES ambiguity rather than guessing.
   */
  const activeContext = async (): Promise<any | null> => {
    const active = await ctx.activeTabInfo().catch(() => null);
    if (!active || active.id == null) return null;
    for (const c of contextsOf(await getTree())) {
      const id = await ctx.tabIdOf(c.context).catch(() => null);
      if (id != null && id === active.id) return c.context;
    }
    return null;
  };

  /**
   * The SELECTED tab's own document, and whether the keyboard is in it.
   *
   * This is the user-visible fact the whole file is about, and it has to be read
   * from the page rather than from the tab list: a tab can be selected and still
   * not have the keyboard (that IS the bug), and `document.hasFocus()` is the one
   * answer a click changes. `null` when the selected tab has no context the
   * harness can address (a chrome page, or a tab mid-teardown) — which is
   * reported as an unreadable answer rather than as a dead keyboard.
   */
  const selectedPage = async (): Promise<any | null> => {
    const byId = await activeContext();
    if (byId) return { context: byId, state: await state(byId) };
    const active = await ctx.activeTabInfo().catch(() => null);
    if (!active || !active.url) return null;
    // A WEB page cannot name its own tab, so the URL is the only key left — and
    // a URL that matches two rows is not an answer. Refusing keeps the failure
    // honest ("cannot say which tab") instead of reading a neighbour's focus.
    const hits = contextsOf(await getTree()).filter((c: any) => c.url === active.url);
    if (hits.length !== 1) return null;
    return { context: hits[0].context, state: await state(hits[0].context) };
  };

  //
  // TWO QUESTIONS, AND EITHER ONE IS AN ANSWER. The PAGE's own
  // `document.hasFocus()` is the user-visible fact, and it is the one a click
  // changes — but an extension-process document (the command center) cannot
  // answer it: `hasFocus()` there is unreliable in a way that says nothing about
  // the keyboard. So the browser's focus manager is asked as well, through the
  // chrome state readout (`focus.inSelectedContent`), and the two are printed
  // together on failure so a reader can tell "the keyboard is elsewhere" from
  // "the page cannot say".
  const keyboardFacts = async (): Promise<any> => {
    const hit = await selectedPage();
    const st = await ctx.chromeStateHandle().catch(() => null);
    return {
      pageHasFocus: !!(hit && hit.state.hasFocus === true),
      page: hit && hit.state,
      chromeFocus: st ? st.focus() : null,
    };
  };

  //
  // REPORT A FAILURE THE WAY THE USER FEELS IT. "the keyboard is not in the page
  // that is on screen" plus all the answers, because the other shapes of this
  // failure (a document that never loaded, a tab that is selected but not
  // addressable, a page whose own answer cannot be trusted) are diagnosed from
  // different fields.
  //
  // THREE ANSWERS, ANY ONE OF WHICH IS THE FACT, and they are alternatives on
  // purpose because no single one is always available:
  //   * the selected page's OWN `document.hasFocus()` — the user-visible fact,
  //     and the one a click changes;
  //   * the browser's focus manager placing focus inside the selected tab's
  //     content (what an out-of-process page reports);
  //   * the harness's own chrome-side read of the SELECTED tab's document, which
  //     is the same answer as the first one asked from the realm that knows
  //     which tab is selected (`#lfc=state`'s `focus.pageHasFocus`).
  const assertKeyboardInSelectedPage = async (what: string): Promise<void> => {
    const want = await waitFor(async () => {
      const f = await keyboardFacts();
      const chrome = f.chromeFocus;
      return f.pageHasFocus ||
        (chrome && (chrome.inSelectedContent === true || chrome.pageHasFocus === true))
        ? true
        : null;
    }, 5000).catch(() => null);
    if (want) return;
    const now = await keyboardFacts();
    throw new Error(
      what +
        " — the page on screen does not have the keyboard, so every Lazyfox key " +
        "goes to the browser's own UI until the user clicks it. selected tab: " +
        JSON.stringify(await ctx.activeTabInfo().catch(() => null)) +
        " page: " +
        JSON.stringify(now.page) +
        " browser focus manager: " +
        JSON.stringify(now.chromeFocus)
    );
  };

  await t("after a Lazyfox tab close, the page you land on has the keyboard", async () => {
    // TWO TABS THIS TEST MADE, both web pages with a content script: the one
    // that is closed (A, selected) and the one the user is left looking at (B).
    // B is created FIRST so that it is the survivor — closing A leaves B
    // selected, which is the whole point.
    await ctx.collapseWindow();
    const b = await createTab();
    await ctx.gotoPage(b, `${ctx.base}/`);
    const a = await createTab();
    // A URL OF ITS OWN for the tab that dies: if it shared the fixture root
    // with B, a reader (and the leak sweep) could not tell the two apart while
    // the close was in flight, and the test would be asserting about a tab it
    // could not name.
    await ctx.gotoPage(a, `${ctx.base}/uitest`);
    await ctx.activateTab(a);
    // The precondition, asserted rather than assumed: the tab we are about to
    // close is the selected one AND has the keyboard. Without this the test
    // could "pass" by closing a tab that was never in front.
    const beforeState = await state(a);
    assert(
      beforeState.content === "1",
      "harness: the tab being closed must carry a content script (state " +
        JSON.stringify(beforeState) +
        ")"
    );
    assert(
      beforeState.hasFocus === true,
      "harness: the selected tab must have the keyboard BEFORE the close, or " +
        "this test cannot tell the bug from its absence (state " +
        JSON.stringify(beforeState) +
        ")"
    );

    const tabsBefore = await ctx.tabCount();
    await ctx.leaderPress(a, "x");
    const closed = await waitFor(async () => {
      const n = await ctx.tabCount();
      return n === tabsBefore - 1 ? true : null;
    }, 10000).catch(() => null);
    assert(
      closed,
      ";x closed the selected tab (before=" +
        tabsBefore +
        ", after=" +
        (await ctx.tabCount().catch(() => "?")) +
        ")"
    );

    // THE MEASUREMENT. The tab left on screen now has the keyboard, or the user
    // has to click it before a single Lazyfox key works.
    const landed = await waitFor(async () => ((await hasKeyboard(b)) ? true : null), 5000).catch(
      () => null
    );
    if (!landed) {
      throw new Error(
        "the page left on screen does not have the keyboard after a Lazyfox " +
          "tab close — every key is going to the browser's own UI until the " +
          "user clicks the page. state: " +
          JSON.stringify(await state(b))
      );
    }

    // ...and the user-visible consequence, on the real key path: `;` arms the
    // leader in THAT page, with no click in between.
    await ctx.press(b, ";");
    const armed = await waitFor(async () => ((await leaderArmed(b)) ? true : null), 5000).catch(
      () => null
    );
    if (!armed) {
      throw new Error(
        "after the tab close the page has the keyboard but does not answer the " +
          "leader key. state: " +
          JSON.stringify(await state(b))
      );
    }
    await ctx.press(b, "Escape");
  });

  await t("a key typed while an iframe has focus still reaches the leader", async () => {
    // THE OTHER HALF OF "IT STOPPED RESPONDING": a frame is a different
    // document, so with the content script injected only into the top frame
    // every Lazyfox key is dead while a frame holds focus. The user's own
    // repair — a click — is what moves the keyboard out.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/frame`);

    // Sanity first: with the TOP document focused, the leader arms. Without
    // this, a failure below could be a broken leader rather than a frame.
    await ctx.press(ctx.tabA, ";");
    const topArms = await waitFor(async () => ((await leaderArmed(ctx.tabA)) ? true : null), 5000).catch(
      () => null
    );
    assert(topArms, "harness: the leader must arm in the top document first");
    await ctx.press(ctx.tabA, "Escape");

    // Focus a CONTROL inside the frame, the way clicking an embedded widget
    // does. Deliberately not the field in there: focus in a field means the
    // user is typing and Lazyfox must keep its hands off (asserted separately
    // below). Same-origin, so the frame's document is reachable from the test.
    const focused = await evalIn(
      ctx.tabA,
      `(() => {
         const f = document.getElementById("f");
         const w = f && f.contentWindow;
         const inner = w && w.document && w.document.getElementById("innerbutton");
         if (!inner) return JSON.stringify({ error: "no inner control" });
         inner.focus();
         return JSON.stringify({
           innerFocused: inner === w.document.activeElement,
           innerHasFocus: w.document.hasFocus(),
           topActive: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
           leader: document.documentElement.getAttribute("data-lf-leader")
         });
       })()`
    );
    const focusState = JSON.parse(String(focused));
    assert(
      focusState.innerFocused === true,
      "harness: focus must land inside the frame (state " + focused + ")"
    );
    assert(
      focusState.leader !== "1",
      "harness: the leader must be disarmed before this press (state " + focused + ")"
    );

    // THE DELIVERY WITNESS FIRST, and it is a key Lazyfox does NOT claim. A
    // claimed key is swallowed in the frame before the frame's page records
    // it, so an unclaimed `q` is the witness: the frame records it (the key
    // went into the frame, not the top document) and the leader stays dark (a
    // frame does not hand up keys Lazyfox does not own — embedded apps keep
    // their shortcuts).
    await ctx.press(ctx.tabA, "q");
    const passthrough = await waitFor(async () => {
      const raw = await evalIn(
        ctx.tabA,
        `JSON.stringify({
           inner: (function () {
             const f = document.getElementById("f");
             const w = f && f.contentWindow;
             return (w && w.__innerKeys) || [];
           })(),
           leader: document.documentElement.getAttribute("data-lf-leader")
         })`
      ).catch(() => null);
      if (!raw) return null;
      const r = JSON.parse(String(raw));
      return r.inner && r.inner.indexOf("q") !== -1 ? r : null;
    }, 8000).catch(() => null);
    if (!passthrough) {
      throw new Error(
        "the harness could not deliver a key into a focused iframe (the " +
          "frame's own page recorded nothing), so this test cannot tell the " +
          "product's behaviour from the harness's silence"
      );
    }
    assert(
      passthrough.leader !== "1",
      "an unclaimed key typed in a frame must not arm Lazyfox (mirror " +
        JSON.stringify(passthrough.leader) +
        ")"
    );

    // ...and now the claimed key: `;` while the frame holds the keyboard.
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(async () => {
      const on = await leaderArmed(ctx.tabA);
      return on ? true : null;
    }, 8000).catch(() => null);
    assert(
      armed,
      "a ';' typed while an iframe holds focus must arm the leader in the top " +
        "document (mirror " +
        JSON.stringify(await state(ctx.tabA)) +
        "). Until it does, every Lazyfox key is dead while a frame has focus " +
        "and the only repair is clicking the page."
    );
    await ctx.press(ctx.tabA, "Escape");

    // THE OTHER DIRECTION, and it is the reason the frame forwards a SELECTED
    // key set rather than everything: a caret in a frame's own field keeps every
    // keystroke, exactly as it does in the top document. The character has to
    // land in the field and the leader must stay dark.
    const typed = await evalIn(
      ctx.tabA,
      `(() => {
         const f = document.getElementById("f");
         const w = f && f.contentWindow;
         const doc = w && w.document;
         const input = doc && doc.getElementById("innerinput");
         if (!input) return JSON.stringify({ error: "no inner field" });
         input.value = "";
         input.focus();
         return JSON.stringify({ focused: input === doc.activeElement });
       })()`
    );
    assert(
      JSON.parse(String(typed)).focused === true,
      "harness: focus must land in the frame's field (state " + typed + ")"
    );
    await ctx.press(ctx.tabA, ";");
    const fieldState = await waitFor(async () => {
      const raw = await evalIn(
        ctx.tabA,
        `(() => {
           const f = document.getElementById("f");
           const w = f && f.contentWindow;
           const input = w && w.document && w.document.getElementById("innerinput");
           return JSON.stringify({
             value: input ? input.value : null,
             leader: document.documentElement.getAttribute("data-lf-leader")
           });
         })()`
      ).catch(() => null);
      if (!raw) return null;
      const r = JSON.parse(String(raw));
      return r.value === ";" ? r : null;
    }, 5000).catch(() => null);
    assert(
      fieldState,
      "a ';' typed with a caret in a frame's own field must land IN that field, " +
        "not be taken by Lazyfox (state " +
        JSON.stringify(await state(ctx.tabA)) +
        ")"
    );
    assert(
      fieldState.leader !== "1",
      "the leader must stay dark while the caret is in a frame's field (mirror " +
        JSON.stringify(fieldState.leader) +
        ")"
    );
  });

  await t("a tab activation leaves the keyboard in the activated page", async () => {
    // The same rule for a switch that is not a close. The activation is driven
    // through `browser.tabs.update(id, {active:true})` — which IS the product's
    // own switch path (the extension's `;j`, `;1`-`;9`, tab-switcher Enter all
    // end in that call), so this measures the tab operation rather than a
    // harness convenience.
    await ctx.collapseWindow();
    const b = await createTab();
    await ctx.gotoPage(b, `${ctx.base}/`);
    const a = await createTab();
    await ctx.gotoPage(a, `${ctx.base}/uitest`);
    await ctx.activateTab(a);
    assert(
      (await state(a)).hasFocus === true,
      "harness: the tab the switch starts from must have the keyboard (state " +
        JSON.stringify(await state(a)) +
        ")"
    );

    // B by its URL: the window was collapsed first, so `${base}/` names exactly
    // one tab and the switch cannot land on a leftover from an earlier test.
    const rows = (await ctx.tabsInfo()) as any[];
    const target = rows.find((r) => r.url === `${ctx.base}/`);
    assert(target, "harness: the survivor tab is in the strip (rows " + JSON.stringify(rows) + ")");
    const switched = await evalIn(
      ctx.probe,
      `browser.tabs.update(${target.id}, {active: true}).then(() => true)`
    ).catch(() => false);
    assert(switched, "the activation was requested through the extension");

    const landed = await waitFor(async () => ((await hasKeyboard(b)) ? true : null), 5000).catch(
      () => null
    );
    if (!landed) {
      throw new Error(
        "the page the switch landed on does not have the keyboard — every " +
          "Lazyfox key goes to the browser's own UI until the user clicks the " +
          "page. state: " +
          JSON.stringify(await state(b)) +
          " active tab: " +
          JSON.stringify((await ctx.tabsInfo().catch(() => [])).find((r: any) => r.active))
      );
    }
  });

  await t(";v reopens a tab and the keyboard is in the page that comes back", async () => {
    // THE UNDO PAIR IS THE OTHER PROGRAMMATIC PATH. `;x` closes and `;v`
    // reopens, and the reopen is a `browser.tabs.create` in the BACKGROUND — a
    // different process from the window that has to give the keyboard to the tab
    // it just made active. Nothing in that path touches focus, so the tab comes
    // back selected, visible, and unable to receive a single key: the user's
    // next keystroke goes to the browser's own UI and the repair they discover is
    // to click the page.
    //
    // On a URL of its own (`/reopen`), so the tab this case closes and the tab it
    // measures cannot be confused with any other tab the suite leaves behind.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/reopen`);
    await ctx.activateTab(ctx.tabA);
    const beforeState = await state(ctx.tabA);
    assert(
      beforeState.content === "1" && beforeState.hasFocus === true,
      "harness: the tab that is about to be closed must carry a content script " +
        "AND the keyboard (state " +
        JSON.stringify(beforeState) +
        ")"
    );
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "x");
    const closed = await waitFor(async () => {
      const n = await ctx.tabCount();
      return n === before - 1 ? true : null;
    }, 10000).catch(() => null);
    assert(
      closed,
      ";x closed the tab (before=" + before + ", after=" + (await ctx.tabCount().catch(() => "?")) + ")"
    );

    // Reopened from a SURVIVING context: the closed tab's context is gone, and a
    // press into a dead one would say nothing about the product.
    // A REAL page, not plumbing. The relay carrier's URL carries other tabs'
    // messages — a presence report ABOUT a page contains that page's URL inside
    // the carrier's fragment — so a bare substring match can hand back
    // relay.html (see fixture/tabs.contextForTabId for the measured case).
    const survivor =
      contextsOf(await getTree()).find(
        (c: any) => c.url && c.url.includes("127.0.0.1") && ctx.isRealTab(c)
      ) || contextsOf(await getTree())[0];
    assert(survivor, "harness: a surviving context to press ;v in");
    await ctx.activateTab(survivor.context).catch(() => {});
    await ctx.leaderPress(survivor.context, "v");

    // The tab is back AND it is the selected one: `;v` opens it active, and a
    // reopened tab that is not in front would make the measurement about a
    // background tab.
    const reopened = await waitFor(async () => {
      const a = await ctx.activeTabInfo().catch(() => null);
      return a && (a.url || "").includes("/reopen") ? a : null;
    }, 10000).catch(() => null);
    assert(
      reopened,
      ";v reopened the tab and it is the selected one (active=" +
        JSON.stringify(await ctx.activeTabInfo().catch(() => null)) +
        ")"
    );

    await assertKeyboardInSelectedPage("the tab ;v reopened is in front");

    // ...and the user-visible consequence, on the real key path: `;` arms the
    // leader in THAT page with no click in between.
    const back = contextsOf(await getTree()).find(
      (c: any) => c.url && c.url.includes("/reopen") && ctx.isRealTab(c)
    );
    assert(back, "harness: the reopened page has a context");
    await ctx.press(back!.context, ";");
    const armed = await waitFor(
      async () => ((await leaderArmed(back!.context)) ? true : null),
      5000
    ).catch(() => null);
    assert(
      armed,
      "the page ;v reopened has the keyboard but does not answer the leader key " +
        "(state " +
        JSON.stringify(await state(back!.context)) +
        ")"
    );
    await ctx.press(back!.context, "Escape");
  });

  await t(";n opens a tab and the keyboard is in it", async () => {
    // The same rule for the other background-driven creation: a tab the user just
    // asked for is useless if they have to click it before a key works. `;n`
    // opens the home page, which is a document that runs its own key engine — so
    // "the keyboard is in the new tab" is measured on the page, not on the tab.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.activateTab(ctx.tabA);
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "n");

    const opened = await waitFor(async () => {
      const n = await ctx.tabCount();
      const a = await ctx.activeTabInfo().catch(() => null);
      return n === before + 1 && a && (a.url || "").includes("commandcenter.html") ? a : null;
    }, 10000).catch(() => null);
    assert(
      opened,
      ";n opened a tab and put it in front (before=" +
        before +
        ", after=" +
        (await ctx.tabCount().catch(() => "?")) +
        ", active=" +
        JSON.stringify(await ctx.activeTabInfo().catch(() => null)) +
        ")"
    );

    // The consequence on the real key path: the new page's own leader arms.
    //
    // RESOLVED BY TAB ID, not by URL: the harness's own probe tab is a
    // command-center page too, so a URL match across the two would press keys
    // into — and read the leader state of — whichever tab it found first. That
    // is the second, quieter way this test can lie.
    const homeCtx = await activeContext();
    assert(
      homeCtx,
      "harness: the tab ;n opened must be addressable by id (active tab " +
        JSON.stringify(await ctx.activeTabInfo().catch(() => null)) +
        ")"
    );
    const home = { context: homeCtx };

    // DIAGNOSTIC, printed even when this test passes: what the browser's focus
    // manager says here, and — the question that matters when a focus rule is
    // in the tree — whether the PRODUCT's own repair works when it is run at
    // this late moment. "The repair is wrong" and "the repair ran before the
    // document existed" are the two ways this can fail, they have opposite
    // fixes, and the second one is invisible unless the repair can be re-run.
    //
    // `#lfc=focus` is that re-run: the same keyboard rule the tab-select,
    // location-change and load-complete triggers apply, on demand. On demand
    // means the answer covers the rule while the browser is settled.
    {
      const before = await keyboardFacts();
      const late = await ctx
        .chromeFocus()
        .catch((e: any) => ({ error: String((e && e.message) || e) }));
      ctx.repaired.push(
        ";n focus before=" +
          JSON.stringify(before.chromeFocus) +
          " " +
          "rule-run-now=" +
          JSON.stringify(late)
      );
    }

    await assertKeyboardInSelectedPage("the tab ;n opened is in front");
    await ctx.press(home!.context, ";");
    const armed = await waitFor(
      async () => ((await leaderArmed(home!.context)) ? true : null),
      5000
    ).catch(() => null);
    assert(
      armed,
      "the page ;n opened has the keyboard but does not answer the leader key " +
        "(state " +
        JSON.stringify(await state(home!.context)) +
        ")"
    );
    await ctx.press(home!.context, "Escape");
  });

  await t("the tab ;o opened is in front and has the keyboard", async () => {
    // THE ORDINARY WAY A USER OPENS A PAGE, and the one where the keyboard's
    // fate is decided by a different process: the URL popup's Enter ends in a
    // `browser.tabs.create` in the BACKGROUND, exactly like `;v` does. A web
    // page has no page-side helper to pull focus the way the command center
    // does, so if the tab is left without the keyboard there is nothing in the
    // document that can repair it — the user clicks, and only a click works.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.activateTab(ctx.tabA);
    const beforeIds = new Set(((await ctx.tabsInfo()) as any[]).map((t) => t.id));
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    await ctx.waitPopup(ctx.tabA, 8000);
    const url = `http://127.0.0.1:${ctx.port}/hello`;
    await ctx.typeIn(ctx.tabA, url);
    await ctx.waitListEvent(ctx.tabA, { q: url });
    await ctx.press(ctx.tabA, "Enter");

    const opened = await waitFor(async () => {
      const now = (await ctx.tabsInfo()) as any[];
      const t = now.find((x) => !beforeIds.has(x.id));
      return t && (t.url || "").includes("/hello") && t.active ? t : null;
    }, 15000).catch(() => null);
    assert(
      opened,
      ";o opened the page in a new tab and put it in front (tabs=" +
        JSON.stringify(await ctx.tabsInfo().catch(() => [])) +
        ")"
    );

    await assertKeyboardInSelectedPage("the tab ;o opened is in front");
    {
      const st = await ctx.chromeStateHandle().catch(() => null);
      ctx.repaired.push(";o chrome focus=" + JSON.stringify(st ? st.focus() : null));
    }

    // The consequence on the real key path: the new page answers the leader key
    // with no click in between.
    const page = contextsOf(await getTree()).find(
      (c: any) => c.url && c.url.includes("/hello") && ctx.isRealTab(c)
    );
    assert(page, "harness: the page ;o opened has a context");
    await ctx.press(page!.context, ";");
    const armed = await waitFor(
      async () => ((await leaderArmed(page!.context)) ? true : null),
      5000
    ).catch(() => null);
    assert(
      armed,
      "the page ;o opened has the keyboard but does not answer the leader key " +
        "(state " +
        JSON.stringify(await state(page!.context)) +
        ")"
    );
    await ctx.press(page!.context, "Escape");
  });

  await t("a dismissed chrome popup gives the keyboard back to the page", async () => {
    // THE SAME REPORT, ONE LAYER UP. A chrome-side popup (the URL popup, the
    // sessions popup) holds the keyboard while it is up — its input is a field
    // in the BROWSER's own UI — and closing it removes that input from the
    // document. Whatever had focus is gone, and the keyboard is left between
    // the page and the chrome: the same shape as the tab-switch report, and the
    // same repair (a click) is what the user discovers.
    //
    // WHICH PAGE THIS HAS TO BE, learned by measuring the wrong one first.
    //
    // A chrome-side popup exists only where the chrome helper OWNS the keys —
    // and on the command center it does not: that page runs the same key engine
    // a content script does and hosts its own popups IN THE PAGE (the
    // command-center suite asserts exactly that, and this case originally drove
    // the home tab and could never see a chrome popup come up at all).
    //
    // The fixture's HTTP-error routes are the obvious candidate and they are
    // NOT one, which is a measurement rather than a preference: a `/err/404`
    // response with a body — `{ status: 404, body: "not found" }`, served as
    // text/html — is RENDERED by this Firefox, so that page carries a
    // `document.contentType` of `text/html`, the server's own text for a body,
    // and (measured) `data-lf-content="1"`: the content script runs there.
    // Firefox substitutes its own error page for an empty body, so the only
    // production-shaped way to be on a page the helper owns is a URL that fails
    // to resolve at all — which is also exactly the user's story ("I followed a
    // dead link, pressed `;o`, pressed Escape, and the page stopped
    // answering"). `.invalid` never resolves, so this needs no fixture route.
    //
    // It is also a page whose document runs OUT of process, which is the state
    // the repair's own argument turns on: an in-process privileged page can be
    // reached by the weaker `selectedBrowser.focus()` the escalation replaced,
    // so a case driven on `about:config` could not tell the two apart
    // (measured: it passes with the weaker call restored).
    await ctx.collapseWindow();
    const page = await createTab();
    ctx.tabA = page;
    const target = "http://lazyfox-e2e.invalid/";
    await ctx.navigateNoWait(page, target);
    // THE PRECONDITION, AND IT IS ASSERTED RATHER THAN ASSUMED — the fixture bug
    // above is exactly what an assumed one hides. Two facts, both read from the
    // page: it has NO Lazyfox content script (so the helper is the only thing
    // that can answer a key on it), and its own document is the one on screen
    // (the error page keeps the requested URL, so a URL wait alone would pass
    // while the command center was still up).
    const ownPage = await waitFor(async () => {
      const f = await evalIn(
        page,
        `JSON.stringify({ href: location.href, content: document.documentElement.getAttribute("data-lf-content"), ready: document.readyState })`
      ).catch(() => "?");
      if (f === "?") return null;
      let d: any = null;
      try {
        d = JSON.parse(String(f));
      } catch (e) {
        return null;
      }
      return String(d.href).indexOf("lazyfox-e2e.invalid") !== -1 && d.content === null
        ? d
        : null;
    }, 15000).catch(() => null);
    assert(
      ownPage,
      "harness: the page under the popup must be a Firefox error page with no Lazyfox content script (facts " +
        String(
          await evalIn(
            page,
            `JSON.stringify({ href: location.href, content: document.documentElement.getAttribute("data-lf-content"), title: document.title })`
          ).catch(() => "unreadable")
        ) +
        ")"
    );
    await ctx.activateTab(page);
    // ...and the product's own answer agrees: the helper owns this page's keys,
    // so the popup this test closes is the chrome one.
    await ctx.expectChromeState(
      "the chrome helper owns the error page's keys",
      (s: any) => s.leader().ownsKeys === true,
      { timeoutMs: 8000 }
    );

    // THE CHORD IS ONE GESTURE, and that is a measurement rather than a style
    // choice. Reading the chrome's state between the leader key and its sub-key
    // stands the armed leader down (the read makes the probe transient and the
    // tab selection it restores is a TabSelect, where every surface the helper
    // no longer owns is closed), so a `;` … `o` spelled as two presses with a
    // read in between measures the harness. And two payloads are not equivalent
    // to one either: measured through the helper's own dispatch trace (chrome
    // state `keyTrace`), a two-payload chord on this page recorded `;` →
    // `leader-arm` and NOTHING for the key that followed — the sub-key never
    // reached the chrome — while one payload records `;` → `leader-arm` then
    // `o` → `leader-chord`, `lastAction: openUrl`. A user presses a chord in one
    // gesture, which is why ctx.leaderPress sends it as one sequence.
    await ctx.leaderPress(page, "o");
    await ctx.expectChromeState("the chrome URL popup is up", (s: any) => s.popup()?.current === true, {
      timeoutMs: 8000,
    });
    // The dismissal goes through the same channel every key on a chrome-owned
    // page does. Not `ctx.press`: its path is chosen by asking the PAGE whether
    // it has a content script, and a page cannot describe a popup that belongs
    // to the browser's own UI (measured: it asked, was told "the page owns
    // this", and sent the key into a document that has no listener — the same
    // silent no-op this whole file is about, produced by the harness).
    await ctx.sendKeys(page, [{ k: "Escape" }]);
    await ctx.expectChromeState("the chrome URL popup is closed", (s: any) => s.popup()?.current === false, {
      timeoutMs: 8000,
    });

    // THE MEASUREMENT: the page the popup was over has the keyboard again.
    await assertKeyboardInSelectedPage("the page under a dismissed chrome popup");

    // ...and the consequence on the real key path: the page answers `;` with no
    // click in between. On this page the helper is the answerer, so the proof is
    // the HELPER arming — which is also the state `assertKeyboardInSelectedPage`
    // just measured from the other side.
    await ctx.sendKeys(page, [{ k: ";" }]);
    const armed = await ctx
      .expectChromeState("the dismissed popup's page answers the leader key", (s: any) => s.leader().active === true, {
        timeoutMs: 5000,
      })
      .then(() => true)
      .catch(() => false);
    assert(
      armed,
      "the page under the dismissed popup never armed the leader key (page state " +
        JSON.stringify(await state(page)) +
        ")"
    );
    await ctx.sendKeys(page, [{ k: "Escape" }]).catch(() => {});
  });

  await t("a page whose keyboard is in the browser's own UI gets it back on the first key", async () => {
    // THE FIELD REPORT IN ITS OWN WORDS: "it stops responding until I move the
    // mouse over the window and click on a spot on the page". The page is alive
    // and its content script owns the keys; the KEYBOARD is in the browser's own
    // UI, so the page's listener never runs and the key the helper declines
    // ("the page owns it") is answered by the browser chrome instead. The
    // keyboard is put there via ctx.chromeBlur — the toolbar state a user
    // leaves behind. Ctrl+L is NOT available, and that is a product fact (the
    // URL bar is hidden, so the browser's chord focuses nothing there).
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await assertKeyboardInSelectedPage("harness: the page starts with the keyboard");

    await ctx.chromeBlur();
    const lost = await waitFor(async () => {
      const f = await keyboardFacts();
      const chrome = f.chromeFocus;
      return chrome && chrome.inSelectedContent === false && !f.pageHasFocus ? chrome : null;
    }, 5000).catch(() => null);
    assert(
      lost,
      "harness: the keyboard must be in the browser's own UI (state " +
        JSON.stringify(await keyboardFacts()) +
        ")"
    );

    // THE KEY IS SENT WHERE THE CHROME HELPER CAN SEE IT, and that is not
    // `ctx.press`. On a web page that helper chooses BiDi input, which lands in
    // the PAGE's own process — so a key "typed while the keyboard sat in the URL
    // bar" would be delivered to a document that never had the keyboard, the
    // helper's capture listener would never run, and this case would measure its
    // own harness. A key typed into the browser's own UI is delivered in the
    // PARENT process; `ctx.sendKeys` is the harness's parent-process path (it
    // runs the product's own chrome dispatch, the same function the window's
    // capture listener calls), which is what the user's key actually is.
    //
    // THE REPAIR happens at that key: the leader key is consumed with the
    // refocus, so it is never spent as a character in the URL bar, and the
    // keyboard goes back to the page.
    await ctx.sendKeys(ctx.tabA, [{ k: ";" }]);
    await assertKeyboardInSelectedPage(
      "the page after one key was pressed while the keyboard sat in the browser's own UI"
    );

    // ...and the gesture completes on the NEXT press: the page's OWN leader,
    // read from the page's own mirror (`data-lf-leader`), which only the content
    // script's engine sets — the helper never paints it on a web page.
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(
      async () => ((await leaderArmed(ctx.tabA)) ? true : null),
      5000
    ).catch(() => null);
    assert(
      armed,
      "the page did not arm its own leader once its keyboard was given back (state " +
        JSON.stringify(await state(ctx.tabA)) +
        ")"
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("a page whose keys the HELPER answers gets its keyboard back too", async () => {
    // THE OTHER HALF OF THE SAME FIELD REPORT: the user's own split — `;` and
    // the helper's chords (`;r`, `;s`, `;o`, `;d`) keep working while everything
    // that lives in the page (j/k/d/u, hints, find) is dead until a click or
    // reload. That split IS the ownership split: the helper answers, the page
    // never sees a key. Produced by dropping the presence record
    // (ctx.chromeForget) and parking the keyboard in the browser's own UI.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await assertKeyboardInSelectedPage("harness: the page starts with the keyboard");

    // The record is written by the page's own script, so the harness has to see it
    // before it can drop it — and saying WHICH record was expected is what makes a
    // failure here a fact about the page rather than about the drop.
    //
    // ONE RETRY, and the reason is measured rather than defensive: inside the
    // whole content group this premise has been seen to fail while the same test
    // passes on its own (twice, in the same window, at the two cases that need a
    // FRESH page's report — this one and "a Firefox developer surface…" right
    // after it). The documents were healthy in both: the page had the keyboard
    // and its mirror answered, so what was missing was the REPORT, not the page.
    // A second navigation is the cheapest honest second chance, and a third
    // failure prints the instruments that decide between the candidates
    // (see presenceDiagnostics): the relay the report travels over, the strips
    // both sides see, and whether the page's own script is even in the document.
    const presenceDiag = async (): Promise<string> => {
      const page = await state(ctx.tabA).catch((e) => ({ unreadable: String(e) }));
      const st = await ctx.chromeStateHandle().catch(() => null);
      return JSON.stringify({
        page,
        presence: st ? st.presence() : "no chrome state",
        relay: st ? (st.raw as any).relay : "no chrome state",
        ownsKeys: st ? st.leader().ownsKeys : "no chrome state",
        lastKeys: st ? st.keyTrace().slice(-4) : "no chrome state",
      });
    };
    const presenceFor = async (): Promise<boolean> => {
      const s = await ctx.chromeStateHandle().catch(() => null);
      return !!(s && s.presence().some((r: any) => String(r.u).includes("/hello")));
    };
    const reported = await waitFor(
      async () => ((await presenceFor()) ? true : null),
      8000
    ).catch(() => null);
    if (!reported) {
      // The second chance: one more navigation, which replaces the document and
      // makes the page's script report from scratch.
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
      await waitFor(async () => ((await presenceFor()) ? true : null), 8000).catch(() => null);
    }
    // THE THIRD CHANCE IS THE PRODUCT'S OWN REPAIR, and asking for it is not a
    // softening of the premise.
    //
    // A fresh document's BOOT report travels content -> background -> relay ->
    // helper, and a group run has been measured losing it while the failure's own
    // diagnostics showed the page perfectly healthy: `hasFocus: true`, the script
    // marked in the document (`data-lf-content="1"`), the other tab in the window
    // reporting normally, and the helper holding no record for this one — with
    // `relay.urlSlot` still carrying a report for a DIFFERENT url at the same
    // index, where the missing instrument for
    // exactly this is named). The product's answer to a missing report is L2: the
    // document re-announces itself on a key IT RECEIVES, which is when its report
    // is true again. So the premise asks the way a user would — press a key into
    // the page — and the assertion is unchanged: the record must exist before it
    // can be dropped, and what the test measures (the ownership decision and the
    // rescue) is downstream of that.
    if (!(await presenceFor())) {
      // The raw page path on purpose: this key has to reach THIS document, which
      // is the case's own premise (`assertKeyboardInSelectedPage` above).
      await keyTap(ctx.tabA, "Escape");
      await waitFor(async () => ((await presenceFor()) ? true : null), 5000).catch(() => null);
    }
    assert(
      await presenceFor(),
      "harness: the page's script must have reported presence — a page that never " +
        "reports is a page the helper claims, which IS the freeze under test. " +
        (await presenceDiag())
    );
    const dropped = await ctx.chromeForget();
    assert(
      dropped && dropped.had === true,
      "harness: dropping the record has to find one (got " + JSON.stringify(dropped) + ")"
    );
    await ctx.expectChromeState(
      "the chrome helper answers this page's keys now",
      (s: any) => s.leader().ownsKeys === true,
      { timeoutMs: 8000 }
    );

    await ctx.chromeBlur();
    const lost = await waitFor(async () => {
      const f = await keyboardFacts();
      const chrome = f.chromeFocus;
      return chrome && chrome.inSelectedContent === false && !f.pageHasFocus ? chrome : null;
    }, 5000).catch(() => null);
    assert(
      lost,
      "harness: the keyboard must be in the browser's own UI (state " +
        JSON.stringify(await keyboardFacts()) +
        ")"
    );

    // THE REPAIR, on the leader key the user already pressed — through the chrome
    // path, because that is where a key typed into the browser's own UI is
    // delivered (ctx.sendKeys runs the product's chrome dispatch; a page key would
    // land in a document that has no keyboard, which is the state under test).
    await ctx.sendKeys(ctx.tabA, [{ k: ";" }]);
    await assertKeyboardInSelectedPage("the page after the leader key while the helper owned its keys");

    // AND THE OWNERSHIP HEALS ITSELF. That is the second half of the repair and
    // the reason a reload is no longer part of it: the page's script can only have
    // received this key because its document HAS the keyboard, which is exactly
    // what its presence report claims — so it re-asserts it, and the keys are the
    // page's again. `keyTap` is the raw page path on purpose: this is the key the
    // USER presses into the page, and it must not be routed by the harness's idea
    // of who owns the keys, which is the fact being measured.
    await keyTap(ctx.tabA, ";");
    const armed = await waitFor(
      async () => ((await leaderArmed(ctx.tabA)) ? true : null),
      5000
    ).catch(() => null);
    assert(
      armed,
      "the page did not arm its own leader after its keyboard came back (page state " +
        JSON.stringify(await state(ctx.tabA)) +
        ")"
    );
    const owned = await ctx
      .expectChromeState("the page owns its keys again", (s: any) => s.leader().ownsKeys === false, {
        timeoutMs: 9000,
      })
      .then(() => true)
      .catch(() => false);
    assert(
      owned,
      "the page never got its keys back, so the next chord would be answered by the helper again (chrome state " +
        JSON.stringify(await (await ctx.chromeStateHandle()).raw).slice(0, 600) +
        ")"
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("a key typed while a SCRIPTLESS frame has focus still reaches the leader", async () => {
    // THE RESIDUAL OF THE FRAME REPORT, and the one `all_frames` alone does not
    // reach. `/frame` above is an http(s) frame, so `all_frames` injects the
    // content script there and the frame's own bridge hands the keys up. A frame
    // built from `srcdoc`, and one that is `about:blank` until the page writes
    // into it, is a document the extension is not in at all — the key event is
    // delivered THERE, nothing listens for it, and the top document's listener
    // never runs. From the user's side this is indistinguishable from the rest of
    // the report: Lazyfox has stopped responding and clicking the page fixes it.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/framenocontent`);

    // Sanity first: with the TOP document focused the leader arms. Without this
    // a failure below could be a broken leader rather than a frame.
    await ctx.press(ctx.tabA, ";");
    const topArms = await waitFor(
      async () => ((await leaderArmed(ctx.tabA)) ? true : null),
      5000
    ).catch(() => null);
    assert(topArms, "harness: the leader must arm in the top document first");
    await ctx.press(ctx.tabA, "Escape");

    for (const frame of ["blank", "doc"] as const) {
      // Focus a CONTROL inside the frame, the way clicking an embedded widget
      // does. In the about:blank frame the control is written by this test — the
      // frame has no document of its own until someone fills it, which is
      // exactly how a page uses one.
      const probe = await evalIn(
        ctx.tabA,
        `(() => {
           const f = document.getElementById(${JSON.stringify(frame)});
           const w = f && f.contentWindow;
           const doc = w && w.document;
           if (!doc) return JSON.stringify({ error: "no frame document" });
           let btn = doc.getElementById("probe-button");
           if (!btn) {
             btn = doc.createElement("button");
             btn.id = "probe-button";
             doc.body.appendChild(btn);
           }
           // What THIS frame's own document received, so the test can tell a
           // key that never arrived here from one that arrived and was never
           // seen by the top document (the same witness /frameinner carries).
           if (!w.__framekeys) {
             w.__framekeys = [];
             w.addEventListener("keydown", function (e) { w.__framekeys.push(e.key); }, true);
           }
           btn.focus();
           return JSON.stringify({
             focused: doc.activeElement === btn,
             innerHasFocus: doc.hasFocus(),
             topActive: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
             leader: document.documentElement.getAttribute("data-lf-leader")
           });
         })()`
      ).catch((e) => JSON.stringify({ evalError: String((e && e.message) || e) }));
      const st = JSON.parse(String(probe));
      assert(
        st.focused === true,
        `harness: focus must land inside the ${frame} frame (state ${probe})`
      );
      assert(
        st.leader !== "1",
        `harness: the leader must be disarmed before this press (${frame}, state ${probe})`
      );

      // The delivery witness: a key Lazyfox does not claim travels untouched, so
      // the frame's own document recording it proves the key really went INTO
      // the frame — without it a failure below could be the harness, not the
      // product.
      await ctx.press(ctx.tabA, "q");
      const seen = await waitFor(async () => {
        const got = await evalIn(
          ctx.tabA,
          `(function () {
             const w = document.getElementById(${JSON.stringify(frame)}).contentWindow;
             return JSON.stringify({
               keys: (w && w.__framekeys) || [],
               seenByFramePage: (w && w.__srckey) || [],
               leader: document.documentElement.getAttribute("data-lf-leader")
             });
           })()`
        ).catch(() => null);
        if (!got) return null;
        const r = JSON.parse(String(got));
        return r.keys && r.keys.indexOf("q") !== -1 ? r : null;
      }, 8000).catch(() => null);
      assert(
        seen,
        `the harness could not deliver a key into the ${frame} frame (its own ` +
          "document recorded nothing), so this test cannot tell the product's " +
          "behaviour from the harness's silence"
      );
      assert(
        seen.leader !== "1",
        `an unclaimed key typed in the ${frame} frame must not arm Lazyfox (mirror ${foundString(seen)})`
      );

      // ...and now the claimed key.
      await ctx.press(ctx.tabA, ";");
      const armed = await waitFor(
        async () => ((await leaderArmed(ctx.tabA)) ? true : null),
        8000
      ).catch(() => null);
      assert(
        armed,
        "a ';' typed while the " +
          frame +
          " frame holds focus must arm the leader in the top document (state " +
          JSON.stringify(await state(ctx.tabA)) +
          "). Until it does, every Lazyfox key is dead while that frame has " +
          "focus and the only repair is clicking the page."
      );
      await ctx.press(ctx.tabA, "Escape");
    }
  });

  /**
   * Put the browser in the user's state, and ASSERT the premise.
   *
   * THE STATE: the address bar holds text, reports it as USER-TYPED (Firefox's
   * own `usertyping`, measured on the running browser), and holds the keyboard —
   * while the page on screen is perfectly alive. That report is what vetoes the
   * rescue (chrome/commandcenterfocus.chromeFieldHoldsUserText), and before
   * chrome/chromefield.ts existed the veto could not be escaped: every key the
   * user pressed was refused, invisibly, and the only repair left was the click
   * they complained about.
   *
   * THE TOOLBAR IS REVEALED, and that is a MEASUREMENT rather than a choice.
   * Lazyfox's chrome CSS hides the URL bar outright and reveals it as a hover
   * overlay, so the state is entered the way a user enters it: hover the top
   * strip (the product's own `lf-debug-reveal`, the same attribute `;W e`
   * toggles), click, type. The other order — focus the bar, then hide the
   * toolbar — is NOT reachable in this browser, and the hook reports why: a field
   * with no box cannot hold the keyboard, and Firefox moves focus back to the
   * content the moment the bar stops being rendered (`inputRect: [0,0]`,
   * `fieldOnScreen: false`, and the focus manager naming `browser` instead).
   *
   * THE PREMISE IS AN ASSERTION, NOT A SETUP. A case that asserts behaviour in a
   * state it never reached is a test of the harness: if this browser will not
   * report user-typing, or the bar is not on screen, that is said out loud here,
   * before a single claim about the product is made.
   */
  const enterTypedUrlBarState = async (): Promise<any> => {
    const bar = await ctx.chromeUrlBar({ text: "gg d", typed: true, show: true, focus: true });
    const typedReported = bar && (bar.usertypingAttr === "true" || bar.valueIsTyped === "true");
    assert(
      typedReported,
      "harness: the URL bar has to report the text as USER-TYPED for this state to be the reported one (got " +
        foundString(bar) +
        ")"
    );
    assert(
      bar.text === "gg d" || bar.inputText === "gg d",
      "harness: the bar must actually hold the stray text (got " + foundString(bar) + ")"
    );
    assert(
      bar.toolbox === "revealed" && bar.navDisplay !== "none" && bar.fieldOnScreen === true,
      "harness: the address bar has to be ON SCREEN and holding the caret (got " + foundString(bar) + ")"
    );
    return bar;
  };

  await t("an address being typed at the top of the window no longer blocks the rescue", async () => {
    // THE USER'S STATE, from their own description: the keyboard is in the URL
    // bar, the page is alive, and their keys do nothing — they see a page that is
    // healthy and a keyboard that is not. The veto that protects an address being
    // typed is what refused the repair, and it refused it on EVERY key, so the
    // next key they pressed was refused too.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await assertKeyboardInSelectedPage("harness: the page starts with the keyboard");

    const bar = await enterTypedUrlBarState();
    const lost = await waitFor(async () => {
      const f = await keyboardFacts();
      const chrome = f.chromeFocus;
      return chrome && chrome.inSelectedContent === false && !f.pageHasFocus ? chrome : null;
    }, 5000).catch(() => null);
    assert(
      lost,
      "harness: the keyboard must be in the address bar (state " +
        foundString(await keyboardFacts()) +
        " bar " +
        foundString(bar) +
        ")"
    );

    // THE KEY THAT REPAIRS IT: the leader key — the one keystroke a Lazyfox user
    // presses to say "now", and the decision recorded in givePageKeyboardBack (the
    // typed text is left where it is; `;o` is the product's own way to enter an
    // address). It is delivered the way a key typed into the browser's own UI
    // is: through the chrome path, since the page has no keyboard to receive it.
    await ctx.sendKeys(ctx.tabA, [{ k: ";" }]);
    await assertKeyboardInSelectedPage("the page after the leader key, while an address was being typed");

    // ...and the page ANSWERS the next key, from its own engine: the page's
    // leader mirror is set by the content script and by nothing else.
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(async () => ((await leaderArmed(ctx.tabA)) ? true : null), 5000).catch(
      () => null
    );
    assert(
      armed,
      "the page did not arm its own leader once its keyboard was given back (page state " +
        foundString(await state(ctx.tabA)) +
        ")"
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("a plain key never robs an address bar that is being typed at", async () => {
    // The other half of the same rule, and the one the veto exists for: the
    // toolbar is revealed, the caret is in the address bar, the user is writing a
    // URL — the first character they type must not pull focus into the page
    // behind it. Only the leader key is excepted (the case above).
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await assertKeyboardInSelectedPage("harness: the page starts with the keyboard");

    const bar = await enterTypedUrlBarState();
    const lost = await waitFor(async () => {
      const f = await keyboardFacts();
      const chrome = f.chromeFocus;
      return chrome && chrome.inSelectedContent === false && !f.pageHasFocus ? chrome : null;
    }, 5000).catch(() => null);
    assert(
      lost,
      "harness: the keyboard must be in the address bar (state " +
        foundString(await keyboardFacts()) +
        " bar " +
        foundString(bar) +
        ")"
    );

    // A plain key does NOT steal the caret: the veto still holds where the user
    // can see what they are typing into.
    await ctx.sendKeys(ctx.tabA, [{ k: "d" }]);
    const stillTyping = await waitFor(async () => {
      const f = await keyboardFacts();
      const chrome = f.chromeFocus;
      return chrome && chrome.inSelectedContent === false && !f.pageHasFocus ? true : null;
    }, 2500).catch(() => null);
    assert(
      stillTyping,
      "a plain key must not pull the keyboard out of a revealed address bar being typed in (state " +
        foundString(await keyboardFacts()) +
        ")"
    );

    // AND THE LEADER KEY STILL WINS — re-asserted here so the two halves of the
    // rule are visible in ONE state, which is where a reader will look for them.
    await ctx.sendKeys(ctx.tabA, [{ k: ";" }]);
    await assertKeyboardInSelectedPage("the page after the leader key while an address was being typed");
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(async () => ((await leaderArmed(ctx.tabA)) ? true : null), 5000).catch(
      () => null
    );
    assert(
      armed,
      "the page did not arm its own leader after `;` was honoured mid-address (page state " +
        foundString(await state(ctx.tabA)) +
        ")"
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("a Firefox developer surface is never claimed (and about:blank still is)", async () => {
    // THE USER'S SECOND REPORT, in their own words: "Lazyfox does a keyboard grab
    // on Firefox's developer tools".
    //
    // The mechanism is structural, not a typo: the `Lazyfox` window actor is
    // registered for EVERY window in EVERY process with no `matches` filter
    // (src/static/chrome/loader/config.js), and its child consumes
    // `j k d u g G ; Escape Backspace` on any document that is not marked
    // `data-lf-content`. A devtools document carries no such marker, so the
    // console, the style editor and a debugger's source view were inside
    // Lazyfox's key claim. The HELPER reaches the same documents from the other
    // side, because a devtools document is not content-ownable and was therefore
    // claimed by the URL rule in keystate.
    //
    // about:debugging is the member of that class a harness can open — no live
    // debugger connection is needed — and its document class is the same one the
    // Browser Toolbox has. `shared/privileged.ts` names the class once for both
    // hosts; `scripts/test/privileged.test.ts` pins the predicate on both edges;
    // this case is the behaviour, on the real key path.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, "about:debugging");

    // The premise, read from the product's OWN answer about which tab is in
    // front, so a navigation that did not land fails as a harness problem
    // instead of as a product one.
    const onDebugging = await waitFor(async () => {
      const s = await ctx.chromeStateHandle().catch(() => null);
      const u = s ? String(s.selectedUrl() || "").replace(/#.*$/, "") : "";
      return u === "about:debugging" ? u : null;
    }, 8000).catch(() => null);
    assert(
      onDebugging !== null,
      "harness: the selected tab has to be on about:debugging (chrome state " +
        foundString((await ctx.chromeStateHandle().catch(() => null))?.selectedUrl()) +
        ")"
    );

    // NOT OURS. `ownsKeys` is the helper's own verdict, and it is the field a
    // field report is answered from: before this rule it answered TRUE here,
    // because "not content-ownable" meant "the helper's".
    await ctx.expectChromeState(
      "the chrome helper does not claim a developer surface",
      (s: any) => s.leader().ownsKeys === false,
      { timeoutMs: 8000 }
    );

    // AND THE INSTRUMENT NAMES THE CLASS (K5/M6), so a field report does not have
    // to be argued from a URL: `keyboard.devtools` is the field that says "the
    // silence here is correct", and reading it here also proves the field is
    // alive in the real product rather than only in the unit fake.
    const kbHere = (await ctx.chromeStateHandle()).keyboard();
    assert(
      !!kbHere && kbHere.devtools === true,
      "the state reply must name a developer surface as one (keyboard " +
        foundString(kbHere) +
        ")"
    );

    // AND NOT TOUCHED — which is a SECOND question, and the reason the refusal
    // lives in the dispatcher and not only in the ownership latch. `ownsKeys:
    // false` routes a key into the WEB PAGE rescue, whose job is to move the
    // keyboard into the page and which SPENDS THE LEADER KEY doing it. On a
    // developer surface that would hand the console the keyboard and eat the
    // user's `;` — a different bug wearing the fix's clothes. "Not ours" has to
    // mean "not touched", so the dispatcher refuses first and names the branch.
    //
    // The keys go through the chrome path (ctx.sendKeys, the parent process),
    // which is where a key typed on a privileged about: document is delivered:
    // it runs in-process, so the chrome window's own capture listener sees it.
    //
    // ARRIVAL IS MEASURED BY SEQUENCE NUMBER, not by trace LENGTH. The trace is a
    // bounded ring (24 entries), so in a full run — where earlier tests have
    // filled it — a new key does not change the length, and the first version of
    // this case reported "the key never reached the dispatcher" with that key's
    // own entry printed in the failure text. `keyTraceSeq()` is the number that
    // does not wrap.
    const before = (await ctx.chromeStateHandle()).keyTraceSeq();
    await ctx.sendKeys(null, [{ k: ";" }]);
    const arrived = await waitFor(async () => {
      const s = await ctx.chromeStateHandle().catch(() => null);
      return s && s.keyTraceSeq() > before ? s : null;
    }, 5000).catch(() => null);
    const st = arrived || (await ctx.chromeStateHandle());
    const trace = st.keyTrace();
    assert(
      arrived !== null,
      "the leader key has to have reached the helper's dispatcher for this case to measure " +
        "anything (seq before " +
        before +
        ", now " +
        st.keyTraceSeq() +
        ", last entries " +
        foundString(trace.slice(-3)) +
        ")"
    );
    const last: any = trace[trace.length - 1];
    assert(
      !!last && last.br === "devtools-surface",
      "a key on a developer surface must be refused as one, and this one took branch " +
        foundString(last && last.br) +
        " (last entries " +
        foundString(trace.slice(-3)) +
        ")"
    );
    assert(last.c === false, "and nothing may be consumed on it: " + foundString(last));

    // Nothing armed anywhere: neither the helper's leader nor its which-key panel.
    // Read AFTER a settle, deliberately: the trace entry proves the key was
    // dispatched, and this proves the dispatch left nothing behind. A read at the
    // instant the trace grew would pass before the overlay had a chance to paint,
    // which is the weaker assertion.
    await sleep(400);
    const settled = await ctx.chromeStateHandle();
    assert(
      settled.leader().active === false,
      "no leader may arm on a developer surface (leader " +
        foundString(settled.leader()) +
        ")"
    );
    assert(
      (settled.popup() ? Number(settled.popup()!.wkOn) : 0) === 0,
      "no which-key overlay may light on a developer surface (popup " +
        foundString(settled.popup()) +
        ")"
    );

    // THE OTHER SIDE OF THE BOUNDARY, with the same instrument: an ORDINARY
    // about: document is still the helper's, because no content script can run
    // there and the helper is the only key engine it has. A rule that grew to
    // cover about:blank would be "Lazyfox is dead on privileged documents" —
    // the exact state the actor half was written to fix, so the boundary is
    // asserted rather than assumed.
    await ctx.gotoPage(ctx.tabA, "about:blank");
    await ctx.expectChromeState(
      "an ordinary about: page is still Lazyfox's",
      (s: any) => s.leader().ownsKeys === true,
      { timeoutMs: 8000 }
    );
    // The other half of the instrument: the same field must NOT report an
    // ordinary privileged document as a developer surface, or the fix would be
    // "Lazyfox says nothing anywhere but web pages".
    const kbBlank = (await ctx.chromeStateHandle()).keyboard();
    assert(
      !!kbBlank && kbBlank.devtools === false,
      "about:blank is not a developer surface (keyboard " + foundString(kbBlank) + ")"
    );
    await ctx.sendKeys(null, [{ k: ";" }]);
    const armedHere = await waitFor(async () => {
      const s = await ctx.chromeStateHandle().catch(() => null);
      return s && s.leader().active === true ? true : null;
    }, 6000).catch(() => null);
    assert(
      armedHere,
      "the leader must still arm on about:blank: the rule removes a claim from ONE class " +
        "of document, it does not remove Lazyfox from privileged pages (leader " +
        foundString((await ctx.chromeStateHandle().catch(() => null))?.leader()) +
        ")"
    );
    await ctx.sendKeys(null, [{ k: "Escape" }]).catch(() => {});
  });
}

// A tiny helper so a failure message can never print `undefined` for a value the
// assertion already has in hand.
function foundString(v: any): string {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}
