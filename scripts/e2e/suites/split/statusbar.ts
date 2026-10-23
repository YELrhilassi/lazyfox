// statusbar tests (split). Deterministic: every wait targets a product signal
// (status bar mount state, per-pane bar hosts, split view ids) instead of
// fixed sleeps.
import { closeContext, createTab, evalIn, keyTap, navigate, send, sleep, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
import { makeSplitHelpers } from "./_shared.ts";
export async function run(ctx: any): Promise<void> {
  // Tags: `--tags split` selects these. "destructive" marks tests
  // that dissolve and rebuild splits, so a quick subset can skip them.
  const TAGS: string[] = ["split"];
  const { t, waitNoSplit, waitPlusPopup, pageState } = makeSplitHelpers(ctx, "split/statusbar", TAGS);

  await t("split: one window-level status bar (not one per pane)", async () => {
    // During a native split the chrome helper shows the single window bar and
    // the web panes hide their per-tab bars, so there is exactly ONE bar for
    // the whole window instead of one rendered in each pane.
    await waitNoSplit();
    const a = await createTab();
    await ctx.openCC(a);
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    await ctx.waitTabUrl("/hello", { timeoutMs: 10000 });
    await ctx.openCC(a); // re-activate the CC tab
    await ctx.leaderSeq(a, ["W", "|"]); // ;W | -> CC + panel
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0).length === 2 ? true : null;
    }, 8000);
    const real = (await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t));
    const helloRow = real.find((t) => (t.url || "").includes("/hello"));
    // The PRODUCT's numbering, not the strip index this test happens to see,
    // and not clamped into 1-9. The clamp was a silent wrong-target bug: in a
    // full run the strip carries tabs from three earlier groups, so a hello
    // sitting at position 11 was addressed as 9 and some OTHER tab was moved
    // into the split. productNumberOf asks the product which digit means
    // /hello, and pressNumber types it a digit at a time so a two-digit answer
    // works exactly like a single keystroke.
    const helloNumber = await ctx.productNumberOf(helloRow, real);
    assert(
      helloNumber >= 1,
      "the product's numbering knows the /hello tab: " + helloNumber + " of " + real.length,
    );
    await ctx.leaderSeq(a, ["W", "m"]); // ;W m -> move tab into split
    await waitPlusPopup(a);
    await ctx.pressNumber(a, helloNumber);
    // Wait for the move to land (hello is IN the split) and then for the
    // per-pane bar to actually disappear (the content poll hides it) instead
    // of a fixed sleep.
    try {
      await waitFor(async () => {
        const ts = await ctx.tabsInfo();
        const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        return sv.length === 2 && sv.some((t) => (t.url || "").includes("/hello")) ? true : null;
      }, 10000);
    } catch (e) {
      // `;W m` + the digit had no effect. Which of the two it was decides where
      // to look: the page's own state says whether the chord could even have
      // meant anything (an input holding focus turns `;` into text), and the
      // move trail says whether the op ran and refused.
      const st = await ctx.chromeState().catch(() => "ERR");
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      const page = await pageState(a);
      throw new Error(
        ";W m + " + helloNumber + " did not move the /hello tab into the split; " +
          "page=" + JSON.stringify(page) +
          " lastMoveDebug=" + JSON.stringify(st && st.lastMoveDebug) +
          " split=" + JSON.stringify(st && st.nativeSplit && { sel: st.nativeSplit.selSplitview, hasSv: st.nativeSplit.selHasSplitview }) +
          " tabs=" + JSON.stringify(ts)
      );
    }
    await waitFor(async () =>
      evalIn(b, `!document.getElementById("lazyfox-status")`).then((v) => (v ? true : null)).catch(() => null)
    , 8000).catch(() => {});
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
    await ctx.leaderSeq(a, ["W", "u"]);
    await waitNoSplit();
    await closeContext(b).catch(() => {});
    await closeContext(a).catch(() => {});
    await ctx.waitTabUrl("/hello", { gone: true, timeoutMs: 8000 }).catch(() => {});
  });

  await t("split: which-key is painted by the WINDOW, not inside a pane, and ;q takes it down", async () => {
    // A page owns HALF the window in a split view, so a menu it draws itself
    // appears at the corner of that pane and reads as the tab's UI. The pane
    // therefore sends the rendered menu to the chrome helper, which paints it
    // over the whole window. `;q` must remove that copy too — the reported
    // "I disabled which-key and it still shows on one split pane".
    await waitNoSplit();
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    await ctx.waitTabUrl("/hello", { timeoutMs: 10000 });
    // Split the web page itself: hello + a fresh split panel.
    await ctx.leaderSeq(b, ["W", "|"]);
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.filter((x) => typeof x.splitViewId === "number" && x.splitViewId >= 0).length === 2
        ? true
        : null;
    }, 8000).catch(async () => {
      throw new Error("split did not form; tabs=" + JSON.stringify(await ctx.tabsInfo()));
    });

    // Arm the page's leader. The menu must appear in the WINDOW...
    await ctx.leaderSeq(b, []);
    const painted = await waitFor(async () => {
      const st = await ctx.chromeState();
      return st && st.pageWhichKey === true ? true : null;
    }, 5000).catch(() => null);
    assert(
      painted,
      "the window paints a split pane's which-key; pane=" +
        JSON.stringify(await evalIn(b, `document.documentElement.getAttribute("data-lf-splitpane")`)) +
        " state=" +
        JSON.stringify(await ctx.chromeState())
    );
    // ...and the pane must not paint its own copy. `data-lf-whichkey` is the
    // page's mirror of "which-key is painted in THIS document"; the window's
    // copy is the one that is up. (The host element may exist from a sequence
    // armed before the split and is deliberately persistent — what must not be
    // true is that it is what the user sees.)
    assert(
      !(await evalIn(b, `document.documentElement.getAttribute("data-lf-whichkey") === "1"`)),
      "the pane paints no which-key of its own"
    );

    // Already armed, so `q` completes the `;q` chord.
    await ctx.press(b, "q");
    await waitFor(async () => {
      const st = await ctx.chromeState();
      return st && st.pageWhichKey === false ? true : null;
    }, 5000).catch(() => null);
    assert(
      !(await ctx.chromeState()).pageWhichKey,
      "`;q` takes the window's copy down"
    );

    // Disabled stays disabled: arming again paints nothing, in either place.
    await ctx.leaderSeq(b, []);
    await new Promise((r) => setTimeout(r, 700));
    assert(
      !(await ctx.chromeState()).pageWhichKey,
      "with which-key off, arming paints nothing in the window"
    );
    assert(
      !(await evalIn(b, `document.documentElement.getAttribute("data-lf-whichkey") === "1"`)),
      "...and nothing in the pane"
    );
    await keyTap(b, "Escape").catch(() => {});
    // Leave the setting as it was found (the runner also repairs it, but a test
    // should not depend on that).
    await ctx.leaderSeq(b, ["q"]);

    await ctx.leaderSeq(b, ["W", "u"]);
    await waitNoSplit();
    await closeContext(b).catch(() => {});
  });

  await t("split: a pane RELOADED inside the split still paints its menu in the window", async () => {
    // The menu reached the window only when the page already had a LOCAL host to
    // repaint from — which a page that armed before the split happened to have.
    // A document that boots as a pane never builds one, and the render path
    // bailed before sending anything, so the window painted nothing at all.
    // That is the reported "it might show for a few first times but then stops
    // showing", and a reload inside the split is the smallest way to put a
    // document in that state.
    await waitNoSplit();
    const b = await createTab();
    await navigate(b, `${ctx.base}/hello`, "complete");
    await ctx.waitTabUrl("/hello", { timeoutMs: 10000 });
    await ctx.leaderSeq(b, ["W", "|"]);
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.filter((x) => typeof x.splitViewId === "number" && x.splitViewId >= 0).length === 2
        ? true
        : null;
    }, 8000).catch(async () => {
      throw new Error("split did not form; tabs=" + JSON.stringify(await ctx.tabsInfo()));
    });

    // Reload the pane: a fresh document that learns it is a pane before its
    // first `;`, so it has never painted a host of its own.
    await send("browsingContext.reload", { context: b, wait: "complete" }).catch(() => null);
    const paneAgain = await waitFor(async () => {
      const on = await evalIn(b, `document.documentElement.getAttribute("data-lf-splitpane")`).catch(() => null);
      return on === "1" ? true : null;
    }, 10000).catch(() => null);
    assert(
      paneAgain,
      "the reloaded document is told it is a pane (data-lf-splitpane); tabs=" +
        JSON.stringify(await ctx.tabsInfo().catch(() => "ERR"))
    );
    await sleep(300);

    await ctx.leaderSeq(b, []);
    const painted = await waitFor(async () => {
      const st = await ctx.chromeState();
      return st && st.pageWhichKey === true ? true : null;
    }, 8000).catch(() => null);
    assert(
      painted,
      "the window paints a reloaded pane's which-key; pane=" +
        JSON.stringify(await evalIn(b, `document.documentElement.getAttribute("data-lf-splitpane")`)) +
        " state=" +
        JSON.stringify(await ctx.chromeState().catch(() => "ERR"))
    );
    assert(
      !(await evalIn(b, `document.documentElement.getAttribute("data-lf-whichkey") === "1"`)),
      "the reloaded pane paints nothing of its own"
    );

    await keyTap(b, "Escape").catch(() => {});
    await ctx.leaderSeq(b, ["W", "u"]);
    await waitNoSplit();
    await closeContext(b).catch(() => {});
  });

  await t("split: `;o` in the split-panel pane closes it and hands the keyboard to the sister", async () => {
    // The panel is our own utility surface, not a page to read: opening a URL
    // INTO it replaces the move-a-tab list with a web page the split never asked
    // for (reported: "I did `;o` instead of pulling another tab and it kind of
    // breaks the software ... instead of doing regular `;o` for that splitpanel
    // tab we just delete it and focus the other sister tab").
    await waitNoSplit();
    await ctx.openCC(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]);
    const pair = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const panes = ts.filter((x) => typeof x.splitViewId === "number" && x.splitViewId >= 0);
      return panes.length === 2 ? panes : null;
    }, 8000).catch(async () => {
      throw new Error("split did not form; tabs=" + JSON.stringify(await ctx.tabsInfo()));
    });
    const panel = pair.find((x) => String(x.url || "").includes("splitpanel.html"));
    assert(panel, "the split has a panel pane: " + JSON.stringify(pair));
    const sister = pair.find((x) => x.id !== panel!.id);
    assert(!!sister, "the split has a sister pane: " + JSON.stringify(pair));

    // Put the keyboard in the panel pane: the panel is created after the home
    // tab, so it is the pane on the right.
    await ctx.leaderSeq(ctx.tabA, ["W", "l"]);
    await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.id === panel!.id ? true : null;
    }, 6000).catch(async () => {
      throw new Error("the panel pane was not selected; tabs=" + JSON.stringify(await ctx.tabsInfo()));
    });
    const panelCtx = await ctx.contextForTabId(panel!.id);

    // `;o` is "open URL" everywhere else. Here it must close the pane.
    await ctx.leaderSeq(panelCtx, ["o"]);
    const gone = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.every((x) => x.id !== panel!.id) ? true : null;
    }, 8000).catch(() => null);
    assert(gone, "the panel pane is gone: " + JSON.stringify(await ctx.tabsInfo()));

    const after = await ctx.tabsInfo();
    assert(
      after.every((x) => !(typeof x.splitViewId === "number" && x.splitViewId >= 0)),
      "closing the panel dissolved the split: " + JSON.stringify(after)
    );
    const active = await ctx.activeTabInfo();
    assert(
      !!active && active.id === sister!.id,
      "the keyboard is on the sister tab: " + JSON.stringify({ active: active && active.id, sister: sister!.id })
    );
    // And the window still answers keys on the sister.
    await ctx.leaderSeq(ctx.tabA, []);
    await keyTap(ctx.tabA, "Escape").catch(() => {});
    await ctx.openCC(ctx.tabA);
  });
}
