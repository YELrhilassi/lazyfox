// popups tests (commandcenter).
//
// THE HOME PAGE'S POPUPS ARE THE PAGE'S OWN, and that is the product's design
// rather than an accident of this suite: the command center runs the same key
// engine a content script does (its own leader, its own popups, the shared
// binding table), because an out-of-process extension tab never reaches the
// chrome helper's capture listener at all. So these tests probe the popup the
// way every other page in the suite does — the host element, the composed
// `lazyfox:list` event, and the mirror the product publishes — instead of
// reading the chrome helper's own popup DOM.
//
// THAT IS ALSO WHY THE ASSERTIONS ARE STRONGER THAN THEY LOOK. The popup lives
// in a CLOSED shadow root, so its rows cannot be read at all; the product
// publishes exactly the observables a closed root permits (count, index, query,
// panel title). Every wait below is on one of those, which means a test can
// only pass by the product actually rendering, filtering and moving the
// selection.
import { evalIn, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "commandcenter/popups";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const popupOpen = (ms = 8000) => ctx.waitPopup(ctx.tabA, ms);
  const popupClosed = (ms = 8000) => ctx.waitPopupGone(ctx.tabA, ms);
  // The panel's identity. The closed shadow root hides the title from the DOM
  // entirely, so the product mirrors it onto <html> (see shared/overlay-popup).
  const titleIs = (want: string, ms = 8000) => ctx.waitPopupTitle(ctx.tabA, want, ms);
  // The leader state that matters on a Lazyfox-owned page: the PAGE's own
  // mirror. chromeState().leaderActive reports the CHROME helper's leader,
  // which this page no longer arms (that double-arming is what made `;f` work
  // only sometimes), so reading it here would be reading the wrong host.
  const pageLeaderArmed = () =>
    ctx.waitExpr(
      ctx.tabA,
      `document.documentElement.getAttribute("data-lf-leader") === "1"`,
      true,
      6000,
    );
  const activeUrl = (fragment: string, ms = 15000) => ctx.waitActiveUrl(fragment, ms);
  // Type the whole value in ONE chrome-helper round trip (real keystrokes,
  // minimal pacing) — used by the fast-typist regressions.
  const typeFast = async (text: string) => {
    await ctx.sendKeys(ctx.tabA, [...text].map((ch) => ({ k: ch })));
  };
  const closePopup = async () => {
    await ctx.press(ctx.tabA, "Escape");
    await popupClosed();
  };

  await t("leader ;o opens the URL popup, ;s the search popup", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    await popupOpen();
    await titleIs("Open URL");
    await closePopup();
    await ctx.leaderPress(ctx.tabA, "s");
    await popupOpen();
    await titleIs("Search");
    await closePopup();
  });
  await t("about:home (the startup-page fallback) converts to the command center", async () => {
    // Bug fix: Firefox's STARTUP tab defaults to about:home, which a Chrome
    // URL override cannot redirect. The startup fix points
    // browser.startup.homepage at about:newtab (which the override redirects
    // instantly); this test covers the FALLBACK — any tab left on about:home
    // (an explicit Home press, a profile whose homepage stayed at about:home)
    // is converted to the command center by the background.
    await ctx.activateTab(ctx.tabA);
    await navigate(ctx.tabA, "about:home", "none");
    await ctx.waitExpr(ctx.tabA, `location.href.includes("commandcenter.html")`, true, 15000);
    const f = await ctx.ccFacts(ctx.tabA);
    assert(f.url.includes("commandcenter.html"), "about:home converted to the command center, got " + f.url);
    await ctx.openCC(ctx.tabA);
  });
  await t(";W w opens the resize popup and arrows resize the window", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["W", "w"]);
    await popupOpen();
    await titleIs("Resize window");
    // The resize panel is fed by the same key route as every other popup: the
    // page's overlay consults it first, so the arrow reaches the panel rather
    // than the grid behind it.
    const before = await ctx.windowInnerSize();
    await ctx.press(ctx.tabA, "ArrowRight");
    // Tiling window managers lock the window size (resizeBy() is a no-op) and
    // some automation environments can't observe a programmatic resize in the
    // viewport at all. The popup open/close + arrow routing are what matter;
    // assert the delta only when a growth was actually observed. The expected
    // delta is the SHARED arrow step (shared/resize.ts: 32, Shift = fine), the
    // same one every host uses — the assertion used to read ~20 because the
    // home page's resize panel was measuring a different host's popup, which is
    // exactly the "it moves a different amount here" drift that constant
    // removed. The viewport is read from a command-center page (innerWidth),
    // never the WebDriver /window/rect endpoint, which stays frozen in this env.
    const grew = await waitFor(async () => {
      const r = await ctx.windowInnerSize();
      return r.width > before.width + 12 ? r : null;
    }, 6000)
      .then(() => true)
      .catch(() => false);
    if (grew) {
      const after = await ctx.windowInnerSize();
      assert(Math.abs(after.width - before.width - 32) <= 6, `width grew by ~32 (${before.width} -> ${after.width})`);
    } else {
      console.log("  (window-growth assertion skipped — WM or automation did not apply the resize)");
    }
    await closePopup();
  });
  await t("popup arrows navigate the list, never resize the window", async () => {
    // Regression: arrow keys used to be routed through the resize handler
    // whenever ANY popup was open, so arrows resized the window (and swallowed
    // the key) instead of reaching the popup's own navigation. Arrows must only
    // resize while the resize popup is actually open.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    await popupOpen();
    const before = await ctx.windowRect();
    await ctx.press(ctx.tabA, "ArrowDown");
    // Give any WRONG resize a bounded window to show up (the absence check),
    // then assert the window never moved.
    await new Promise((r) => setTimeout(r, 300));
    await popupOpen(3000).catch(() => {
      throw new Error("the URL popup closed on ArrowDown (it should only navigate)");
    });
    const after = await ctx.windowRect();
    assert(
      Math.abs(after.width - before.width) < 10 && Math.abs(after.height - before.height) < 10,
      `window not resized by ArrowDown (${before.width}x${before.height} -> ${after.width}x${after.height})`
    );
    await closePopup();
  });
  await t("popup arrow keys move the highlighted row", async () => {
    // Regression: the selector's mouseenter handler used to hijack idx on hover,
    // so every arrow-driven re-render snapped the selection back to the hovered
    // row and arrow navigation looked dead. Hover feedback is now pure CSS; the
    // keyboard alone moves the selection. The tabs popup reliably has >1 row
    // (tabA + probe), so ArrowDown/ArrowUp must actually change the selection.
    await ctx.openCC(ctx.tabA);
    // Installed BEFORE the popup opens: the rows render (and publish) the
    // moment it does, so a watcher installed afterwards misses the first fill.
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "t");
    await popupOpen();
    const first = (await ctx.waitListEvent(ctx.tabA, { count: { ge: 2 } }, 8000)).idx;
    await ctx.press(ctx.tabA, "ArrowDown");
    await ctx.waitListEvent(ctx.tabA, { idx: { ne: first } }, 5000).catch(() => {
      throw new Error(`ArrowDown did not move the selection away from ${first}`);
    });
    await ctx.press(ctx.tabA, "ArrowUp");
    await ctx.waitListEvent(ctx.tabA, { idx: first }, 5000).catch(() => {
      throw new Error(`ArrowUp did not return the selection to ${first}`);
    });
    await closePopup();
  });
  await t(";t digits jump straight to a tab (the popup closes AND the tab switches)", async () => {
    // QUICK ACCESS BY NUMBER. Typing digits narrows the picker by jump number,
    // and when they resolve to exactly one tab the popup switches to it without
    // waiting for Enter. It used to close the popup and leave the selection
    // where it was, which is worse than ignoring the digit: the modal vanishes
    // and the user is left on the tab they were already on, with nothing to
    // read as "that did not work".
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    const home = ctx.tabA;
    // The number comes from the PRODUCT's own numbering (the same list the
    // popup filters on), never from counting the strip: the two disagree about
    // transient tabs, and a re-derived number names a different tab.
    const all = await ctx.tabsInfo();
    const probeId = await evalIn(ctx.probe, `browser.tabs.getCurrent().then(t => t && t.id)`).catch(() => null);
    const probeTab = (all as any[]).find((x) => x.id === probeId);
    const n = await ctx.productNumberOf(probeTab, all);
    assert(n > 0, "the probe tab has a number in the product's numbering");
    await ctx.leaderPress(ctx.tabA, "t");
    await popupOpen();
    await ctx.pressNumber(ctx.tabA, n);
    await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.id === probeId ? a : null;
    }, 8000).catch(async () => {
      throw new Error(
        `typing ${n} in ;t did not switch to the probe tab (active is ${(await ctx.activeTabInfo()).url})`
      );
    });
    await popupClosed(4000).catch(() => {
      throw new Error(";t stayed open after the digits resolved to one tab");
    });
    // Put the home tab back in front for the rest of the suite.
    await ctx.activateTab(home);
  });
  await t("home ;o popup: fast Enter opens the typed URL, never the home page", async () => {
    // Regression: Enter in the ;o popup must open the typed value even when
    // Enter lands before the debounced suggestions resolve (fast typists) —
    // previously the empty list swallowed Enter, or a scheme-less value was
    // passed raw to gBrowser and, failing to load, left an about:blank tab that
    // the background converted to the lazyfox home page.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    await popupOpen();
    const target = `http://127.0.0.1:${ctx.port}/hello`;
    // Type fast and press Enter immediately, before the 70ms debounce + async
    // suggestion fetch can populate the list: one round trip, no pacing.
    await typeFast(target);
    await ctx.press(ctx.tabA, "Enter");
    // The typed URL must open and the active tab must never be the home page.
    await activeUrl("/hello");
    const a = await ctx.activeTabInfo();
    assert(a && a.url.includes("/hello"), "active tab is the typed URL, got " + (a && a.url));
    assert(!a.url.includes("commandcenter.html"), "active tab is not the home page");
    // ;o from the home page reuses the home tab, so tabA is now the site —
    // navigate it back to the command center for the tests that follow.
    await ctx.openCC(ctx.tabA);
  });
  await t("home ;O replaces the current tab in place", async () => {
    // Regression: ;O (replace-open) must navigate the current tab, not open a
    // new one. The <browser> element's loadURI() takes an nsIURI, so a string
    // used to throw and fall through to addTab.
    await ctx.openCC(ctx.tabA);
    const before = (await ctx.tabsInfo()).length;
    await ctx.leaderPress(ctx.tabA, "O");
    await popupOpen();
    await titleIs("Open URL in current tab");
    const target = `http://127.0.0.1:${ctx.port}/hello`;
    await typeFast(target);
    await ctx.press(ctx.tabA, "Enter");
    await activeUrl("/hello");
    const after = (await ctx.tabsInfo()).length;
    assert(after === before, "no new tab opened: " + before + " -> " + after);
    const a = await ctx.activeTabInfo();
    assert(a.url.includes("/hello"), "active tab replaced with typed URL, got " + a.url);
    assert(!a.url.includes("commandcenter.html"), "active tab is not the home page");
    await ctx.openCC(ctx.tabA);
  });
  await t("home ;h opens history in place", async () => {
    // Regression: opening a history row from the home page must reuse the
    // home tab, not stack a new tab.
    await ctx.openCC(ctx.tabA);
    // Seed a REAL visit (addUrl registers no visit, so history.search never
    // sees it): visit /hello in tabA, then wait for the history service to
    // actually report it before opening the popup — the popup fetches its
    // items once at open, so this is the deterministic race fix. (The probe
    // stays untouched: it must keep its extension realm for history.search.)
    await navigate(ctx.tabA, `${ctx.base}/hello`, "complete");
    // The visit is registered synchronously with the page load; give the
    // history service its own poll window, then return to the command center.
    await ctx.waitExpr(ctx.tabA, `document.title`, "HELLO PAGE", 10000);
    await ctx.openCC(ctx.tabA); // back to the command center
    const before = (await ctx.tabsInfo()).length;
    // The watcher goes in BEFORE the popup opens: the list is fetched once at
    // open and published on the first render, so a later install sees nothing
    // until a re-render that may never come.
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "h");
    await popupOpen();
    await titleIs("History");
    // Wait for the rows to actually load (the list is fetched once at open).
    await ctx.waitListEvent(ctx.tabA, { count: { ge: 1 } }, 15000).catch(() => {
      throw new Error("[history-rows] the history popup never rendered a row");
    });
    // The leader must be DOWN before the filter keys go out, and that is read
    // rather than assumed: an armed leader (or a live one-shot capture, which
    // the same mirror reports) treats the first character as a BINDING, so it
    // would answer `h` by re-running `;h` — which re-opens this popup with a
    // fresh, empty input, and the remaining four characters land in THAT one.
    // The observable is exactly a query one character short, which is what
    // makes this worth stating in the test rather than leaving to a log.
    const armed = await pageLeaderArmed().then(() => true).catch(() => false);
    assert(!armed, ";h left the page leader armed, so the filter keys would run as bindings");
    await ctx.typeIn(ctx.tabA, "hello");
    // The input holds what was TYPED, and the matched row SURVIVED the filter.
    // This is the direct regression guard for the defect this test found the
    // hard way: the popup's own keymap preventDefaulted the key that switches
    // it into insert mode, which the host reads as "do not insert" — so the
    // FIRST character of every query was dropped and the popup quietly searched
    // for `ello`. A row-presence assertion cannot see that, because `ello`
    // matches the same rows `hello` does.
    await ctx.waitListEvent(ctx.tabA, { q: "hello", count: { ge: 1 } }, 15000).catch(() => {
      throw new Error("[history-typed] the popup input never held the full query with a row to match");
    });
    // Which row is actually OPENED is asserted below, against the real tab URL,
    // rather than against a guess about which rows the fuzzy matcher keeps.
    await ctx.press(ctx.tabA, "Enter");
    await activeUrl("/hello").catch(() => {
      throw new Error("[history-open] Enter did not open /hello");
    });
    const after = (await ctx.tabsInfo()).length;
    assert(after === before, "no new tab opened: " + before + " -> " + after);
    const a = await ctx.activeTabInfo();
    assert(a.url.includes("/hello"), "history row opened in place, got " + a.url);
    await ctx.openCC(ctx.tabA);
  });
}
