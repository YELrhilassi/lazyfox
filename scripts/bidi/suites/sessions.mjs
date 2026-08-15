// Sessions (tmux-style) + shared status bar tests. Covers save/restore, marker
// assignment and quick-switch, the status bar rendering (web + chrome), and
// the no-op/safe dispatch paths.

import { evalIn, waitFor, sleep, createTab, navigate } from "../lib.mjs";
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
    // The bottom bar reserves real layout space (html padding-bottom) so it
    // never covers the page content behind it.
    const pb = await evalIn(ctx.tabA, `getComputedStyle(document.documentElement).paddingBottom`);
    assert(pb && parseFloat(pb) >= 18, "status bar reserves bottom space: " + pb);
  });

  await t("status bar reserves space on a body-scrolling page", async () => {
    // Pages that scroll via BODY (not html) used to hide their last rows
    // behind the fixed bar; the reservation must land on the scrolling
    // element, which is body here.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/bodyscroll`);
    await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v ? v : null;
    }, 8000);
    const info = await evalIn(ctx.tabA, `JSON.stringify({
      htmlPb: getComputedStyle(document.documentElement).paddingBottom,
      bodyPb: getComputedStyle(document.body).paddingBottom,
    })`);
    const d = JSON.parse(info);
    // Firefox reports documentElement as scrollingElement even when body is the
    // real scroll container, so assert the reservation landed on BODY (the
    // element that actually scrolls here) — html padding alone would leave the
    // page's last rows behind the fixed bar.
    assert(parseFloat(d.bodyPb) >= 18, "body padding reserved so content is not hidden: " + info);
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

  await t("sessions: x x on empty input deletes the highlighted session", async () => {
    // Regression: `x` used to fall through into the popup input (filtering the
    // list) instead of deleting the highlighted session, and a single x
    // deleted with no confirmation. Now the first x arms the delete and the
    // second confirms. Save a throwaway session, reopen the popup (empty
    // input), highlight it and delete it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "delme");
    await sleep(700);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.delme)`);
      return r ? r : null;
    }, 8000);
    // Reopen the popup: the input starts empty and sessions are sorted by
    // marker, so work(1) is first and delme(2) second.
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "ArrowDown");
    await sleep(300);
    // x is two-step: first press arms the delete, second confirms it.
    await ctx.press(ctx.tabA, "x");
    await ctx.press(ctx.tabA, "x");
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions)`);
      return r && !r.delme ? r : null;
    }, 8000);
    const all = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    assert(!all.delme, "delme session was deleted by x");
    // Every session that existed before the delete must be untouched — x must
    // have removed exactly the highlighted delme row, not some other session.
    for (const n of Object.keys(before)) {
      assert(all[n], `session "${n}" untouched by the delete`);
    }
    // saveSession set the current-session pointer to delme; point it back so
    // later tests see a consistent current session.
    await evalIn(ctx.probe, `browser.storage.local.set({ lfCurrentSession: "work" })`);
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("sessions: split layout is saved and restored with the session", async () => {
    // Collapse the window to just the probe (exact tab id via getCurrent), so
    // the split pair we create is the window's only pair (deterministic
    // assertions). Use a fresh probe for the trim so we never depend on a
    // possibly-stale harness context.
    const probe = await ctx.makeProbeTab();
    const probeId = await evalIn(probe, `browser.tabs.getCurrent().then(t => t ? t.id : null)`);
    await evalIn(probe, `(async () => {
      const ts = await browser.tabs.query({ currentWindow: true });
      for (const t of ts) {
        if (t.id !== ${probeId} && !t.pinned) { try { await browser.tabs.remove(t.id); } catch (e) {} }
      }
      return true;
    })()`);
    await sleep(500);
    ctx.probe = probe;
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.openCC(ctx.tabA);
    // A split of two REAL tabs (the user's flow): ;| pairs the active CC tab
    // with the split-panel companion, then ;+N moves a real content tab into
    // the split, REPLACING the panel (the panel is pure UI and must never be
    // saved as a session tab).
    const tabB = await createTab();
    await navigate(tabB, `${ctx.base}/hello`, "complete");
    await sleep(400);
    await ctx.openCC(ctx.tabA); // re-activate the CC tab
    await ctx.leaderPress(ctx.tabA, "\\", { shift: true }); // ;| via chrome helper
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error("split not created; tabs=" + JSON.stringify(ts));
    });
    const realT0 = (await ctx.tabsInfo()).filter(
      (t) => !(t.url || "").includes("splitpanel.html") && !(t.url || "").includes("#lfc=")
    );
    const bIdx = realT0.findIndex((t) => (t.url || "").includes("/hello")) + 1;
    assert(bIdx >= 1 && bIdx <= 9, ";+N target within 1-9: " + bIdx + " of " + realT0.length);
    await ctx.leaderPress(ctx.tabA, "=", { shift: true }); // ;+ -> shift+=
    await sleep(250);
    await ctx.press(ctx.tabA, String(bIdx)); // ;+N moves tab B into the split
    const pair = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 && sv.some((t) => (t.url || "").includes("/hello")) ? sv : null;
    }, 8000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      throw new Error(";+N did not move tab into split; tabs=" + JSON.stringify(ts));
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
    const saved = await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.splitws)`);
      return r && r.tabs && r.tabs.length ? r : null;
    }, 8000).catch(() => { throw new Error("splitws session was not saved"); });
    const svSaved = (saved.tabs || []).filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    assert(svSaved.length === 2, "saved session captured the split pair: " + JSON.stringify(saved.tabs.map((t) => ({ u: t.url, s: t.splitViewId }))));

    // Build a flat "away" session (unsplit first) to switch to: the window's
    // tabs get replaced by restore, so the split must vanish.
    await ctx.leaderPress(ctx.tabA, "\\"); // ;\ unsplit (chrome helper)
    await sleep(600);
    const awayRes = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfaway" } })`);
    assert(awayRes && awayRes.ok, "away session saved: " + JSON.stringify(awayRes));
    const away = await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfaway)`);
      return r && r.tabs && r.tabs.length ? r : null;
    }, 8000).catch(() => { throw new Error("lfaway session was not saved"); });
    assert(away.tabs.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "away session has no split: " + JSON.stringify(away.tabs.map((t) => t.splitViewId)));

    // Switch away by restoring lfaway; the window's tabs are replaced. Send
    // fire-and-forget: awaiting the reply would race the tab teardown.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfaway" } }); true`);
    await sleep(2000);
    let fresh = await ctx.makeProbeTab();
    let cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "lfaway", "switched away to lfaway, got " + cur);
    ctx.probe = fresh;
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const flat = await ctx.tabsInfo();
    assert(flat.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "switched-away window has no split: " + JSON.stringify(flat.map((t) => t.url)));

    // Switch back to splitws; restore must re-pair the panes from the saved
    // splitViewIds.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "splitws" } }); true`);
    await sleep(2500);
    fresh = await ctx.makeProbeTab();
    cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "splitws", "switched back to splitws, got " + cur);
    ctx.probe = fresh;
    const restored = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv.length === 2 ? sv : null;
    }, 10000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      const cur = await evalIn(ctx.probe, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`).catch(() => "ERR");
      throw new Error("restore did not re-pair; cur=" + cur + " tabs=" + JSON.stringify(ts));
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
    await sleep(600);
    const post = await ctx.tabsInfo();
    assert(post.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)), "cleanup left a split: " + JSON.stringify(post.map((t) => ({ u: t.url, s: t.splitViewId }))));
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Drop the splitws session so the suite is repeatable.
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.splitws; delete r.lfSessions.lfaway; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
  });
}
