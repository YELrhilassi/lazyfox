// sessions tests. Deterministic: every step waits on a product signal
// (leader overlay state, storage writes, split-view ids, popup list events)
// instead of fixed sleeps.
import { closeContext, createTab, evalIn, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "sessions/sessions";
  // Tags: `--tags destructive` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["destructive"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[]; keepTabs?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS, keepTabs: opts.keepTabs });

  // --- composable condition helpers (replace sleeps) ---
  // The leader is armed on a WEB page: the content script mirrors it onto
  // <html> as data-lf-leader. (The which-key overlay's host element is NOT a
  // signal — it lives in a closed shadow root and survives hide().)
  const armedOnPage = (tab, ms = 4000) => ctx.waitLeader(tab, false, ms);
  // A leader sequence DISPATCHED: the leader is disarmed again.
  const leaderDone = (tab, ms = 6000) => ctx.waitLeader(tab, true, ms);
  // The chrome window's leader is idle (a chrome-side dispatch finished —
  // no-op bindings change nothing else observable).
  const chromeLeaderIdle = (ms = 6000) =>
    waitFor(async () => {
      const s = await ctx.chromeState().catch(() => null);
      return s && !s.leaderActive ? true : null;
    }, ms);
  // Poll a storage expression through the probe tab's extension realm.
  const waitStore = (expr, ms = 8000) => ctx.waitExpr(ctx.probe, expr, true, ms);
  const storeGet = (expr) => evalIn(ctx.probe, expr);
  // Watch the popup's composed list/tabs events (closed shadow root).
  const watchPopupEvents = (tab) =>
    evalIn(
      tab,
      `window.__lfList = null; window.__lfTabs = null;
       if (!window.__lfEvtWatch) { window.__lfEvtWatch = true;
         document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true);
         document.addEventListener("lazyfox:tabs", (e) => { window.__lfTabs = e.detail; }, true); } true`
    );
  const openSessionsPopup = async (tab) => {
    await ctx.leaderPress(tab, "p");
    await ctx.waitPopup(tab, 8000);
  };
  // Save a session by name through the ;p popup. Enter creates the session but
  // does NOT necessarily close the popup, and a popup left open swallows every
  // later keystroke — the next test's `;` would be typed into its input
  // instead of arming the leader. So the close is part of the operation, not an
  // afterthought.
  const saveSession = async (tab, name) => {
    await openSessionsPopup(tab);
    await ctx.typeIn(tab, name);
    await ctx.press(tab, "Enter");
    await waitStore(`browser.storage.local.get("lfSessions").then(r => !!(r.lfSessions && r.lfSessions[${JSON.stringify(name)}]))`);
    await ctx.waitPopupGone(tab, 8000).catch(async () => {
      throw new Error("[save-session] the ;p popup stayed open after Enter");
    });
  };
  const splitTabsOf = async () => {
    const ts = await ctx.tabsInfo();
    return ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
  };

  await t("sessions: ;W [ split-pane switch is a no-op without a split", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await ctx.leaderSeq(ctx.tabA, ["W", "["]);
    await leaderDone(ctx.tabA);
    await chromeLeaderIdle();
    const after = await ctx.tabsInfo();
    assert(after.length === before.length, "split-pane switch without a split view changed no tabs");
  });
  await t("sessions: ;W . and ;W , move bindings dispatch cleanly", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await ctx.leaderSeq(ctx.tabA, ["W", "."]);
    await leaderDone(ctx.tabA);
    await ctx.leaderSeq(ctx.tabA, ["W", ","]);
    await leaderDone(ctx.tabA);
    await chromeLeaderIdle();
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
    await saveSession(ctx.tabA, "work");
    await waitStore(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.work && r.lfSessions.work.marker === 1)`);
    const r = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions.work)`);
    assert(r && r.marker === 1, "work got marker 1, got " + (r && r.marker));
    assert(r && r.tabs && r.tabs.length >= 1, "work captured tabs");
    // The status bar reflects the current session name.
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("work") !== -1 ? true : null;
    }, 8000);
  });
  await t("sessions: ;' + digit consumes the marker binding", async () => {
    // Switch to a marker with no session: the pending-prefix path must run
    // without touching the window's tabs (non-destructive verification).
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await ctx.press(ctx.tabA, ";");
    await armedOnPage(ctx.tabA);
    await ctx.press(ctx.tabA, "'");
    await ctx.press(ctx.tabA, "9");
    await leaderDone(ctx.tabA);
    const after = await ctx.tabsInfo();
    assert(after.length === before.length, "no tabs were changed by an unknown marker");
  });
  await t("sessions: ;' + 1 hot-swaps to the marked session", async () => {
    // Save a second session from a distinct tab set.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await saveSession(ctx.tabA, "mail");
    // Switch to marker 1 ("work") with ;' + 1.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.press(ctx.tabA, ";");
    await armedOnPage(ctx.tabA);
    await ctx.press(ctx.tabA, "'");
    await ctx.press(ctx.tabA, "1");
    // The switch REPLACES every tab in the window, so this keystroke destroys
    // tabA and the probe by design. Nothing may be read from them afterwards:
    // every eval there fails with "no such frame" and the failure looks like a
    // product bug instead of the test's own teardown. Re-establish both
    // contexts first, then read the store the switch wrote.
    await ctx.waitCurrentSession("work");
    // The restored session's own tabs are on the strip now; the work session
    // was saved from tabA, so the window must actually hold its URL.
    await ctx.waitTabUrl("127.0.0.1", { timeoutMs: 15000 });
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("sessions: Ctrl+digit assigns a marker", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await watchPopupEvents(ctx.tabA);
    await openSessionsPopup(ctx.tabA);
    // Wait for the list to render before navigating, then highlight the
    // second session (mail) and mark it 9 with Ctrl+9. The list event is
    // mirrored in the PAGE realm (tabA), not the probe's — waitStore() polls
    // the probe and would never see it.
    await ctx.waitListEvent(ctx.tabA, { count: 2 }, 10000)
      .catch(async () => {
        const d = await evalIn(ctx.tabA, `window.__lfList`).catch(() => null);
        throw new Error("[ctrl-marker] the sessions list never rendered 2 rows: " + JSON.stringify(d));
      });
    await ctx.press(ctx.tabA, "ArrowDown");
    await ctx.waitListEvent(ctx.tabA, { idx: 1 });
    await ctx.press(ctx.tabA, "9", { ctrl: true });
    await waitStore(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.mail && r.lfSessions.mail.marker === 9)`);
    const r = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions.mail)`);
    assert(r && r.marker === 9, "mail marker reassigned to 9, got " + (r && r.marker));
    const w = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.work)`);
    assert(w && w.marker === 1, "work marker unchanged at 1, got " + (w && w.marker));
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 5000);
  });
  // A marker switch REPLACES every tab in the window, so it destroys both
  // tabA and the probe. The new probe must therefore be opened BEFORE the
  // store is read — polling the dead one only ever times out.
  const hotSwap = async (digit: string, session: string) => {
    await ctx.press(ctx.tabA, digit, { ctrl: true });
    await ctx.waitCurrentSession(session);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  };
  await t("sessions: Ctrl+digit hot-swaps to the marked session", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await hotSwap("9", "mail");
    await hotSwap("1", "work");
  });
  await t("sessions: ;p saves on immediate Enter (no debounce wait)", async () => {
    // Regression for the Enter race: typing a name and pressing Enter at once
    // must save, without waiting for the (formerly debounced) search to land.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await openSessionsPopup(ctx.tabA);
    await ctx.typeIn(ctx.tabA, "instant");
    await ctx.press(ctx.tabA, "Enter"); // no settling sleep
    await waitStore(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.instant && r.lfSessions.instant.tabs && r.lfSessions.instant.tabs.length)`);
    // The popup must be closed before this test ends, or the next test's `;`
    // is typed into its input instead of arming the leader.
    await ctx.waitPopupGone(ctx.tabA, 8000).catch(() => {
      throw new Error("[instant-save] the ;p popup stayed open after Enter");
    });
    const r = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions.instant)`);
    assert(r && r.tabs && r.tabs.length >= 1, "instant saved with tabs");
    // clean up so later tests are unaffected
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.instant; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
  });
  await t("sessions: new clean session creates an empty session without touching the window", async () => {
    // A brand-new name offers a "new clean session" row (arrow down from the
    // save row); picking it creates an EMPTY session under that name and must
    // leave the current window's tabs exactly as they were.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await watchPopupEvents(ctx.tabA);
    await openSessionsPopup(ctx.tabA);
    await ctx.typeIn(ctx.tabA, "clean");
    // Wait for the *filtered* list (q === "clean") to render exactly the two
    // action rows (save + new clean), then move onto the new-clean row.
    await ctx.waitListEvent(ctx.tabA, { q: "clean", count: 2 }, 10000);
    await ctx.press(ctx.tabA, "ArrowDown"); // save row -> new-clean-session row
    await ctx.waitListEvent(ctx.tabA, { idx: 1 });
    await ctx.press(ctx.tabA, "Enter");
    await waitStore(`browser.storage.local.get("lfSessions").then(r => !!r.lfSessions && !!r.lfSessions.clean)`);
    await ctx.waitPopupGone(ctx.tabA, 8000).catch(() => {
      throw new Error("[clean-session] the ;p popup stayed open after Enter");
    });
    const clean = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.clean)`);
    assert(clean && Array.isArray(clean.tabs) && clean.tabs.length === 0, "clean session saved with zero tabs: " + JSON.stringify(clean && clean.tabs));
    const after = await ctx.tabsInfo();
    assert(after.length === before.length, "creating a clean session did not change the window's tabs");
    // Clean up the throwaway session.
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.clean; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
  });
  await t("sessions: x x on empty input deletes the highlighted session", async () => {
    // Regression: `x` used to fall through into the popup input (filtering the
    // list) instead of deleting the highlighted session, and a single x
    // deleted with no confirmation. Now the first x arms the delete and the
    // second confirms. Save a throwaway session, reopen the popup (empty
    // input), highlight it and delete it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    await openSessionsPopup(ctx.tabA);
    await ctx.typeIn(ctx.tabA, "delme");
    await ctx.press(ctx.tabA, "Enter");
    await waitStore(`browser.storage.local.get("lfSessions").then(r => !!r.lfSessions && !!r.lfSessions.delme)`);
    await ctx.waitPopupGone(ctx.tabA, 8000).catch(() => {
      throw new Error("[delete-session] the ;p popup stayed open after Enter");
    });
    // Reopen the popup: the input starts empty (that is the point — `x` used to
    // fall through and filter the list instead of deleting). Watch the composed
    // `lazyfox:list` event so ArrowDown/x never race the async list render.
    //
    // delme's ROW POSITION is computed, never assumed. The popup lists sessions
    // sorted by marker, so which row `delme` lands on depends on every session
    // left behind by the tests that ran before this one — which differs
    // between an isolated group run and a full run. Hardcoding "ArrowDown once"
    // therefore passed in isolation and highlighted the wrong row here, and `x`
    // then deleted somebody else's session. Ask the store for the same order
    // the popup renders, so the highlight is aimed at delme whatever else
    // exists. If the product's sort ever changes, the idx wait below fails
    // loudly rather than deleting a stranger's session.
    await watchPopupEvents(ctx.tabA);
    await openSessionsPopup(ctx.tabA);
    const shown = await ctx.waitListEvent(ctx.tabA, { count: { ge: 2 } }, 10000);
    const delmeIdx = await evalIn(
      ctx.probe,
      `(async () => {
         const all = (await browser.storage.local.get("lfSessions")).lfSessions || {};
         const ordered = Object.keys(all)
           .map((k) => all[k])
           .filter((s) => s && Array.isArray(s.tabs))
           .sort((a, b) => (a.marker || 99) - (b.marker || 99));
         const i = ordered.findIndex((s) => s.name === "delme");
         return i;
       })()`
    );
    assert(
      typeof delmeIdx === "number" && delmeIdx >= 0,
      "delme is in the session list the popup renders (idx=" + delmeIdx + ")"
    );
    for (let i = 0; i < delmeIdx; i++) await ctx.press(ctx.tabA, "ArrowDown");
    // The highlight must actually sit on the delme row before x can be trusted
    // to delete it (idx stays 0 while the list is empty, which would arm on the
    // wrong session).
    await ctx.waitListEvent(ctx.tabA, { idx: delmeIdx }, 5000);
    void shown;
    // x is two-step: first press arms the delete, second confirms it.
    await ctx.press(ctx.tabA, "x");
    await ctx.press(ctx.tabA, "x");
    await waitStore(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && !r.lfSessions.delme)`);
    const all = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    assert(!all.delme, "delme session was deleted by x");
    // Every session that existed before the delete must be untouched — x must
    // have removed exactly the highlighted delme row, not some other session.
    for (const n of Object.keys(before)) {
      assert(all[n], `session "${n}" untouched by the delete`);
    }
    // And exactly one session went away: a delete that took a second session
    // with it (or none) would still satisfy the loop above.
    assert(
      Object.keys(all).length === Object.keys(before).length,
      "x x removed exactly one session (" +
        Object.keys(before).length +
        " -> " +
        Object.keys(all).length +
        ")"
    );
    // saveSession set the current-session pointer to delme; point it back so
    // later tests see a consistent current session.
    await evalIn(ctx.probe, `browser.storage.local.set({ lfCurrentSession: "work" })`);
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 5000);
  });
  await t("sessions: split layout is saved and restored with the session", async () => {
    // No window trim here, deliberately. An earlier version collapsed the
    // window to a single probe tab "for determinism" — and the trim removed
    // the persistent relay tab the harness talks to, so every later step ran
    // against a dead context. Nothing actually needed the trim: the split
    // pair is identified by its splitViewIds, not by being the only pair, and
    // the move target is resolved over the same real-tab list the product
    // uses. A test should not reshape the world more than the behaviour under
    // test requires.
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.openCC(ctx.tabA);
    // A split of two REAL tabs (the user's flow): `;W |` pairs the active CC
    // tab with the split-panel companion, then `;W m N` moves a real content
    // tab into the split, REPLACING the panel (the panel is pure UI and must
    // never be saved as a session tab).
    const tabB = await createTab();
    await navigate(tabB, `${ctx.base}/hello`, "complete");
    await ctx.openCC(ctx.tabA); // re-activate the CC tab
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]); // ;W | -> split side-by-side
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("split not created; tabs=" + JSON.stringify(ts));
    });
    // The target position is read from the product's OWN numbering at the
    // moment of the press. Deriving it from the WebDriver tab list instead
    // looks equivalent and is not: the two lists disagree the moment a
    // transient helper tab is alive, and a correctly-typed digit then names
    // the wrong tab — which surfaces as "the split did not form" rather than
    // as the real cause. It must not come from chromeState() either: that
    // reply rides the probe's own `#lfc=state` hash, which hides the probe
    // from the numbering for the length of the read, so every number after it
    // comes back one short and the move lands on the wrong tab.
    const bIdx = await ctx.tabNumberOf("/hello");
    assert(bIdx >= 1, ";W m target has a strip position: " + bIdx);
    await ctx.leaderSeq(ctx.tabA, ["W", "m"]); // ;W m -> move tab into split
    for (const d of String(bIdx)) {
      await ctx.press(ctx.tabA, d); // the digits pick tab B
    }
    const pair = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 && sv.some((t) => (t.url || "").includes("/hello")) ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error(";W m N did not move tab into split; bIdx=" + bIdx + " chromeNumbering=" + JSON.stringify(st && st.lastMoveDebug) + " extNumbering=" + JSON.stringify(await ctx.tabNumbers().catch(() => "ERR")) + " chromeStrip=" + JSON.stringify(st && st.strip) + " tabs=" + JSON.stringify(ts));
    });
    assert(pair && pair.length === 2, "split pair is two real tabs: " + JSON.stringify(pair.map((t) => ({ u: t.url, s: t.splitViewId }))));
    const noPanel = await ctx.tabsInfo();
    assert(
      !noPanel.some((t) => (t.url || "").includes("splitpanel.html")),
      "no split-panel pane left in the split: " + JSON.stringify(noPanel.map((t) => t.url))
    );
    // Save the session. The command center is a chrome page, so the save
    // popup mounts at window level (not in the page DOM the test can drive);
    // save directly through the background instead.
    const saveRes = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "splitws" } })`);
    assert(saveRes && saveRes.ok, "saveSession message ok: " + JSON.stringify(saveRes));
    const saved = await waitStore(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.splitws && r.lfSessions.splitws.tabs && r.lfSessions.splitws.tabs.length)`)
      .then(() => storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions.splitws)`))
      .catch(() => { throw new Error("splitws session was not saved"); });
    const svSaved = (saved.tabs || []).filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    assert(svSaved.length === 2, "saved session captured the split pair: " + JSON.stringify(saved.tabs.map((t) => ({ u: t.url, s: t.splitViewId }))));
    // Build a flat "away" session (unsplit first) to switch to: the window's
    // tabs get replaced by restore, so the split must vanish.
    await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u -> dissolve the split
    // Wait until the split actually dissolved instead of sleeping.
    await waitFor(async () => ((await splitTabsOf()).length === 0 ? true : null), 10000)
      .catch(async () => {
        throw new Error(";W u left a split: " + JSON.stringify((await ctx.tabsInfo()).map((t) => t.url)));
      });
    const awayRes = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfaway" } })`);
    assert(awayRes && awayRes.ok, "away session saved: " + JSON.stringify(awayRes));
    const away = await waitStore(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfaway && r.lfSessions.lfaway.tabs && r.lfSessions.lfaway.tabs.length)`)
      .then(() => storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions.lfaway)`))
      .catch(() => { throw new Error("lfaway session was not saved"); });
    assert(away.tabs.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "away session has no split: " + JSON.stringify(away.tabs.map((t) => t.splitViewId)));
    // Switch away by restoring lfaway; the window's tabs are replaced. Send
    // fire-and-forget: awaiting the reply would race the tab teardown. Wait
    // for the current-session pointer instead of a fixed sleep.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfaway" } }); true`);
    await ctx.waitCurrentSession("lfaway");
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const flat = await ctx.tabsInfo();
    assert(flat.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "switched-away window has no split: " + JSON.stringify(flat.map((t) => t.url)));
    // Switch back to splitws; restore must re-pair the panes from the saved
    // splitViewIds.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "splitws" } }); true`);
    await ctx.waitCurrentSession("splitws");
    const restored = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 15000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      const cur = await evalIn(ctx.probe, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`).catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("restore did not re-pair; cur=" + cur + " splits=" + JSON.stringify(saved.splits) + " savedTabs=" + JSON.stringify((saved.tabs || []).map((t) => t.url.slice(-12))) + " strip=" + JSON.stringify(st && st.strip) + " tabs=" + JSON.stringify(ts));
    });
    assert(restored && restored.length === 2, "restore re-paired the split panes: " + JSON.stringify(restored.map((t) => ({ u: t.url, s: t.splitViewId }))));
    assert(new Set(restored.map((t) => t.splitViewId)).size === 1, "restored panes share one splitViewId");
    // Clean up: dissolve EVERY remaining split view (the ;\ unsplit only
    // handles the active one, and later suites assume a flat window). Closing
    // any pane of a native split auto-unsplits its partner.
    const rem = await ctx.tabsInfo();
    const splitTabs = rem.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    for (const p of splitTabs) {
      await evalIn(ctx.probe, `browser.tabs.remove(${p.id})`).catch(() => {});
    }
    await waitFor(async () => ((await splitTabsOf()).length === 0 ? true : null), 10000);
    const post = await ctx.tabsInfo();
    assert(post.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "cleanup left a split: " + JSON.stringify(post.map((t) => ({ u: t.url, s: t.splitViewId }))));
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Drop the splitws session so the suite is repeatable.
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.splitws; delete r.lfSessions.lfaway; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
  });
  await t("sessions: Tab + c copies a tab into another session", async () => {
    // Seed two sessions directly in storage so the test owns the exact tab
    // lists (no dependency on the window's current tabs). The sessions popup
    // then drives the whole flow: Tab into the tabs pane, c -> target picker,
    // type the destination name, Enter confirms — and the popup stays open.
    const srcUrl = `${ctx.base}/lf-src-a`;
    const dstUrl = `${ctx.base}/lf-dst-x`;
    await evalIn(
      ctx.probe,
      `browser.storage.local.get("lfSessions").then(r => {
        const all = r.lfSessions || {};
        all.lfSrc = { name: "lfSrc", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
          tabs: [{ url: ${JSON.stringify(srcUrl)}, title: "lf-src-a", pinned: false }], splits: "" };
        all.lfDst = { name: "lfDst", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
          tabs: [{ url: ${JSON.stringify(dstUrl)}, title: "lf-dst-x", pinned: false }], splits: "" };
        return browser.storage.local.set({ lfSessions: all });
      }).then(() => true)`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await watchPopupEvents(ctx.tabA);
    await openSessionsPopup(ctx.tabA);
    // Filter to lfSrc so the highlight is deterministic, then Tab into the
    // tabs pane (the highlighted session's tabs).
    await ctx.typeIn(ctx.tabA, "lfSrc");
    await ctx.waitListEvent(ctx.tabA, { q: "lfSrc", count: 1, idx: 0 }, 10000);
    await ctx.press(ctx.tabA, "Tab");
    await ctx.waitListEvent(ctx.tabA, { count: 1 }, 8000, "tabs");
    await ctx.press(ctx.tabA, "c");
    await ctx.typeIn(ctx.tabA, "lfDst");
    await ctx.waitListEvent(ctx.tabA, { q: "lfDst", count: 1 }, 10000);
    await ctx.press(ctx.tabA, "Enter");
    const all = await waitStore(`browser.storage.local.get("lfSessions").then(r => { const s = r.lfSessions || {}; return s.lfDst && s.lfDst.tabs && s.lfDst.tabs.length === 2; })`)
      .then(() => storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`))
      .catch(() => { throw new Error("copy did not add a tab to lfDst"); });
    assert(all.lfDst.tabs.some((t) => t.url === srcUrl), "lfDst contains the copied tab: " + JSON.stringify(all.lfDst.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.some((t) => t.url === dstUrl), "lfDst kept its original tab");
    assert(all.lfSrc.tabs.length === 1, "copy left the source session intact: " + JSON.stringify(all.lfSrc.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.every((t) => typeof t.splitViewId !== "number" || t.splitViewId < 0), "copied tab carries no split pairing");
    // The popup stays open after a copy; Escape first leaves the tabs pane,
    // a second Esc closes (Tab leaks would have moved focus out of the popup).
    assert(await ctx.hasHost(ctx.tabA, "lazyfox-popup"), "popup stays open after a copy");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 5000);
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.lfSrc; delete r.lfSessions.lfDst; return browser.storage.local.set({ lfSessions: r.lfSessions }); }); true`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("sessions: Tab + m moves a tab into another session", async () => {
    const srcA = `${ctx.base}/lf-mv-a`;
    const srcB = `${ctx.base}/lf-mv-b`;
    const dstX = `${ctx.base}/lf-mv-x`;
    await evalIn(
      ctx.probe,
      `browser.storage.local.get("lfSessions").then(r => {
        const all = r.lfSessions || {};
        all.lfSrc = { name: "lfSrc", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
          tabs: [
            { url: ${JSON.stringify(srcA)}, title: "lf-mv-a", pinned: false },
            { url: ${JSON.stringify(srcB)}, title: "lf-mv-b", pinned: false }
          ], splits: "" };
        all.lfDst = { name: "lfDst", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
          tabs: [{ url: ${JSON.stringify(dstX)}, title: "lf-mv-x", pinned: false }], splits: "" };
        return browser.storage.local.set({ lfSessions: all });
      }).then(() => true)`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await watchPopupEvents(ctx.tabA);
    await openSessionsPopup(ctx.tabA);
    await ctx.typeIn(ctx.tabA, "lfSrc");
    await ctx.waitListEvent(ctx.tabA, { q: "lfSrc", count: 1, idx: 0 }, 10000);
    await ctx.press(ctx.tabA, "Tab");
    await ctx.waitListEvent(ctx.tabA, { count: 2 }, 8000, "tabs");
    await ctx.press(ctx.tabA, "j"); // select the second tab
    await ctx.waitListEvent(ctx.tabA, { idx: 1 }, 3000, "tabs");
    await ctx.press(ctx.tabA, "m");
    await ctx.typeIn(ctx.tabA, "lfDst");
    await ctx.waitListEvent(ctx.tabA, { q: "lfDst", count: 1 }, 10000);
    await ctx.press(ctx.tabA, "Enter");
    const all = await waitStore(`browser.storage.local.get("lfSessions").then(r => { const s = r.lfSessions || {}; const src = s.lfSrc; const dst = s.lfDst; return src && dst && src.tabs && dst.tabs && src.tabs.length === 1 && dst.tabs.length === 2; })`)
      .then(() => storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`))
      .catch(() => { throw new Error("move did not transfer the tab"); });
    assert(all.lfSrc.tabs.length === 1 && all.lfSrc.tabs[0].url === srcA, "source kept the un-moved tab: " + JSON.stringify(all.lfSrc.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.length === 2 && all.lfDst.tabs.some((t) => t.url === srcB), "destination gained the moved tab: " + JSON.stringify(all.lfDst.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.some((t) => t.url === dstX), "destination kept its original tab");
    assert(all.lfDst.tabs.every((t) => typeof t.splitViewId !== "number" || t.splitViewId < 0), "moved tab carries no split pairing");
    assert(await ctx.hasHost(ctx.tabA, "lazyfox-popup"), "popup stays open after a move");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 5000);
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.lfSrc; delete r.lfSessions.lfDst; return browser.storage.local.set({ lfSessions: r.lfSessions }); }); true`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("sessions: Esc cancels the copy target picker without closing the popup", async () => {
    await evalIn(
      ctx.probe,
      `browser.storage.local.get("lfSessions").then(r => {
        const all = r.lfSessions || {};
        all.lfTmp = { name: "lfTmp", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
          tabs: [{ url: ${JSON.stringify(`${ctx.base}/lf-tmp`)}, title: "lf-tmp", pinned: false }], splits: "" };
        return browser.storage.local.set({ lfSessions: all });
      }).then(() => true)`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await watchPopupEvents(ctx.tabA);
    await openSessionsPopup(ctx.tabA);
    await ctx.typeIn(ctx.tabA, "lfTmp");
    await ctx.waitListEvent(ctx.tabA, { q: "lfTmp", count: 1 }, 10000);
    await ctx.press(ctx.tabA, "Tab");
    await ctx.waitListEvent(ctx.tabA, { count: 1 }, 8000, "tabs");
    await ctx.press(ctx.tabA, "c"); // enter the target picker
    // Esc cancels the picker and returns to the tabs pane — the popup must
    // stay open (Esc is normally the popup's close key, so this pins the
    // "the popup may consume Esc" override on both the content and chrome
    // sides). A second Esc leaves the tabs pane, a third closes.
    await ctx.press(ctx.tabA, "Escape");
    assert(await ctx.hasHost(ctx.tabA, "lazyfox-popup"), "popup still open after canceling the picker");
    await ctx.press(ctx.tabA, "Escape");
    assert(await ctx.hasHost(ctx.tabA, "lazyfox-popup"), "popup still open after leaving the tabs pane");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 5000);
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.lfTmp; return browser.storage.local.set({ lfSessions: r.lfSessions }); }); true`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("sessions: chrome popup — Tab toggles the tabs pane, Esc steps back (no leak)", async () => {
    // On the command center the popup mounts at chrome-window level, where a
    // leaked Tab (returned false from onKey, so not preventDefaulted) moves
    // focus into the browser chrome and the popup silently stops receiving
    // keys. The chrome input listener now captures Tab for every popup, and
    // the window's capture listener lets the popup consume Esc first.
    await ctx.openCC(ctx.tabA);
    await ctx.chromeLeaderPress(ctx.tabA, "p");
    const opened = await waitFor(async () => {
      const s = await ctx.chromeState();
      const p = s && s.popup;
      return p && p.current && p.panels && p.panels.length && (p.panels[0].title || "").indexOf("Sessions") !== -1 ? s : null;
    }, 8000).catch(() => null);
    assert(opened, "sessions popup opened on the command center: " + JSON.stringify(opened && opened.popup));
    // Tab moves into the tabs pane; the popup must stay open and show the
    // tabs-pane hint (a leaked Tab would have moved focus out of the popup).
    await ctx.sendKeys(ctx.tabA, [{ k: "Tab" }]);
    const afterTab = await waitFor(async () => {
      const s = await ctx.chromeState();
      const p = s && s.popup;
      return p && p.current && p.panels && p.panels[0] && p.panels[0].status && p.panels[0].status.indexOf("j/k select") !== -1 ? s : null;
    }, 5000).catch(() => null);
    assert(afterTab, "Tab toggled into the tabs pane, popup stayed open: " + JSON.stringify(afterTab && afterTab.popup && afterTab.popup.panels));
    // Esc in the tabs pane returns to the left list (the popup consumes it
    // through handleKey instead of closing).
    await ctx.sendKeys(ctx.tabA, [{ k: "Escape" }]);
    const afterEsc = await waitFor(async () => {
      const s = await ctx.chromeState();
      const p = s && s.popup;
      return p && p.current && p.panels && p.panels[0] && p.panels[0].status === "" ? s : null;
    }, 5000).catch(() => null);
    assert(afterEsc, "Esc left the tabs pane without closing the popup: " + JSON.stringify(afterEsc && afterEsc.popup && afterEsc.popup.panels));
    // A final Esc (left pane active) closes the popup normally.
    await ctx.sendKeys(ctx.tabA, [{ k: "Escape" }]);
    const closed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.current === false ? s : null;
    }, 5000).catch(() => null);
    assert(closed, "Esc on the left pane closed the popup");
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("sessions: moving the last tab out of the current session sticks (autosave can't resurrect it)", async () => {
    // The current session's stored tabs track the live window (the autosave
    // re-snapshots it on every tab change), so a manual move out of it used to
    // be silently undone moments later when the autosave put the tab back.
    // The move now closes the tab in the live window too, so the autosave
    // converges on the edit instead of fighting it.
    const srcUrl = `${ctx.base}/lf-cur-src`;
    const dstUrl = `${ctx.base}/lf-cur-dst`;
    const extra = await createTab();
    await navigate(extra, srcUrl, "complete");
    // Saving snapshots the window and makes the new session current.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfCur" } }); true`);
    await waitStore(`browser.storage.local.get("lfSessions").then(r => { const s = r.lfSessions && r.lfSessions.lfCur; return s && s.tabs && s.tabs.some(t => t.url === ${JSON.stringify(srcUrl)}); })`);
    const idx = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => (r.lfSessions.lfCur.tabs || []).findIndex(t => t.url === ${JSON.stringify(srcUrl)}))`);
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => {
      const all = r.lfSessions || {};
      all.lfDst = { name: "lfDst", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
        tabs: [{ url: ${JSON.stringify(dstUrl)}, title: "lf-cur-dst", pinned: false }], splits: "" };
      return browser.storage.local.set({ lfSessions: all });
    }).then(() => true)`);
    // Await the reply: the move's live side effect closes the moved tab (not
    // the sender, so awaiting is safe) and we want its result for a clean
    // failure message.
    const mvRes = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionTabMove", data: { from: "lfCur", index: ${idx}, to: "lfDst" } }).then(r => r)`);
    assert(mvRes && mvRes.ok === true, "move returned ok: " + JSON.stringify(mvRes) + " idx=" + idx);
    // The old bug only surfaced once the debounced autosave re-snapshotted the
    // current session — wait for that convergence (dst gained, cur lost the
    // tab, live window closed it) instead of a fixed sleep.
    const all = await waitStore(`browser.storage.local.get("lfSessions").then(r => { const a = r.lfSessions || {}; return a.lfDst && a.lfDst.tabs.some(t => t.url === ${JSON.stringify(srcUrl)}) && a.lfCur && !a.lfCur.tabs.some(t => t.url === ${JSON.stringify(srcUrl)}); })`, 15000)
      .then(() => storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`))
      .catch(() => storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`));
    assert(all.lfDst && all.lfDst.tabs.some((t) => t.url === srcUrl), "destination gained the moved tab: " + JSON.stringify(all.lfDst && all.lfDst.tabs && all.lfDst.tabs.map((t) => t.url)));
    assert(all.lfCur && !all.lfCur.tabs.some((t) => t.url === srcUrl), "current session did not resurrect the moved tab: " + JSON.stringify(all.lfCur && all.lfCur.tabs && all.lfCur.tabs.map((t) => t.url)));
    await ctx.waitTabUrl("/lf-cur-src", { gone: true, timeoutMs: 10000 });
    const live = await ctx.tabsInfo();
    assert(!live.some((t) => (t.url || "").includes("/lf-cur-src")), "moved tab was closed in the live window: " + JSON.stringify(live.map((t) => t.url)));
    // Cleanup: drop the throwaway sessions and restore the established current.
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { const a = r.lfSessions || {}; delete a.lfCur; delete a.lfDst; return browser.storage.local.set({ lfSessions: a }); }).then(() => browser.storage.local.set({ lfCurrentSession: "work" })); true`);
    await closeContext(extra).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("sessions: moving a tab into the current session opens it live (autosave can't drop it)", async () => {
    // The move's target is the current session, whose stored tabs are the live
    // window. The autosave used to overwrite the target with the window (which
    // lacked the tab), so the tab vanished from BOTH sessions. The move now
    // opens the tab in the live window, so the autosave keeps it.
    const srcUrl = `${ctx.base}/lf-into-src`;
    const curUrl = `${ctx.base}/lf-into-cur`;
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => {
      const all = r.lfSessions || {};
      all.lfSrc = { name: "lfSrc", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
        tabs: [{ url: ${JSON.stringify(srcUrl)}, title: "lf-into-src", pinned: false }], splits: "" };
      all.lfCur = { name: "lfCur", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
        tabs: [{ url: ${JSON.stringify(curUrl)}, title: "lf-into-cur", pinned: false }], splits: "" };
      return browser.storage.local.set({ lfSessions: all, lfCurrentSession: "lfCur" });
    }).then(() => true)`);
    // The await above matters: the seed must be COMMITTED before the move
    // fires, or the move answers "no source session" (a race, not a product
    // bug — the trailing `; true` form does not await the storage write).
    const mvRes = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionTabMove", data: { from: "lfSrc", index: 0, to: "lfCur" } }).then(r => r)`);
    assert(mvRes && mvRes.ok === true, "move returned ok: " + JSON.stringify(mvRes));
    // Wait for the convergence (current session kept the tab AND the live
    // window opened it) instead of a fixed sleep.
    await waitStore(`browser.storage.local.get("lfSessions").then(r => { const a = r.lfSessions || {}; return a.lfCur && a.lfCur.tabs.some(t => t.url === ${JSON.stringify(srcUrl)}) && a.lfSrc && !a.lfSrc.tabs.some(t => t.url === ${JSON.stringify(srcUrl)}); })`, 15000);
    await ctx.waitTabUrl("/lf-into-src", { timeoutMs: 10000 });
    const all = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    const live = await ctx.tabsInfo();
    assert(all.lfCur && all.lfCur.tabs.some((t) => t.url === srcUrl), "current session kept the moved-in tab: lfSrc=" + JSON.stringify(all.lfSrc && all.lfSrc.tabs && all.lfSrc.tabs.map((t) => t.url)) + " live=" + JSON.stringify(live.map((t) => t.url)) + " lfCur=" + JSON.stringify(all.lfCur && all.lfCur.tabs && all.lfCur.tabs.map((t) => t.url)));
    assert(all.lfSrc && !all.lfSrc.tabs.some((t) => t.url === srcUrl), "source no longer has the moved tab");
    assert(live.some((t) => (t.url || "").includes("/lf-into-src")), "moved-in tab was opened in the live window: " + JSON.stringify(live.map((t) => t.url)));
    // Cleanup.
    const movedTab = live.find((t) => (t.url || "").includes("/lf-into-src"));
    if (movedTab) await evalIn(ctx.probe, `browser.tabs.remove(${movedTab.id}).catch(() => true)`).catch(() => {});
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { const a = r.lfSessions || {}; delete a.lfSrc; delete a.lfCur; return browser.storage.local.set({ lfSessions: a }); }).then(() => browser.storage.local.set({ lfCurrentSession: "work" })); true`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
}
