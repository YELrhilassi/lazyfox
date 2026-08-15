// Sessions (tmux-style) + shared status bar tests. Covers save/restore, marker
// assignment and quick-switch, the status bar rendering (web + chrome), and
// the no-op/safe dispatch paths.

import { evalIn, waitFor, sleep, createTab, navigate, activate } from "../lib.mjs";
import { assert } from "../harness.mjs";

export const group = "sessions";

export async function run(ctx) {
  const t = (name, fn) => ctx.runTest(group, name, fn);

  console.log("\n== Sessions + status bar ==");

  await t("status bar renders on web pages (single window bar)", async () => {
    // The chrome helper owns ONE window-level bar for every tab. A web page
    // must NOT carry its own fixed bar (that one overlapped content while
    // scrolling) — only the window bar exists, and it shrinks the content
    // area so the page never renders underneath it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const s = await ctx.chromeState();
    assert(s && s.statusMounted === true, "window bar mounted on a web page");
    assert(s && s.statusAttr && s.statusAttr.indexOf("default") !== -1, "window bar shows the default session: " + (s && s.statusAttr));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-status")), "no per-page fixed bar (it would overlap content while scrolling)");
  });

  await t("window bar shrinks content so a web page never renders under it", async () => {
    // The reservation lives in the chrome document (#browser margin), so even
    // a body-scrolling page reflows above the bar instead of hiding its last
    // rows behind a fixed overlay.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/bodyscroll`);
    const s = await ctx.chromeState();
    assert(s && s.browserReserve && s.browserReserve.mb === "18px", "#browser reserved 18px for the bar: " + JSON.stringify(s && s.browserReserve));
  });

  await t("chrome status bar renders on the command center", async () => {
    await ctx.openCC(ctx.tabA);
    await sleep(600);
    const s = await ctx.chromeState();
    assert(s && s.statusMounted === true, "chrome status bar mounted: " + JSON.stringify(s && { mounted: s.statusMounted, position: s.statusPosition }));
  });

  await t("status bar position: top setting moves the bar", async () => {
    // Config reaches the chrome helper through the #lfc=cfg channel (the same
    // path the options page uses), then the bar re-renders on its 500ms poll.
    const pushCfg = async (partial) => {
      const nonce = "cfgt" + Date.now() + Math.floor(Math.random() * 1e6);
      const payload = encodeURIComponent(JSON.stringify({ config: partial }));
      await evalIn(ctx.probe, `location.hash = "#lfc=cfg.${nonce}.${payload}"`).catch(() => {});
      await sleep(900);
    };
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await pushCfg({ statusBarPosition: "top" });
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("|top") !== -1 ? true : null;
    }, 8000);
    // restore bottom
    await pushCfg({ statusBarPosition: "bottom" });
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("|bottom") !== -1 ? true : null;
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

  await t("sessions: new clean session creates an empty session without touching the window", async () => {
    // A brand-new name offers a "new clean session" row (arrow down from the
    // save row); picking it creates an EMPTY session under that name and must
    // leave the current window's tabs exactly as they were.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabsInfo();
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "clean");
    await sleep(700);
    await ctx.press(ctx.tabA, "ArrowDown"); // save row -> new-clean-session row
    await sleep(200);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.clean)`);
      return r ? r : null;
    }, 8000);
    const clean = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.clean)`);
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

  await t("downloads: progress, done indicator, ;D dismiss, popup list", async () => {
    // Start a slow download (streamed ~8s) so it stays in_progress long
    // enough for the bar's ⭳ segment to be observed. The extension auto-saves
    // it (fresh profile, no prompt).
    const id = await evalIn(ctx.probe, `browser.downloads.download({ url: ${JSON.stringify(ctx.base + "/slowfile")}, filename: "lf-slow.bin", saveAs: false }).then(d => d).catch(e => "ERR:" + e)`);
    assert(typeof id === "number", "download started: " + id);

    // The chrome helper polls Downloads.sys.mjs each second; the bar shows a
    // progress segment naming the file.
    const prog = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.dlCount >= 1 ? s : null;
    }, 20000).catch(() => null);
    assert(prog && prog.dlCount >= 1, "status bar shows download progress: " + JSON.stringify(prog && prog.dlActive));
    assert(prog.dlActive.some((n) => String(n).indexOf("lf-slow") !== -1), "progress names the file: " + JSON.stringify(prog.dlActive));

    // When it finishes, the bar keeps a small GREEN done indicator (state
    // complete) instead of the percent, until the user dismisses it.
    const done = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s &&
        (s.dlActive || []).some((n) => String(n).indexOf("lf-slow") !== -1 && String(n).indexOf("complete") !== -1)
        ? s
        : null;
    }, 25000).catch(() => null);
    assert(done, "done download keeps a green indicator: " + JSON.stringify(done && done.dlActive));

    // ;D dismisses the notification from the bar; the popup still lists it.
    await ctx.openCC(ctx.tabA);
    await sleep(400);
    await ctx.chromeLeaderPress(ctx.tabA, "D");
    const gone = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.dlCount === 0 ? true : null;
    }, 8000).catch(() => null);
    assert(gone === true, "dismiss cleared the bar segment");

    await ctx.chromeLeaderPress(ctx.tabA, "d");
    const pop = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.current && s.popup.items && s.popup.items.length ? s.popup : null;
    }, 8000).catch(() => null);
    assert(pop && pop.items.some((txt) => String(txt).indexOf("lf-slow") !== -1), "popup lists the download: " + JSON.stringify(pop && pop.items));
    await ctx.press(ctx.tabA, "Escape");

    // Clean the file + history entry so the suite is repeatable.
    await evalIn(ctx.probe, `browser.downloads.search({ filename: "lf-slow.bin" }).then(rs => Promise.all(rs.map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

  await t("stealth: isolated tab, session round-trip, wiped on close", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);

    // ;S opens the current page in its own container (isolated cookie jar).
    await ctx.leaderPress(ctx.tabA, "S");
    const opened = await waitFor(async () => {
      const ts = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, url: t.url, cs: t.cookieStoreId})))`);
      const stealth = ts.find((t) => t.cs && t.cs !== "firefox-default");
      return stealth ? stealth : null;
    }, 10000).catch(() => null);
    assert(opened, "stealth tab opened in its own container");
    assert(opened.cs !== "firefox-default", "stealth container is not the default jar");

    // Session save records the stealth flag.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfstealth" } }); true`);
    await sleep(700);
    const saved = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfstealth)`);
    assert(saved && saved.tabs.some((t) => t.stealth === true), "session marks the stealth tab: " + JSON.stringify(saved && saved.tabs.map((t) => t.stealth)));

    // Close it -> the container is wiped + removed.
    await evalIn(ctx.probe, `browser.tabs.remove(${opened.id})`).catch(() => {});
    const gone = await waitFor(async () => {
      const cis = await evalIn(ctx.probe, `browser.contextualIdentities.query({}).then(cs => cs.map(c => c.cookieStoreId))`);
      return cis && cis.indexOf(opened.cs) === -1 ? true : null;
    }, 8000).catch(() => null);
    assert(gone === true, "container removed after closing the stealth tab");

    // Restore the session: the stealth tab returns in a FRESH container.
    // The restore tears down the window (including the probe tab), so re-make
    // the probe before querying anything.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfstealth" } }); true`);
    await sleep(2500);
    const fresh = await ctx.makeProbeTab();
    ctx.probe = fresh;
    const restored = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, cs: t.cookieStoreId})))`);
    const stealthTab = restored.find((t) => t.cs && t.cs !== "firefox-default");
    assert(stealthTab, "restore re-opened a stealth container tab");
    assert(stealthTab.cs !== opened.cs, "restored stealth tab uses a fresh container");

    // Clean up: remove the stealth tab and the session.
    await evalIn(ctx.probe, `browser.tabs.remove(${stealthTab.id})`).catch(() => {});
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionDelete", data: { name: "lfstealth" } }); true`);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA).catch(() => {});
  });
}
