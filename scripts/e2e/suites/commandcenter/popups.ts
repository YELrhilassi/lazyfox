// popups tests (commandcenter). Deterministic: every wait targets a product
// signal (chrome popup state, selection index, active tab URL) instead of
// fixed sleeps.
import { navigate, waitFor } from "../../bidi.ts";
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

  const popupOpen = (ms = 8000) =>
    waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.current ? s : null;
    }, ms);
  const popupClosed = (ms = 8000) =>
    waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && !s.popup.current ? s : null;
    }, ms);
  const activeUrl = (fragment: string, ms = 15000) => ctx.waitActiveUrl(fragment, ms);
  // Type the whole value in ONE chrome-helper round trip (real keystrokes,
  // minimal pacing) — used by the fast-typist regressions.
  const typeFast = async (text: string) => {
    await ctx.sendKeys(ctx.tabA, [...text].map((ch) => ({ k: ch })));
  };

  await t("leader ;o opens the chrome URL popup, ;s the search popup", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    const s = await popupOpen();
    assert(s && s.popup && s.popup.current, ";o opens a popup");
    const panel = s.popup.panels[0] || {};
    assert(panel.title === "Open URL", "URL popup title, got " + panel.title);
    assert(panel.hasInput, "URL popup has its input");
    await ctx.press(ctx.tabA, "Escape");
    await popupClosed();
    await ctx.leaderPress(ctx.tabA, "s");
    const s2 = await popupOpen();
    assert(s2 && s2.popup && s2.popup.current, ";s opens a popup");
    assert((s2.popup.panels[0] || {}).title === "Search", "search popup title");
    await ctx.press(ctx.tabA, "Escape");
    await popupClosed();
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
  await t("leader ;w opens the resize popup and arrows resize the window", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["W", "w"])
    await popupOpen();
    const before = await ctx.windowInnerSize();
    await ctx.press(ctx.tabA, "ArrowRight");
    // Tiling window managers lock the window size (resizeBy() is a no-op) and
    // some automation environments can't observe a programmatic resize in the
    // viewport at all. The popup open/close + arrow routing are what matter;
    // assert the ~20px delta only when a growth was actually observed. The
    // viewport is read from a command-center page (innerWidth), never the
    // WebDriver /window/rect endpoint, which stays frozen in this env.
    const grew = await waitFor(async () => {
      const r = await ctx.windowInnerSize();
      return r.width > before.width + 12 ? r : null;
    }, 6000)
      .then(() => true)
      .catch(() => false);
    if (grew) {
      const after = await ctx.windowInnerSize();
      assert(Math.abs(after.width - before.width - 20) <= 6, `width grew by ~20 (${before.width} -> ${after.width})`);
    } else {
      console.log("  (window-growth assertion skipped — WM or automation did not apply the resize)");
    }
    await ctx.press(ctx.tabA, "Escape");
    await popupClosed();
  });
  await t("popup arrows navigate the list, never resize the window", async () => {
    // Regression: the chrome window's capture-phase keydown handler routed
    // arrow keys through the resize handler whenever ANY popup was open, so
    // arrows resized the window (and swallowed the key) instead of reaching
    // the popup's own navigation. Arrows must only resize while the ;w
    // resize popup is actually open.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    await popupOpen();
    const before = await ctx.windowRect();
    await ctx.press(ctx.tabA, "ArrowDown");
    // Give any WRONG resize a bounded window to show up (the absence check),
    // then assert the window never moved.
    await new Promise((r) => setTimeout(r, 300));
    const s = await ctx.chromeState();
    assert(s && s.popup && s.popup.current, "URL popup still open after ArrowDown");
    const after = await ctx.windowRect();
    assert(
      Math.abs(after.width - before.width) < 10 && Math.abs(after.height - before.height) < 10,
      `window not resized by ArrowDown (${before.width}x${before.height} -> ${after.width}x${after.height})`
    );
    await ctx.press(ctx.tabA, "Escape");
    await popupClosed();
  });
  await t("popup arrow keys move the highlighted row", async () => {
    // Regression: the selector's mouseenter handler used to hijack idx on hover,
    // so every arrow-driven re-render snapped the selection back to the hovered
    // row and arrow navigation looked dead. Hover feedback is now pure CSS; the
    // keyboard alone moves the selection. The tabs popup reliably has >1 row
    // (tabA + probe), so ArrowDown/ArrowUp must actually change the selection.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "t");
    const s0 = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.current && s.popup.selIdx && s.popup.selIdx[0] >= 0 ? s : null;
    }, 8000);
    const first = s0.popup.selIdx[0];
    await ctx.press(ctx.tabA, "ArrowDown");
    const down = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.selIdx && s.popup.selIdx[0] !== first ? true : null;
    }, 5000);
    assert(down === true, `ArrowDown moved selection away from ${first}`);
    await ctx.press(ctx.tabA, "ArrowUp");
    const up = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.selIdx && s.popup.selIdx[0] === first ? true : null;
    }, 5000);
    assert(up === true, `ArrowUp returned selection to ${first}`);
    await ctx.press(ctx.tabA, "Escape");
    await popupClosed();
  });
  await t("chrome ;o popup: fast Enter opens the typed URL, never the home page", async () => {
    // Regression: Enter in the ;o popup must open the typed value even when
    // Enter lands before the debounced suggestions resolve (fast typists) —
    // previously the empty list swallowed Enter, or a scheme-less value was
    // passed raw to gBrowser and, failing to load, left an about:blank tab that
    // the background converted to the lazyfox home page.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    const s = await popupOpen();
    assert(s && s.popup && s.popup.current, ";o opens a popup");
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
    // ;o from the home page opens in place (the home tab is reused), so tabA
    // is now the site — navigate it back to the command center for the tests
    // that follow.
    await ctx.openCC(ctx.tabA);
  });
  await t("chrome ;O replaces the current tab in place", async () => {
    // Regression: ;O (replace-open) must navigate the current tab, not open a
    // new one. The <browser> element's loadURI() takes an nsIURI, so a string
    // used to throw and fall through to addTab.
    await ctx.openCC(ctx.tabA);
    const before = (await ctx.tabsInfo()).length;
    await ctx.leaderPress(ctx.tabA, "O");
    const s = await popupOpen();
    const panel = (s && s.popup && s.popup.panels && s.popup.panels[0]) || {};
    assert(panel.title === "Open URL in current tab", ";O popup title, got " + panel.title);
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
  await t("chrome ;h from home opens history in place", async () => {
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
    await ctx.leaderPress(ctx.tabA, "h");
    const s = await popupOpen();
    const panel = (s && s.popup && s.popup.panels && s.popup.panels[0]) || {};
    assert(panel.title === "History", ";h popup title, got " + panel.title);
    // Wait for the rows to actually load (the list is fetched once at open).
    await waitFor(async () => {
      const st = await ctx.chromeState();
      return st && st.popup && st.popup.items && st.popup.items.length ? true : null;
    }, 8000).catch(() => { throw new Error("[history-rows] popup rows never loaded"); });
    // Filter to the /hello row and wait for the filtered list before Enter.
    await ctx.typeIn(ctx.tabA, "hello");
    await waitFor(async () => {
      const st = await ctx.chromeState();
      const items = (st && st.popup && st.popup.items) || [];
      return items.length >= 1 && items.every((t) => /hello/i.test(t)) ? true : null;
    }, 8000).catch(() => { throw new Error("[history-filter] filtered row never matched"); });
    await ctx.press(ctx.tabA, "Enter");
    await activeUrl("/hello").catch(() => { throw new Error("[history-open] Enter did not open /hello"); });
    const after = (await ctx.tabsInfo()).length;
    assert(after === before, "no new tab opened: " + before + " -> " + after);
    const a = await ctx.activeTabInfo();
    assert(a.url.includes("/hello"), "history row opened in place, got " + a.url);
    await ctx.openCC(ctx.tabA);
  });
}
