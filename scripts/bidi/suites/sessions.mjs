// Sessions (tmux-style) + shared status bar tests. Covers save/restore, marker
// assignment and quick-switch, the status bar rendering (web + chrome), and
// the no-op/safe dispatch paths.

import { evalIn, waitFor, sleep, createTab } from "../lib.mjs";
import { assert } from "../harness.mjs";

export const group = "sessions";

export async function run(ctx) {
  const t = (name, fn) => ctx.runTest(group, name, fn);

  console.log("\n== Sessions + status bar ==");

  await t("status bar renders on web pages", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v ? v : null;
    }, 8000);
    const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-status")`);
    assert(v && v.indexOf("default") !== -1, "status bar shows the default session: " + v);
    assert(await ctx.hasHost(ctx.tabA, "lazyfox-status"), "status bar host mounted on the page");
  });

  await t("chrome status bar renders on the command center", async () => {
    await ctx.openCC(ctx.tabA);
    await sleep(600);
    const s = await ctx.chromeState();
    assert(s && s.statusMounted === true, "chrome status bar mounted: " + JSON.stringify(s && { mounted: s.statusMounted, position: s.statusPosition }));
  });

  await t("status bar position: top setting moves the bar", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(ctx.probe, `browser.storage.local.get("config").then(r => browser.storage.local.set({ config: Object.assign({}, r.config || {}, { statusBarPosition: "top" }) }))`).catch(() => {});
    await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v && v.indexOf("|top") !== -1 ? v : null;
    }, 8000);
    // restore bottom
    await evalIn(ctx.probe, `browser.storage.local.get("config").then(r => browser.storage.local.set({ config: Object.assign({}, r.config || {}, { statusBarPosition: "bottom" }) }))`).catch(() => {});
    await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v && v.indexOf("|bottom") !== -1 ? v : null;
    }, 8000);
  });

  await t("sessions: ;[ split-pane switch is a no-op without a split", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await ctx.leaderPress(ctx.tabA, "[");
    await sleep(700);
    const after = await ctx.tabsInfo();
    assert(after.length === before.length, "split-pane switch without a split view changed no tabs");
  });

  await t("sessions: ;. and ;, move bindings dispatch cleanly", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await ctx.leaderPress(ctx.tabA, ".");
    await sleep(500);
    await ctx.leaderPress(ctx.tabA, ",");
    await sleep(500);
    const after = await ctx.tabsInfo();
    // tabs.move is a no-op for WebDriver-created tabs on this Firefox beta, so
    // assert the dispatch is safe (no tab created/destroyed, no popup left
    // open) rather than the reorder itself — the reorder is exercised by the
    // background's moveTab path and the binding keys are pinned in Go tests.
    assert(after.length === before.length, "move bindings create/destroy no tabs");
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), "move bindings open no popup");
  });

  await t("sessions: ;p saves a session with marker 1", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "work");
    await sleep(700);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.work)`);
      return r && r.marker === 1 ? r : null;
    }, 8000);
    const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions.work)`);
    assert(r && r.marker === 1, "work got marker 1, got " + (r && r.marker));
    assert(r && r.tabs && r.tabs.length >= 1, "work captured tabs");
    // The status bar reflects the current session name.
    await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v && v.indexOf("work") !== -1 ? v : null;
    }, 8000);
  });

  await t("sessions: ;' + digit consumes the marker binding", async () => {
    // Switch to a marker with no session: the pending-prefix path must run
    // without touching the window's tabs (non-destructive verification).
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await ctx.press(ctx.tabA, ";");
    await sleep(300);
    await ctx.press(ctx.tabA, "'");
    await sleep(250);
    await ctx.press(ctx.tabA, "9");
    await sleep(700);
    const after = await ctx.tabsInfo();
    assert(after.length === before.length, "no tabs were changed by an unknown marker");
  });

  await t("sessions: ;' + 1 hot-swaps to the marked session", async () => {
    // Save a second session from a distinct tab set.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "mail");
    await sleep(700);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.mail)`);
      return r ? r : null;
    }, 8000);
    // Switch to marker 1 ("work") with ;' + 1.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.press(ctx.tabA, ";");
    await sleep(300);
    await ctx.press(ctx.tabA, "'");
    await sleep(250);
    await ctx.press(ctx.tabA, "1");
    await sleep(1800);
    // The switch replaced the window's tabs; verify from a fresh extension tab.
    const fresh = await ctx.makeProbeTab();
    const cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "work", "hot-swapped to work, got " + cur);
    ctx.probe = fresh;
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

  await t("sessions: Ctrl+digit assigns a marker", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // Highlight the second session (mail) and mark it 9 with Ctrl+9.
    await ctx.press(ctx.tabA, "ArrowDown");
    await sleep(250);
    await ctx.press(ctx.tabA, "9", { ctrl: true });
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.mail)`);
      return r && r.marker === 9 ? r : null;
    }, 8000);
    const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions.mail)`);
    assert(r && r.marker === 9, "mail marker reassigned to 9, got " + (r && r.marker));
    const w = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.work)`);
    assert(w && w.marker === 1, "work marker unchanged at 1, got " + (w && w.marker));
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("sessions: Ctrl+digit hot-swaps to the marked session", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Ctrl+9 -> "mail" (marker 9)
    await ctx.press(ctx.tabA, "9", { ctrl: true });
    await sleep(1800);
    let fresh = await ctx.makeProbeTab();
    let cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "mail", "Ctrl+9 hot-swapped to mail, got " + cur);
    ctx.probe = fresh;
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Ctrl+1 -> "work" (marker 1)
    await ctx.press(ctx.tabA, "1", { ctrl: true });
    await sleep(1800);
    fresh = await ctx.makeProbeTab();
    cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "work", "Ctrl+1 hot-swapped to work, got " + cur);
    ctx.probe = fresh;
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

  await t("sessions: ;p saves on immediate Enter (no debounce wait)", async () => {
    // Regression for the Enter race: typing a name and pressing Enter at once
    // must save, without waiting for the (formerly debounced) search to land.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "instant");
    await ctx.press(ctx.tabA, "Enter"); // no settling sleep
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.instant)`);
      return r && r.tabs && r.tabs.length ? r : null;
    }, 8000);
    const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions.instant)`);
    assert(r && r.tabs && r.tabs.length >= 1, "instant saved with tabs");
    // clean up so later tests are unaffected
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.instant; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
  });
}
