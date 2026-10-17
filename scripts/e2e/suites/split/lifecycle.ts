// lifecycle tests (split). Split verbatim from the original
// split.ts monolith — behavior unchanged, timing fixed separately.
import { createTab, evalIn, getTree, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
import { makeSplitHelpers } from "./_shared.ts";
export async function run(ctx: any): Promise<void> {
  // Tags: `--tags split` selects these. "destructive" marks tests
  // that dissolve and rebuild splits, so a quick subset can skip them.
  const TAGS: string[] = ["split","destructive"];
  const { t, nativeSplit, waitNoSplit, waitNoSplitStable, waitPlusPopup } = makeSplitHelpers(ctx, "split/lifecycle", TAGS);

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
    // THE ROW SHOWS WHAT THE USER CAN RECOGNISE: the number to press, the
    // title, and the site. It used to print `id 123 \u00B7 https://\u2026`, and
    // the id was the problem — it is a number that appears nowhere else in the
    // product, printed beside a URL long enough to be cut off, so the pane read
    // as a debug dump. This pins the replacement, and that the id is gone.
    assert(/(class="?kbd"?>)\d+</.test(dump.listHTML || ""), "rows carry the move number: " + String(raw));
    assert((dump.listHTML || "").includes("txt"), "rows carry the title/site pair: " + String(raw));
    assert(!/id \d/.test(dump.listHTML || ""), "rows no longer print the Firefox tab id: " + String(raw));
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
    //
    // The RESOLVER is the one part of this that is not the product, and a
    // transient DNS failure raises NS_ERROR_UNKNOWN_HOST — which failed the
    // whole group with a product-shaped message ("the split did not load") for
    // an event that had nothing to do with the split. So the two navigations
    // are made as a pair and retried while the panes are not both on their
    // site. The assertions below are untouched: a domain that genuinely does
    // not resolve still fails the test, after the retries, with the reason it
    // failed attached instead of a bare timeout.
    let loaded: any = null;
    let lastErr = "";
    for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
      try {
        await evalIn(ctx.probe, `browser.tabs.update(${blankPane.id}, { url: "https://example.org" })`);
      } catch (e) {
        lastErr = "example.org: " + String((e && (e as any).message) || e);
      }
      try {
        await navigate(ctx.tabA, "https://example.com", "complete");
      } catch (e) {
        lastErr = "example.com: " + String((e && (e as any).message) || e);
      }
      loaded = await waitFor(async () => {
        const now = await ctx.tabsInfo();
        const panes = now.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        const urls = panes.map((t) => t.url || "").join(" ");
        return panes.length === 2 && urls.includes("example.com") && urls.includes("example.org") ? panes : null;
      }, 8000).catch(() => null);
    }
    const ts = await ctx.tabsInfo();
    const sv = loaded || ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    assert(
      sv.length === 2,
      "both panes still share the split after loading: " + JSON.stringify(ts) + " lastError=" + lastErr
    );
    assert(sv.some((t) => (t.url || "").includes("example.com")), "pane 1 loaded example.com: " + JSON.stringify(sv.map((t) => t.url)));
    assert(sv.some((t) => (t.url || "").includes("example.org")), "pane 2 loaded example.org: " + JSON.stringify(sv.map((t) => t.url)));
    // Clean up: close pane 2; Firefox auto-unsplits the remaining tab.
    const p2 = ts.find((t) => (t.url || "").includes("example.org"));
    if (p2) await evalIn(ctx.probe, `browser.tabs.remove(${p2.id})`).catch(() => {});
    await waitNoSplit();
  });
  await t("split: native split ;W h / ;W l switch the active pane", async () => {
    const pair = await nativeSplit();
    const p1 = pair.find((t) => t.active);
    const p2 = pair.find((t) => !t.active);
    assert(p1 && p2, "native split has an active and an inactive pane: " + JSON.stringify(pair));
    // The command center pane stays selected right after splitting (the helper
    // keeps the original tab active); keys on it reach the chrome helper.
    await ctx.leaderSeq(ctx.tabA, ["W", "h"])
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
    await ctx.leaderSeq(ctx.tabA, ["W", "l"])
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
  await t("split: ;W s swaps the panes", async () => {
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
    // `;W s` swaps the pair (order flips). A two-pane split has no direction
    // to pick, which is why the directional `{` / `}` keys are gone.
    await ctx.leaderSeq(ctx.tabA, ["W", "s"])
    try {
      await waitFor(async () => ((await order()) === flipped ? flipped : null), 8000);
    } catch (e) {
      const now = await ctx.tabsInfo().catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error(";W s did not flip panes; before=" + before + " now=" + JSON.stringify(now) + " state=" + JSON.stringify(st && { lastAction: st.lastAction, strip: st.strip }));
    }
    const after1 = await order();
    assert(after1 === flipped, ";W s swapped the panes: " + before + " -> " + after1);
    // The same key again is the inverse: a swap is its own undo.
    await ctx.leaderSeq(ctx.tabA, ["W", "s"])
    await waitFor(async () => ((await order()) === before ? before : null), 8000);
    const after2 = await order();
    assert(after2 === before, ";W s swapped the panes back: " + after1 + " -> " + after2);
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

  await t("split: ;W then the Shift that `|` needs is not eaten by the menu", async () => {
    // THE REPORTED BUG, typed the way a hand types it: "if I hit ;W then let go
    // to hit the next key like | i get error shift not exist. I can only access
    // | key by shift key and I can't do it after ;W in steps".
    //
    // `;W |` is a THREE-key sequence on a real keyboard — `;`, `W`, Shift, `|` —
    // because Shift is a keydown of its own before the character it modifies. The
    // category capture consumed that keydown as though it were the answer,
    // reported "no binding for ;Shift" and closed the menu, so the `|` that
    // followed belonged to no menu and `|`, `{`, `}` — every Shifted sub-key -
    // were unreachable. The unit tier pins the state machine
    // (scripts/test-leader-sequences.ts); this is the same sequence through a real
    // browser, real key events and the real split.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderSeq(ctx.tabA, [
      "W",
      { k: "Shift" }, // the bare modifier press, exactly as the keyboard sends it
      { k: "|", shift: true },
    ]);
    const pair = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 10000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error(
        "`;W` then a bare Shift then `|` did not split; tabs=" +
          JSON.stringify(ts) +
          " lastMoveDebug=" +
          JSON.stringify(st && st.lastMoveDebug)
      );
    });
    assert(
      new Set(pair.map((t) => t.splitViewId)).size === 1,
      "the two panes share one splitViewId: " + JSON.stringify(pair)
    );
    // Clean up the same way every other test in this file does.
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]);
    await waitNoSplit();
  });

  await t("split: after ;W u the window is USABLE again (`;N` moves, `;t` opens)", async () => {
    // The manual report this exists for, verbatim: "the unsplit is completely
    // broken and breaks the whole software ... after unsplit I can't use navigate
    // to any other places (doing ;Number does nothing, doing ;t show empty list
    // of tabs — the status bar show 3/4 tabs but I can do anything to see them or
    // use them), history is not working, basically the whole software useless").
    //
    // Every assertion below is about the window AFTER the unsplit, which is the
    // half no earlier test looked at: the existing unsplit case checks that the
    // split is gone and our panel pane was closed, and stops there. A window with
    // no split and nothing selected passes that test and is still unusable.
    await nativeSplit();
    const before = await ctx.tabsInfo();
    const panelIds = before
      .filter((t) => (t.url || "").includes("splitpanel.html"))
      .map((t) => t.id);
    const realBefore = before.filter((t) => ctx.isRealTab(t) && !panelIds.includes(t.id));
    assert(
      realBefore.length >= 2,
      "the fixture has real tabs to come back to: " + JSON.stringify(before.map((t) => t.url))
    );

    await ctx.leaderSeq(ctx.tabA, ["W", "u"]);
    await waitNoSplit();

    // 1. THE IDS AND THE LOCATIONS AGREE. Every real tab is still in the strip
    // and still reported by the tabs API — the same question the reported
    // "disconnect between the tab ids and their locations" is asking.
    const after = await ctx.tabsInfo();
    for (const t of realBefore) {
      assert(
        after.some((x) => x.id === t.id),
        "tab " + t.id + " did not survive the unsplit: " +
          JSON.stringify(after.map((x) => x.id + ":" + String(x.url || "").slice(-24)))
      );
    }
    assert(
      after.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)),
      "no tab is in a split after the unsplit: " + JSON.stringify(after)
    );

    // 2. SOMETHING IS SELECTED. With no selected tab, every action that resolves
    // "the current tab" — `;N`, the switcher's active row, the history — has
    // nothing to resolve against, which is what "then nothing works" is made of.
    const active = await ctx.activeTabInfo();
    assert(
      !!active,
      "a tab is selected after the unsplit: " + JSON.stringify(after.map((t) => t.id + ":" + (t.active ? "ACTIVE" : "")))
    );

    // 3. `;N` STILL ADDRESSES A TAB. The product's own numbering decides the
    // number (never a count of what the test can see).
    const realAfter = after.filter((t) => ctx.isRealTab(t));
    const target = realAfter.find((t) => !t.active && !t.pinned);
    if (target) {
      const n = await ctx.productNumberOf(target, realAfter);
      assert(n >= 1, "the product's numbering knows the target tab: " + n);
      await ctx.leaderSeq(ctx.tabA, String(n).split(""));
      const moved = await waitFor(async () => {
        const a = await ctx.activeTabInfo();
        return a && a.id === target.id ? a : null;
      }, 8000).catch(() => null);
      const now = await ctx.activeTabInfo().catch(() => null);
      assert(
        moved,
        "`;" + n + " did not switch to tab " + target.id + " after the unsplit (active=" +
          JSON.stringify(now && now.id) + ")"
      );
    }

    // 4. THE TAB SWITCHER LISTS THE WINDOW, rather than showing nothing — "`;t`
    // shows an empty list of tabs (the status bar show 3/4 tabs)".
    //
    // It is asked on a WEB page, which is the realm the user's report describes
    // and the only one where the popup is the page's own: on a chrome-owned page
    // the helper draws it in the chrome document, where the page-side read this
    // harness uses cannot see it at all. The window is the same window either
    // way, and the rows are the question.
    const web = await createTab();
    try {
      await ctx.gotoPage(web, `${ctx.base}/`);
      // The rows live in a closed shadow root, so the harness listens for the
      // popup's own composed "lazyfox:list" event (the same pattern as the
      // content suite's ;t tests).
      await evalIn(
        web,
        `window.__lfList = null; document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true); true`
      );
      await ctx.leaderPress(web, "t");
      await waitFor(async () => ((await ctx.hasHost(web, "lazyfox-popup")) ? true : null), 8000).catch(
        async () => {
          throw new Error(
            "`;t` did not open the tab switcher after the unsplit; tabs=" +
              JSON.stringify(await ctx.tabsInfo().catch(() => "ERR"))
          );
        }
      );
      const detail = await waitFor(async () => {
        const d = await evalIn(web, `window.__lfList`).catch(() => null);
        return d && d.count > 0 ? d : null;
      }, 8000).catch(() => null);
      assert(
        detail && detail.count >= 2,
        "the tab switcher lists the window after the unsplit: " + JSON.stringify(detail) +
          " tabs=" +
          JSON.stringify(await ctx.tabsInfo().catch(() => "ERR"))
      );
      await evalIn(web, `window.__lfList = null; true`);
      await ctx.press(web, "Escape");
      await waitFor(async () => (!(await ctx.hasHost(web, "lazyfox-popup")) ? true : null), 5000).catch(
        () => null
      );
    } finally {
      // Leave the window as this file's other tests expect to find it: the
      // scratch tab gone and tabA a command center.
      const id = await ctx.tabIdOf(web).catch(() => null);
      if (id != null) await evalIn(ctx.probe, `browser.tabs.remove(${id})`).catch(() => {});
      await waitFor(async () => {
        const ts = await ctx.tabsInfo();
        return id == null || ts.every((t) => t.id !== id) ? true : null;
      }, 5000).catch(() => {});
      ctx.tabA = await createTab();
      await ctx.openCC(ctx.tabA);
    }
  });

  // THE THREE OPS, TIMED. The report was "splitting and the switching and any
  // action related to window manipulation is super slow that it makes thing not
  // usable" — a claim about LATENCY, which no assertion in this folder measured:
  // every other test waits for an outcome and passes whatever it cost.
  //
  // The measurement starts at the LAST key of the chord and ends at the first
  // cheap read that can see the outcome (`tabsInfo`, one `browser.tabs.query` in
  // the probe — never `chromeState`, which is a page NAVIGATION per read and was
  // measured at ~700ms, i.e. more than the thing being measured). So the number
  // printed here is the user-visible lag of one op, plus the key dispatch.
  //
  // The ceilings are deliberately loose. This is a regression guard against the
  // two ways these ops can become unusable — a per-op relay wait that grows with
  // the strip, or an op that stopped answering at all — not a micro-benchmark
  // with a budget that would fail on a loaded machine.
  await t("split: the three ops answer inside a keystroke's patience (measured)", async () => {
    const pair = await nativeSplit();
    assert(pair.length === 2, "native split paired two tabs: " + JSON.stringify(pair));

    const activeId = async (): Promise<number | null> => {
      const ts = await ctx.tabsInfo().catch(() => [] as any[]);
      const a = ts.find((x: any) => x.active);
      return a ? a.id : null;
    };
    const timed = async (what: string, key: string, done: () => Promise<boolean>): Promise<number> => {
      // The head of the chord first, so the clock starts at the one key that is
      // supposed to cause the change.
      await ctx.leaderSeq(ctx.tabA, ["W"]);
      const t0 = Date.now();
      await ctx.press(ctx.tabA, key);
      const ok = await done();
      const ms = Date.now() - t0;
      assert(ok, what + " did not take effect within the 8s the wait allows");
      console.log(`     ${what}: ${ms}ms from the key to the change`);
      assert(ms < 2500, what + " took " + ms + "ms from the keypress to the visible change (budget 2500ms)");
      return ms;
    };

    const before = await activeId();
    await timed("switch pane", "h", async () => {
      const id = await waitFor(async () => {
        const now = await activeId();
        return now != null && now !== before ? now : null;
      }, 8000).catch(() => null);
      return id != null;
    });

    const splitPair = await ctx.tabsInfo();
    const panes = splitPair.filter((x: any) => typeof x.splitViewId === "number" && x.splitViewId >= 0);
    assert(panes.length === 2, "the split is still there after the switch: " + JSON.stringify(panes));

    await timed("unsplit", "u", async () => {
      await waitNoSplit().catch(() => {});
      const ts = await ctx.tabsInfo().catch(() => [] as any[]);
      return ts.every((x: any) => !(typeof x.splitViewId === "number" && x.splitViewId >= 0));
    });

    // And back, so the split op is measured on a strip that just changed.
    await waitNoSplitStable();
    await ctx.leaderSeq(ctx.tabA, ["W"]);
    const t0 = Date.now();
    await ctx.press(ctx.tabA, "|");
    const again = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.filter((x: any) => typeof x.splitViewId === "number" && x.splitViewId >= 0).length === 2 ? ts : null;
    }, 8000).catch(() => null);
    const splitMs = Date.now() - t0;
    assert(again, "the second split did not form within 8s");
    console.log(`     split: ${splitMs}ms from the key to the pair`);
    assert(splitMs < 2500, "split took " + splitMs + "ms from the keypress to the pair (budget 2500ms)");

    await ctx.leaderSeq(ctx.tabA, ["W", "u"]);
    await waitNoSplit().catch(() => {});
    await waitNoSplitStable();
  });

  await t("split: the pairing and its place are written down (what a restart reads)", async () => {
    // A split changes no tab, so it fires no `tabs.*` event, and the autosave is
    // driven entirely by those events. Before the helper reported the layout
    // change, a pair made after the last tab change was never written into the
    // crash-recovery session — so the next launch had nothing to restore and
    // came back flat. This asserts the WRITE, at the position level, because
    // that is the thing a restart reads.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
    const tabB = await createTab();
    await navigate(tabB, `${ctx.base}/hello`, "complete");
    await ctx.waitTabUrl("/hello", { timeoutMs: 10000 });
    await ctx.openCC(ctx.tabA);
    //
    // Build the pair the way the persistence path can actually describe it:
    // TWO CONTENT PANES. `;W |` alone pairs the active page with the
    // split-panel companion, which is plumbing the snapshot drops on purpose
    // (it is our own UI, recreated on demand, not something a restore reopens)
    // — so that split has nothing to write down, and is not what this test is
    // about. Moving a real page into the split replaces the companion, which is
    // the layout a user ends up with and quits from.
    const want = (expr: string, ms = 10000) => ctx.waitExpr(ctx.probe, expr, true, ms);
    const get = (expr: string) => evalIn(ctx.probe, expr);
    // The pair on screen, so the stored layout can be compared with it.
    await nativeSplit();
    const live = await ctx.tabsInfo();
    const real = live.filter((t: any) => ctx.isRealTab(t));
    const target = real.find((t: any) => (t.url || "").indexOf("/hello") !== -1);
    assert(target, "found the content tab to pair with: " + JSON.stringify(live));
    const targetIndex = await ctx.productNumberOf(target, real);
    await ctx.leaderSeq(ctx.tabA, ["W", "m"]); // ;W m -> move tab into split
    await waitPlusPopup(ctx.tabA);
    await ctx.pressNumber(ctx.tabA, targetIndex); // ;+N
    const panes = await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const sv = now.filter((t: any) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 && sv.some((t: any) => t.id === target.id) ? sv : null;
    }, 10000).catch(() => null);
    assert(
      panes,
      "two content panes to remember: " + JSON.stringify(await ctx.tabsInfo().catch(() => "ERR"))
    );
    await want(
      `browser.storage.local.get("lfLastSession").then((r) => { const s = r.lfLastSession;` +
        ` return !!(s && s.tabs && /[0-9]+:[0-9]+/.test(String(s.splits || ""))); })`
    ).catch(async (e) => {
      const saved = await get(
        `browser.storage.local.get("lfLastSession").then((r) => JSON.stringify(r.lfLastSession || null))`
      ).catch(() => "ERR");
      // What the EXTENSION can see, pane by pane: a stored layout can only be as
      // good as this view, and "the id is not on the tab yet" and "the tab is
      // not in the list at all" are different bugs with the same symptom.
      const api = await get(
        `browser.tabs.query({ currentWindow: true }).then((ts) => ts.map((t) => ({ id: t.id, u: String(t.url || "").slice(-28), sv: t.splitViewId === undefined ? "none" : t.splitViewId, pinned: !!t.pinned, hidden: !!t.hidden })))`
      ).catch(() => "ERR");
      throw new Error(
        "the split was never written to the autosave: " + String(e) +
        " last=" + saved + " api=" + JSON.stringify(api)
      );
    });
    const paneUrls = panes.map((p: any) => String(p.url || ""));
    assert(
      paneUrls.every((u: string) => !u.includes("splitpanel.html")),
      "both panes are content: " + JSON.stringify(paneUrls)
    );
    const saved: any = await get(`browser.storage.local.get("lfLastSession").then((r) => r.lfLastSession)`);
    // `saved` is the crash-recovery "last" session, which is exactly what a
    // restart reads when the window was never given a name.
    //
    // "a:b" per pair, 0-based over the tabs a split can address (unpinned).
    const pairs: number[][] = String(saved.splits)
      .split(",")
      .filter(Boolean)
      .map((p: string) => p.split(":").map(Number));
    assert(pairs.length === 1, "exactly one pair is recorded: " + JSON.stringify(saved.splits));
    const [a, b] = pairs[0];
    assert(
      Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0,
      "the pair is two positions: " + JSON.stringify(saved.splits)
    );
    const addressable = (saved.tabs || []).filter((x: any) => !x.pinned);
    assert(
      addressable.length > Math.max(a, b),
      "both positions exist in the saved list: " + saved.splits + " of " + addressable.length + " tabs"
    );
    // The positions must name the two tabs that ARE the split, which is a
    // stronger claim than "two tabs share an id": a snapshot taken while the
    // panes are still settling can name the wrong pair, and the user sees that
    // as "my layout came back paired with the wrong tab".
    //
    // Identity, not position arithmetic: two tabs in one window can share a URL
    // (a command center each), so "the first tab with this URL" is not the pane.
    // The multiset of the recorded panes is what must match.
    const leaf = (u: unknown) => String(u || "").split("#")[0];
    const asc = (xs: unknown[]) => xs.map(leaf).sort();
    const atA = addressable[a];
    const atB = addressable[b];
    const got = asc([atA.url, atB.url]);
    assert(
      JSON.stringify(got) === JSON.stringify(asc(paneUrls)),
      "the recorded pair is the pane pair: want " + JSON.stringify(asc(paneUrls)) +
        " got " + JSON.stringify(got) + " at " + saved.splits + " over " +
        JSON.stringify(addressable.map((x: any) => String(x.url || "").slice(-24)))
    );
    assert(
      typeof atA.splitViewId === "number" && atA.splitViewId >= 0 && atA.splitViewId === atB.splitViewId,
      "the recorded positions are the two panes of one split view: " +
        JSON.stringify({ splits: saved.splits, a: atA, b: atB })
    );
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]);
    await waitNoSplit().catch(() => {});
    await waitNoSplitStable();
    // And the layout is written down again when it goes away — the same report,
    // the other direction. An empty layout is absence of a pair, not a stale one.
    await want(
      `browser.storage.local.get("lfLastSession").then((r) => { const s = r.lfLastSession;` +
        ` return !!(s && s.tabs && !/[0-9]+:[0-9]+/.test(String(s.splits || ""))); })`
    ).catch((e) => {
      throw new Error("the unsplit was never written to the autosave: " + String(e));
    });
    // Hand the window back. This test opens pages of its own, and the next test
    // in the group reasons about WHERE a tab sits ("A stays first among the web
    // tabs") — a page left behind by this one is a tab the next test never made
    // and cannot account for, so its order assertion fails for a reason that has
    // nothing to do with the order. Measured: the two `order` tests pass alone
    // and failed only behind this one.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
  });
}
