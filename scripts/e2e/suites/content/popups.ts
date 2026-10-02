// popups tests (content). Deterministic: every wait targets a product signal
// (popup hosts, composed list events, tab strip changes) instead of fixed
// sleeps.
import { activate, evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content", name, fn);

  // The popup renders its rows (and fires the composed `lazyfox:list` event)
  // the moment it opens, so the watcher has to be installed BEFORE the leader
  // press — otherwise the first render is missed and `waitListEvent` only
  // catches a later re-render that may never come.
  //
  // It also waits for the popup's input to hold focus. Keys only reach a
  // popup through its focused input, so a typeIn that races the focus() lands
  // on the page behind instead — the same silent flake as an early Enter.
  const openPopup = async (key: string, opts?: any) => {
    await ctx.watchList(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, key, opts);
    await ctx.waitPopup(ctx.tabA, 8000);
    await ctx.waitExpr(
      ctx.tabA,
      `(() => { const h = document.getElementById("lazyfox-popup"); if (!h) return false;
        const i = h.querySelector("input") || h.querySelector(".lf-input");
        return !!i && i === document.activeElement; })()`,
      true,
      5000
    ).catch(() => {});
  };
  const closePopup = async () => {
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 8000);
  };
  // Type a filter and wait for the popup's composed list event to report it —
  // the closed-shadow-root signal that the rows actually re-rendered.
  const filterTo = async (query: string) => {
    await ctx.watchList(ctx.tabA);
    await ctx.typeIn(ctx.tabA, query);
    await ctx.waitListEvent(ctx.tabA, { q: query });
  };

  await t(";s search popup: type query, Enter searches", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const beforeIds = new Set((await ctx.tabsInfo()).map((t) => t.id));
    await openPopup("s");
    await filterTo("hello world");
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitPopupGone(ctx.tabA, 8000);
    // Firefox's default search engine opens a new tab. Assert only that a new
    // tab appeared — don't depend on the engine's URL (Google serves a captcha
    // wall on some networks, and the test must not depend on an external site).
    const searchTab = await waitFor(async () => {
      const now = await ctx.tabsInfo();
      return now.find((x) => !beforeIds.has(x.id)) || null;
    }, 20000);
    assert(searchTab, "a search tab opened");
    // Close the search tab so its subframes don't pollute later tests.
    await evalIn(ctx.probe, `browser.tabs.remove(${searchTab.id})`).catch(() => {});
    await ctx.waitTabUrl("", { gone: false, timeoutMs: 1 }).catch(() => {});
    await activate(ctx.tabA);
  });
  await t(";S search popup: Enter searches in the current tab", async () => {
    // ;S (shift+s) runs the search in the SAME tab, replacing it — the
    // opposite of ;s (new tab). Verify via the probe's tabs.query (robust to
    // the external engine page still loading): the active tab is still tabA's
    // id, its URL left the test page, and no new tab appeared.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA);
    const before = await ctx.tabCount();
    const tabAId = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => { const t = ts.find(x => (x.url||"").indexOf("127.0.0.1") !== -1); return t ? t.id : null; })`);
    assert(tabAId, "located tabA's id");
    await openPopup("S", { shift: true });
    await filterTo("hello world");
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitPopupGone(ctx.tabA, 8000);
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const active = now.find((t) => t.active);
      return active && active.id === tabAId && (active.url || "").indexOf(ctx.base) === -1 ? active : null;
    }, 20000);
    assert((await ctx.tabCount()) === before, ";S opened no new tab");
    // Force the tab back to the local test page through the extension API
    // (a BiDi navigate away from the heavy external page can stall, and later
    // tests need a clean local context).
    await evalIn(ctx.probe, `browser.tabs.update(${tabAId}, { url: ${JSON.stringify(`${ctx.base}/`)} }).then(() => true)`).catch(() => {});
    await ctx.waitActiveUrl("127.0.0.1", 10000);
  });
  await t(";o URL popup: type URL, Enter opens it in a new tab", async () => {
    // ;o opens in a NEW tab (openInNewTab config default); ;O is the replace
    // variant. The current tab must be left untouched.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const beforeIds = new Set((await ctx.tabsInfo()).map((t) => t.id));
    await openPopup("o");
    const url = `http://127.0.0.1:${ctx.port}/hello`;
    await ctx.watchList(ctx.tabA);
    await ctx.typeIn(ctx.tabA, url);
    await ctx.waitListEvent(ctx.tabA, { q: url });
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const t = now.find((x) => !beforeIds.has(x.id));
      return t && (t.url || "").includes("/hello") ? t : null;
    }, 15000);
    // the current tab was NOT navigated
    const u = await evalIn(ctx.tabA, `location.href`);
    assert(u && u.includes("/") && !u.includes("/hello"), ";o left the current tab alone: " + u);
  });
  await t(";O URL popup: Enter replaces the current tab", async () => {
    // ;O (shift+o) opens the URL in the SAME tab, replacing it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    await openPopup("O", { shift: true });
    const url = `http://127.0.0.1:${ctx.port}/hello`;
    await ctx.watchList(ctx.tabA);
    await ctx.typeIn(ctx.tabA, url);
    await ctx.waitListEvent(ctx.tabA, { q: url });
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitExpr(ctx.tabA, `location.href.includes("/hello")`, true, 15000);
    assert((await ctx.tabCount()) === before, ";O opened no new tab");
  });
  await t(";t tab switcher popup lists tabs and Enter switches", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await openPopup("t");
    // Wait for the tab rows to render before pressing Enter. The popup's
    // listTabs skips the harness plumbing (relay / probe #lfc= tabs), so the
    // row count is the *real* tab count, not tabsInfo().length.
    await ctx.waitListEvent(ctx.tabA, { count: await ctx.tabCount() });
    const first = await ctx.tabsInfo();
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitPopupGone(ctx.tabA, 8000);
    // Enter activates the highlighted tab (index 0 = tabA, the first tab)
    const a = await ctx.activeTabInfo();
    assert(a && a.id === first[0].id, "activated the first tab: " + (a && a.url));
  });
  await t(";h history popup filters and opens a result", async () => {
    // ;h opens the history result in a NEW tab (it follows the openInNewTab
    // config like ;o); the current tab is left untouched.
    // seed history with the target page first
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target2`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Firefox indexes a visit asynchronously, and the popup fetches its items
    // ONCE at open (`history("")`) — if the entry is not searchable yet the
    // popup caches an empty list and the filter/Enter below can never match.
    // Wait on the SAME query the popup makes, so the signal is exactly the
    // precondition the product needs.
    await waitFor(async () => {
      const hit = await evalIn(
        ctx.probe,
        `browser.history.search({ text: "", startTime: 0, maxResults: 1000 }).then(rs => rs.some(r => (r.url || "").includes("/target2")))`
      ).catch(() => false);
      return hit ? true : null;
    }, 15000).catch(() => { throw new Error("[history-seed] /target2 never became searchable"); });
    const beforeIds = new Set((await ctx.tabsInfo()).map((t) => t.id));
    await openPopup("h");
    await filterTo("target two");
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const t = now.find((x) => !beforeIds.has(x.id));
      return t && (t.url || "").includes("/target2") ? t : null;
    }, 15000);
    const u = await evalIn(ctx.tabA, `location.href`);
    assert(u && !u.includes("/target2"), ";h left the current tab alone: " + u);
  });
  await t(";b bookmarks popup opens and closes", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await openPopup("b");
    await closePopup();
  });
  await t(";d downloads popup opens and closes", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await openPopup("d");
    await closePopup();
  });
  await t(";? help popup opens with the binding list", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await openPopup("?", { shift: true });
    await closePopup();
  });
  await t(";t tab switcher: the number key jumps to that tab", async () => {
    // The picker shows each tab's 1-based strip position and its digit keys
    // jump there, exactly like ;1-;9.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Make sure there is at least a second real tab to jump to.
    if ((await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t)).length < 2) {
      await evalIn(
        ctx.probe,
        `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/target2`)}, active: false }).then(t => t.id)`
      );
      await ctx.waitTabUrl("/target2", { timeoutMs: 8000 });
    }
    const list = (await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t));
    const second = list[1];
    assert(second, "there is a tab 2 to jump to");
    await ctx.activateTab(ctx.tabA).catch(() => {});
    await openPopup("t");
    await ctx.press(ctx.tabA, "2");
    const jumped = await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.id === second.id ? a : null;
    }, 8000).catch(() => null);
    assert(jumped, "pressing 2 in the tab switcher jumped to tab 2");
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });
  await t(";? help popup filters as you type and Enter runs the match", async () => {
    // The redesigned help popup searches by key/name/group; typing "zen"
    // narrows to the ;z binding and Enter runs it (fullscreen toggles on).
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await openPopup("?", { shift: true });
    await filterTo("zen");
    await ctx.press(ctx.tabA, "Enter");
    const fs = await ctx.waitExpr(ctx.tabA, `window.fullScreen`, true, 8000).catch(() => null);
    assert(fs, "help search matched ;z and ran it (fullscreen on)");
    await ctx.leaderSeq(ctx.tabA, ["W", "z"]);
    await ctx.waitExpr(ctx.tabA, `!window.fullScreen`, true, 8000);
  });
  await t(";/ find-in-page popup opens and finds", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await openPopup("/");
    await ctx.typeIn(ctx.tabA, "Lazyfox");
    await ctx.press(ctx.tabA, "Enter");
    // The walk landed when the widget mirrors its state on <html>.
    await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-find") != null`, true, 8000);
    await closePopup();
  });
  await t(";w resize popup from the content page", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.windowInnerSize();
    await openPopup("w");
    await ctx.press(ctx.tabA, "ArrowDown");
    // Same WM/automation caveat as the command-center resize test: exercise the
    // popup opening and the arrow, but assert the height delta only when a
    // growth was actually observed (see windowInnerSize).
    const grew = await waitFor(async () => {
      const r = await ctx.windowInnerSize();
      return r.height > before.height + 12 ? r : null;
    }, 6000)
      .then(() => true)
      .catch(() => false);
    if (grew) {
      const after = await ctx.windowInnerSize();
      assert(Math.abs(after.height - before.height - 32) <= 8, `height grew by ~32 (${before.height} -> ${after.height})`);
    } else {
      console.log("  (window-growth assertion skipped — WM or automation did not apply the resize)");
    }
    await closePopup();
  });
  await t(";V recently-closed popup lists and restores a closed tab", async () => {
    // The popup (capital V) shows everything the browser remembers closing;
    // Enter restores the highlighted (most recent) entry. Unlike ;v, which
    // reopens the last tab without a list, ;V must open a real popup.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    // Seed one recently-closed entry without disturbing tabA: create and then
    // remove a background tab through the probe's extension realm.
    const tid = await evalIn(
      ctx.probe,
      `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/scratch?recentlyclosed`)}, active: false }).then(t => t.id)`
    );
    await ctx.waitTabUrl("scratch?recentlyclosed", { timeoutMs: 8000 });
    await evalIn(ctx.probe, `browser.tabs.remove(${tid}).then(() => true)`);
    await ctx.waitTabUrl("scratch?recentlyclosed", { gone: true, timeoutMs: 8000 });
    await openPopup("V", { shift: true });
    // The list is fetched ASYNC at open, and Enter restores whatever row is
    // HIGHLIGHTED — in a full run the newest closed entry may be a *window*
    // left by an earlier test, not the tab seeded here. So filter to this
    // test's own entry first. The filter token is the unique query string of
    // this test's URL, so exactly one row can ever match no matter what else
    // is in the list, and landing on count === 1 is simultaneously the proof
    // that the async list actually loaded.
    await filterTo("recentlyclosed");
    // Landing on exactly this one row is also the proof that the async list
    // finished loading: count === 1 with our filter in the input.
    await ctx
      .waitListEvent(ctx.tabA, { q: "recentlyclosed", count: 1 }, 10000)
      .catch(async () => {
        const d = await evalIn(ctx.tabA, `window.__lfList`).catch(() => null);
        throw new Error("[recently-closed] filtered rows never rendered: " + JSON.stringify(d));
      });
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitTabCount(before + 1, 10000);
    // The restored tab is the newly active web page; hand focus back to tabA
    // and remove the restored tab so later tests start from a clean strip.
    await ctx.activateTab(ctx.tabA);
    await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => { const t = ts.find(x => (x.url||"").indexOf("scratch?recentlyclosed") !== -1); return t ? browser.tabs.remove(t.id).then(() => true) : true; })`).catch(() => {});
    await ctx.waitTabUrl("scratch?recentlyclosed", { gone: true, timeoutMs: 8000 });
  });
  await t("popup input never leaks to the page behind (keypress/keyup isolation)", async () => {
    // Regression: an overlay swallows every keydown at the window capture
    // phase, but Firefox still dispatches the keypress/keyup that follow a
    // consumed keydown — so a page listening on those saw what the user typed
    // into Lazyfox's own popup. Instrument the page, open a popup, type, and
    // assert the page observed nothing.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(ctx.tabA, `(() => {
      window.__lfLeak = [];
      for (const type of ["keypress", "keyup"]) {
        window.addEventListener(type, (e) => window.__lfLeak.push(type + ":" + e.key), true);
      }
      return true;
    })()`);
    await openPopup("t");
    // `;t` and the query characters all go through the popup's own input.
    await ctx.typeIn(ctx.tabA, "jklmn");
    const leak = await evalIn(ctx.tabA, `JSON.stringify(window.__lfLeak || [])`);
    const seen = JSON.parse(leak || "[]");
    assert(seen.length === 0, "the page observed no keypress/keyup, got " + leak);
    await closePopup();
    // Control: with no overlay up the page DOES observe keys, so "nothing
    // seen" above is a real result and not dead instrumentation.
    await evalIn(ctx.tabA, `window.__lfLeak = []; true`);
    await ctx.press(ctx.tabA, "a");
    await ctx.press(ctx.tabA, "b");
    const control = JSON.parse(
      (await evalIn(ctx.tabA, `JSON.stringify(window.__lfLeak || [])`)) || "[]"
    );
    assert(
      control.some((s) => s.indexOf(":a") !== -1) && control.some((s) => s.indexOf(":b") !== -1),
      "control: the page sees keys when no overlay is up, got " + JSON.stringify(control)
    );
  });
}
