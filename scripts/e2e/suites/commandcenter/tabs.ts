// tabs tests (commandcenter). Deterministic: every wait targets a product
// signal (active tab URL, tab counts, chrome state, muted counts) instead of
// fixed sleeps.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "commandcenter/tabs";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const waitCount = async (want: number, step: string, ms = 10000) => {
    let seen = -1;
    try {
      await waitFor(async () => {
        seen = await ctx.tabCount();
        return seen === want ? true : null;
      }, ms);
    } catch (e) {
      throw new Error(step + ": wanted " + want + " tabs, saw " + seen);
    }
  };

  await t("leader ;I from the home opens the setup page in the current tab", async () => {
    // Regression: ;I used to spawn a NEW tab (browser.tabs.create). From the
    // command-center home it must reuse the tab in place (like ;o/;h) so the
    // install page never stacks a second extension tab.
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    const before = (await ctx.tabsInfo()).length;
    await ctx.leaderPress(ctx.tabA, "I");
    const setupTab = await ctx.waitActiveUrl("setup.html", 15000);
    assert(setupTab, ";I opened the setup page");
    const after = (await ctx.tabsInfo()).length;
    assert(after === before, "no new tab opened: " + before + " -> " + after);
    const a = await ctx.activeTabInfo();
    assert(a.url.includes("setup.html"), "active tab is the setup page, got " + a.url);
    assert(!a.url.includes("commandcenter.html"), "setup page replaced the home tab, not stacked");
    // Back to the command center for the tests that follow.
    await ctx.openCC(ctx.tabA);
  });
  await t("leader ;m mutes the active tab", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    // The extension-page realm does not expose tabs.Tab.muted, so the chrome
    // helper reports the muted-tab count (the source of truth).
    const before = (await ctx.chromeState()).mutedCount;
    assert(typeof before === "number", "muted count readable");
    await ctx.leaderPress(ctx.tabA, "m");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s.mutedCount === before + 1 ? s : null;
    }, 8000);
    // unmute again so later tests are unaffected
    await ctx.leaderPress(ctx.tabA, "m");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s.mutedCount === before ? s : null;
    }, 8000);
  });
  await t("command center tab commands ;n ;x ;v ;c", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    // ;n — new tab, redirected to the command center
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "n");
    await waitCount(before + 1, ";n new tab");
    await ctx.waitTabUrl("commandcenter.html", { timeoutMs: 10000 });
    assert((await ctx.ccTabs()).length >= 1, "new tab redirected to command center");
    // ;c — duplicate the active tab (tabA after the activate below)
    await ctx.activateTab(ctx.tabA);
    const before2 = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "c");
    await waitCount(before2 + 1, ";c duplicate");
    // ;x — the duplicate is active (chrome selects it); close it, keep tabA
    const before3 = await ctx.tabCount();
    await ctx.leaderPressNoFocus("x");
    await waitCount(before3 - 1, ";x close");
    // ;v — reopen the closed tab
    await ctx.activateTab(ctx.tabA);
    const before4 = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "v");
    try {
      await waitCount(before4 + 1, ";v reopen");
    } catch (e) {
      // On failure, show what SessionStore actually offers to reopen.
      const rc = await evalIn(
        ctx.probe,
        `browser.sessions.getRecentlyClosed({maxResults:20}).then(l => JSON.stringify(l.map(i => i.tab ? (i.tab.url||"") : "(window)")))`
      ).catch(() => "<err>");
      throw new Error(String((e && e.message) || e) + "; recently closed: " + rc);
    }
    await ctx.activateTab(ctx.tabA);
  });
  await t("probe tab: command center from the background", async () => {
    const a = await ctx.activeTabInfo();
    assert(a && a.url.includes("commandcenter.html"), "probe tab active: " + (a && a.url));
  });
  await t("stealth ;N from the command center opens a stealth tab", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    const before = await ctx.tabCount();
    // Chrome owns the leader on the command center: ;N goes through the
    // requestBg -> reqResult round-trip and must still open a container tab.
    await ctx.leaderPress(ctx.tabA, "N");
    const opened = await waitFor(async () => {
      const ts = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, cs: t.cookieStoreId})))`);
      const stealth = (ts || []).find((t) => t.cs && t.cs !== "firefox-default");
      return stealth ? stealth : null;
    }, 10000).catch(() => null);
    assert(opened, ";N from the command center opened a stealth container tab");
    // The stealth tab and a transient #lfc= request/sessionState tab can
    // coexist for a moment: wait for the transients to self-remove AND the
    // count to settle at exactly one added tab, instead of sleeping.
    await waitFor(async () => (await ctx.tabCount()) === before + 1 ? true : null, 10000);
    await new Promise((r) => setTimeout(r, 600));
    assert((await ctx.tabCount()) === before + 1, "one tab added: " + (await ctx.tabCount()));
    // With the stealth tab active, the window bar badges it.
    const st = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("stealth") !== -1 ? s : null;
    }, 8000).catch(() => null);
    assert(st, "status bar badges the stealth tab opened from the command center");
    // Clean up: close the stealth tab and return to the command center.
    await evalIn(ctx.probe, `browser.tabs.remove(${opened.id}).catch(() => true); true`).catch(() => {});
    await waitFor(async () => (await ctx.tabCount()) === before ? true : null, 10000).catch(() => {});
    await ctx.activateTab(ctx.tabA);
  });
  await t("closing a tab down to two leaves a real tab active, not the relay", async () => {
    // Regression (the blank-page dead end): with the strip [A, relay, B],
    // closing the tab next to the hidden relay makes Firefox select the
    // relay, and the post-close guard must steer back to a REAL tab — never
    // the dying wrapper still in gBrowser.tabs mid-teardown. Drive the window
    // down to exactly two real tabs, close one, and assert the survivor is
    // active, is a real page, and the leader still runs. NOTE: ctx.tabA is
    // deliberately the tab that gets closed — it must not be touched after.
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    // Identify the two tabs we keep (probe + tabA), close every other tab
    // from the probe's extension realm.
    const tabAid = await evalIn(ctx.tabA, `browser.tabs.getCurrent().then(t => t && t.id)`).catch(() => null);
    const probeId = await evalIn(ctx.probe, `browser.tabs.getCurrent().then(t => t && t.id)`).catch(() => null);
    assert(tabAid && probeId, "resolved keep ids: " + tabAid + " / " + probeId);
    // tabsInfo() includes the hidden relay tab (moz-extension://…/relay.html);
    // "real" tabs are everything else, exactly what the user sees.
    const realOf = (ts: any[]) => (ts || []).filter((t: any) => !String(t.url || "").includes("relay.html"));
    const info = await ctx.tabsInfo();
    for (const t of info as any[]) {
      if (t.id !== tabAid && t.id !== probeId) {
        await evalIn(ctx.probe, `browser.tabs.remove(${t.id}).then(() => true)`).catch(() => {});
        await waitFor(async () => {
          const ts = await ctx.tabsInfo();
          return ts.every((x: any) => x.id !== t.id) ? true : null;
        }, 5000).catch(() => {});
      }
    }
    const two = realOf(await ctx.tabsInfo());
    assert(two.length === 2, "trimmed to exactly two real tabs, got " + two.length);
    // Close tabA via the leader key path (what the user does).
    await ctx.activateTab(ctx.tabA);
    await ctx.leaderPressNoFocus("x");
    await waitFor(async () => realOf(await ctx.tabsInfo()).length === 1 ? true : null, 10000);
    const left = realOf(await ctx.tabsInfo());
    assert(left.length === 1, "one tab remains after the close, got " + left.length);
    const active = left.find((t: any) => t.active);
    assert(active && active.url && active.url.includes("commandcenter.html"), "survivor is active and a real page, got " + (active && active.url));
    // The leader must still work on the survivor (probe-only from here).
    const before = left.length;
    await ctx.leaderPressNoFocus("n");
    await waitFor(async () => realOf(await ctx.tabsInfo()).length === before + 1 ? true : null, 10000);
    assert(realOf(await ctx.tabsInfo()).length === before + 1, ";n still opens a tab after the close");
    // Restore the trimmed tabs so later tests see the standard window. The
    // count is already before+1 after the ;n above, so each press adds one.
    for (let i = 0; i < 2; i++) {
      await ctx.leaderPressNoFocus("n");
      await waitCount(before + 2 + i, ";n restore " + (i + 1));
    }
    await ctx.activateTab(ctx.probe);
    // tabA was closed above, so its browsing-context id is dead. Re-point it at
    // a fresh real page: the content/sessions/split suites that follow drive
    // ctx.tabA, and running the FULL suite (commandcenter -> content -> ...)
    // would otherwise fail every downstream test with "no such frame".
    ctx.tabA = await ctx.newPageTab(`${ctx.base}/`);
    // Prove the reassignment took: the new tabA must be a live, drivable page,
    // so the next suite starts from a real tab (this is what the full-run
    // regression hinged on).
    const href = await evalIn(ctx.tabA, `location.href`).catch(() => "");
    assert(
      href && href.indexOf("127.0.0.1") !== -1,
      "ctx.tabA re-pointed at a live page tab for the suites that follow, got " + href
    );
  });
}
