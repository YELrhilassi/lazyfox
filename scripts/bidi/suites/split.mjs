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

import { evalIn, waitFor, sleep, clickPage, navigate, getTree, createTab, closeContext } from "../lib.mjs";
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

  await t("split: ;| splits side-by-side via the native split view", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // geckodriver cannot synthesize "|" from the bare character, so send the
    // leader + Shift+\\ (which produces the "|" binding) explicitly. The native
    // split pairs the current tab with a fresh split-panel pane (two real tabs
    // sharing one splitViewId).
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true });
    const pair = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 10000).catch(async () => {
      const tabs = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("split did not happen; tabs=" + JSON.stringify(tabs));
    });
    assert(new Set(pair.map((t) => t.splitViewId)).size === 1, "the two panes share one splitViewId: " + JSON.stringify(pair));
    const companion = pair.find((t) => !t.active) || pair[1];
    assert((companion.url || "").includes("splitpanel.html"), "companion pane is the split panel: " + JSON.stringify(pair));

    // Close one pane; the remaining tab auto-unsplits back to an independent tab.
    await evalIn(ctx.probe, `browser.tabs.remove(${companion.id})`).catch(() => {});
    await waitNoSplit();
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
    // The panel's tab list must list the other (non-split) tabs.
    const tree = await getTree();
    const all = [];
    const walk = (cs) => { for (const c of cs) { all.push(c); if (c.children) walk(c.children); } };
    walk(tree);
    const panelCtx = all.find((c) => (c.url || "").includes("splitpanel.html"));
    assert(panelCtx, "found the split panel's browsing context");
    const raw = await evalIn(panelCtx.context, `(async () => {
      const r = await browser.runtime.sendMessage({ action: "splitPanelTabs", data: {} }).catch((e) => ({ err: String(e) }));
      return JSON.stringify({
        href: location.href,
        listHTML: (document.getElementById("tabs") || {}).innerHTML || null,
        resp: r && r.tabs ? r.tabs.map((t) => ({ i: t.index, u: t.url, s: t.inSplit })) : r,
      });
    })()`);
    const dump = JSON.parse(raw);
    assert(dump && (dump.listHTML || "").includes("data-index"), "split panel lists other tabs: " + String(raw));
    // Each row must carry the real Firefox tab id so the user can tell tabs
    // apart in the panel.
    assert((dump.listHTML || "").includes("id "), "split panel rows show the tab id: " + String(raw));
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
    // The split-panel companion pane is pure UI: unsplitting must close it
    // instead of leaving it behind to accumulate (a pane the user navigated
    // to real content is kept — the companion here is still splitpanel.html).
    const panels = ts.filter((t) => (t.url || "").includes("splitpanel.html"));
    assert(panels.length === 0, "unsplit closes the split-panel pane: " + JSON.stringify(ts.map((t) => t.url)));
  });

  await t("split: re-splitting the same tab right after an unsplit works", async () => {
    // Regression for the "need firefox 149+" toast after an unsplit: a stale
    // split-view reference on the just-unsplit tab used to make the next ;|
    // on that same tab fail. ;| must work immediately after ;\.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true }); // ;| split
    const p1 = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("first split did not happen: " + JSON.stringify(ts));
    });
    assert(p1 && p1.length === 2, "first split created: " + JSON.stringify(p1));
    await ctx.leaderPress(ctx.tabA, "\\"); // ;\ unsplit
    await waitNoSplit();
    // Immediately re-split the SAME tab.
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true });
    const p2 = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("re-split after unsplit failed: " + JSON.stringify(ts));
    });
    assert(p2 && p2.length === 2, "re-split on the same tab works: " + JSON.stringify(p2));
    await ctx.leaderPress(ctx.tabA, "\\"); // cleanup
    await waitNoSplit();
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
    // Pick a tab currently outside the split and derive its 1-based REAL-tab
    // index for ;+N. Numbering skips the split panel and the #lfc= request
    // channel, so the test must too (the suite accumulates tabs, so use the
    // earliest movable real tab rather than assuming a fresh tab lands in 1-9).
    const ts = await ctx.tabsInfo();
    const real = ts.filter(
      (t) =>
        !(t.url || "").includes("splitpanel.html") &&
        !(t.url || "").includes("#lfc=")
    );
    const ci = real.findIndex(
      (t) => !t.pinned && !(typeof t.splitViewId === "number" && t.splitViewId >= 0)
    );
    assert(ci >= 0, "found a movable tab to move in: " + JSON.stringify(ts));
    const targetIndex = ci + 1;
    assert(targetIndex <= 9, "tab index stays within 1-9 for ;+N: " + targetIndex + " of " + real.length);
    const targetId = real[ci].id;

    await ctx.leaderPress(ctx.tabA, "=", { shift: true }); // ;+ -> shift+=
    await sleep(250);
    await ctx.press(ctx.tabA, String(targetIndex)); // ;+N
    try {
      await waitFor(async () => {
        const now = await ctx.tabsInfo();
        const sv = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        return sv.length === 2 && sv.some((t) => t.id === targetId) ? sv : null;
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
    assert(sv.length === 2, "moved tab REPLACED the split panel (2 panes): " + JSON.stringify(now));
    assert(sv.some((t) => t.id === targetId), "tab " + targetIndex + " is now in the split");
    assert(new Set(sv.map((t) => t.splitViewId)).size === 1, "both panes share one splitViewId");
    assert(
      !now.some((t) => (t.url || "").includes("splitpanel.html")),
      "the split-panel pane is gone after the move: " + JSON.stringify(now.map((t) => t.url))
    );
    // Clean up: unsplit (no panel pane is left to close).
    await ctx.leaderPress(ctx.tabA, "\\"); // ;\
    await waitNoSplit();
  });

  await t("split: ;{ and ;} swap the panes left/right", async () => {
    // Isolate: collapse the window to just the probe + a fresh CC (tabA) and
    // a fresh content tab (tabB), so the split pair and its ;+N index are
    // deterministic (probe=1, tabA=2, tabB=3).
    const probe = await ctx.makeProbeTab();
    const probeId = await evalIn(probe, `browser.tabs.getCurrent().then(t => t ? t.id : null)`);
    await evalIn(probe, `(async () => {
      const ts = await browser.tabs.query({ currentWindow: true });
      for (const t of ts) if (t.id !== ${probeId} && !t.pinned) { try { await browser.tabs.remove(t.id); } catch (e) {} }
      return true;
    })()`);
    await sleep(500);
    ctx.probe = probe;
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
    const tabB = await createTab();
    await navigate(tabB, `${ctx.base}/hello`, "complete");
    await sleep(400);
    await ctx.openCC(ctx.tabA); // tabA active
    // ;| creates [tabA, panel]; ;+3 moves tabB in, replacing the panel.
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true });
    try {
      await waitFor(async () => {
        const ts = await ctx.tabsInfo();
        const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        return sv.length === 2 ? sv : null;
      }, 8000);
    } catch (e) {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("swap setup ;| failed; state=" + JSON.stringify(st && { strip: st.strip, nativeSplit: st.nativeSplit }) + " tabs=" + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR")));
    }
    // Wait for the strip to settle back to [probe, tabA, tabB] before ;+N —
    // Firefox glides the freshly glued pair around asynchronously and the
    // numbering must be stable when the digit is pressed.
    const settleInfo = await ctx.tabsInfo();
    const aId = settleInfo.find((t) => t.active)?.id;
    const bId = settleInfo.find((t) => (t.url || "").includes("/hello"))?.id;
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const real = ts.filter(
        (t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc=")
      );
      return real.map((t) => t.id).join(",") === [probeId, aId, bId].join(",") ? real : null;
    }, 5000).catch(async () => {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("swap setup strip did not settle; state=" + JSON.stringify(st && { strip: st.strip }) + " tabs=" + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR")));
    });
    await ctx.leaderPress(ctx.tabA, "=", { shift: true });
    await sleep(250);
    await ctx.press(ctx.tabA, "3");
    try {
      await waitFor(async () => {
        const now = await ctx.tabsInfo();
        const sv = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        return sv.length === 2 && sv.some((t) => (t.url || "").includes("/hello")) ? sv : null;
      }, 10000);
    } catch (e) {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("swap setup ;+3 failed; state=" + JSON.stringify(st && { strip: st.strip, lastAction: st.lastAction }) + " tabs=" + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR")));
    }
    const order = async () => {
      const now = await ctx.tabsInfo();
      return now
        .filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0)
        .map((t) => t.id)
        .join(",");
    };
    const before = await order();
    const flipped = before.split(",").reverse().join(",");
    assert(before.split(",").length === 2, "swap test has a 2-pane split: " + before);
    // ;} moves the active pane right (order flips).
    await ctx.leaderPress(ctx.tabA, "}");
    try {
      await waitFor(async () => ((await order()) === flipped ? flipped : null), 8000);
    } catch (e) {
      const now = await ctx.tabsInfo().catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error(";} did not flip panes; before=" + before + " now=" + JSON.stringify(now) + " state=" + JSON.stringify(st && { lastAction: st.lastAction, strip: st.strip }));
    }
    const after1 = await order();
    assert(after1 === flipped, ";} swapped the panes: " + before + " -> " + after1);
    // ;{ moves the active pane back left (order flips again).
    await ctx.leaderPress(ctx.tabA, "{");
    await waitFor(async () => ((await order()) === before ? before : null), 8000);
    const after2 = await order();
    assert(after2 === before, ";{ swapped the panes back: " + after1 + " -> " + after2);
    // The pair must still be a live split after swapping.
    const live = (await ctx.tabsInfo()).filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    assert(live.length === 2, "split intact after swapping: " + JSON.stringify(live));
    // Clean up: dissolve every split, close the fresh tabs, drop the probe
    // pollution so later tests see a flat window with the usual tabA/probe.
    const rem = await ctx.tabsInfo();
    const splitTabs = rem.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    for (const p of splitTabs) {
      await evalIn(ctx.probe, `browser.tabs.remove(${p.id})`).catch(() => {});
    }
    await sleep(500);
    const post = await ctx.tabsInfo();
    assert(post.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "cleanup left a split");
    // tabB is a BiDi context handle, not a tab id — resolve the id by URL.
    const rem2 = await ctx.tabsInfo();
    const helloId = rem2.find((t) => (t.url || "").includes("/hello"))?.id;
    if (helloId != null) {
      await evalIn(ctx.probe, `browser.tabs.remove(${helloId}).catch(()=>{})`);
    }
    await sleep(400);
    // Restore the harness invariant: ctx.tabA is the command-center tab
    // (other tests filter it out of "web tabs" by URL).
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
  });

  await t("split: ;+N auto-splits when no split exists", async () => {
    // Ensure a flat window: no split view active.
    await waitNoSplit();
    const before = await ctx.tabsInfo();
    // Pick the first non-active real tab as the move target (real-tab index).
    const real = before.filter(
      (t) =>
        !(t.url || "").includes("splitpanel.html") &&
        !(t.url || "").includes("#lfc=")
    );
    const target = real.find((t) => !t.active && !t.pinned);
    assert(target, "found a non-active tab to move: " + JSON.stringify(before));
    const targetIndex = real.indexOf(target) + 1;
    // ;+N with NO split must pair the active tab DIRECTLY with tab N — no
    // empty companion panel pane.
    await ctx.leaderPress(ctx.tabA, "=", { shift: true }); // ;+
    await sleep(250);
    await ctx.press(ctx.tabA, String(targetIndex));
    const sv = await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const split = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return split.length === 2 && split.some((t) => t.id === target.id) ? split : null;
    }, 10000).catch(async () => {
      const now = await ctx.tabsInfo().catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error(";+N auto-split failed; tabs=" + JSON.stringify(now) + " moveDebug=" + JSON.stringify(st && st.lastMoveDebug));
    });
    assert(sv && sv.length === 2, "auto-split paired the active tab with tab N directly: " + JSON.stringify(sv));
    assert(new Set(sv.map((t) => t.splitViewId)).size === 1, "both panes share one splitViewId");
    const after = await ctx.tabsInfo();
    assert(
      !after.some((t) => (t.url || "").includes("splitpanel.html")),
      "auto-split created no panel pane: " + JSON.stringify(after.map((t) => t.url))
    );
    // The pair sits exactly where the active tab was: every tab BEFORE the
    // anchor keeps its slot, the anchor keeps ITS slot, the partner joins it
    // right there, and the rest keep their relative order — nothing may jump
    // to the strip end (the old regroup bug). The strip settles a moment
    // after the split forms (Firefox glides the pair around), so wait for the
    // pinned order instead of asserting the first snapshot.
    const activeRow = real.find((t) => t.active);
    const preOrder = real.map((t) => t.id);
    const anchorIdx = preOrder.indexOf(activeRow.id);
    const pairIds = sv.map((t) => t.id).sort((x, y) => x - y);
    const partner = pairIds.find((id) => id !== activeRow.id);
    let settleOrder = null;
    const settled = await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const postReal2 = now.filter(
        (t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc=")
      );
      const postOrder2 = postReal2.map((t) => t.id);
      settleOrder = postOrder2;
      if (postOrder2[anchorIdx] !== activeRow.id) return null;
      if (partner == null || (postOrder2[anchorIdx + 1] !== partner && postOrder2[anchorIdx - 1] !== partner)) return null;
      return postOrder2;
    }, 4000).catch(async () => {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("pair did not settle; anchor=" + activeRow.id + "@" + anchorIdx + " partner=" + partner + " pair=" + JSON.stringify(pairIds) + " order=" + JSON.stringify(settleOrder) + " strip=" + JSON.stringify(st && st.strip) + " tabs=" + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR")));
    });
    assert(
      settled != null,
      "pair pinned next to the anchor: anchor=" + activeRow.id + " partner=" + partner + " pair=" + JSON.stringify(pairIds) + " order=" + JSON.stringify((await ctx.tabsInfo()).filter((t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc=")).map((t) => t.id))
    );
    // Clean up.
    await ctx.leaderPress(ctx.tabA, "\\"); // ;\
    await waitNoSplit();
  });

  await t("split: ;+N auto-split keeps the other tabs' order", async () => {
    // Regression: addTabSplitView used to park a freshly glued pair at the
    // END of the strip, renumbering every tab between the pair and the tail —
    // so ;1-9 could silently point at a different tab after a split. Splitting
    // a MIDDLE tab must keep the anchor at its own slot, seat the partner
    // right next to it, and leave every other tab exactly where it was.
    await waitNoSplit();
    const a = await createTab();
    await navigate(a, `${ctx.base}/orderA`, "complete");
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    const c = await createTab();
    await navigate(c, `${ctx.base}/target1`, "complete");
    await sleep(400);
    const ids = await ctx.tabsInfo();
    const urlOf = (t) => (t.url || "").split("?")[0].split("#")[0];
    const short = (u) => String(u).replace(ctx.base, "");
    const realIds = ids.filter((t) => !(t.url || "").includes("commandcenter.html"));
    const aRow = realIds.find((t) => short(urlOf(t)) === "/orderA");
    const bRow = realIds.find((t) => short(urlOf(t)) === "/hello");
    const cRow = realIds.find((t) => short(urlOf(t)) === "/target1");
    assert(aRow && bRow && cRow, "found the three fresh tabs: " + JSON.stringify(ids));
    const beforeOrder = realIds.map((t) => t.id).join(",");
    // Activate A (a MIDDLE tab, not the last) and auto-split A with C.
    await evalIn(ctx.probe, `browser.tabs.update(${aRow.id}, { active: true })`).catch(() => {});
    await sleep(300);
    // ;+N numbers REAL tabs exactly like the chrome helper's realTabs(): skip
    // only splitpanel/#lfc transients (commandcenter tabs count).
    const chromeReal = ids.filter((t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc="));
    const cRealIndex = chromeReal.findIndex((t) => t.id === cRow.id) + 1;
    assert(cRealIndex <= 9, "C index within 1-9: " + cRealIndex);
    await ctx.leaderPress(a, "=", { shift: true }); // ;+
    await sleep(250);
    await ctx.press(a, String(cRealIndex));
    try {
      await waitFor(async () => {
        const now = await ctx.tabsInfo();
        const split = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        return split.length === 2 ? split : null;
      }, 10000);
    } catch (e) {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("auto-split keeps: pair never formed; state=" + JSON.stringify(st && { strip: st.strip, lastAction: st.lastAction }) + " tabs=" + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR")));
    }
    // The achievable invariant: the ANCHOR (A) stays first among the web
    // tabs, the partner (C) sits right next to it, and B keeps its relative
    // position — the old bug flung B to the strip end and moved A too. The
    // strip settles a moment after the split forms, so wait for it.
    const settled = await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const realAfter2 = now.filter((t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc="));
      const webOnly = realAfter2.filter((t) => !(t.url || "").includes("commandcenter.html"));
      const wA = webOnly.findIndex((t) => t.id === aRow.id);
      const wC = webOnly.findIndex((t) => t.id === cRow.id);
      const wB = webOnly.findIndex((t) => t.id === bRow.id);
      if (wA !== 0 || wC !== 1 || wB !== 2) return null;
      const sv2 = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      if (sv2.length !== 2 || !sv2.every((t) => [aRow.id, cRow.id].includes(t.id))) return null;
      return webOnly;
    }, 4000);
    assert(settled != null, "pair pinned next to the anchor (A first, then C, then B): web=" + JSON.stringify((await ctx.tabsInfo()).filter((t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc=") && !(t.url || "").includes("commandcenter.html")).map((t) => t.id)));
    // Clean up: unsplit and close the fresh tabs.
    await ctx.leaderPress(a, "\\");
    await waitNoSplit();
    for (const id of [aRow.id, bRow.id, cRow.id]) {
      await evalIn(ctx.probe, `browser.tabs.remove(${id}).catch(() => {})`);
    }
    await sleep(400);
  });

  await t("split: splitting a middle tab keeps the other tabs' order", async () => {
    // Regression for the shuffle: gBrowser.addTabSplitView used to move the
    // pair to the end, reordering every tab between the split root and the
    // panel. Three fresh tabs with distinct URLs; splitting the middle one
    // must leave the real tabs in their relative order.
    await waitNoSplit();
    const a = await createTab();
    await navigate(a, `${ctx.base}/`, "complete");
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    const c = await createTab();
    await navigate(c, `${ctx.base}/target1`, "complete");
    await sleep(400);
    const ids = await ctx.tabsInfo();
    const urlOf = (t) => (t.url || "").split("?")[0].split("#")[0];
    const aId = ids.find((t) => urlOf(t) === `${ctx.base}/`)?.id;
    const bId = ids.find((t) => urlOf(t) === `${ctx.base}/hello`)?.id;
    const cId = ids.find((t) => urlOf(t) === `${ctx.base}/target1`)?.id;
    assert(aId != null && bId != null && cId != null, "found the three fresh tabs: " + JSON.stringify(ids));
    // Split the middle tab (B) via its content-script leader.
    await evalIn(ctx.probe, `browser.tabs.update(${bId}, { active: true })`).catch(() => {});
    await sleep(300);
    await ctx.leaderPress(b, "\\", { shift: true }); // ;| on B
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const sv = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000);
    const after = await ctx.tabsInfo();
    const realOrder = after
      .filter((t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc="))
      .map((t) => t.id)
      .filter((id) => id === aId || id === bId || id === cId);
    assert(
      realOrder.join(",") === [aId, bId, cId].join(","),
      "real tabs kept their order after a middle split: want=" + JSON.stringify([aId, bId, cId]) + " got=" + JSON.stringify(realOrder)
    );
    // Clean up: unsplit and close the fresh tabs + panel.
    await ctx.leaderPress(b, "\\"); // ;\
    await waitNoSplit();
    const leftovers = await ctx.tabsInfo();
    for (const id of [aId, bId, cId]) {
      await evalIn(ctx.probe, `browser.tabs.remove(${id})`).catch(() => {});
    }
    const panel = leftovers.find((t) => (t.url || "").includes("splitpanel.html"));
    if (panel) await evalIn(ctx.probe, `browser.tabs.remove(${panel.id})`).catch(() => {});
    await sleep(400);
  });

  await t("split: one window-level status bar (not one per pane)", async () => {
    // During a native split the chrome helper shows the single window bar and
    // the web panes hide their per-tab bars, so there is exactly ONE bar for
    // the whole window instead of one rendered in each pane.
    await waitNoSplit();
    const a = await createTab();
    await ctx.openCC(a);
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    await sleep(400);
    await ctx.openCC(a); // re-activate the CC tab
    await ctx.leaderPress(a, "\\", { shift: true }); // ;| -> CC + panel
    await sleep(800);
    const real = (await ctx.tabsInfo()).filter(
      (t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc=")
    );
    const helloIdx = real.findIndex((t) => (t.url || "").includes("/hello")) + 1;
    await ctx.leaderPress(a, "=", { shift: true }); // ;+
    await sleep(250);
    await ctx.press(a, String(Math.min(Math.max(helloIdx, 1), 9)));
    await sleep(4000); // let the 3s content poll hide the pane's bar
    const st = await ctx.chromeState();
    assert(st && st.statusMounted === true, "chrome window bar mounted during the split");
    // The window bar must reserve its height out of the browser content area
    // (margin-bottom on #browser), so the panes reflow above it instead of
    // rendering behind it.
    assert(
      st && st.browserReserve && st.browserReserve.mb === "18px",
      "#browser reserved 18px for the bar during the split: " + JSON.stringify(st && st.browserReserve)
    );
    // The hello pane (b) must have hidden its per-tab bar.
    const host = await evalIn(b, `!!document.getElementById("lazyfox-status")`).catch(() => null);
    assert(host === false, "web pane has no per-tab bar during the split (got " + host + ")");
    // Clean up: unsplit and drop the two fresh tabs.
    await ctx.leaderPress(a, "\\");
    await waitNoSplit();
    await closeContext(b).catch(() => {});
    await closeContext(a).catch(() => {});
    await sleep(400);
  });
}
