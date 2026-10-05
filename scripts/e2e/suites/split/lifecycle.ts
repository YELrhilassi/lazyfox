// lifecycle tests (split). Split verbatim from the original
// split.ts monolith — behavior unchanged, timing fixed separately.
import { createTab, evalIn, getTree, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
import { makeSplitHelpers } from "./_shared.ts";
export async function run(ctx: any): Promise<void> {
  // Tags: `--tags split` selects these. "destructive" marks tests
  // that dissolve and rebuild splits, so a quick subset can skip them.
  const TAGS: string[] = ["split","destructive"];
  const { t, nativeSplit, waitNoSplit, waitPlusPopup } = makeSplitHelpers(ctx, "split/lifecycle", TAGS);

  await t("split: ;W | splits side-by-side via the native split view", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // geckodriver cannot synthesize "|" from the bare character, so send the
    // leader + Shift+\\ (which produces the "|" binding) explicitly. The native
    // split pairs the current tab with a fresh split-panel pane (two real tabs
    // sharing one splitViewId).
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]);
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
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]);
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
  await t("split: native split ;W [ / ;W ] switch the active pane", async () => {
    const pair = await nativeSplit();
    const p1 = pair.find((t) => t.active);
    const p2 = pair.find((t) => !t.active);
    assert(p1 && p2, "native split has an active and an inactive pane: " + JSON.stringify(pair));
    // The command center pane stays selected right after splitting (the helper
    // keeps the original tab active); keys on it reach the chrome helper.
    await ctx.leaderSeq(ctx.tabA, ["W", "]"])
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
    await ctx.leaderSeq(ctx.tabA, ["W", "["])
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
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u unsplit
    await waitNoSplit();
  });
  await t("split: native split ;W u unsplits back to independent tabs", async () => {
    await nativeSplit();
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u
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
    // on that same tab fail. ;W | must work immediately after ;W u.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]); // ;W | split
    const p1 = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("first split did not happen: " + JSON.stringify(ts));
    });
    assert(p1 && p1.length === 2, "first split created: " + JSON.stringify(p1));
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u unsplit
    await waitNoSplit();
    // Immediately re-split the SAME tab.
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]);
    const p2 = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("re-split after unsplit failed: " + JSON.stringify(ts));
    });
    assert(p2 && p2.length === 2, "re-split on the same tab works: " + JSON.stringify(p2));
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // cleanup
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
  await t("split: native split ;W m +N moves tab N into the split", async () => {
    // Isolate FIRST, for the same reason the two tests below do: `;+N` is a
    // digit addressed at whatever the product's own numbering says, so the
    // strip it numbers has to be one this test built. Inherited from a full
    // run it held a dozen leftover command-center tabs, "the first real tab
    // outside the split" was one of THOSE rather than a page, and the move
    // never had a chance — a test whose subject is numbering cannot be the one
    // that lets numbering drift.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
    const tabB = await createTab();
    await navigate(tabB, `${ctx.base}/hello`, "complete");
    await ctx.waitTabUrl("/hello", { timeoutMs: 10000 });
    await ctx.openCC(ctx.tabA); // tabA active
    await nativeSplit();
    // The target is a tab this test made, not "whatever is first": a leftover
    // command-center tab is a legal thing to move into a split, but it is not
    // what this test is about, and it is the one shape that made the digit
    // ambiguous in a full run.
    //
    // Its NUMBER still comes from the product, never from counting the strip
    // here: realTabs() skips the split panel and the relay but keeps a real
    // tab carrying a momentary #lfc= request hash, so a harness-side count
    // disagrees with the product about exactly those tabs and every tab after
    // the first disagreement is off by one. The number is not even 1-9, so the
    // digits are typed in full.
    const ts = await ctx.tabsInfo();
    const real = ts.filter((t) => ctx.isRealTab(t));
    const target = real.find((t) => (t.url || "").indexOf("/hello") !== -1);
    assert(target, "found the content tab to move in: " + JSON.stringify(ts));
    const targetIndex = await ctx.productNumberOf(target, real);
    assert(targetIndex >= 1, "the product's numbering knows the target tab: " + targetIndex + " of " + real.length);
    const targetId = target.id;
    await ctx.leaderSeq(ctx.tabA, ["W", "m"]); // ;W m -> move tab into split -> shift+=
    await waitPlusPopup(ctx.tabA);
    await ctx.pressNumber(ctx.tabA, targetIndex); // ;+N
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
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u
    await waitNoSplit();
  });
  await t("split: ;W { and ;W } swap the panes left/right", async () => {
    // Isolate: collapse the window to just the probe + a fresh CC (tabA) and
    // a fresh content tab (tabB), so the split pair and its ;+N index are
    // deterministic (probe=1, tabA=2, tabB=3).
    //
    // Two things this wipe has to get right, and both were wrong at once.
    //
    // It must NOT close the relay. The relay tab is the one carrier for every
    // chrome<->background message, and closing it does not fail loudly — it
    // makes every later browser.* round-trip from the chrome helper simply
    // never arrive, which reads as "the split never formed" in the three tests
    // after this one. `pinned` is not a safe proxy for it: a relay that has
    // not committed relay.html yet is about:blank. So the URL is checked too.
    //
    // And it must not be SEQUENTIAL. One awaited tabs.remove per tab is a round
    // trip each, and a full run reaches forty tabs by this point — the wipe
    // simply ran out of its 10s budget, left the window half-closed, and took
    // the rest of the group with it. Removing in parallel makes the setup
    // deterministic instead of racing the clock.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
    const tabB = await createTab();
    await navigate(tabB, `${ctx.base}/hello`, "complete");
    await ctx.waitTabUrl("/hello", { timeoutMs: 10000 });
    await ctx.openCC(ctx.tabA); // tabA active
    // ;W | creates [tabA, panel]; ;W m moves tabB in, replacing the panel.
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]);
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
    const probeId = await evalIn(ctx.probe, `browser.tabs.getCurrent().then(t => t ? t.id : null)`);
    const aId = settleInfo.find((t) => t.active)?.id;
    const bId = settleInfo.find((t) => (t.url || "").includes("/hello"))?.id;
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const real = ts.filter(
        (t) => ctx.isRealTab(t)
      );
      return real.map((t) => t.id).join(",") === [probeId, aId, bId].join(",") ? real : null;
    }, 5000).catch(async () => {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("swap setup strip did not settle; state=" + JSON.stringify(st && { strip: st.strip }) + " tabs=" + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR")));
    });
    await ctx.leaderSeq(ctx.tabA, ["W", "m"]);
    await waitPlusPopup(ctx.tabA);
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
    await ctx.leaderSeq(ctx.tabA, ["W", "}"])
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
    await ctx.leaderSeq(ctx.tabA, ["W", "{"])
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
    await waitNoSplit();
    const post = await ctx.tabsInfo();
    assert(post.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "cleanup left a split");
    // tabB is a BiDi context handle, not a tab id — resolve the id by URL.
    const rem2 = await ctx.tabsInfo();
    const helloId = rem2.find((t) => (t.url || "").includes("/hello"))?.id;
    if (helloId != null) {
      await evalIn(ctx.probe, `browser.tabs.remove(${helloId}).catch(()=>{})`);
      await ctx.waitTabUrl("/hello", { gone: true, timeoutMs: 8000 });
    }
    // Restore the harness invariant: ctx.tabA is the command-center tab
    // (other tests filter it out of "web tabs" by URL).
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
  });
  await t("split: ;W m +N auto-splits when no split exists", async () => {
    // Ensure a flat window: no split view active.
    await waitNoSplit();
    const before = await ctx.tabsInfo();
    // Pick the first non-active real tab as the move target, and ask the
    // PRODUCT for its number rather than counting the strip — see the sibling
    // test above for why the two lists are not the same list.
    const real = before.filter((t) => ctx.isRealTab(t));
    const target = real.find((t) => !t.active && !t.pinned);
    assert(target, "found a non-active tab to move: " + JSON.stringify(before));
    const targetIndex = await ctx.productNumberOf(target, real);
    assert(targetIndex >= 1, "the product's numbering knows the target tab: " + targetIndex);
    // ;+N with NO split must pair the active tab DIRECTLY with tab N — no
    // empty companion panel pane.
    await ctx.leaderSeq(ctx.tabA, ["W", "m"]); // ;W m -> move tab into split
    await waitPlusPopup(ctx.tabA);
    await ctx.pressNumber(ctx.tabA, targetIndex);
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
        (t) => ctx.isRealTab(t)
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
      "pair pinned next to the anchor: anchor=" + activeRow.id + " partner=" + partner + " pair=" + JSON.stringify(pairIds) + " order=" + JSON.stringify((await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t)).map((t) => t.id))
    );
    // Clean up.
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u
    await waitNoSplit();
  });
}
