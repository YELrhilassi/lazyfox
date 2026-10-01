// statusbar tests (sessions). Split verbatim from the original
// sessions.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, waitFor } from "../../lib.ts";
import { assert } from "../../harness.ts";
export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("sessions", name, fn);
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
    // Put the overlay in a KNOWN state (ensure, not toggle): this test only
    // cares that the bar shows LEADER when the overlay is off, and a blind
    // toggle would depend on whichever value the previous test left behind.
    await ctx.ensureWhichKey(ctx.tabA, false);
    // Press ; alone: the leader arms, the overlay stays hidden.
    await ctx.press(ctx.tabA, ";");
    const armed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.leaderActive === true ? s : null;
    }, 8000);
    assert(armed && armed.leaderActive === true,
      "leader armed with the overlay off: " + JSON.stringify(armed && { la: armed.leaderActive, st: armed.statusAttr }));
    assert(armed && armed.statusAttr && armed.statusAttr.indexOf("|LEADER|") !== -1,
      "status bar shows LEADER mode while armed: " + JSON.stringify(armed && armed.statusAttr));
    // Escape disarms; the chevron leaves the bar.
    await ctx.press(ctx.tabA, "Escape");
    const disarmed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.leaderActive === false ? s : null;
    }, 8000);
    assert(disarmed && disarmed.leaderActive === false, "Escape disarmed the leader");
    assert(disarmed && disarmed.statusAttr && disarmed.statusAttr.indexOf("|LEADER|") === -1,
      "status bar left LEADER mode after disarm: " + JSON.stringify(disarmed && disarmed.statusAttr));
    // Re-enable the overlay so the rest of the suite runs with hints on.
    await ctx.ensureWhichKey(ctx.tabA, true);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("web page: with the which-key overlay off, the window bar shows LEADER", async () => {
    // The content script owns the leader key on web pages (the chrome helper
    // stays hands-off there), but the window-level status bar is the chrome
    // helper's. The pulsing LEADER chevron must still appear — it is the ONLY
    // visible sign the leader is armed when the which-key overlay is off.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Known state (see above): the assertion is about the bar, not the toggle.
    await ctx.ensureWhichKey(ctx.tabA, false);
    // Press ; alone: the content leader arms, the overlay stays hidden.
    await ctx.press(ctx.tabA, ";");
    // The chrome helper's bar learns of the arm through the per-tab lfLeader
    // session value; wait for the bar to show it (bounded, not a sleep).
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
    await ctx.ensureWhichKey(ctx.tabA, true);
  });
  await t("status bar position: top setting moves the bar", async () => {
    // Config reaches the chrome helper through the #lfc=cfg channel (the same
    // path the options page uses), then the bar re-renders on its 500ms poll.
    const pushCfg = async (partial) => {
      const nonce = "cfgt" + Date.now() + Math.floor(Math.random() * 1e6);
      const payload = encodeURIComponent(JSON.stringify({ config: partial }));
      await evalIn(ctx.probe, `location.hash = "#lfc=cfg.${nonce}.${payload}"`).catch(() => {});
      // The caller waits for the config to actually appear in the bar's state;
      // give the hash channel a moment to be consumed before it is reused.
      await ctx.waitExpr(ctx.probe, `!location.hash.includes("lfc=cfg")`, true, 5000).catch(() => {});
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
}
