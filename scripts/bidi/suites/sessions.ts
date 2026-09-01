// Sessions (tmux-style) + shared status bar tests. Covers save/restore, marker
// assignment and quick-switch, the status bar rendering (web + chrome), and
// the no-op/safe dispatch paths.

import { evalIn, waitFor, sleep, createTab, navigate, activate, getTree, closeContext } from "../lib.ts";
import { assert } from "../harness.ts";

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

  await t("status bar hides during DOM fullscreen and returns on exit", async () => {
    // A video going fullscreen (requestFullscreen) must hide the window-level
    // bar, and exiting must bring it back. Regression: after a Firefox update
    // the bar stayed on screen during video fullscreen — the layered check
    // (the chrome document's inDOMFullscreen attribute OR the selected tab's
    // standard document.fullscreenElement) must catch both signals.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/fullscreen`);
    const s0 = await ctx.chromeState();
    assert(s0 && s0.statusMounted === true, "bar mounted before fullscreen: " + JSON.stringify(s0 && { m: s0.statusMounted, fs: s0.fullscreen }));
    // A real user pressing `f` grants transient activation, so Firefox accepts
    // requestFullscreen. WebDriver-synthesized key events do NOT carry that
    // activation in this geckodriver (the page logs FS-DENIED), so try the
    // key first (faithful to the real path) and fall back to a script call
    // with explicit userActivation — same DOM result, same bar hide/show.
    await ctx.press(ctx.tabA, "f");
    const entered = await waitFor(async () => evalIn(ctx.tabA, `!!document.fullscreenElement`), 2000).catch(() => null);
    if (!entered) {
      await evalIn(ctx.tabA, `(document.getElementById("vid").requestFullscreen(), true)`, false, { userActivation: true });
      await waitFor(async () => evalIn(ctx.tabA, `!!document.fullscreenElement`), 10000).catch(() => {});
    }
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusMounted === false ? true : null;
    }, 10000).catch(() => {
      throw new Error("status bar stayed visible during DOM fullscreen");
    });
    const fs = await evalIn(ctx.tabA, `!!document.fullscreenElement`);
    assert(fs, "page really entered DOM fullscreen");
    await ctx.press(ctx.tabA, "x"); // exit fullscreen
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusMounted === true ? true : null;
    }, 10000).catch(() => {
      throw new Error("status bar did not return after fullscreen exit");
    });
  });

  await t("leader-armed indicator: with the which-key overlay off, the bar shows LEADER", async () => {
    // ;q toggles the which-key overlay off. With the overlay hidden, pressing
    // ; arms the leader with NO visible overlay — the status bar's pulsing
    // chevron (mode LEADER) is the only sign the leader is armed. Regression:
    // the bar used to render nothing for LEADER mode.
    await ctx.openCC(ctx.tabA);
    // Toggle the overlay off through the chrome helper (chrome owns the keys
    // on the command center).
    await ctx.chromeLeaderPress(ctx.tabA, "q");
    await waitFor(async () => {
      const c = await evalIn(ctx.probe, `browser.storage.local.get("config").then(r => r.config && r.config.whichKey)`);
      return c === false ? true : null;
    }, 8000).catch(() => { throw new Error(";q did not flip whichKey off"); });
    // Press ; alone: the leader arms, the overlay stays hidden.
    await ctx.press(ctx.tabA, ";");
    await sleep(300);
    const armed = await ctx.chromeState();
    assert(armed && armed.leaderActive === true,
      "leader armed with the overlay off: " + JSON.stringify(armed && { la: armed.leaderActive, st: armed.statusAttr }));
    assert(armed && armed.statusAttr && armed.statusAttr.indexOf("|LEADER|") !== -1,
      "status bar shows LEADER mode while armed: " + JSON.stringify(armed && armed.statusAttr));
    // Escape disarms; the chevron leaves the bar.
    await ctx.press(ctx.tabA, "Escape");
    await sleep(300);
    const disarmed = await ctx.chromeState();
    assert(disarmed && disarmed.leaderActive === false, "Escape disarmed the leader");
    assert(disarmed && disarmed.statusAttr && disarmed.statusAttr.indexOf("|LEADER|") === -1,
      "status bar left LEADER mode after disarm: " + JSON.stringify(disarmed && disarmed.statusAttr));
    // Re-enable the overlay so the rest of the suite runs with hints on.
    await ctx.chromeLeaderPress(ctx.tabA, "q");
    await waitFor(async () => {
      const c = await evalIn(ctx.probe, `browser.storage.local.get("config").then(r => r.config && r.config.whichKey)`);
      return c === true ? true : null;
    }, 8000).catch(() => { throw new Error(";q did not re-enable whichKey"); });
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });


  await t("web page: with the which-key overlay off, the window bar shows LEADER", async () => {
    // The content script owns the leader key on web pages (the chrome helper
    // stays hands-off there), but the window-level status bar is the chrome
    // helper's. The pulsing LEADER chevron must still appear — it is the ONLY
    // visible sign the leader is armed when the which-key overlay is off.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Toggle the overlay off through the content script (it owns the keys on
    // a web page).
    await ctx.leaderPress(ctx.tabA, "q");
    await waitFor(async () => {
      const c = await evalIn(ctx.probe, `browser.storage.local.get("config").then(r => r.config && r.config.whichKey)`);
      return c === false ? true : null;
    }, 8000).catch(() => { throw new Error(";q did not flip whichKey off"); });
    // Press ; alone: the content leader arms, the overlay stays hidden.
    await ctx.press(ctx.tabA, ";");
    // The chrome helper's bar learns of the arm through the per-tab lfLeader
    // session value; wait for the 500ms status poll to pick it up.
    const armed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("|LEADER|") !== -1 ? s : null;
    }, 8000).catch(() => null);
    assert(armed && armed.statusAttr,
      "window bar shows LEADER while the content leader is armed: " + JSON.stringify(armed && armed.statusAttr));
    // Escape disarms; the chevron leaves the bar.
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("|LEADER|") === -1 ? true : null;
    }, 8000).catch(() => { throw new Error("bar stayed in LEADER mode after Escape"); });
    // Re-enable the overlay so the rest of the suite runs with hints on.
    await ctx.leaderPress(ctx.tabA, "q");
    await waitFor(async () => {
      const c = await evalIn(ctx.probe, `browser.storage.local.get("config").then(r => r.config && r.config.whichKey)`);
      return c === true ? true : null;
    }, 8000).catch(() => { throw new Error(";q did not re-enable whichKey"); });
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
    // Watch the composed `lazyfox:list` event (the popup's rows live in a
    // closed shadow root, unreadable from the page) so ArrowDown/Enter never
    // race the async list render.
    await evalIn(
      ctx.tabA,
      `window.__lfList = null; document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true); true`
    );
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "clean");
    // Wait for the *filtered* list (q === "clean") to render exactly the two
    // action rows (save + new clean), then move onto the new-clean row.
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.q === "clean" && d.count === 2 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "ArrowDown"); // save row -> new-clean-session row
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.idx === 1 ? d : null;
    }, 3000);
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
    // marker, so work(1) is first and delme(2) second. The session list
    // loads asynchronously — the popup lives in a closed shadow root, so the
    // rows are unreadable from the page; instead watch the composed
    // `lazyfox:list` event the selector fires on every render.
    await evalIn(
      ctx.tabA,
      `window.__lfList = null; document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true); true`
    );
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // Wait for the list to render (>= 2 sessions) before navigating, or
    // ArrowDown/x would race the fetch (x falling into the input, or arming
    // on the wrong row).
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.count >= 2 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "ArrowDown");
    // The highlight must actually sit on the delme row before x can be
    // trusted to delete it (idx stays 0 while the list is empty, which would
    // arm on the wrong session).
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.idx === 1 ? d : null;
    }, 3000);
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
      (t) => ctx.isRealTab(t)
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
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error(";+N did not move tab into split; lastMoveDebug=" + JSON.stringify(st && st.lastMoveDebug) + " tabs=" + JSON.stringify(ts));
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

  await t("restore brings back every tab's exact strip position (split included)", async () => {
    // Regression: switching sessions must not renumber tabs. Firefox's own
    // split machinery parks a re-formed pair at the strip END, so before the
    // fix a session with a mid-strip split came back with the pair at the
    // tail — ;1-9 pointed at different tabs than when the session was saved.
    await ctx.openCC(ctx.tabA);
    // Four distinctive tabs in a known order.
    const names = ["lfw1", "lfw2", "lfw3", "lfw4"];
    const tabs2 = [];
    for (const n of names) {
      const t = await createTab();
      await navigate(t, `${ctx.base}/${n}`, "complete");
      tabs2.push(t);
    }
    await sleep(400);
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
    const chromeReal = ids.filter((t) => ctx.isRealTab(t));
    const w3ChromeIdx = chromeReal.findIndex((t) => t.id === w3Row.id) + 1;
    assert(w3ChromeIdx <= 9, "w3 within ;+1-9: " + w3ChromeIdx);
    await evalIn(ctx.probe, `browser.tabs.update(${w2Row.id}, { active: true })`).catch(() => {});
    await sleep(300);
    // ;+ on the w2 WEB page keeps w2 selected (leaderPress only focuses).
    await ctx.leaderPress(tabs2[1], "=", { shift: true }); // ;+
    await sleep(250);
    await ctx.press(tabs2[1], String(w3ChromeIdx)); // digit -> pair (w2, w3)
    await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const sv2 = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return sv2.length === 2 ? sv2 : null;
    }, 10000);
    // Save this layout, then switch away and back.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lforder" } }); true`);
    await sleep(600);
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfaway2" } }); true`);
    await sleep(600);
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfaway2" } }); true`);
    await sleep(2000);
    ctx.probe = await ctx.makeProbeTab();
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lforder" } }); true`);
    await sleep(2500);
    ctx.probe = await ctx.makeProbeTab();
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
    }, 6000).catch(async () => {
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      const st = await ctx.chromeState().catch(() => "ERR");
      throw new Error("restore order never settled; want=" + beforeOrder + " w2SavedIdx=" + iw2Saved + " realAfter=" + JSON.stringify(Array.isArray(ts) ? ts.filter((t) => { const u = t.url || ""; return !u.includes("commandcenter.html") && !u.includes("relay.html"); }).map((t) => ({ u: t.url, s: t.splitViewId })) : ts) + " strip=" + JSON.stringify(st && st.strip));
    });
    assert(restored != null, "restore kept every tab's strip slot (want " + beforeOrder + " with w2@" + iw2Saved + "): " + JSON.stringify((await ctx.tabsInfo()).map((t) => ({ u: t.url, s: t.splitViewId }))));
    const svTabs = restored.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
    // Clean up: dissolve the split and drop the throwaway sessions.
    for (const p of svTabs) {
      await evalIn(ctx.probe, `browser.tabs.remove(${p.id}).catch(() => {})`);
    }
    await sleep(500);
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.lforder; delete r.lfSessions.lfaway2; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

  await t("downloads: progress shows done indicator, ;D dismiss, popup list", async () => {
    // Sweep leftovers from earlier interrupted runs (Firefox appends " (N)"
    // to avoid overwriting, so match by name fragment) before starting.
    await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => Promise.all(rs.filter(r => String(r.filename).indexOf("lf-slow") !== -1).map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
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

    // Clean the file + history entry so the suite is repeatable (match by
    // fragment so numbered copies from interrupted runs are swept too).
    await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => Promise.all(rs.filter(r => String(r.filename).indexOf("lf-slow") !== -1).map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

  await t("downloads: r retries a failed download, y copies its link", async () => {
    // Sweep leftovers, then start a download that always fails so the popup
    // has a failed entry to retry.
    await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => Promise.all(rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1).map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
    const id = await evalIn(ctx.probe, `browser.downloads.download({ url: ${JSON.stringify(ctx.base + "/failfile")}, filename: "lf-fail.bin", saveAs: false }).then(d => d).catch(e => "ERR:" + e)`);
    assert(typeof id === "number", "failed download started: " + id);

    // The bar shows the failed entry (red indicator).
    const failed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && (s.dlActive || []).some((n) => String(n).indexOf("lf-fail") !== -1 && String(n).indexOf("failed") !== -1) ? s : null;
    }, 15000).catch(() => null);
    assert(failed, "failed download shows on the bar: " + JSON.stringify(failed && failed.dlActive));

    // ;d opens the downloads popup. `r` retries the failed download (its
    // startTime moves — Firefox restarts it from the source, same entry); `y`
    // copies the link and keeps the popup open; Esc closes.
    await ctx.openCC(ctx.tabA);
    await sleep(400);
    await ctx.chromeLeaderPress(ctx.tabA, "d");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.current && s.popup.items && s.popup.items.length ? true : null;
    }, 8000).catch(() => null);
    const t0 = await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => { const d = rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1)[0]; return d && d.startTime ? d.startTime : ""; })`);
    // Keys inside an OPEN popup go straight to it (a leading `;` would be
    // typed into the popup's search box and empty the list).
    await ctx.press(ctx.tabA, "r");
    const retried = await waitFor(async () => {
      const t = await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => { const d = rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1)[0]; return d && d.startTime ? d.startTime : ""; })`);
      return t && t !== t0 ? t : null;
    }, 10000).catch(() => null);
    assert(retried, "retry restarted the download (new startTime): before=" + t0 + " after=" + retried);
    await ctx.press(ctx.tabA, "y");
    await sleep(400);
    const stillOpen = await ctx.chromeState();
    assert(stillOpen && stillOpen.popup && stillOpen.popup.current, "copy link keeps the popup open");
    await ctx.press(ctx.tabA, "Escape");

    // Sweep the failed downloads so the suite stays repeatable.
    await evalIn(ctx.probe, `browser.downloads.search({}).then(rs => Promise.all(rs.filter(r => String(r.filename).indexOf("lf-fail") !== -1).map(r => browser.downloads.removeFile(r.id).catch(() => {}).then(() => browser.downloads.erase({ id: r.id }).catch(() => {}))))).then(() => true)`).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

  await t("stealth: isolated jar, session round-trip, wiped on close", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const origin = JSON.stringify(`${ctx.base}/`);

    // ;N opens a FRESH empty stealth tab in its own container (isolated
    // cookie jar) — it starts on the command center, NOT a clone of tabA.
    const beforeCtxs = (await getTree()).map((c) => c.context);
    await ctx.leaderPress(ctx.tabA, "N");
    const opened = await waitFor(async () => {
      const ts = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, url: t.url, cs: t.cookieStoreId})))`);
      const stealth = ts.find((t) => t.cs && t.cs !== "firefox-default");
      return stealth ? stealth : null;
    }, 10000).catch(() => null);
    assert(opened, "stealth tab opened in its own container");
    assert(opened.cs !== "firefox-default", "stealth container is not the default jar");
    assert(opened.url && opened.url.indexOf("commandcenter.html") !== -1 && opened.url.indexOf("#lfc=") === -1,
      "stealth tab starts empty on the command center, not a duplicate: " + opened.url);

    // Status-bar badge: with the stealth tab active, the window bar shows the
    // stealth indicator; a plain tab does not.
    const st = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("stealth") !== -1 ? s : null;
    }, 8000).catch(() => null);
    assert(st, "status bar badges the active stealth tab");

    // The command center home page renders with a distinct stealth look when
    // it is shown inside a stealth tab (the lf-stealth class + badge). The
    // stealth tab already sits on the command center; locate its BiDi context
    // as the context that appeared since ;N (filtering out the transient
    // #lfc= request tabs) and inspect it directly.
    const stealthCtx = await waitFor(async () => {
      const tree = await getTree();
      const c = (tree || []).find(
        (x) =>
          !beforeCtxs.includes(x.context) &&
          x.url && x.url.indexOf("commandcenter.html") !== -1 &&
          x.url.indexOf("#lfc=") === -1
      );
      return c ? c : null;
    }, 8000).catch(() => null);
    assert(stealthCtx && stealthCtx.context, "located the stealth tab's browsing context");
    const stealthHome = await waitFor(async () => {
      const c = await evalIn(stealthCtx.context, `document.documentElement.classList.contains("lf-stealth")`);
      return c === true ? true : null;
    }, 8000).catch(() => null);
    assert(stealthHome === true, "stealth tab's home page carries the lf-stealth look");
    const stealthTag = await evalIn(stealthCtx.context, `(document.getElementById("stealthTag")||{style:{}}).style.display`);
    assert(stealthTag !== "none", "stealth home shows the stealth header badge");

    // Data isolation — the whole point of the feature: a cookie in the NORMAL
    // jar (the "signed-in YouTube" case) must NOT be visible in the stealth
    // jar, even on the same origin.
    await evalIn(ctx.probe, `browser.cookies.set({ url: ${origin}, name: "lfiso", value: "def", storeId: "firefox-default" }).then(() => true)`);
    const iso = await evalIn(ctx.probe, `browser.cookies.getAll({ url: ${origin}, storeId: ${JSON.stringify(opened.cs)} }).then(cs => cs.map(c => c.name))`);
    assert(!(iso || []).includes("lfiso"), "stealth jar does not see the normal jar's cookie (got: " + JSON.stringify(iso) + ")");

    // The tab list marks the stealth tab so the tab switcher can badge it.
    const listed = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "tabs" }).then(r => r.tabs.map(t => ({ id: t.id, stealth: t.stealth })))`);
    const listedStealth = (listed || []).find((x) => x.id === opened.id);
    assert(listedStealth && listedStealth.stealth === true, "tab list marks the stealth tab");

    // Session save records the stealth flag.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfstealth" } }); true`);
    await sleep(700);
    const saved = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfstealth)`);
    assert(saved && saved.tabs.some((t) => t.stealth === true), "session marks the stealth tab: " + JSON.stringify(saved && saved.tabs.map((t) => t.stealth)));

    // Seed the stealth jar with its OWN cookie so we can prove close wipes the
    // DATA, not just the container identity.
    await evalIn(ctx.probe, `browser.cookies.set({ url: ${origin}, name: "lfst", value: "1", storeId: ${JSON.stringify(opened.cs)} }).then(() => true)`);
    const seeded = await evalIn(ctx.probe, `browser.cookies.getAll({ storeId: ${JSON.stringify(opened.cs)} }).then(cs => cs.map(c => c.name))`);
    assert((seeded || []).includes("lfst"), "stealth jar accepts its own cookie");

    // Close it -> the container is wiped + removed, data included.
    await evalIn(ctx.probe, `browser.tabs.remove(${opened.id})`).catch(() => {});
    const gone = await waitFor(async () => {
      const cis = await evalIn(ctx.probe, `browser.contextualIdentities.query({}).then(cs => cs.map(c => c.cookieStoreId))`);
      return cis && cis.indexOf(opened.cs) === -1 ? true : null;
    }, 8000).catch(() => null);
    assert(gone === true, "container removed after closing the stealth tab");
    const wiped = await evalIn(ctx.probe, `browser.cookies.getAll({ storeId: ${JSON.stringify(opened.cs)} }).then(cs => cs.map(c => c.name)).catch(() => [])`);
    assert(!(wiped || []).includes("lfst"), "closing wiped the stealth jar's data");

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

    // Clean up: remove the stealth tab, the session, and the default-jar cookie.
    await evalIn(ctx.probe, `browser.tabs.remove(${stealthTab.id})`).catch(() => {});
    await evalIn(ctx.probe, `browser.cookies.remove({ url: ${origin}, name: "lfiso", storeId: "firefox-default" }).catch(() => true); browser.runtime.sendMessage({ action: "sessionDelete", data: { name: "lfstealth" } }); true`);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA).catch(() => {});
  });

  await t("tabs opened after saving are persisted into the session", async () => {
    // Regression: tabs opened AFTER a session was saved never reached that
    // session's stored tab list (only the crash-recovery "last" slot), so the
    // pill count stayed stale and the tabs vanished on quit. Every tab change
    // must now re-persist the CURRENT named session.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hello`);
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lftrack" } }); true`);
    await sleep(700);
    const saved = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lftrack)`);
    assert(saved && Array.isArray(saved.tabs) && saved.tabs.length >= 1, "session saved with its current tab");
    const baseline = (saved && saved.tabs && saved.tabs.length) || 0;

    // Open a NEW tab in the same window (like opening youtube/google after
    // creating the session).
    const extra = await createTab();
    await navigate(extra, `${ctx.base}/world`, "complete");
    await activate(extra).catch(() => {});
    await sleep(300);

    // The debounced autosave must fold the new tab into the named session.
    const tracked = await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lftrack)`);
      return r && r.tabs && r.tabs.length > baseline ? r : null;
    }, 8000).catch(() => null);
    assert(tracked, "new tab was persisted into the session: " + JSON.stringify(tracked && tracked.tabs.map((t) => t.url)));
    assert(
      (tracked.tabs || []).some((t) => (t.url || "").indexOf("/world") !== -1),
      "persisted session includes the newly opened tab: " + JSON.stringify(tracked.tabs.map((t) => t.url))
    );

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
    await ctx.openCC(ctx.tabA);
    await sleep(500);
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfpartial" } }); true`);
    await sleep(700);
    // "open a site from the home screen" — the CC tab becomes the first tab.
    await navigate(ctx.tabA, `${ctx.base}/hello`, "complete");
    await activate(ctx.tabA).catch(() => {});
    await sleep(2200);
    // One more tab via ;o.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "openUrl", data: { url: ${JSON.stringify(`${ctx.base}/world`)}, newTab: true } }); true`);
    await sleep(2200);

    // Simulate Firefox's imperfect native restore: a blank first tab plus the
    // surviving tab (the probe's command-center tab stays out of the way).
    const ids = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.filter(t => (t.url||"").indexOf("commandcenter.html") === -1).map(t => t.id))`);
    for (const id of ids) {
      await evalIn(ctx.probe, `browser.tabs.remove(${id}).catch(() => true)`).catch(() => {});
    }
    await sleep(400);
    await evalIn(ctx.probe, `browser.tabs.create({ url: "about:blank", active: true }).then(t => t.id)`);
    await evalIn(ctx.probe, `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/world`)}, active: false }).then(t => t.id)`);
    await sleep(600);

    // Restore — the blank first tab must be replaced by /hello.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfpartial" } }); true`);
    await sleep(2500);
    const fresh = await ctx.makeProbeTab();
    ctx.probe = fresh;
    const urls = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => t.url))`);
    const hello = (urls || []).filter((u) => String(u).indexOf("/hello") !== -1).length;
    const world = (urls || []).filter((u) => String(u).indexOf("/world") !== -1).length;
    const blank = (urls || []).filter((u) => String(u).indexOf("about:blank") !== -1).length;
    assert(hello === 1, "first tab (/hello) restored, got " + JSON.stringify(urls));
    assert(world === 1, "last tab (/world) restored, got " + JSON.stringify(urls));
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
    await sleep(2000); // well past the old 500ms conversion window
    const u = await evalIn(ctx.probe, `browser.tabs.get(${id}).then(t => t.url).catch(() => "GONE")`);
    assert(String(u).indexOf("about:blank") !== -1, "blank tab was left alone, got " + u);
    await evalIn(ctx.probe, `browser.tabs.remove(${id}).catch(() => true)`);
    await activate(ctx.tabA).catch(() => {});
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
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
      }); true`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // The popup lives in a closed shadow root; watch the composed list events
    // (left sessions list + right tabs pane) instead of reading rows directly.
    await evalIn(
      ctx.tabA,
      `window.__lfList = null; window.__lfTabs = null;
       document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true);
       document.addEventListener("lazyfox:tabs", (e) => { window.__lfTabs = e.detail; }, true); true`
    );
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // Filter to lfSrc so the highlight is deterministic, then Tab into the
    // tabs pane (the highlighted session's tabs).
    await ctx.typeIn(ctx.tabA, "lfSrc");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.q === "lfSrc" && d.count === 1 && d.idx === 0 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "Tab");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfTabs`);
      return d && d.count === 1 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "c");
    await ctx.typeIn(ctx.tabA, "lfDst");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.q === "lfDst" && d.count === 1 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "Enter");
    const all = await waitFor(async () => {
      const s = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
      return s.lfDst && s.lfDst.tabs && s.lfDst.tabs.length === 2 ? s : null;
    }, 8000).catch(() => { throw new Error("copy did not add a tab to lfDst"); });
    assert(all.lfDst.tabs.some((t) => t.url === srcUrl), "lfDst contains the copied tab: " + JSON.stringify(all.lfDst.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.some((t) => t.url === dstUrl), "lfDst kept its original tab");
    assert(all.lfSrc.tabs.length === 1, "copy left the source session intact: " + JSON.stringify(all.lfSrc.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.every((t) => typeof t.splitViewId !== "number" || t.splitViewId < 0), "copied tab carries no split pairing");
    // The popup stays open after a copy; Escape first leaves the tabs pane,
    // a second Esc closes (Tab leaks would have moved focus out of the popup).
    assert(await ctx.hasHost(ctx.tabA, "lazyfox-popup"), "popup stays open after a copy");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
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
      }); true`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(
      ctx.tabA,
      `window.__lfList = null; window.__lfTabs = null;
       document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true);
       document.addEventListener("lazyfox:tabs", (e) => { window.__lfTabs = e.detail; }, true); true`
    );
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "lfSrc");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.q === "lfSrc" && d.count === 1 && d.idx === 0 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "Tab");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfTabs`);
      return d && d.count === 2 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "j"); // select the second tab
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfTabs`);
      return d && d.idx === 1 ? d : null;
    }, 3000);
    await ctx.press(ctx.tabA, "m");
    await ctx.typeIn(ctx.tabA, "lfDst");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.q === "lfDst" && d.count === 1 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "Enter");
    const all = await waitFor(async () => {
      const s = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
      const src = s.lfSrc;
      const dst = s.lfDst;
      return src && dst && src.tabs && dst.tabs && src.tabs.length === 1 && dst.tabs.length === 2 ? s : null;
    }, 8000).catch(() => { throw new Error("move did not transfer the tab"); });
    assert(all.lfSrc.tabs.length === 1 && all.lfSrc.tabs[0].url === srcA, "source kept the un-moved tab: " + JSON.stringify(all.lfSrc.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.length === 2 && all.lfDst.tabs.some((t) => t.url === srcB), "destination gained the moved tab: " + JSON.stringify(all.lfDst.tabs.map((t) => t.url)));
    assert(all.lfDst.tabs.some((t) => t.url === dstX), "destination kept its original tab");
    assert(all.lfDst.tabs.every((t) => typeof t.splitViewId !== "number" || t.splitViewId < 0), "moved tab carries no split pairing");
    assert(await ctx.hasHost(ctx.tabA, "lazyfox-popup"), "popup stays open after a move");
    await ctx.press(ctx.tabA, "Escape");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
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
      }); true`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(
      ctx.tabA,
      `window.__lfList = null; window.__lfTabs = null;
       document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true);
       document.addEventListener("lazyfox:tabs", (e) => { window.__lfTabs = e.detail; }, true); true`
    );
    await ctx.leaderPress(ctx.tabA, "p");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "lfTmp");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfList`);
      return d && d.q === "lfTmp" && d.count === 1 ? d : null;
    }, 5000);
    await ctx.press(ctx.tabA, "Tab");
    await waitFor(async () => {
      const d = await evalIn(ctx.tabA, `window.__lfTabs`);
      return d && d.count === 1 ? d : null;
    }, 5000);
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
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
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
    await sleep(600);
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
    await sleep(400);
    // Saving snapshots the window and makes the new session current.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfCur" } }); true`);
    await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfCur)`);
      return r && r.tabs && r.tabs.some((t) => t.url === srcUrl) ? r : null;
    }, 8000).catch(() => { throw new Error("lfCur session was not saved"); });
    const idx = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => (r.lfSessions.lfCur.tabs || []).findIndex(t => t.url === ${JSON.stringify(srcUrl)}))`);
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => {
      const all = r.lfSessions || {};
      all.lfDst = { name: "lfDst", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
        tabs: [{ url: ${JSON.stringify(dstUrl)}, title: "lf-cur-dst", pinned: false }], splits: "" };
      return browser.storage.local.set({ lfSessions: all });
    }); true`);
    // Await the reply: the move's live side effect closes the moved tab (not
    // the sender, so awaiting is safe) and we want its result for a clean
    // failure message.
    const mvRes = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionTabMove", data: { from: "lfCur", index: ${idx}, to: "lfDst" } }).then(r => r)`);
    assert(mvRes && mvRes.ok === true, "move returned ok: " + JSON.stringify(mvRes) + " idx=" + idx);
    // Give the debounced autosave time to re-snapshot the current session —
    // the old bug only surfaced after it ran.
    await sleep(2500);
    const all = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    assert(all.lfDst && all.lfDst.tabs.some((t) => t.url === srcUrl), "destination gained the moved tab: " + JSON.stringify(all.lfDst && all.lfDst.tabs && all.lfDst.tabs.map((t) => t.url)));
    assert(all.lfCur && !all.lfCur.tabs.some((t) => t.url === srcUrl), "current session did not resurrect the moved tab: " + JSON.stringify(all.lfCur && all.lfCur.tabs && all.lfCur.tabs.map((t) => t.url)));
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
    }); true`);
    const mvRes = await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionTabMove", data: { from: "lfSrc", index: 0, to: "lfCur" } }).then(r => r)`);
    await sleep(2500);
    const all = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    const liveDbg = await ctx.tabsInfo();
    assert(mvRes && mvRes.ok === true, "move returned ok: " + JSON.stringify(mvRes));
    assert(all.lfCur && all.lfCur.tabs.some((t) => t.url === srcUrl), "current session kept the moved-in tab: lfSrc=" + JSON.stringify(all.lfSrc && all.lfSrc.tabs && all.lfSrc.tabs.map((t) => t.url)) + " live=" + JSON.stringify(liveDbg.map((t) => t.url)) + " lfCur=" + JSON.stringify(all.lfCur && all.lfCur.tabs && all.lfCur.tabs.map((t) => t.url)));
    assert(all.lfSrc && !all.lfSrc.tabs.some((t) => t.url === srcUrl), "source no longer has the moved tab");
    const live = await ctx.tabsInfo();
    assert(live.some((t) => (t.url || "").includes("/lf-into-src")), "moved-in tab was opened in the live window: " + JSON.stringify(live.map((t) => t.url)));
    // Cleanup.
    const movedTab = live.find((t) => (t.url || "").includes("/lf-into-src"));
    if (movedTab) await evalIn(ctx.probe, `browser.tabs.remove(${movedTab.id}).catch(() => true)`).catch(() => {});
    await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => { const a = r.lfSessions || {}; delete a.lfSrc; delete a.lfCur; return browser.storage.local.set({ lfSessions: a }); }).then(() => browser.storage.local.set({ lfCurrentSession: "work" })); true`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

await t("sessions: moving the only tab out of the current session replaces it with a fresh empty tab", async () => {
    // Closing the last tab in a window would close the window, so the move
    // replaces it with a fresh about:blank tab instead; the autosave folds the
    // blank tab back into the session. The moved tab lands in the destination.
    // The sender is a splitpanel.html tab — a UI tab that realTabsInWindow
    // skips — so the window has exactly ONE real tab (the moved web tab) at
    // move time, yet the sender survives the move and the reply can be awaited
    // (no fire-and-forget raciness).
    const movedUrl = `${ctx.base}/lf-only-src`;
    const sender = await createTab();
    const splitUrl = await evalIn(ctx.probe, `browser.runtime.getURL("splitpanel.html")`);
    await navigate(sender, splitUrl, "complete");
    const senderId = await evalIn(sender, `browser.tabs.getCurrent().then(t => t ? t.id : null)`);
    const movedTab = await createTab();
    await navigate(movedTab, movedUrl, "complete");
    // Resolve the moved tab's id from the sender: the moved tab is a WEB page,
    // where the browser.* tabs API is unavailable.
    const movedId = await evalIn(sender, `browser.tabs.query({currentWindow:true}).then(ts => { const m = ts.find(t => (t.url || "").indexOf("/lf-only-src") !== -1); return m ? m.id : null; })`);
    assert(movedId != null, "moved web tab found: " + movedId);
    // Trim: keep only the sender (UI) and the moved web tab.
    await evalIn(sender, `(async () => {
      const ts = await browser.tabs.query({ currentWindow: true });
      for (const t of ts) {
        if (t.id !== ${senderId} && t.id !== ${movedId} && !t.pinned) { try { await browser.tabs.remove(t.id); } catch (e) {} }
      }
      return true;
    })()`);
    await sleep(500);
    // Saving snapshots the window EXCLUDING the sender (a UI tab), so the
    // saved session is exactly the single moved tab, and it becomes current.
    const saveRes = await evalIn(sender, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfCur" } }).then(r => r)`);
    assert(saveRes && saveRes.ok === true, "sessionSave returned ok: " + JSON.stringify(saveRes));
    await waitFor(async () => {
      const r = await evalIn(sender, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfCur)`);
      return r && r.tabs && r.tabs.length === 1 && r.tabs[0].url === movedUrl ? r : null;
    }, 8000).catch(() => { throw new Error("lfCur did not capture the single web tab"); });
    await evalIn(sender, `browser.storage.local.get("lfSessions").then(r => {
      const all = r.lfSessions || {};
      all.lfDst = { name: "lfDst", marker: 0, active: 0, windowState: "normal", updatedAt: Date.now(),
        tabs: [{ url: ${JSON.stringify(`${ctx.base}/lf-only-dst`)}, title: "lf-only-dst", pinned: false }], splits: "" };
      return browser.storage.local.set({ lfSessions: all });
    }); true`);
    // The sender survives the move (only the moved web tab is replaced), so
    // await the reply for a deterministic assertion.
    const mvRes = await evalIn(sender, `browser.runtime.sendMessage({ action: "sessionTabMove", data: { from: "lfCur", index: 0, to: "lfDst" } }).then(r => r)`);
    assert(mvRes && mvRes.ok === true, "move returned ok: " + JSON.stringify(mvRes));
    // Give the debounced autosave time to fold the blank replacement into the
    // current session.
    await sleep(2500);
    const all = await evalIn(sender, `browser.storage.local.get("lfSessions").then(r => r.lfSessions || {})`);
    assert(all.lfDst && all.lfDst.tabs.some((t) => t.url === movedUrl), "destination gained the only tab: " + JSON.stringify(all.lfDst && all.lfDst.tabs && all.lfDst.tabs.map((t) => t.url)));
    assert(all.lfCur && all.lfCur.tabs.some((t) => (t.url || "") === "about:blank"), "current session holds a fresh empty replacement tab: " + JSON.stringify(all.lfCur && all.lfCur.tabs && all.lfCur.tabs.map((t) => t.url)));
    const live = await evalIn(sender, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => t.url))`);
    assert(live.some((u) => String(u).indexOf("about:blank") !== -1), "live window kept an empty tab, not a closed window: " + JSON.stringify(live));
    // Cleanup: drop the throwaway sessions, trim back to a fresh probe and
    // restore the established current.
    await evalIn(sender, `browser.storage.local.get("lfSessions").then(r => { const a = r.lfSessions || {}; delete a.lfCur; delete a.lfDst; return browser.storage.local.set({ lfSessions: a }); }).then(() => browser.storage.local.set({ lfCurrentSession: "work" })); true`);
    ctx.probe = await ctx.makeProbeTab();
    const freshId = await evalIn(ctx.probe, `browser.tabs.getCurrent().then(t => t ? t.id : null)`);
    await evalIn(ctx.probe, `(async () => {
      const ts = await browser.tabs.query({ currentWindow: true });
      for (const t of ts) {
        if (t.id !== ${freshId} && !t.pinned) { try { await browser.tabs.remove(t.id); } catch (e) {} }
      }
      return true;
    })()`);
    await sleep(400);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
}
