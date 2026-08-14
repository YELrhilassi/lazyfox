// i3-style split view tests.
//
// Two horizontal split mechanisms exist: the legacy iframe container
// (splitview.html, the fallback for Firefox without native split) and the
// native Firefox split view (two real tabs sharing a splitViewId, created by
// the chrome helper via gBrowser.addTabSplitView). The native split is the
// primary path — each pane is a real top-level tab, so real websites load in
// them with no header stripping tricks — so most of the coverage here
// exercises it. Vertical/stacked splits were removed (Firefox's native view
// is side-by-side only).

import { evalIn, waitFor, sleep, clickPage, navigate } from "../lib.mjs";
import { assert } from "../harness.mjs";

export const group = "split";

export async function run(ctx) {
  const t = (name, fn) => ctx.runTest(group, name, fn);

  // Create a native split of the command center + a fresh split-panel tab and
  // wait until two tabs share a splitViewId. Returns the tab pair (extension
  // tab ids/urls/active + splitViewId). Dissolves any split left over from a
  // previous test first (a pane may be a remote web page the chrome helper
  // cannot unsplit, so closing its partner panes auto-unsplits it).
  const nativeSplit = async () => {
    await ctx.openCC(ctx.tabA);
    for (let i = 0; i < 3; i++) {
      const pre = await ctx.tabsInfo();
      const sv = pre.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      if (!sv.length) break;
      const act = pre.find((t) => t.active);
      for (const p of sv.filter((t) => !t.active)) {
        await evalIn(ctx.probe, `browser.tabs.remove(${p.id})`).catch(() => {});
      }
      await sleep(300);
      if (act && sv.some((t) => t.id === act.id)) {
        await ctx.leaderPress(ctx.tabA, "\\"); // ;\ via the chrome helper (tabA is the active CC)
        await sleep(300);
      }
    }
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true }); // ;| side-by-side
    return waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const pair = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return pair.length === 2 ? pair : null;
    }, 8000);
  };

  // Wait until no tab is in a split view.
  const waitNoSplit = async () =>
    waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)) ? true : null;
    }, 8000);

  console.log("\n== Split view (i3-style) ==");

  await t("split: ;| splits side-by-side, ;[ / ;] switch panes, ;\\ closes", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // geckodriver cannot synthesize "|" from the bare character, so send the
    // leader + Shift+\\ (which produces the "|" binding) explicitly.
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true });
    try {
      await waitFor(async () => {
        const u = await evalIn(ctx.tabA, `location.href`);
        return u && u.includes("splitview.html") ? u : null;
      }, 10000);
    } catch (e) {
      const href = await evalIn(ctx.tabA, `location.href`).catch(() => "ERR");
      const tabs = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("split did not happen; href=" + href + " tabs=" + JSON.stringify(tabs));
    }
    const facts = await evalIn(ctx.tabA, `({
      panes: document.querySelectorAll("#panes iframe").length,
      vertical: document.getElementById("panes").classList.contains("vertical"),
      active: [...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active")),
    })`);
    assert(facts.panes === 2, "split has 2 panes, got " + facts.panes);
    assert(facts.vertical === false, "side-by-side orientation, got vertical=" + facts.vertical);
    assert(facts.active === 0, "pane 1 active, got " + facts.active);

    // Focus the split bar so leader keys reach the chrome helper, then switch.
    await clickPage(ctx.tabA, 40, 15);
    await sleep(250);
    await ctx.press(ctx.tabA, ";");
    await sleep(250);
    await ctx.press(ctx.tabA, "]");
    try {
      await waitFor(async () => {
        const idx = await evalIn(ctx.tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`);
        return idx === 1 ? idx : null;
      }, 8000);
    } catch (e) {
      throw new Error("pane-switch-to-2 timed out; active=" + await evalIn(ctx.tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`));
    }
    await ctx.press(ctx.tabA, ";");
    await sleep(250);
    await ctx.press(ctx.tabA, "[");
    try {
      await waitFor(async () => {
        const idx = await evalIn(ctx.tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`);
        return idx === 0 ? 1 : null;
      }, 8000);
    } catch (e) {
      throw new Error("pane-switch-to-1 timed out; active=" + await evalIn(ctx.tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`));
    }

    // Close the split view; the tab leaves splitview.html.
    await ctx.press(ctx.tabA, ";");
    await sleep(250);
    await ctx.press(ctx.tabA, "\\");
    try {
      await waitFor(async () => {
        const u = await evalIn(ctx.tabA, `location.href`).catch(() => "");
        return u && !u.includes("splitview.html") ? u : null;
      }, 10000);
    } catch (e) {
      throw new Error("close-split timed out; href=" + await evalIn(ctx.tabA, `location.href`).catch(() => "ERR"));
    }
  });

  // NOTE: the iframe container's panes cannot be asserted to load real
  // websites here — the chrome helper requires extension pages to run
  // in-process (extensions.webextensions.remote=false), and in-process
  // extension pages cannot host remote-content iframes (the pane stays
  // about:blank). The native split tests below have no such limitation: each
  // pane is a real top-level tab, so real sites load in them directly.

  await t("split: native split companion pane shows the split panel", async () => {
    const pair = await nativeSplit();
    const companion = pair.find((t) => !t.active) || pair[1];
    assert(companion && (companion.url || "").includes("splitpanel.html"), "companion pane is the split panel: " + JSON.stringify(pair));
    // Clean up.
    await ctx.leaderPress(ctx.tabA, "\\");
    await waitNoSplit();
  });

  await t("split: native split loads real pages in both panes", async () => {
    const pair = await nativeSplit();
    assert(pair.length === 2, "native split paired two tabs: " + JSON.stringify(pair));
    assert(new Set(pair.map((t) => t.splitViewId)).size === 1, "panes share one splitViewId");

    // Pane 2 is the fresh split panel; pane 1 is the command center
    // (ctx.tabA). Address the pane by its tab id from the pair (never by
    // scanning the context tree — leftover tabs/iframes from earlier tests
    // can match first, and navigating a stale iframe to a real site trips
    // COEP). tabs.update is unambiguous and survives the pane being in a
    // native split view.
    const blankPane = pair.find((t) => (t.url || "").includes("splitpanel.html")) || pair.find((t) => !t.active);
    assert(blankPane, "found the split panel pane in the split pair: " + JSON.stringify(pair));
    // Real websites with no captcha: IETF example domains are static and safe.
    await evalIn(ctx.probe, `browser.tabs.update(${blankPane.id}, { url: "https://example.org" })`);
    await navigate(ctx.tabA, "https://example.com", "complete");

    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      const urls = sv.map((t) => t.url || "").join(" ");
      return sv.length === 2 && urls.includes("example.com") && urls.includes("example.org") ? sv : null;
    }, 20000);
    const ts = await ctx.tabsInfo();
    const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    assert(sv.length === 2, "both panes still share the split after loading: " + JSON.stringify(ts));
    assert(sv.some((t) => (t.url || "").includes("example.com")), "pane 1 loaded example.com: " + JSON.stringify(sv.map((t) => t.url)));
    assert(sv.some((t) => (t.url || "").includes("example.org")), "pane 2 loaded example.org: " + JSON.stringify(sv.map((t) => t.url)));
    // Clean up: close pane 2; Firefox auto-unsplits the remaining tab.
    const p2 = ts.find((t) => (t.url || "").includes("example.org"));
    if (p2) await evalIn(ctx.probe, `browser.tabs.remove(${p2.id})`).catch(() => {});
    await waitNoSplit();
  });

  await t("split: native split ;[ / ;] switch the active pane", async () => {
    const pair = await nativeSplit();
    const p1 = pair.find((t) => t.active);
    const p2 = pair.find((t) => !t.active);
    assert(p1 && p2, "native split has an active and an inactive pane: " + JSON.stringify(pair));

    // The command center pane stays selected right after splitting (the helper
    // keeps the original tab active); keys on it reach the chrome helper.
    await ctx.leaderPress(ctx.tabA, "]");
    try {
      await waitFor(async () => {
        const a = await ctx.activeTabInfo();
        return a && a.id === p2.id ? a : null;
      }, 8000);
    } catch (e) {
      const st = await ctx.chromeState().catch((e2) => "ERR:" + String(e2 && e2.message ? e2.message : e2));
      const ts = await ctx.tabsInfo().catch((e2) => "ERR:" + String(e2 && e2.message ? e2.message : e2));
      throw new Error("pane switch to p2 failed; pair=" + JSON.stringify(pair) + " state=" + JSON.stringify(st) + " tabs=" + JSON.stringify(ts));
    }
    await ctx.leaderPress(ctx.tabA, "[");
    try {
      await waitFor(async () => {
        const a = await ctx.activeTabInfo();
        return a && a.id === p1.id ? a : null;
      }, 8000);
    } catch (e) {
      const st = await ctx.chromeState().catch((e2) => "ERR:" + String(e2 && e2.message ? e2.message : e2));
      const ts = await ctx.tabsInfo().catch((e2) => "ERR:" + String(e2 && e2.message ? e2.message : e2));
      throw new Error("switch-back to p1 failed; p1=" + JSON.stringify(p1) + " state=" + JSON.stringify(st) + " tabs=" + JSON.stringify(ts));
    }
    const finalTs = await ctx.tabsInfo();
    const sv = finalTs.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    assert(sv.length === 2, "split intact after pane switching: " + JSON.stringify(finalTs));
    await ctx.leaderPress(ctx.tabA, "\\"); // ;\ unsplit
    await waitNoSplit();
  });

  await t("split: native split ;\\ unsplits back to independent tabs", async () => {
    await nativeSplit();
    await ctx.leaderPress(ctx.tabA, "\\"); // ;\
    await waitNoSplit();
    const ts = await ctx.tabsInfo();
    assert(ts.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "all tabs independent after unsplit: " + JSON.stringify(ts));
  });

  await t("split: native split closing one pane auto-unsplits the other", async () => {
    const pair = await nativeSplit();
    const toClose = pair.find((t) => !t.active) || pair[1];
    assert(toClose, "found a pane to close: " + JSON.stringify(pair));
    await evalIn(ctx.probe, `browser.tabs.remove(${toClose.id})`);
    await waitNoSplit();
    const ts = await ctx.tabsInfo();
    assert(ts.length >= 1, "the other pane survives closing one: " + JSON.stringify(ts));
    assert(ts.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "remaining tab auto-unsplit: " + JSON.stringify(ts));
  });

  await t("split: native split ;+N moves tab N into the split", async () => {
    await nativeSplit();
    // Pick a tab currently outside the split and derive its 1-based strip
    // position for ;+N (the suite accumulates tabs, so use whatever non-split
    // tab is earliest rather than assuming a fresh tab lands within 1-9).
    const ts = await ctx.tabsInfo();
    const ci = ts.findIndex(
      (t) => !t.pinned && !(typeof t.splitViewId === "number" && t.splitViewId >= 0)
    );
    assert(ci >= 0, "found a movable tab to move in: " + JSON.stringify(ts));
    const targetIndex = ci + 1;
    assert(targetIndex <= 9, "tab index stays within 1-9 for ;+N: " + targetIndex + " of " + ts.length);
    const targetId = ts[ci].id;

    await ctx.leaderPress(ctx.tabA, "=", { shift: true }); // ;+ -> shift+=
    await sleep(250);
    await ctx.press(ctx.tabA, String(targetIndex)); // ;+N
    try {
      await waitFor(async () => {
        const now = await ctx.tabsInfo();
        const sv = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        return sv.length === 3 && sv.some((t) => t.id === targetId) ? sv : null;
      }, 10000);
    } catch (e) {
      const st = await ctx.chromeState().catch(() => "ERR");
      const now = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error(
        ";+N move failed for index " + targetIndex + " (id " + targetId + "): state=" +
          JSON.stringify(st) + " tabs=" + JSON.stringify(now)
      );
    }
    const now = await ctx.tabsInfo();
    const sv = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    assert(sv.length === 3, "moved tab joined the split: " + JSON.stringify(now));
    assert(sv.some((t) => t.id === targetId), "tab " + targetIndex + " is now in the split");
    assert(new Set(sv.map((t) => t.splitViewId)).size === 1, "all three panes share one splitViewId");
    // Clean up: unsplit, then close the leftover split-panel pane.
    await ctx.leaderPress(ctx.tabA, "\\"); // ;\
    await waitNoSplit();
    const leftovers = await ctx.tabsInfo();
    const panel = leftovers.find((t) => (t.url || "").includes("splitpanel.html"));
    if (panel) await evalIn(ctx.probe, `browser.tabs.remove(${panel.id})`).catch(() => {});
    await sleep(300);
  });
}
