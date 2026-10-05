// restore tests (sessions). Deterministic: every wait targets a product
// signal (tab strip contents, storage writes, window URLs) instead of fixed
// sleeps.
import { activate, closeContext, createTab, evalIn, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "sessions/restore";
  // Tags: `--tags newfeatures` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["newfeatures","sessions","destructive"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  // Poll storage through the probe's extension realm.
  const waitStore = (expr, ms = 8000) => ctx.waitExpr(ctx.probe, expr, true, ms);
  const storeGet = (expr) => evalIn(ctx.probe, expr);
  // Wait for a tab id to disappear from the strip (closed).
  const tabGone = async (id, ms = 8000) =>
    waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.every((t) => t.id !== id) ? true : null;
    }, ms);

  await t("restore brings back every tab's exact strip position (split included)", async () => {
    // Regression: switching sessions must not renumber tabs. Firefox's own
    // split machinery parks a re-formed pair at the strip END, so before the
    // fix a session with a mid-strip split came back with the pair at the
    // tail — ;1-9 pointed at different tabs than when the session was saved.
    // Start from a window this test controls. The subject is whether a
    // mid-strip split pair SURVIVES a session round-trip, but the move that
    // forms the pair is driven by a tab NUMBER, and a number is only meaningful
    // against a known strip. In a full run the window arrives holding a dozen
    // tabs from earlier tests, and the digits the test read resolved against a
    // strip that had since changed — so the pair never formed and the failure
    // landed on the restore, which is the one thing under test here.
    //
    // BEFORE openCC: the collapse closes everything it did not keep, and
    // ctx.tabA is one of the tabs it is clearing. So tabA is re-made after it,
    // not merely re-pointed at.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await ctx.openCC(ctx.tabA);
    // Four distinctive tabs in a known order.
    const names = ["lfw1", "lfw2", "lfw3", "lfw4"];
    const tabs2 = [];
    for (const n of names) {
      const t = await createTab();
      await navigate(t, `${ctx.base}/${n}`, "complete");
      tabs2.push(t);
    }
    // Wait until all four are in the strip instead of sleeping.
    for (const n of names) await ctx.waitTabUrl(`/${n}`, { timeoutMs: 10000 });
    const ids = await ctx.tabsInfo();
    const w1Row = ids.find((t) => (t.url || "").includes("/lfw1"));
    const w2Row = ids.find((t) => (t.url || "").includes("/lfw2"));
    const w3Row = ids.find((t) => (t.url || "").includes("/lfw3"));
    const w4Row = ids.find((t) => (t.url || "").includes("/lfw4"));
    assert(w1Row && w2Row && w3Row && w4Row, "found all four fresh tabs: " + JSON.stringify(ids.map((t) => t.url)));
    // The ordering check compares the four WEB tabs' relative strip slots:
    // commandcenter tabs (the probe, the home tab) and the persistent relay
    // tab (relay.html — invisible plumbing whose slot shifts when restore
    // recreates it) are both excluded, exactly like the baseline test did for
    // commandcenter alone.
    const realIds = ids.filter((t) => {
      const u = t.url || "";
      return !u.includes("commandcenter.html") && !u.includes("relay.html");
    });
    // Match by URL, not id: restore RECREATES tabs, so ids change across the
    // session switch — the strip order itself is what must be preserved.
    const namesOf = (rows) =>
      rows
        .map((t) => {
          const u = t.url || "";
          if (u.includes("/lfw1")) return "w1";
          if (u.includes("/lfw2")) return "w2";
          if (u.includes("/lfw3")) return "w3";
          if (u.includes("/lfw4")) return "w4";
          return "?";
        })
        .join(",");
    const beforeOrder = namesOf(realIds);
    // Split the SECOND tab (w2) with the third (w3) — a mid-strip pair. The
    // ;+N digit is a position over the chrome's realTabs() (skips only
    // splitpanel/#lfc transients; commandcenter tabs COUNT), so resolve w3's
    // index over that same list.
    // The position must come from the product's OWN numbering, read at the
    // moment of the press — and read through a channel that does not change
    // it. Both halves matter, and the second one is not obvious: a state reply
    // rides the probe tab's `#lfc=state` hash, which makes the probe transient
    // for the duration of the read, so the numbering that reply reports is
    // missing a tab standing plainly in the strip. Every number after it is
    // one short, and the move lands on the tab before the intended one.
    // ctx.tabNumberOf reads the same list the tab popup numbers and the same
    // one the digit resolves against, without touching the strip.
    //
    // "At the moment of the press" also has to mean a strip that has STOPPED
    // changing. A real user never hits that race because the status bar shows
    // the numbering LIVE beside their hand, so the honest primitive is "wait
    // until it is quiescent", not "read it and hope".
    const w3PosNow = async () => {
      let last = "";
      return waitFor(async () => {
        const rows = await ctx.tabNumbers();
        const sig = rows.map((r) => r.n + ":" + r.url).join("|");
        if (sig && sig === last) {
          const hit = rows.find((r) => r.url.indexOf("/lfw3") !== -1);
          return hit ? hit.n : null;
        }
        last = sig;
        return null;
      }, 10000).catch(async () => {
        throw new Error("tab numbering never settled: " + JSON.stringify(await ctx.tabNumbers()));
      });
    };
    await evalIn(ctx.probe, `browser.tabs.update(${w2Row.id}, { active: true })`).catch(() => {});
    // Create the split explicitly first. This test used to jump straight to
    // the move, which only worked because an EARLIER test had left a live
    // split view behind for `;W m` to attach to — so the test only passed when
    // it ran after that one, and its own subject (a mid-strip pair surviving a
    // restore) was never actually exercised in isolation. `;W |` is also the
    // real user flow: pair the current tab, then move the partner in.
    await ctx.leaderSeq(tabs2[1], ["W", "|"]); // ;W | -> split side-by-side
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0).length === 2
        ? true
        : null;
    }, 10000).catch(async () => {
      throw new Error(";W | did not form the initial split: " + JSON.stringify((await ctx.tabsInfo()).map((t) => (t.url || "").slice(-10))));
    });
    // The pair we ASKED FOR — not merely "any two split tabs". The `;W |` step
    // already forms a pair (the active tab plus the companion panel), so a
    // "two tabs have a splitViewId" wait passes immediately and the save then
    // captures the window mid-move, with the panel still in place and the real
    // partner not yet swapped in. The stored session came back with no split
    // at all, which read as a restore bug.
    const wantedPair = async (ms: number) =>
      waitFor(async () => {
        const ts = await ctx.tabsInfo();
        const sv2 = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
        const urls = sv2.map((t) => t.url || "");
        const hasW2 = urls.some((u) => u.indexOf("/lfw2") !== -1);
        const hasW3 = urls.some((u) => u.indexOf("/lfw3") !== -1);
        // The panel must be gone: it is pure UI and is replaced by the real
        // partner, never saved as a session tab.
        const noPanel = !urls.some((u) => u.indexOf("splitpanel.html") !== -1);
        return sv2.length === 2 && hasW2 && hasW3 && noPanel ? sv2 : null;
      }, ms);

    // `;W m` on the w2 WEB page keeps w2 selected (leaderSeq only focuses).
    // The target is typed as its full number, so a position past nine works
    // exactly like a single digit — which is the point of routing the split
    // move through the same planner `;1` uses.
    //
    // Retried, and only when NOTHING happened. A chord that never reached the
    // move leaves no trace at all in the chrome's move trail, and a user
    // simply presses it again; retrying is also the only honest response,
    // because a trace-less failure says nothing about which part drifted.
    // A chord that DID run but moved the wrong tab stops the loop: repeating
    // it would compound a real defect instead of hiding it.
    let w3ChromeIdx = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      w3ChromeIdx = await w3PosNow();
      assert(w3ChromeIdx >= 1, "w3 has a strip position: " + w3ChromeIdx);
      const before = String((await ctx.chromeState().catch(() => "ERR"))?.lastMoveDebug || "");
      await ctx.leaderSeq(tabs2[1], ["W", "m"]); // ;W m -> move tab into split
      for (const d of String(w3ChromeIdx)) {
        await ctx.press(tabs2[1], d); // digits -> pair (w2, w3)
      }
      const paired = await wantedPair(attempt === 3 ? 10000 : 3000).then(() => true).catch(() => false);
      if (paired) break;
      const after = String((await ctx.chromeState().catch(() => "ERR"))?.lastMoveDebug || "");
      if (after !== before) break; // a move ran; retrying would compound it
      if (attempt === 3) break;
    }
    await wantedPair(2000).catch(async () => {
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error(
        "split pair not formed; w3Idx=" + w3ChromeIdx +
        " lastAction=" + JSON.stringify(st && st.lastAction) +
        " leaderPending=" + JSON.stringify(st && st.leaderPending) +
        " moveLog=" + JSON.stringify(st && st.lastMoveDebug) +
        " strip=" + JSON.stringify(st && st.strip) +
        " tabs=" + JSON.stringify((await ctx.tabsInfo()).map((t) => ({ u: (t.url || "").slice(-10), s: t.splitViewId })))
      );
    });
    // Save this layout, then switch away and back — each save waits for its
    // storage write to land.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lforder" } }); true`);
    await waitStore(`browser.storage.local.get("lfSessions").then(r => { const s = r.lfSessions && r.lfSessions.lforder; return s && s.tabs && s.tabs.some(t => (t.url||"").indexOf("/lfw1") !== -1); })`);
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfaway2" } }); true`);
    await waitStore(`browser.storage.local.get("lfSessions").then(r => !!r.lfSessions && !!r.lfSessions.lfaway2)`);
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfaway2" } }); true`);
    await ctx.waitCurrentSession("lfaway2");
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lforder" } }); true`);
    await ctx.waitCurrentSession("lforder");
    // The strip settles a moment after restore re-forms the split, so wait
    // for the pinned layout instead of asserting the first snapshot. Restore
    // RECREATES tabs (new ids), so re-resolve w2/w3 by URL — never by the
    // pre-restore ids.
    const iw2Saved = realIds.findIndex((t) => t.id === w2Row.id);
    const restored = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const realAfter2 = ts.filter((t) => {
        const u = t.url || "";
        return !u.includes("commandcenter.html") && !u.includes("relay.html");
      });
      if (namesOf(realAfter2) !== beforeOrder) return null;
      const sv2 = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      if (sv2.length !== 2) return null;
      const w2r = realAfter2.find((t) => (t.url || "").includes("/lfw2"));
      const w3r = realAfter2.find((t) => (t.url || "").includes("/lfw3"));
      if (!w2r || !w3r) return null;
      const a2 = realAfter2.indexOf(w2r);
      const b2 = realAfter2.indexOf(w3r);
      if (a2 !== iw2Saved || Math.abs(b2 - a2) !== 1) return null;
      return ts;
    }, 15000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      const sv: any = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lforder)`).catch(() => null);
      throw new Error("restore order never settled; want=" + beforeOrder + " w2SavedIdx=" + iw2Saved + " splits=" + JSON.stringify(sv && sv.splits) + " savedTabs=" + JSON.stringify(((sv && sv.tabs) || []).map((x) => ({ u: (x.url || "").slice(-10), s: x.splitViewId }))) + " realAfter=" + JSON.stringify(Array.isArray(ts) ? ts.filter((t) => { const u = t.url || ""; return !u.includes("commandcenter.html") && !u.includes("relay.html"); }).map((t) => ({ u: (t.url||"").slice(-10), s: t.splitViewId })) : ts) + " realTabs=" + JSON.stringify(st && st.realTabs));
    });
    assert(restored != null, "restore kept every tab's strip slot (want " + beforeOrder + " with w2@" + iw2Saved + "): " + JSON.stringify((await ctx.tabsInfo()).map((t) => ({ u: t.url, s: t.splitViewId }))));
    const svTabs = restored.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    // Clean up: dissolve the split and drop the throwaway sessions.
    for (const p of svTabs) {
      await evalIn(ctx.probe, `browser.tabs.remove(${p.id}).catch(() => {})`);
      await tabGone(p.id);
    }
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.lforder; delete r.lfSessions.lfaway2; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("tabs opened after saving are persisted into the session", async () => {
    // Regression: tabs opened AFTER a session was saved never reached that
    // session's stored tab list (only the crash-recovery "last" slot), so the
    // pill count stayed stale and the tabs vanished on quit. Every tab change
    // must now re-persist the CURRENT named session.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lftrack" } }); true`);
    await waitStore(`browser.storage.local.get("lfSessions").then(r => { const s = r.lfSessions && r.lfSessions.lftrack; return s && Array.isArray(s.tabs) && s.tabs.length >= 1; })`);
    const saved = await storeGet(`browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lftrack)`);
    const baseline = (saved && saved.tabs && saved.tabs.length) || 0;
    // Open a NEW tab in the same window (like opening youtube/google after
    // creating the session).
    const extra = await createTab();
    await navigate(extra, `${ctx.base}/world`, "complete");
    await activate(extra).catch(() => {});
    // The debounced autosave must fold the new tab into the named session.
    const tracked = await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lftrack)`);
      return r && r.tabs && r.tabs.length > baseline && r.tabs.some((t) => (t.url || "").indexOf("/world") !== -1) ? r : null;
    }, 10000).catch(() => null);
    assert(tracked, "new tab was persisted into the session: " + JSON.stringify(tracked && tracked.tabs.map((t) => t.url)));
    // Clean up: close the extra tab, delete the throwaway session, restore
    // focus to the main tab.
    await closeContext(extra).catch(() => {});
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionDelete", data: { name: "lftrack" } }); true`);
    await activate(ctx.tabA).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("restore replaces a partially-restored window (no blank first tab)", async () => {
    // Regression: Firefox's OWN session restore can't bring back a tab that
    // was navigated from the command center, leaving a blank tab where it
    // used to be. Our restore must REBUILD the window from the saved snapshot
    // (replacing whatever Firefox natively restored), not skip because some
    // tabs are already non-blank.
    // Start from a CLEAN window so the session this test saves contains only
    // the tabs it creates. Saving first and opening the pages afterwards (the
    // old order) captured whatever the previous test happened to leave on the
    // strip, so the restore assertion was really asserting about its
    // neighbours' leftovers.
    await ctx.openCC(ctx.tabA);
    const strayIds = await evalIn(
      ctx.probe,
      `browser.tabs.query({currentWindow:true}).then(ts => ts.filter(t => (t.url||"").indexOf("commandcenter.html") === -1 && (t.url||"").indexOf("relay.html") === -1 && (t.url||"").indexOf("/partial") === -1).map(t => t.id))`
    );
    for (const id of strayIds) {
      await evalIn(ctx.probe, `browser.tabs.remove(${id}).catch(() => true)`).catch(() => {});
      await tabGone(id);
    }
    ctx.tabA = await createTab();
    // "open a site from the home screen" — the CC tab becomes the first tab.
    await navigate(ctx.tabA, `${ctx.base}/partial-hello`, "complete");
    await activate(ctx.tabA).catch(() => {});
    await ctx.waitTabUrl("/partial-hello", { timeoutMs: 10000 });
    // One more tab via ;o (background openUrl).
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "openUrl", data: { url: ${JSON.stringify(`${ctx.base}/partial-world`)}, newTab: true } }); true`);
    await ctx.waitTabUrl("/partial-world", { timeoutMs: 10000 });
    // Now — and only now — the session reflects this test's own two pages.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfpartial" } }); true`);
    await waitStore(`browser.storage.local.get("lfSessions").then(r => { const s = r.lfSessions && r.lfSessions.lfpartial; return s && s.tabs && s.tabs.some(t => (t.url||"").indexOf("/partial-hello") !== -1) && s.tabs.some(t => (t.url||"").indexOf("/partial-world") !== -1); })`, 15000);
    // Simulate Firefox's imperfect native restore: a blank first tab plus the
    // surviving tab (the probe's command-center tab stays out of the way).
    const ids = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.filter(t => (t.url||"").indexOf("commandcenter.html") === -1).map(t => t.id))`);
    for (const id of ids) {
      await evalIn(ctx.probe, `browser.tabs.remove(${id}).catch(() => true)`).catch(() => {});
      await tabGone(id);
    }
    // A blank first tab, then a real page: restoring must REPLACE the blank,
    // not stack the session's tabs behind it.
    await evalIn(ctx.probe, `browser.tabs.create({ url: "about:blank", active: true }).then(t => t.id)`);
    await evalIn(ctx.probe, `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/partial-world`)}, active: false }).then(t => t.id)`);
    // Wait for the shape this test SET UP — a blank tab and a /partial-world
    // tab — not an exact tab count. The exact number depends on how many
    // command-center/relay tabs earlier tests left behind, so pinning it made
    // the test fail on the state of its neighbours rather than its own
    // precondition.
    await waitFor(async () => {
      const urls = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => t.url))`).catch(() => null);
      if (!urls) return null;
      const blank = urls.filter((u) => String(u).indexOf("about:blank") !== -1).length;
      const world = urls.filter((u) => String(u).indexOf("/partial-world") !== -1).length;
      return blank === 1 && world === 1 ? urls : null;
    }, 10000);
    // Restore — the blank first tab must be replaced by the session's first page.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfpartial" } }); true`);
    await ctx.waitCurrentSession("lfpartial");
    const urlsOk = await waitFor(async () => {
      const urls = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => t.url))`);
      const hello = (urls || []).filter((u) => String(u).indexOf("/partial-hello") !== -1).length;
      const world = (urls || []).filter((u) => String(u).indexOf("/partial-world") !== -1).length;
      const blank = (urls || []).filter((u) => String(u).indexOf("about:blank") !== -1).length;
      return hello === 1 && world === 1 && blank === 0 ? urls : null;
    }, 15000).catch(async () => JSON.stringify(await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => t.url))`).catch(() => "ERR")));
    const urls = Array.isArray(urlsOk) ? urlsOk : JSON.parse(String(urlsOk));
    const hello = (urls || []).filter((u) => String(u).indexOf("/partial-hello") !== -1).length;
    const world = (urls || []).filter((u) => String(u).indexOf("/partial-world") !== -1).length;
    const blank = (urls || []).filter((u) => String(u).indexOf("about:blank") !== -1).length;
    assert(hello === 1, "first tab (/partial-hello) restored, got " + JSON.stringify(urls));
    assert(world === 1, "last tab (/partial-world) restored, got " + JSON.stringify(urls));
    assert(blank === 0, "no leftover blank tab, got " + JSON.stringify(urls));
    // Clean up: delete the throwaway session and restore a content tab.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionDelete", data: { name: "lfpartial" } }); true`);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA).catch(() => {});
  });
  await t("an active about:blank tab is never hijacked into the command center", async () => {
    // Regression: the background converted active about:blank tabs to the
    // command center after 500ms, racing in-flight navigations (a
    // target=_blank link, ;o, a search results tab). A Firefox update
    // changed when a new tab reports its pending URL, the conversion won the
    // race, and every link / ;s / ;o landed on the command-center home
    // instead of the target page — the "empty new tab" the user saw. The
    // command center for user-opened tabs comes from the newtab override, so
    // a genuinely blank tab must simply stay blank.
    const id = await evalIn(ctx.probe, `browser.tabs.create({ url: "about:blank", active: true }).then(t => t.id)`);
    assert(id, "active blank tab created");
    // Well past the old 500ms conversion window: wait the window out, then
    // assert the tab is still blank. The wait here IS the product signal —
    // any conversion to the command center would flip the URL while polling.
    await new Promise((r) => setTimeout(r, 2000));
    const u = await evalIn(ctx.probe, `browser.tabs.get(${id}).then(t => t.url).catch(() => "GONE")`);
    assert(String(u).indexOf("about:blank") !== -1, "blank tab was left alone, got " + u);
    await evalIn(ctx.probe, `browser.tabs.remove(${id}).catch(() => true)`);
    await activate(ctx.tabA).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
}
