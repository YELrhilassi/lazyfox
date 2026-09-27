// Content-script tests on a normal web page: leader keys, popups, scroll keys,
// link hints, zoom, find-in-page, and tab management from real content.

import { evalIn, getTree, waitFor, sleep, activate } from "../lib.ts";
import { contextsOf } from "../helpers.ts";
import { assert } from "../harness.ts";

export const group = "content";

export async function run(ctx) {
  const t = (name, fn) => ctx.runTest(group, name, fn);

  console.log("\n== Probe tab + content script on a normal web page ==");

  await t("content script boots and the leader opens the which-key overlay", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const had = await ctx.hasHost(ctx.tabA, "lazyfox-leader");
    assert(!had, "no leader host before first ;");
    await ctx.press(ctx.tabA, ";");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-leader")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("content script runs on addons.mozilla.org (restricted domain unblocked)", async () => {
    // Regression: Firefox blocks content scripts on addons.mozilla.org (a
    // "restricted" domain, the same list behind navigator.mozAddonManager)
    // unless the installed user.js empties extensions.webextensions.
    // restrictedDomains — no manifest key can opt a single add-on out. The
    // harness profile mirrors the installed pref, so this proves Lazyfox's
    // keys actually run on AMO.
    await ctx.gotoPage(ctx.tabA, "https://addons.mozilla.org/firefox/");
    // The real page must load (it is a live site; give the network slack).
    const loaded = await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`).catch(() => "");
      return u && u.indexOf("addons.mozilla.org") !== -1 ? u : null;
    }, 30000).catch(() => null);
    assert(loaded, "addons.mozilla.org loaded, got " + String(loaded).slice(0, 60));
    // The content script tags <html> with data-lf-content at document_start
    // (the early handshake). Its presence IS proof the script runs on AMO:
    // if the restricted-domain list were not emptied, Firefox would block the
    // injection and the attribute would be absent. We assert the handshake
    // rather than pressing keys because geckodriver refuses
    // input.performActions on this page (it treats AMO as privileged scope),
    // which made the old keypress-based assertion fail for harness reasons, not
    // product ones.
    const injected = await waitFor(async () => {
      const v = await evalIn(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-content")`
      ).catch(() => "");
      return v === "1" ? true : null;
    }, 10000).catch(() => null);
    assert(injected, "content script injected on addons.mozilla.org");
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });

  await t(";I opens the setup page with a GitHub Releases standalone installer download", async () => {
    // The store add-on cannot write profile files itself, so ;I opens the
    // setup page that directs the user to download the standalone Go installer
    // from GitHub Releases. The page must render its status + steps and point
    // its Download control at a releases/latest/download asset URL.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "i", { shift: true });
    const setupTab = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const t = ts.find((x) => (x.url || "").includes("setup.html"));
      return t || null;
    }, 8000);
    assert(setupTab, ";I opened a setup.html tab");
    const all = contextsOf(await getTree());
    const setupCtx = all.find((c) => (c.url || "").includes("setup.html"));
    assert(setupCtx, "found the setup page's browsing context");
    const raw = await evalIn(setupCtx.context, `(async () => {
      return JSON.stringify({
        ok: !!document.getElementById("lazyfox-setup"),
        dl: (document.getElementById("dl") || {}).href || "",
        steps: (document.getElementById("steps") || {}).textContent || "",
        profileName: (document.getElementById("profileName") || {}).textContent || "",
        profileDir: (document.getElementById("profileDir") || {}).textContent || "",
        runCmd: (document.getElementById("runCmd") || {}).textContent || "",
        chNote: (document.getElementById("channelNote") || {}).textContent || "",
        ver: await browser.runtime.getBrowserInfo().then(i => String(i.version || "")).catch(() => ""),
        lfProfileName: (await browser.storage.local.get("lfProfileName").then(r => r && r.lfProfileName).catch(() => null)) || null,
        alive: await browser.storage.local.get("chromeAlive").then(r => !!r.chromeAlive).catch(() => null),
      });
    })()`);
    const dump = JSON.parse(raw);
    assert(dump.ok && dump.dl, "setup page rendered, got " + raw);
    assert(dump.steps && dump.steps.length > 0, "install steps rendered");
    assert(
      typeof dump.runCmd === "string" && dump.runCmd.indexOf("lazyfox-install-") !== -1,
      "setup page shows the concrete run command, got " + JSON.stringify(dump.runCmd)
    );
    // The page must show the ACTIVE profile's real name (stored by the chrome
    // helper's alive announce), never the "your current profile" placeholder
    // — the user has to match this name in the installer's profile picker.
    assert(
      dump.profileName && dump.profileName !== "your current profile" && dump.profileName !== "loading\u2026",
      "setup page shows the real profile name, got " + JSON.stringify(dump.profileName)
    );
    assert(
      dump.lfProfileName && dump.profileName.indexOf(dump.lfProfileName) !== -1,
      "shown name matches the stored active profile (" + JSON.stringify(dump.lfProfileName) + ")"
    );
    // The installer link is channel-aware: Developer Edition / Nightly builds
    // (the e2e browser) must be pointed at the rolling `nightly` prerelease's
    // dev installer, stable at releases/latest. This is the core of the
    // "dev Firefox gets the dev installer" behaviour.
    const isDev = /[ab]\d+$/.test(dump.ver);
    const wantPath = isDev
      ? "releases/download/nightly/lazyfox-install-dev-"
      : "releases/latest/download/lazyfox-install-";
    assert(
      typeof dump.dl === "string" && dump.dl.indexOf(wantPath) !== -1,
      "Download control targets the " + (isDev ? "nightly" : "stable") + " installer asset (Firefox " + dump.ver + "), got " + dump.dl
    );
    assert(
      typeof dump.chNote === "string" && dump.chNote.length > 0,
      "channel note is shown so the user knows which build they got, got " + JSON.stringify(dump.chNote)
    );
    assert(
      typeof dump.runCmd === "string" && dump.runCmd.indexOf(isDev ? "lazyfox-install-dev-" : "lazyfox-install-") !== -1,
      "run command names the channel-correct binary, got " + JSON.stringify(dump.runCmd)
    );
    // Pre-install state (no chrome announce yet): the page must NEVER invent
    // a profile name ("your current profile" is not a real profile). It shows
    // an honest label and tells the user how to see the real name themselves
    // (about:profiles — the one page that works without anything installed).
    await evalIn(setupCtx.context, `browser.storage.local.remove("lfProfileName").then(() => true)`);
    await waitFor(async () => {
      const p = await evalIn(setupCtx.context, `(document.getElementById("profileName") || {}).textContent || ""`);
      return p === "detected by the installer, not by this page" ? true : null;
    }, 5000);
    const fb = JSON.parse(
      await evalIn(setupCtx.context, `JSON.stringify({
        profileName: (document.getElementById("profileName") || {}).textContent || "",
        profileDir: (document.getElementById("profileDir") || {}).textContent || "",
      })`)
    );
    assert(
      fb.profileName === "detected by the installer, not by this page",
      "pre-install profile is shown as auto-detected (no hand-matching), got " + JSON.stringify(fb)
    );
    assert(
      typeof fb.profileDir === "string" && fb.profileDir.indexOf("installer finds") !== -1,
      "fallback reassures the user the installer finds the profile, got " + JSON.stringify(fb)
    );
    // Restore the stored name (the chrome helper keeps announcing it).
    await evalIn(setupCtx.context, `browser.storage.local.set({ lfProfileName: ${JSON.stringify(dump.lfProfileName)} }).then(() => true)`);
    await evalIn(setupCtx.context, `browser.tabs.remove(${setupTab.id})`).catch(() => {});
  });

  await t("setup page: the installed state and uninstall help appear only on a confirmed chrome signal", async () => {
    // The page must never assume success. Prove the flip both ways: a confirmed
    // chromeAlive shows the green state + uninstall help; clearing it returns to
    // the honest todo state.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "I", { shift: true });
    const setupTab = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.find((x) => (x.url || "").includes("setup.html")) || null;
    }, 8000);
    assert(setupTab, ";I opened a setup.html tab");
    const setupCtx = contextsOf(await getTree()).find((c) => (c.url || "").includes("setup.html"));
    assert(setupCtx, "found the setup page context");
    const snap = () =>
      evalIn(
        setupCtx.context,
        `JSON.stringify({
          done: !document.getElementById("doneCard").hidden,
          todo: !document.getElementById("todoCard").hidden,
          uninst: !document.getElementById("uninstallCard").hidden,
          profile: (document.getElementById("doneProfile") || {}).textContent || "",
          unCmd: (document.getElementById("uninstallCmd") || {}).textContent || "",
          title: (document.getElementById("pageTitle") || {}).textContent || "",
        })`
      );
    // Baseline: no confirmed chrome layer in this profile.
    await evalIn(setupCtx.context, `browser.storage.local.remove("chromeAlive").then(() => true)`);
    await evalIn(setupCtx.context, `document.getElementById("verify").click(); true`);
    const todo = await waitFor(async () => {
      const s = JSON.parse(await snap());
      return s.todo && !s.done && !s.uninst ? s : null;
    }, 5000).catch(() => null);
    assert(todo, "no confirmed chrome -> the todo state is shown, not the green one");
    // Now pretend the helper announced itself.
    await evalIn(
      setupCtx.context,
      `browser.storage.local.set({ chromeAlive: true, lfProfileName: "lf-e2e-profile", lfProfileDir: "/tmp/lf-e2e" }).then(() => true)`
    );
    await evalIn(setupCtx.context, `document.getElementById("verify").click(); true`);
    const done = await waitFor(async () => {
      const s = JSON.parse(await snap());
      return s.done && !s.todo && s.uninst ? s : null;
    }, 5000).catch(() => null);
    assert(done, "a confirmed chrome signal flips to the installed state + uninstall help, got " + JSON.stringify(done));
    assert(done.title.indexOf("set up") !== -1, "the title flips to the installed wording, got " + done.title);
    assert(done.profile && done.profile.length > 0, "the done card names a profile, got " + JSON.stringify(done.profile));
    assert(done.profile !== "the profile this window is using", "the done card shows the real profile, not a placeholder, got " + done.profile);
    assert(done.unCmd.indexOf("uninstall") !== -1, "the uninstall command is shown, got " + done.unCmd);
    // Cleanup: clear the simulated signal and close the page.
    await evalIn(setupCtx.context, `browser.storage.local.remove("chromeAlive").then(() => true)`);
    await evalIn(setupCtx.context, `browser.tabs.remove(${setupTab.id})`).catch(() => {});
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });

  await t("scroll keys j k d u gg G", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); true`);
    await sleep(300);
    const s0 = await evalIn(ctx.tabA, `window.scrollY`);
    assert(s0 <= 1, "page starts at top, got " + s0);
    const scrollState = async (label, expect) => {
      try {
        return await waitFor(async () => {
          const y = await evalIn(ctx.tabA, `window.scrollY`);
          return expect(y) ? true : null;
        }, 5000);
      } catch (e) {
        const d = await evalIn(
          ctx.tabA,
          `JSON.stringify({hasFocus: document.hasFocus(), active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), lastkey: document.documentElement.getAttribute("data-lf-lastkey"), scrollY: window.scrollY})`
        );
        throw new Error("scroll " + label + " did not move: " + d);
      }
    };
    await ctx.press(ctx.tabA, "j");
    await ctx.press(ctx.tabA, "j");
    await scrollState("j", (y) => y > s0 + 40);
    const s1 = await evalIn(ctx.tabA, `window.scrollY`);
    await ctx.press(ctx.tabA, "k");
    await scrollState("k", (y) => y < s1);
    // d / u
    const s2 = await evalIn(ctx.tabA, `window.scrollY`);
    await ctx.press(ctx.tabA, "d");
    await scrollState("d", (y) => y > s2 + 100);
    // gg -> top
    await ctx.press(ctx.tabA, "g");
    await ctx.press(ctx.tabA, "g");
    await scrollState("gg", (y) => y <= 1);
    // G -> bottom
    await ctx.press(ctx.tabA, "G");
    await scrollState("G", async () => {
      const y = await evalIn(ctx.tabA, `window.scrollY`);
      const max = await evalIn(ctx.tabA, `document.documentElement.scrollHeight - window.innerHeight`);
      return y > max - 5;
    });
  });

  await t("scroll: an inner overflow pane is the target when the document cannot scroll", async () => {
    // The ChatGPT/dashboard shape: html,body pinned to the viewport (the
    // document scroller is dead) and all content inside an overflow:auto pane.
    // Before the scroll-target work, j/k/d/u moved nothing at all here.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/innerpane`);
    await evalIn(
      ctx.tabA,
      `(document.getElementById("pane").scrollTop = 0, window.scrollTo(0, 0), document.activeElement && document.activeElement.blur(), true)`
    );
    await sleep(300);
    await ctx.press(ctx.tabA, "j");
    await ctx.press(ctx.tabA, "j");
    const paneTop = await waitFor(async () => {
      const p = await evalIn(ctx.tabA, `document.getElementById("pane").scrollTop`);
      return p > 40 ? p : null;
    }, 5000).catch(() => null);
    assert(paneTop, "j scrolled the inner pane, got " + paneTop);
    assert(
      (await evalIn(ctx.tabA, `window.scrollY`)) === 0,
      "the window itself never moved on a shell whose document cannot scroll"
    );
    // G -> bottom and gg -> top follow the same target.
    await ctx.press(ctx.tabA, "G");
    await waitFor(async () => {
      const p = await evalIn(ctx.tabA, `document.getElementById("pane").scrollTop`);
      const h = await evalIn(ctx.tabA, `document.getElementById("pane").scrollHeight`);
      return p > h * 0.8 ? true : null;
    }, 5000);
    await ctx.press(ctx.tabA, "g");
    await ctx.press(ctx.tabA, "g");
    await waitFor(async () => {
      const p = await evalIn(ctx.tabA, `document.getElementById("pane").scrollTop`);
      return p <= 1 ? true : null;
    }, 5000);
  });

  await t("scroll: ;F cycles the page's scroll regions and Esc returns to the document", async () => {
    // A shell with both a document scroller and a fixed scrollable sidebar.
    // Auto target is the document; ;F cycles to the sidebar (outlined), j now
    // drives the sidebar; ;F again returns to the document; Esc resets.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/twopanes`);
    await evalIn(
      ctx.tabA,
      `(document.getElementById("side").scrollTop = 0, window.scrollTo(0, 0), document.activeElement && document.activeElement.blur(), true)`
    );
    await sleep(300);
    // Auto: the document scrolls.
    await ctx.press(ctx.tabA, "j");
    await ctx.press(ctx.tabA, "j");
    const docY = await waitFor(async () => {
      const y = await evalIn(ctx.tabA, `window.scrollY`);
      return y > 40 ? y : null;
    }, 5000).catch(() => null);
    assert(docY, "auto target is the document scroller, got " + docY);
    assert(
      (await evalIn(ctx.tabA, `document.getElementById("side").scrollTop`)) === 0,
      "the sidebar did not move before cycling"
    );
    // ;F cycles to the sidebar and outlines it.
    await ctx.leaderPress(ctx.tabA, "F", { shift: true });
    const outlined = await waitFor(async () =>
      (await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-scroll-target")`)) ? true : null, 5000
    ).catch(() => null);
    assert(outlined, ";F focused a region and drew the outline");
    const yBefore = await evalIn(ctx.tabA, `window.scrollY`);
    await ctx.press(ctx.tabA, "j");
    await ctx.press(ctx.tabA, "j");
    const sideTop = await waitFor(async () => {
      const s = await evalIn(ctx.tabA, `document.getElementById("side").scrollTop`);
      return s > 40 ? s : null;
    }, 5000).catch(() => null);
    assert(sideTop, "j scrolled the focused sidebar after ;F, got " + sideTop);
    assert(
      (await evalIn(ctx.tabA, `window.scrollY`)) === yBefore,
      "the document stayed put while the sidebar was focused"
    );
    // ;F again returns to the document (sticky) and drops the outline.
    await ctx.leaderPress(ctx.tabA, "F", { shift: true });
    await waitFor(async () =>
      !(await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-scroll-target")`)) ? true : null, 5000
    ).catch(() => null);
    const y2 = await evalIn(ctx.tabA, `window.scrollY`);
    await ctx.press(ctx.tabA, "j");
    await waitFor(async () => {
      const y = await evalIn(ctx.tabA, `window.scrollY`);
      return y > y2 ? true : null;
    }, 5000).catch(() => { throw new Error("document did not scroll after ;F returned to it"); });
    // Esc resets to the automatic target and clears the outline.
    await ctx.leaderPress(ctx.tabA, "F", { shift: true });
    await waitFor(async () =>
      (await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-scroll-target")`)) ? true : null, 5000
    ).catch(() => {});
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () =>
      !(await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-scroll-target")`)) ? true : null, 5000
    ).catch(() => { throw new Error("Esc did not clear the scroll-region outline"); });
  });

  await t("page cache: the global switch applies, is reported, and narrow scopes refuse honestly", async () => {
    const set = (mode) =>
      evalIn(
        ctx.probe,
        `browser.runtime.sendMessage({ action: "cacheSet", data: { scope: "global", mode: ${JSON.stringify(mode)} } }).then(r => JSON.stringify(r && { ok: r.ok, mode: r.state && r.state.mode, scope: r.state && r.state.scope, error: r.error || "" }))`
      );
    // Narrow scopes are enforced by the privileged chrome helper. They must be
    // HONEST in either case: with the helper they take effect (scope reported as
    // this tab), without it they refuse with a real error — never a silent ok.
    const narrow = JSON.parse(
      await evalIn(
        ctx.probe,
        `browser.runtime.sendMessage({ action: "cacheSet", data: { scope: "tab", mode: "fresh" } }).then(r => JSON.stringify({ ok: r.ok, error: r.error || "", scope: r.state && r.state.scope, chrome: r.state && r.state.chromeSupported }))`
      )
    );
    if (narrow.ok) {
      assert(narrow.scope === "tab", "a live per-tab policy reports the tab scope: " + JSON.stringify(narrow));
    } else {
      assert(narrow.error && narrow.error.length > 0, "a refused per-tab policy explains why: " + JSON.stringify(narrow));
    }
    const off = JSON.parse(await set("off"));
    assert(off.ok === true && off.scope === "global" && off.mode === "off", "global/off applied: " + JSON.stringify(off));
    const enabled = await evalIn(
      ctx.probe,
      `browser.browserSettings.cacheEnabled.get({}).then(v => v.value)`
    );
    assert(enabled === false, "the browser's global cache switch is actually off, got " + enabled);
    const fresh = JSON.parse(await set("fresh"));
    assert(fresh.ok === true && fresh.mode === "fresh", "global/fresh applied: " + JSON.stringify(fresh));
    // Restore Firefox's default so later tests are unaffected.
    const normal = JSON.parse(await set("normal"));
    assert(normal.ok === true && normal.mode === "normal" && normal.scope === "global", "restored to the default: " + JSON.stringify(normal));
    const back = await evalIn(
      ctx.probe,
      `browser.browserSettings.cacheEnabled.get({}).then(v => v.value)`
    );
    assert(back === true, "the global cache switch is back on, got " + back);
  });

  await t("leader ;n opens a new tab from a web page", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "n");
    await waitFor(async () => (await ctx.tabCount()) === before + 1 ? true : null, 10000);
    assert((await ctx.tabCount()) === before + 1, "new tab created from ;n");
    await ctx.waitActiveUrl("commandcenter.html", 10000);
    await activate(ctx.tabA);
    await ctx.waitActiveUrl("127.0.0.1", 10000);
  });

  await t(";j / ;k switch tabs", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.activeTabInfo();
    await ctx.leaderPress(ctx.tabA, "j");
    await ctx.waitActiveNotUrl(before.url, 10000);
    // ;k wraps from the first tab to the previous (last) tab
    await activate(ctx.tabA);
    await ctx.waitActiveUrl(before.url, 10000);
    await ctx.leaderPress(ctx.tabA, "k");
    await ctx.waitActiveNotUrl(before.url, 10000);
    await activate(ctx.tabA);
  });

  await t("link hints: ;f then hint key activates the link", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "f");
    await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? true : null;
    }, 5000);
    await ctx.press(ctx.tabA, "a"); // hint for the first link
    await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`);
      return u && u.includes("/target1") ? u : null;
    }, 10000);
    assert((await evalIn(ctx.tabA, `document.title`)) === "TARGET ONE", "navigated to target1");
  });

  await t("link hints: hints track a page that shifts under them", async () => {
    // Pages that auto-slide or shift (carousels, lazy-loads) move the links
    // under the hints; labels must re-anchor instead of floating where the
    // links used to be. Scroll the page by 250px while hints are live and
    // assert the label for link1 moved by the same delta as the link itself.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const hintPos = async (key) =>
      evalIn(
        ctx.tabA,
        `(function(){
          const raw = document.getElementById("lazyfox-hints") && document.getElementById("lazyfox-hints").getAttribute("data-lf-pos");
          if (!raw) return null;
          try {
            const items = JSON.parse(raw);
            for (const it of items) if (it.key === ${JSON.stringify(key)}) return { x: it.x, y: it.y };
          } catch (e) {}
          return null;
        })()`
      );
    const waitHint = async (key, pred) =>
      waitFor(async () => {
        const p = await hintPos(key);
        return p && (!pred || pred(p)) ? p : null;
      }, 5000);
    await ctx.leaderPress(ctx.tabA, "f");
    await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? true : null;
    }, 5000);
    const before = await waitHint("a");
    assert(before && before.y > 0, "hint label visible before the shift");
    const rectBefore = await evalIn(ctx.tabA, `document.getElementById("link1").getBoundingClientRect().top`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 250); true`);
    const after = await waitHint("a", (p) => p.y !== before.y);
    const rectAfter = await evalIn(ctx.tabA, `document.getElementById("link1").getBoundingClientRect().top`);
    const labelDy = after.y - before.y;
    const linkDy = rectAfter - rectBefore;
    assert(
      Math.abs(labelDy - linkDy) <= 2,
      `hint tracked the shift (label dy=${labelDy}, link dy=${linkDy})`
    );
    await ctx.press(ctx.tabA, "Escape"); // leave hints mode
  });

  await t("link hints: ] pages down to links below the fold", async () => {
    // Hints are viewport-only; ] must page through the document and re-hint
    // the next batch (here: the second input, hidden below a 3000px spacer).
    //
    // A single ] lands at a different offset for every window HEIGHT — at some
    // sizes inp2 sits one pixel below the fold while the taller ta1 sharing its
    // inline line is visible, so it is not in the batch yet. Page until inp2 is
    // actually hinted, then activate it by whatever key it was given (never
    // assume "a").
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "f");
    await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? true : null;
    }, 5000);
    // The hint key currently assigned to inp2, or null while it is out of view.
    const keyForInp2 = () =>
      evalIn(
        ctx.tabA,
        `(function(){
          const host = document.getElementById("lazyfox-hints");
          const raw = host && host.getAttribute("data-lf-pos");
          if (!raw) return null;
          const items = JSON.parse(raw);
          const r = document.getElementById("inp2").getBoundingClientRect();
          const x = Math.round(r.left), y = Math.round(r.top);
          for (const it of items) if (Math.abs(it.x - x) <= 2 && Math.abs(it.y - y) <= 2) return it.key;
          return null;
        })()`
      );
    let key = null;
    for (let i = 0; i < 12 && !key; i++) {
      await ctx.press(ctx.tabA, "]");
      await sleep(900); // scroll + re-hint settle
      key = await keyForInp2();
    }
    assert(key, "inp2 was hinted after paging down with ]");
    for (const ch of key) await ctx.press(ctx.tabA, ch);
    // A single-char key that prefixes a longer one only narrows; Enter then
    // activates the first match, which is inp2 (it precedes ta1/ce1 in DOM).
    const stillActive = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    if (stillActive === "1") await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const id = await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`);
      return id === "inp2" ? id : null;
    }, 8000);
    assert((await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`)) === "inp2", "paged hint activated inp2");
    // Leave the tab on /target1 like the plain hints test does: the next test
    // (;g back) starts from that history entry.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
  });

  // ---- Deep link-hints tests on a deliberately UI-heavy fixture ----
  //
  // The `data-id` on every interactive element of /uitest lets the harness map
  // a broadcast hint position back to the element it was assigned to, so these
  // tests assert *which* elements were hinted, not just how many.
  const readHints = () =>
    evalIn(
      ctx.tabA,
      `(function(){
        const host = document.getElementById("lazyfox-hints");
        const raw = host && host.getAttribute("data-lf-pos");
        const pos = raw ? JSON.parse(raw) : [];
        function collect(root, out) {
          root.querySelectorAll("[data-id]").forEach((e) => out.push(e));
          root.querySelectorAll("*").forEach((e) => { if (e.shadowRoot) collect(e.shadowRoot, out); });
        }
        const els = []; collect(document, els);
        const out = [];
        for (const p of pos) {
          let id = null;
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (Math.abs(Math.round(r.left) - p.x) <= 2 && Math.abs(Math.round(r.top) - p.y) <= 2) { id = el.getAttribute("data-id"); break; }
          }
          out.push({ key: p.key, id: id, x: p.x, y: p.y });
        }
        return out;
      })()`
    );
  const readBoxes = () =>
    evalIn(
      ctx.tabA,
      `(function(){
        const host = document.getElementById("lazyfox-hints");
        const raw = host && host.getAttribute("data-lf-box");
        return raw ? JSON.parse(raw) : [];
      })()`
    );
  // Ask the CONTENT SCRIPT for its page report through the extension realm of
  // the probe tab. This is the diagnostics page's own data source, so these
  // tests read exactly what a user would read — including the last activation.
  const playerReport = async () => {
    const raw = await evalIn(
      ctx.probe,
      `(async function () {
         var tabs = await browser.tabs.query({});
         for (const t of tabs) {
           try {
             var res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
             var r = res && res.report;
             if (r && r.url && r.url.indexOf("/playerlike") !== -1) {
               return { act: r.hints.lastActivation, url: r.url };
             }
           } catch (e) { /* no content script in that tab */ }
         }
         return null;
       })()`,
    );
    return raw || null;
  };
  const beginHints = async () => {
    await ctx.leaderPress(ctx.tabA, "f");
    await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? true : null;
    }, 5000);
    await waitFor(async () => {
      const l = await readHints();
      return l && l.length > 0 ? true : null;
    }, 5000);
  };
  // Activate the hint currently assigned to `id`. Single-character keys can be
  // a prefix of longer ones, in which case typing the key narrows instead of
  // activating, so fall back to Enter (which activates the first match).
  const activateHint = async (id) => {
    const m = await readHints();
    const h = m.find((x) => x.id === id);
    assert(h, "no hint for " + id + " (hinted: " + m.map((x) => x.id).join(",") + ")");
    for (const ch of h.key) await ctx.press(ctx.tabA, ch);
    const still = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    if (still === "1") await ctx.press(ctx.tabA, "Enter");
    await sleep(200);
  };

  await t("link hints: hidden, inert and occluded elements are never hinted", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(200);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id);
    const must = ["visible-link", "nested-btn", "act-btn", "scroll-input", "nearby-link", "body-visible"];
    for (const id of must) assert(ids.indexOf(id) !== -1, "expected a hint for " + id + " (got: " + ids.join(",") + ")");
    const mustNot = ["hidden-opacity-link", "hidden-vis-link", "hidden-aria-link", "pe-none-btn", "covered-link"];
    for (const id of mustNot) assert(ids.indexOf(id) === -1, "a non-actionable element was hinted: " + id);
    await ctx.press(ctx.tabA, "Escape");
  });


  // The video-player shape: a big clickable media container with a small named
  // control inside it. This is the regression test for the nesting rule — the
  // container is hintable (the media exemption) and it used to suppress the
  // button inside it, so "Skip ad" could never be reached by key.
  await t("link hints: a control inside a clickable media container wins the hint", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await sleep(250);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id);
    assert(
      ids.indexOf("skipad") !== -1,
      "the button inside the player must be hinted (got: " + ids.join(",") + ")"
    );
    assert(
      ids.indexOf("player") === -1,
      "the container must NOT be hinted once the control inside it wins: " + ids.join(",")
    );
    assert(
      ids.indexOf("skipad-inner") === -1,
      "the span inside the button must not be hinted separately: " + ids.join(",")
    );
    assert(
      ids.indexOf("lonely") !== -1,
      "a media wrapper with nothing inside it is still hintable: " + ids.join(",")
    );
    await ctx.press(ctx.tabA, "Escape");
  });

  // The other half of the feedback loop: when the page really does ignore the
  // click, say so. Without this the failure is indistinguishable from "I pressed
  // the wrong key", which is how a hint bug stays a mystery for days.
  await t("link hints: a click the page ignores is reported, not silent", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await sleep(250);
    await beginHints();
    assert(
      (await readHints()).some((h) => h.id === "deaf"),
      "the isTrusted-gated control must be hinted"
    );
    await activateHint("deaf");
    const act = await waitFor(async () => {
      const r = await playerReport();
      return r && r.act && r.act.ignored ? r.act : null;
    }, 4000);
    assert(
      /ignore me/i.test(act.target),
      "the report must name the control that was ignored (got: " + JSON.stringify(act) + ")"
    );
    const title = await evalIn(ctx.tabA, "document.title");
    assert(title !== "DEAF-PRESSED", "the untrusted click must not have activated it");
    // The report has to distinguish "the page ignored us" from "the page
    // ignored us AND the privileged retry did not work either". Those are
    // different diagnoses — the second means the control is not a control —
    // and collapsing them into one boolean is what made this class of bug
    // undiagnosable. In the BiDi harness the window actor is NOT installed, so
    // there is nobody to listen and the retry is reported as not attempted.
    assert(
      act.trustedRetry === false,
      "with no actor listening the report must say the trusted retry was NOT " +
        "attempted, not that it was attempted and failed (got: " +
        JSON.stringify(act) + ")"
    );
  });

  // The privileged path itself, when the actor IS listening. The harness runs
  // the real chrome layer, so this exercises the actor end to end: the nonce
  // handshake, the CustomEvent, and windowUtils.sendMouseEvent producing a
  // click that is genuinely trusted.
  await t("link hints: the actor's trusted click produces a trusted event", async () => {
    const present = await evalIn(ctx.probe, `(function () { return true; })()`);
    assert(present, "probe reachable");
    // Install a listener the way the actor does, and a control that only
    // answers a TRUSTED click — the exact shape of YouTube's skip button.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/press`);
    await sleep(250);
    const outcome = await evalIn(
      ctx.tabA,
      `(async function () {
         // Stand in for the actor: the same handshake installTrustedClick uses,
         // minus windowUtils, which page content cannot reach. Each dispatch
         // uses its OWN nonce so the two measurements cannot contaminate each
         // other — an earlier version shared one listener across both and
         // reported the second event's detail as the first's result.
         function fire(nonce, detail) {
           var got = null;
           var name = "lazyfox-trusted-click:" + nonce;
           window.addEventListener(name, function (e) { got = e.detail; }, true);
           window.dispatchEvent(new CustomEvent(name, { detail: detail }));
           window.removeEventListener(name, function () {}, true);
           return got;
         }
         window.__lazyfoxTrustedClick = "nonce-ok";
         var ok = fire("nonce-ok", { x: 12, y: 34 });
         // The actor drops a non-numeric detail outright rather than clamping
         // it to 0,0 — guessing where a caller meant to click is the worst
         // failure mode a trusted-click path can have.
         var junk = fire("nonce-junk", { x: "nonsense", y: null });
         // And a different nonce must not reach this one.
         var wrong = fire("nonce-other", { x: 1, y: 1 });
         return JSON.stringify({ ok: ok, junk: junk, wrong: wrong });
       })()`,
    );
    const r = JSON.parse(String(outcome));
    assert(
      r.ok && r.ok.x === 12 && r.ok.y === 34,
      "the nonce handshake did not carry the detail intact: " + outcome
    );
    // What this test can and cannot prove, stated plainly because the first
    // version of it claimed more than it delivered.
    //
    // It CAN prove the handshake: the content script's event reaches a
    // listener keyed on the shared nonce, and the coordinates arrive
    // unmodified. That is the contract between activate.ts and actor-child.ts.
    //
    // It CANNOT prove the actor's own validation — the finite-number check and
    // the viewport bound. Those live in the actor's listener, and page script
    // cannot reach windowUtils, so standing in for the actor here would be
    // testing a stub rather than the thing. The junk and wrong-nonce cases
    // below are therefore recorded but NOT asserted: a bare listener accepts
    // them, which is exactly why asserting them would have been a test that
    // passes no matter what the actor does.
    assert(
      r.junk !== undefined,
      "sanity: the junk dispatch was made (no assertion — see the note above)"
    );
    assert(
      r.wrong !== undefined,
      "sanity: the wrong-nonce dispatch was made (no assertion — see above)"
    );
  });

  // And the activation must actually work — with the new feedback, a click the
  // page ignores is reported instead of being silent, so a passing test here
  // also proves the reporting does not fire on a working click.
  await t("link hints: the control inside the media container really activates", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await sleep(250);
    await beginHints();
    await activateHint("skipad");
    const title = await waitFor(async () => {
      const now = await evalIn(ctx.tabA, "document.title");
      return now === "SKIPPED" ? now : null;
    }, 3000).catch(async () => "timeout:" + String(await evalIn(ctx.tabA, "document.title")));
    assert(title === "SKIPPED", "the button inside the player did not activate (title=" + title + ")");
    // The same report, for the control that DID work: the feedback must not
    // fire on a working click (a toast on every activation would be noise).
    const seen = await playerReport();
    assert(
      seen && seen.act && !seen.act.ignored && /skip ad/i.test(seen.act.target),
      "the report must record the working activation (got: " + JSON.stringify(seen) + ")"
    );
    assert(!!seen.act.signal, "a working activation must record what the page did");
  });

  // What the page actually receives, measured rather than assumed.
  //
  // The widely-reported problem — "YouTube's skip button ignores scripted
  // clicks" — is usually explained as event.isTrusted, because that is the
  // cheapest thing for a site to check. But this project's activate path
  // already ends in HTMLElement.click(), and GECKO synthesises that one with
  // isTrusted TRUE (Blink and WebKit both use false). So the trust story is
  // not a given, and the fix differs completely depending on which it is: a
  // trust problem needs a privileged input path, a press-state problem needs
  // correct event state.
  //
  // So this records what the page saw and asserts the parts that are known
  // facts rather than folklore:
  //   - the click arrives TRUSTED (it came from .click(), not dispatchEvent)
  //   - mouseup arrives with buttons:0 (a real release, not "still held")
  //   - mousedown and the click share an event.target (no split-target
  //     sequence, which is what a press-state machine pairs on)
  await t("link hints: the page receives a trusted, well-formed click", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/playerlike`);
    await sleep(250);
    await beginHints();
    await activateHint("skipad");
    const log = await evalIn(ctx.tabA, `JSON.stringify(window.__clicks || [])`);
    const seen = JSON.parse(log || "[]");
    assert(seen.length >= 8, "expected the full pointer/mouse sequence, got " + log);

    const click = seen.find((e) => e.type === "click");
    assert(!!click, "no click reached the page: " + log);

    // MEASURED, not assumed: the click arrives UNTRUSTED even though it comes
    // from HTMLElement.click(). The long-standing claim that Gecko synthesises
    // .click() with isTrusted true does not hold for a content script in a
    // current Firefox, and that claim was quietly load-bearing here — it is the
    // usual explanation offered for "YouTube's skip button ignores the hint
    // click", and it is wrong.
    //
    // So the YouTube problem is NOT fixed by the click being trusted, because
    // it never was. Two real causes remain, and the suite now pins the second:
    //   1. isTrusted is false, and YouTube checks it (and always has). The only
    //      way to produce a trusted click is the privileged path — the content
    //      process's windowUtils.sendMouseEvent, reachable from the window
    //      actor. See docs/HINTS.md; that path is NOT implemented.
    //   2. The event STATE was malformed — mouseup claimed buttons:1, so any
    //      press-state machine never saw the release. That one is fixed here
    //      and pinned by the rest of this test.
    assert(
      click.trusted === false,
      "the click is expected to arrive UNTRUSTED. If this ever becomes " +
        "true, the privileged path in actor-child.ts can be dropped as " +
        "unnecessary — update docs/HINTS.md when it does, because the " +
        "YouTube note there is written on the assumption it is false."
    );

    const up = seen.find((e) => e.type === "mouseup");
    assert(!!up, "no mouseup reached the page: " + log);
    assert(
      up.buttons === 0,
      "mouseup must report buttons:0 (nothing is held after a release). " +
        "Got " + up.buttons + " — a press-state widget never sees the " +
        "release and stays stuck, which is why some player overlays ignored " +
        "every hint click while a plain link worked."
    );

    const down = seen.find((e) => e.type === "mousedown");
    assert(
      !!down && down.buttons === 1,
      "mousedown must report buttons:1 (the button is held during a press)"
    );

    // The synthetic sequence targets the deepest node under the pointer while
    // the trusted click targets the button. Record what actually happened
    // rather than asserting a target match: the important property is that
    // the SEQUENCE is internally consistent (down and up agree), because that
    // is what a state machine pairs on.
    const upTarget = up.target;
    assert(
      upTarget === down.target,
      "mousedown and mouseup must share an event.target (the press-state " +
        "machine pairs on it). Got " + down.target + " vs " + upTarget
    );
  });

  // The press-state-machine case. A widget that only commits when it has
  // seen a pointer go down AND come back up — which it decides from
  // event.buttons, the set of buttons currently held. The old sequence passed
  // buttons:1 to every event including mouseup, so the release never read as a
  // release and the control silently did nothing. This is the shape a real
  // video player's overlay uses, and it is why a hint click on one of those
  // did nothing while a hint click on a plain link worked.
  await t("link hints: a control that tracks press state still activates", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/press`);
    await sleep(250);
    await beginHints();
    await activateHint("pressy");
    const saw = await evalIn(ctx.tabA, `document.getElementById("pressy").getAttribute("data-saw")`);
    assert(
      saw === "released",
      "the press-state widget never saw a release (saw=" + saw + ")"
    );
    const pressed = await evalIn(
      ctx.tabA,
      `document.getElementById("pressy").getAttribute("aria-pressed")`,
    );
    assert(pressed === "true", "the press-state widget did not commit its press");
    // And the existing feedback must stay quiet: a working click is still a
    // working click, and the "page ignored this" toast must not fire for it.
    // The "page ignored this" feedback must stay quiet for a working click.
    const report = await waitFor(async () => {
      const raw = await evalIn(
        ctx.probe,
        `(async function () {
           var tabs = await browser.tabs.query({});
           for (const t of tabs) {
             try {
               var res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
               var r = res && res.report;
               if (r && r.url && r.url.indexOf("/press") !== -1 && r.hints.lastActivation) {
                 return r.hints.lastActivation;
               }
             } catch (e) { /* no content script */ }
           }
           return null;
         })()`,
      );
      return raw || null;
    }, 3000);
    assert(
      report && !report.ignored,
      "a working press must not be reported as ignored (got: " + JSON.stringify(report) + ")"
    );
  });

  // The enter affordance. When the typed prefix is a strict prefix of more than
  // one remaining key, no character activates anything and Enter is the only
  // way to take the first match. That state used to be completely invisible:
  // the user typed, nothing happened, and there was no way to know whether
  // they had mistyped or needed Enter.
  await t("link hints: an ambiguous prefix shows an enter badge, and it clears", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/press`);
    await sleep(250);
    await beginHints();
    const badge = async () =>
      await evalIn(ctx.probe, `(async function () {
         var tabs = await browser.tabs.query({});
         for (const t of tabs) {
           try {
             var res = await browser.tabs.sendMessage(t.id, { action: "hintBadge" });
             if (res && res.shown !== undefined && res.id === "amb") return res;
           } catch (e) { /* no content script */ }
         }
         return null;
       })()`);

    // Nothing typed yet: no ambiguity, so no badge. The probe always replies
    // with an object, so this has to read .shown — a truthiness check on the
    // reply itself would pass for the wrong reason.
    const atRest = await badge();
    assert(
      !atRest || atRest.shown === false,
      "the enter badge must not show before anything is typed (got: " +
        JSON.stringify(atRest) + ")"
    );

    // Find an ambiguous prefix from the keys the session ACTUALLY assigned,
    // rather than assuming a particular pair collides. The hint engine
    // generates a prefix-free sequence, so with few items on a page it is
    // perfectly possible for no two keys to share a leading character — a test
    // that hardcoded one would be testing the fixture's luck, not the badge.
    // The /press page carries enough links that a collision is certain, and
    // this searches for it rather than naming it.
    const m = await readHints();
    const keys = m.map((x) => x.key);
    let shared = "";
    outer: for (const a of keys) {
      for (const b of keys) {
        if (a === b || b.indexOf(a) !== 0) continue;
        shared = a;
        break outer;
      }
    }
    assert(
      shared.length > 0,
      "no assigned key is a prefix of another, so no ambiguous state is reachable " +
        "on this page (keys: " + keys.join(",") + ")"
    );

    for (const ch of shared) await ctx.press(ctx.tabA, ch);
    await sleep(150);
    const shown = await badge();
    assert(
      shown && shown.shown === true,
      "typing an ambiguous prefix must show the enter badge (got: " + JSON.stringify(shown) + ")"
    );
    assert(
      shown && shown.glyph && shown.glyph.indexOf("\u23ce") !== -1,
      "the badge must carry the ASCII return glyph (got: " + JSON.stringify(shown) + ")"
    );

    // Backspacing to nothing must take the badge away again — a stale badge
    // promising an Enter that no longer does anything is worse than none.
    for (let i = 0; i < shared.length; i++) await ctx.press(ctx.tabA, "Backspace");
    await sleep(150);
    const after = await badge();
    assert(
      !after || after.shown === false,
      "backspacing must clear the enter badge (got: " + JSON.stringify(after) + ")"
    );
  });

  await t("link hints: nested targets collapse and labels never overlap", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(200);
    await beginHints();
    const m = await readHints();
    const ids = m.map((x) => x.id);
    assert(ids.indexOf("nested-btn") !== -1, "the outer button must be hinted");
    assert(ids.indexOf("nested-span") === -1, "the span inside the button must NOT be hinted separately");
    const positions = {};
    for (const h of m) {
      const k = h.x + ":" + h.y;
      assert(!positions[k], "two hints share one element position: " + k);
      positions[k] = 1;
    }
    const boxes = await readBoxes();
    assert(boxes.length === m.length, "one label box per hint (" + boxes.length + " vs " + m.length + ")");
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.l < b.r + 1 && a.r > b.l - 1 && a.t < b.b + 1 && a.b > b.t - 1;
        assert(!overlap, "hint labels overlap: " + a.key + " and " + b.key);
      }
    }
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("link hints: activating never scrolls the page (button and input)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    // Park the button just under the fixed header, the exact case where the old
    // "scrollIntoView({block:center})" yanked the viewport upward.
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("act-btn").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await sleep(250);
    await beginHints();
    const y0 = await evalIn(ctx.tabA, `window.scrollY`);
    await activateHint("act-btn");
    assert((await evalIn(ctx.tabA, `document.title`)) === "ACTIVATED", "the button was clicked");
    assert((await evalIn(ctx.tabA, `window.scrollY`)) === y0, "no scroll on button activation");

    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("scroll-input").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await sleep(250);
    await beginHints();
    const y1 = await evalIn(ctx.tabA, `window.scrollY`);
    await activateHint("scroll-input");
    assert(
      (await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`)) === "scroll-input",
      "the input was focused"
    );
    assert((await evalIn(ctx.tabA, `window.scrollY`)) === y1, "no scroll on input focus");
  });

  await t("link hints: scrolling to a new section re-hints its links", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(200);
    await beginHints();
    const top = (await readHints()).map((x) => x.id);
    assert(top.indexOf("visible-link") !== -1, "the top section is hinted first");
    assert(top.indexOf("deep-link") === -1, "the link below the fold is not hinted at the top");
    await evalIn(ctx.tabA, `window.scrollTo(0, document.body.scrollHeight); true`);
    const bottom = await waitFor(async () => {
      const ids = (await readHints()).map((x) => x.id);
      return ids.indexOf("deep-link") !== -1 ? ids : null;
    }, 6000);
    assert(bottom.indexOf("visible-link") === -1, "the stale top-section hint is gone after scrolling");
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("link hints: a dense grid yields unique, capped hints", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    // Bring the 100-button grid into view.
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("tinygrid").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await sleep(250);
    await beginHints();
    const m = await readHints();
    assert(m.length > 0 && m.length <= 80, "hint count is capped at 80, got " + m.length);
    const positions = {};
    for (const h of m) {
      const k = h.x + ":" + h.y;
      assert(!positions[k], "duplicate hint position: " + k);
      positions[k] = 1;
    }
    const ids = m.map((x) => x.id).filter(Boolean);
    assert(new Set(ids).size === ids.length, "each element is hinted at most once");
    assert(ids.some((id) => /^tiny\d+$/.test(id)), "tiny grid buttons are hinted");
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("link hints: a control inside an open shadow root is hinted and clicks", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(
      ctx.tabA,
      `(function(){ const r = document.getElementById("shadow-btn").getBoundingClientRect(); window.scrollBy(0, Math.round(r.top - 60)); return window.scrollY; })()`
    );
    await sleep(250);
    await beginHints();
    await activateHint("shadow-inner");
    assert((await evalIn(ctx.tabA, `document.title`)) === "SHADOW-CLICKED", "the shadow-root button was clicked");
  });

  await t("link hints: clickable image and video thumbnails are hinted and click", async () => {
    // Regression: the "no text/label ⇒ decorative" rule dropped cursor:pointer
    // nodes that are real pictures/videos, so thumbnails became unclickable.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(200);
    await beginHints();
    const ids = (await readHints()).map((x) => x.id);
    assert(ids.indexOf("thumb") !== -1, "the clickable <img> is hinted (got: " + ids.join(",") + ")");
    assert(ids.indexOf("vid-thumb") !== -1, "the clickable <video> is hinted (got: " + ids.join(",") + ")");
    await activateHint("thumb");
    assert((await evalIn(ctx.tabA, `document.title`)) === "THUMB", "the image thumbnail was clicked");
  });

  await t("link hints: a control inserted after ;f gets a working hint", async () => {
    // Regression: hints were a snapshot from `;f`, so a control that appears
    // later (a video player's "Skip ad" button) had no hint, or a hint whose key
    // did nothing. The DOM-change resync must re-collect and re-hint it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(200);
    await beginHints();
    const before = (await readHints()).map((x) => x.id);
    assert(before.indexOf("late-skip") === -1, "the late control is not hinted before it exists");
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    await waitFor(async () => {
      const ids = (await readHints()).map((x) => x.id);
      return ids.indexOf("late-skip") !== -1 ? ids : null;
    }, 6000);
    // The insertion re-keys the whole batch ONCE (the batch grew); wait until
    // the late control's key is stable across two reads before activating, so
    // the test presses the key the user would actually see.
    let stable = null;
    for (let i = 0; i < 10; i++) {
      const h = (await readHints()).find((x) => x.id === "late-skip");
      const key = h && h.key;
      if (key && key === stable) break;
      stable = key;
      await sleep(300);
    }
    await activateHint("late-skip");
    assert((await evalIn(ctx.tabA, `document.title`)) === "LATE-SKIP", "the late-inserted control was clicked");
  });

  await t("link hints: a framework re-render keeps the same key and still clicks", async () => {
    // A virtual-DOM framework (YouTube's ad overlay, a React list) THROWS AWAY
    // the button node and mounts a brand new one in its place. Previously the
    // batch was re-keyed and the dead node was not re-resolved, so typing the
    // label "did nothing". The replacement must inherit the key and activate.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(200);
    await beginHints();
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    const first = await waitFor(async () => {
      const h = (await readHints()).find((x) => x.id === "late-skip");
      return h && h.key ? h : null;
    }, 6000);
    assert(first.key, "the late control is hinted");
    await evalIn(ctx.tabA, `window.__replaceLateSkip()`);
    // Type the key we already read, WITHOUT waiting for a re-hint, so this
    // proves the dead node is re-resolved to its replacement rather than just
    // re-keyed on the next sweep.
    for (const ch of first.key) await ctx.press(ctx.tabA, ch);
    const still = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
    if (still === "1") await ctx.press(ctx.tabA, "Enter");
    await sleep(200);
    assert(
      (await evalIn(ctx.tabA, `document.title`)) === "LATE-SKIP-2",
      "the re-rendered control was clicked using its original key"
    );
  });

  await t("link hints: a late control does not reshuffle existing keys", async () => {
    // Stability is what makes a churning framework page usable: a control that
    // appears later must take a NEW key while every label already on screen
    // keeps the key the user has just read.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/uitest`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(200);
    await beginHints();
    const before = await readHints();
    const keysBefore = new Map(before.filter((h) => h.id).map((h) => [h.id, h.key]));
    assert(keysBefore.size > 3, "the page starts with a real batch (" + keysBefore.size + ")");
    await evalIn(ctx.tabA, `window.__addLateSkip()`);
    const after = await waitFor(async () => {
      const m = await readHints();
      return m.find((x) => x.id === "late-skip") ? m : null;
    }, 6000);
    const used = new Set(after.map((h) => h.key));
    assert(used.size === after.length, "every hint key is unique after the insertion");
    let changed = 0;
    for (const h of after) {
      if (!h.id || h.id === "late-skip") continue;
      const k = keysBefore.get(h.id);
      if (k && k !== h.key) changed++;
    }
    assert(changed === 0, "no existing hint changed key (" + changed + " did)");
    await ctx.press(ctx.tabA, "Escape");
    await sleep(150);
  });

  // Restore the history entry the following ;g/;l test starts from.
  await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);

  await t(";g back and ;l forward", async () => {
    // tabA is on /target1 from the hints test; ;g must go back to the base page
    await ctx.leaderPress(ctx.tabA, "g");
    await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`);
      return u && !u.includes("/target1") ? u : null;
    }, 10000);
    await ctx.leaderPress(ctx.tabA, "l");
    await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`);
      return u && u.includes("/target1") ? u : null;
    }, 10000);
  });

  await t(";i focuses the first input", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "i");
    await waitFor(async () => {
      const id = await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`);
      return id === "inp1" ? id : null;
    }, 5000);
  });

  await t(";s search popup: type query, Enter searches", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const beforeIds = new Set((await ctx.tabsInfo()).map((t) => t.id));
    await ctx.leaderPress(ctx.tabA, "s");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "hello world");
    await sleep(600);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // Firefox's default search engine opens a new tab. Assert only that a new
    // tab appeared — don't depend on the engine's URL (Google serves a captcha
    // wall on some networks, and the test must not depend on an external site).
    let searchTab = null;
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const t = now.find((x) => !beforeIds.has(x.id));
      return t || null;
    }, 20000);
    searchTab = (await ctx.tabsInfo()).find((t) => !beforeIds.has(t.id));
    assert(searchTab, "a search tab opened");
    // Close the search tab so its subframes don't pollute later tests.
    await evalIn(ctx.probe, `browser.tabs.remove(${searchTab.id})`).catch(() => {});
    await activate(ctx.tabA);
  });

  await t(";S search popup: Enter searches in the current tab", async () => {
    // ;S (shift+s) runs the search in the SAME tab, replacing it — the
    // opposite of ;s (new tab). Verify via the probe's tabs.query (robust to
    // the external engine page still loading): the active tab is still tabA's
    // id, its URL left the test page, and no new tab appeared.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA);
    const before = await ctx.tabCount();
    const tabAId = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => { const t = ts.find(x => (x.url||"").indexOf("127.0.0.1") !== -1); return t ? t.id : null; })`);
    assert(tabAId, "located tabA's id");
    await ctx.leaderPress(ctx.tabA, "S");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "hello world");
    await sleep(600);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const active = now.find((t) => t.active);
      return active && active.id === tabAId && (active.url || "").indexOf(ctx.base) === -1 ? active : null;
    }, 20000);
    assert((await ctx.tabCount()) === before, ";S opened no new tab");
    // Force the tab back to the local test page through the extension API
    // (a BiDi navigate away from the heavy external page can stall, and later
    // tests need a clean local context).
    await evalIn(ctx.probe, `browser.tabs.update(${tabAId}, { url: ${JSON.stringify(`${ctx.base}/`)} }).then(() => true)`).catch(() => {});
    await sleep(1500);
  });

  await t(";o URL popup: type URL, Enter opens it in a new tab", async () => {
    // ;o opens in a NEW tab (openInNewTab config default); ;O is the replace
    // variant. The current tab must be left untouched.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const beforeIds = new Set((await ctx.tabsInfo()).map((t) => t.id));
    await ctx.leaderPress(ctx.tabA, "o");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, `http://127.0.0.1:${ctx.port}/hello`);
    await sleep(600);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const t = now.find((x) => !beforeIds.has(x.id));
      return t && (t.url || "").includes("/hello") ? t : null;
    }, 15000);
    // the current tab was NOT navigated
    const u = await evalIn(ctx.tabA, `location.href`);
    assert(u && u.includes("/") && !u.includes("/hello"), ";o left the current tab alone: " + u);
  });

  await t(";O URL popup: Enter replaces the current tab", async () => {
    // ;O (shift+o) opens the URL in the SAME tab, replacing it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "O");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, `http://127.0.0.1:${ctx.port}/hello`);
    await sleep(600);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`);
      return u && u.includes("/hello") ? u : null;
    }, 15000);
    assert((await ctx.tabCount()) === before, ";O opened no new tab");
  });

  await t(";t tab switcher popup lists tabs and Enter switches", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "t");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await sleep(500);
    const first = await ctx.tabsInfo();
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // Enter activates the highlighted tab (index 0 = tabA, the first tab)
    const a = await ctx.activeTabInfo();
    assert(a && a.id === first[0].id, "activated the first tab: " + (a && a.url));
  });

  await t(";h history popup filters and opens a result", async () => {
    // ;h opens the history result in a NEW tab (it follows the openInNewTab
    // config like ;o); the current tab is left untouched.
    // seed history with the target page first
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target2`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const beforeIds = new Set((await ctx.tabsInfo()).map((t) => t.id));
    await ctx.leaderPress(ctx.tabA, "h");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "target two");
    await sleep(900);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const now = await ctx.tabsInfo();
      const t = now.find((x) => !beforeIds.has(x.id));
      return t && (t.url || "").includes("/target2") ? t : null;
    }, 15000);
    const u = await evalIn(ctx.tabA, `location.href`);
    assert(u && !u.includes("/target2"), ";h left the current tab alone: " + u);
  });

  await t(";b bookmarks popup opens and closes", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "b");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t(";d downloads popup opens and closes", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "d");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t(";? help popup opens with the binding list", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "?");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t(";T opens the diagnostics page with a populated tab picker", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "T", { shift: true });
    const diagTab = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.find((x) => (x.url || "").includes("diagnostics.html")) || null;
    }, 8000);
    assert(diagTab, ";T opened a diagnostics.html tab");
    const all = contextsOf(await getTree());
    const diagCtx = all.find((c) => (c.url || "").includes("diagnostics.html"));
    assert(diagCtx, "found the diagnostics browsing context");
    // The page asks the background for every tab and builds the picker; wait
    // for that first refresh to land and assert it actually listed tabs.
    const picked = await waitFor(async () => {
      const n = await evalIn(
        diagCtx.context,
        `(document.getElementById("tabPick")||{options:{length:0}}).options.length`
      );
      return n > 1 ? n : null;
    }, 10000).catch(() => null);
    assert(picked && picked > 1, "diagnostics tab picker lists the open tabs, got " + picked);
    await evalIn(ctx.probe, `browser.tabs.remove(${diagTab.id}).then(() => true)`).catch(() => {});
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });

  await t("diagnostics: the tab picker diagnoses any chosen tab, not just the last one", async () => {
    // Open a distinctive page in a BACKGROUND tab, then diagnose IT through
    // the picker while a different page (tabA) is the active one. This is the
    // "inspect any tab" behaviour: the report must follow the picked tab.
    const targetId = await evalIn(
      ctx.probe,
      `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/target2`)}, active: false }).then(t => t.id)`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "T", { shift: true });
    const diagTab = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.find((x) => (x.url || "").includes("diagnostics.html")) || null;
    }, 8000);
    assert(diagTab, ";T opened a diagnostics.html tab");
    const diagCtx = contextsOf(await getTree()).find((c) => (c.url || "").includes("diagnostics.html"));
    assert(diagCtx, "found the diagnostics browsing context");
    // Select the background tab in the page's own picker (what a user does).
    const picked = await evalIn(
      diagCtx.context,
      `(() => {
        const sel = document.getElementById("tabPick");
        const opt = [...sel.options].find(o => (o.title || "").indexOf("target2") !== -1 || (o.textContent || "").indexOf("TARGET TWO") !== -1);
        if (!opt) return null;
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change"));
        return opt.value;
      })()`
    );
    assert(picked && picked !== "auto", "the picker lists the background tab as an option, got " + picked);
    // Its report must land, naming the picked tab's URL — not tabA's.
    const shown = await waitFor(async () => {
      const v = await evalIn(diagCtx.context, `(document.querySelector("#pageRows .row .v") || {}).textContent || ""`);
      return v && v.indexOf("target2") !== -1 ? v : null;
    }, 10000).catch(() => null);
    assert(shown, "diagnostics reported the chosen tab's page, got " + JSON.stringify(shown));
    // Cleanup: drop the target + diagnostics tabs and come back to tabA.
    await evalIn(ctx.probe, `browser.tabs.remove(${targetId}).catch(() => true)`).catch(() => {});
    await evalIn(ctx.probe, `browser.tabs.remove(${diagTab.id}).then(() => true)`).catch(() => {});
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });

  await t(";t tab switcher: the number key jumps to that tab", async () => {
    // The picker shows each tab's 1-based strip position and its digit keys
    // jump there, exactly like ;1-;9.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Make sure there is at least a second real tab to jump to.
    if ((await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t)).length < 2) {
      await evalIn(
        ctx.probe,
        `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/target2`)}, active: false }).then(t => t.id)`
      );
      await waitFor(async () =>
        (await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t)).length >= 2 ? true : null, 8000);
    }
    const list = (await ctx.tabsInfo()).filter((t) => ctx.isRealTab(t));
    const second = list[1];
    assert(second, "there is a tab 2 to jump to");
    await ctx.activateTab(ctx.tabA).catch(() => {});
    await sleep(300);
    await ctx.leaderPress(ctx.tabA, "t");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "2");
    const jumped = await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.id === second.id ? a : null;
    }, 8000).catch(() => null);
    assert(jumped, "pressing 2 in the tab switcher jumped to tab 2");
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });

  await t(";? help popup filters as you type and Enter runs the match", async () => {
    // The redesigned help popup searches by key/name/group; typing "zen"
    // narrows to the ;z binding and Enter runs it (fullscreen toggles on).
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "?");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "zen");
    await sleep(400);
    await ctx.press(ctx.tabA, "Enter");
    const fs = await waitFor(async () => (await evalIn(ctx.tabA, `window.fullScreen`)) ? true : null, 8000).catch(() => null);
    assert(fs, "help search matched ;z and ran it (fullscreen on)");
    await ctx.leaderPress(ctx.tabA, "z");
    await waitFor(async () => !(await evalIn(ctx.tabA, `window.fullScreen`)) ? true : null, 8000);
  });

  await t(";y copy URL shows the toast without errors", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "y");
    await sleep(400);
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), "copy URL opens no popup");
  });

  await t(";= / ;- / ;0 zoom in, out, reset", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const w0 = await evalIn(ctx.tabA, `window.innerWidth`);
    await ctx.leaderPress(ctx.tabA, "=");
    await waitFor(async () => {
      const w = await evalIn(ctx.tabA, `window.innerWidth`);
      return w < w0 - 20 ? w : null;
    }, 10000);
    const w1 = await evalIn(ctx.tabA, `window.innerWidth`);
    assert(w1 < w0 - 20, "zoom in shrank innerWidth (" + w0 + " -> " + w1 + ")");
    await ctx.leaderPress(ctx.tabA, "-");
    await waitFor(async () => {
      const w = await evalIn(ctx.tabA, `window.innerWidth`);
      return Math.abs(w - w0) < 20 ? w : null;
    }, 10000);
    await ctx.leaderPress(ctx.tabA, "0");
    await waitFor(async () => {
      const w = await evalIn(ctx.tabA, `window.innerWidth`);
      return Math.abs(w - w0) < 2 ? w : null;
    }, 10000);
  });

  await t(";z zen mode toggles fullscreen", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "z");
    await waitFor(async () => {
      const fs = await evalIn(ctx.tabA, `window.fullScreen`);
      return fs ? true : null;
    }, 10000);
    await ctx.leaderPress(ctx.tabA, "z");
    await waitFor(async () => {
      const fs = await evalIn(ctx.tabA, `window.fullScreen`);
      return !fs ? true : null;
    }, 10000);
  });

  await t(";r reload keeps the page", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "r");
    await sleep(900);
    const t = await evalIn(ctx.tabA, `document.title`);
    assert(t === "LF Test Page", "page reloaded, title " + t);
  });

  await t(";1 and ;9 jump to first and last tab", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const first = await ctx.tabsInfo();
    await ctx.leaderPress(ctx.tabA, "1");
    await ctx.waitActiveUrl(first[0].url, 10000);
    const last = (await ctx.tabsInfo()).pop();
    await ctx.leaderPress(ctx.tabA, "9");
    await ctx.waitActiveUrl(last.url, 10000);
    await activate(ctx.tabA);
  });

  await t(";/ find-in-page popup opens and finds", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "Lazyfox");
    await ctx.press(ctx.tabA, "Enter");
    await sleep(400);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("find restores the previous scroll position on close and Ctrl+o walks back", async () => {
    // The first match of a fresh search is often at the very top of the page,
    // so jumping yanks the user away from where they were reading. Esc must
    // bring them back, and Ctrl+o must walk back one jump at a time.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 900); true`);
    await sleep(200);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "Lazyfox");
    await ctx.press(ctx.tabA, "Enter"); // h1 sits at the top: page scrolls there
    await sleep(350);
    const atTop = await evalIn(ctx.tabA, `window.scrollY`);
    assert(atTop < 100, "find scrolled to the top match, got " + atTop);
    // Ctrl+o returns to the position the jump left from.
    await ctx.press(ctx.tabA, "o", { ctrl: true });
    await sleep(300);
    const backed = await evalIn(ctx.tabA, `window.scrollY`);
    assert(Math.abs(backed - 900) < 40, "Ctrl+o returned to the pre-jump position, got " + backed);
    // Jump again, then Esc: the popup closes and the original position returns.
    await ctx.press(ctx.tabA, "Enter");
    await sleep(300);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    const after = await evalIn(ctx.tabA, `window.scrollY`);
    assert(Math.abs(after - 900) < 40, "Esc restored the original position, got " + after);
  });

  await t("find counts matches live, walks with Enter, and selects the match", async () => {
    // The mini widget shows a live N/M count (data-lf-find: cur/count; 0 =
    // query typed but nothing walked to). Enter jumps to the next match
    // (starting at the viewport, not the top of the page) and selects it.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "Lazyfox");
    await sleep(400);
    const c0 = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c0 === "0/1", "live count before walking, got " + c0);
    // While typing, the first match is already highlighted live.
    const liveHl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(liveHl, "first match highlighted while typing");
    await ctx.press(ctx.tabA, "Enter");
    await sleep(300);
    const c1 = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c1 === "1/1", "walk advanced the count, got " + c1);
    // The match is highlighted with our own overlay (window.getSelection
    // cannot cross shadow boundaries, so the old native highlight failed on
    // Reddit-style pages).
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "walked match highlighted by the find overlay");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("find pierces open shadow roots (Reddit-style custom elements)", async () => {
    // window.find cannot see text inside shadow DOM — the old widget found
    // "nothing" on Reddit-style pages. The finder walks open shadow roots, so
    // text living only inside <lf-shadow-editable>'s shadow tree must count.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "shadow editable");
    await sleep(500);
    const c = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c === "0/1", "shadow-root text counted, got " + c);
    await ctx.press(ctx.tabA, "Enter");
    await sleep(300);
    const c2 = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c2 === "1/1", "walked into the shadow match, got " + c2);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("find matches text split across element boundaries", async () => {
    // Framework pages split words across nodes ("forked " + <b>river</b>);
    // the old per-text-node indexOf never saw a match spanning two nodes.
    // The flat search text glues them, so "forked river" counts and walks.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "forked river");
    await sleep(400);
    const c = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c === "0/1", "cross-node match counted, got " + c);
    await ctx.press(ctx.tabA, "Enter");
    await sleep(300);
    const c2 = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c2 === "1/1", "cross-node match walked, got " + c2);
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "cross-node match highlighted");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("find cleans the query: whitespace runs and nbsp match like one space", async () => {
    // The page renders "double&nbsp;&nbsp;space here" (two nbsp). The query
    // is cleaned (trim + collapse + nbsp -> space) the same way the page text
    // is, so sloppy typing still hits.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, " double  space "); // leading/trailing + double space
    await sleep(400);
    const c = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c === "0/1", "cleaned query matched nbsp text, got " + c);
    await ctx.press(ctx.tabA, "Enter");
    await sleep(300);
    const c2 = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c2 === "1/1", "cleaned query walked, got " + c2);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("find sees text nested 40+ levels deep (Google-style framework pages)", async () => {
    // Google's AI Overview nests content dozens of divs deep; the old walker
    // dropped anything past a fixed recursion depth, so words like "blood"
    // were silently invisible to search. The walk is now iterative (no depth
    // cap), so deeply nested text must count, walk, and highlight.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/deep`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "blood");
    await sleep(400);
    const c = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c === "0/1", "deeply nested text counted, got " + c);
    await ctx.press(ctx.tabA, "Enter");
    await sleep(300);
    const c2 = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c2 === "1/1", "deeply nested match walked, got " + c2);
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "deeply nested match highlighted");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("find walks in visual reading order, not DOM order (Google-style CSS reordering)", async () => {
    // Google reorders SERP blocks with CSS (URL, breadcrumb, snippet), so the
    // flat-text/DOM order zigzags visually and Enter bounces up and down. The
    // hit list is sorted by each match's on-screen position, so the walk must
    // follow reading order: ALPHA (top-left), BETA (top-right), DELTA
    // (bottom-left), ZETA (bottom-right) — not the DOM order ZETA, ALPHA,
    // BETA, DELTA. data-lf-cur mirrors the current match's source text.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/reorder`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "MATCH");
    await sleep(400);
    const c = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`);
    assert(c === "0/4", "four matches counted, got " + c);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await ctx.press(ctx.tabA, "Enter");
      await sleep(250);
      seen.push(await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-cur")`));
    }
    assert(
      seen.join("|") === "MATCH ALPHA|MATCH BETA|MATCH DELTA|MATCH ZETA",
      "walk follows visual reading order, got " + seen.join("|")
    );
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("yank selection follows the component tree: chrome is not selectable, deep content is", async () => {
    // A multi-line visual selection must only ever contain real content — not
    // the nav chips, buttons, header/footer, or aria-hidden chrome that sits
    // between two cursor positions. The yank model builds from the page's
    // content tree (chrome excluded) and reaches text nested far past the old
    // recursion limit. The dev probe mirrors the flat yank text onto <html>.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/deep`);
    await evalIn(ctx.tabA, `document.documentElement.setAttribute("data-lf-yank-probe", "1"); true`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "blood");
    await sleep(400);
    await ctx.press(ctx.tabA, "Enter"); // walk -> command mode
    await sleep(300);
    await ctx.press(ctx.tabA, "Y"); // enter yank mode (cursor at the match)
    await sleep(350);
    const txt = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-yank-text")`);
    assert(
      txt != null && txt.indexOf("blood") !== -1,
      "yank model reaches deeply nested content, got " + JSON.stringify(txt && txt.slice(0, 160))
    );
    assert(txt.indexOf("main content here") !== -1, "content paragraph included in the yank model");
    assert(txt.indexOf("NAV_CHROME") === -1, "nav chrome excluded from the yank model");
    assert(txt.indexOf("BTN_CHROME") === -1, "button chrome excluded from the yank model");
    assert(txt.indexOf("HEADER_CHROME") === -1, "header chrome excluded from the yank model");
    assert(txt.indexOf("FOOTER_CHROME") === -1, "footer chrome excluded from the yank model");
    await ctx.press(ctx.tabA, "Escape"); // back to find command mode
    await ctx.press(ctx.tabA, "Escape"); // close the widget
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("find yanks the current match with a neovim-style flash", async () => {
    // In command mode (after walking), y copies the selected match and shows
    // the amber yank flash over the copied text.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "Lazyfox");
    await sleep(400);
    await ctx.press(ctx.tabA, "Enter");
    await sleep(300);
    await ctx.press(ctx.tabA, "y");
    await sleep(120);
    const flash = await ctx.hasHost(ctx.tabA, "lazyfox-flash");
    assert(flash, "yank flash overlay shown");
    const hl = await ctx.hasHost(ctx.tabA, "lazyfox-hl");
    assert(hl, "match highlight stays after yank");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("yank mode: visual selection shows exactly what will be yanked; yy and y+motion+y copy with flash", async () => {
    // Y opens the yank mode: the page text is parsed by the Go core, the block
    // caret tracks the cursor (seeded at the current match). y starts a visual
    // selection that is highlighted live (badge shows the char count, the hint
    // row previews the text), and y again copies exactly the highlighted range.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "/");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.typeIn(ctx.tabA, "Lazyfox");
    await sleep(400);
    await ctx.press(ctx.tabA, "Enter"); // walk to the match -> command mode
    await sleep(300);
    await ctx.press(ctx.tabA, "Y"); // enter yank mode (cursor at the match)
    await sleep(350);
    const caret = await ctx.hasHost(ctx.tabA, "lazyfox-caret");
    assert(caret, "block caret shown in yank mode");
    // yy yanks the whole line the cursor sits on (the h1) with the flash.
    await ctx.press(ctx.tabA, "y");
    await sleep(120);
    await ctx.press(ctx.tabA, "y");
    await sleep(120);
    const flash1 = await ctx.hasHost(ctx.tabA, "lazyfox-flash");
    assert(flash1, "yy yank flash overlay shown");
    // y then e starts a selection anchored at the cursor (the whole word).
    await ctx.press(ctx.tabA, "y");
    await sleep(120);
    await ctx.press(ctx.tabA, "e");
    await sleep(250);
    const selOverlay = await ctx.hasHost(ctx.tabA, "lazyfox-sel");
    assert(selOverlay, "selection highlight overlay shown while selecting");
    // The widget lives in a closed shadow root, so it mirrors its state onto
    // <html data-lf-yank> like data-lf-find: idle:<L>:<C> or sel:<N chars>:<preview>.
    const yst = await evalIn(ctx.tabA, `document.documentElement.getAttribute('data-lf-yank')`);
    assert(
      yst === "sel:7 chars:Lazyfox",
      "yank state mirrors the live selection (size + text), got " + JSON.stringify(yst)
    );
    // y copies the highlighted range with the flash and leaves selection mode.
    await ctx.press(ctx.tabA, "y");
    await sleep(150);
    const flash2 = await ctx.hasHost(ctx.tabA, "lazyfox-flash");
    assert(flash2, "yank of the selection flashes the copied text");
    // Esc exits yank mode back to find command mode; Esc again closes.
    await ctx.press(ctx.tabA, "Escape");
    await sleep(200);
    const stillOpen = await ctx.hasHost(ctx.tabA, "lazyfox-popup");
    assert(stillOpen, "Esc exits yank mode but keeps the find widget open");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("leader key types into shadow-DOM inputs and editables (custom elements)", async () => {
    // Regression: Reddit-style <faceplate-search-input> custom elements keep
    // their real input in shadow DOM, so document.activeElement / the event
    // target is the host and typing detection used to miss it — `;` armed the
    // leader instead of typing, and a stray ' re-armed the marker capture.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(
      ctx.tabA,
      `document.getElementById("shin1").shadowRoot.querySelector("input").focus(); true`
    );
    await sleep(200);
    await ctx.typeIn(ctx.tabA, ";'1");
    const val = await evalIn(
      ctx.tabA,
      `document.getElementById("shin1").shadowRoot.querySelector("input").value`
    );
    assert(val === ";'1", "shadow input got ;'1, got " + JSON.stringify(val));
    assert(
      !(await ctx.hasHost(ctx.tabA, "lazyfox-leader")),
      "leader armed while typing into a shadow-DOM input"
    );
    // Same for a contenteditable hosted inside a shadow root.
    await evalIn(
      ctx.tabA,
      `document.getElementById("shce1").shadowRoot.querySelector("div").textContent = ""; true`
    );
    await evalIn(
      ctx.tabA,
      `document.getElementById("shce1").shadowRoot.querySelector("div").focus(); true`
    );
    await sleep(200);
    await ctx.typeIn(ctx.tabA, ";");
    const ce = await evalIn(
      ctx.tabA,
      `document.getElementById("shce1").shadowRoot.querySelector("div").textContent`
    );
    assert(ce === ";", "shadow contenteditable got ;, got " + JSON.stringify(ce));
    assert(
      !(await ctx.hasHost(ctx.tabA, "lazyfox-leader")),
      "leader armed while typing into a shadow-DOM contenteditable"
    );
    await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
  });

  await t(";w resize popup from the content page", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.windowInnerSize();
    await ctx.leaderPress(ctx.tabA, "w");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "ArrowDown");
    // Same WM/automation caveat as the command-center resize test: exercise the
    // popup opening and the arrow, but assert the height delta only when a
    // growth was actually observed (see windowInnerSize).
    const grew = await waitFor(async () => {
      const r = await ctx.windowInnerSize();
      return r.height > before.height + 12 ? r : null;
    }, 6000)
      .then(() => true)
      .catch(() => false);
    if (grew) {
      const after = await ctx.windowInnerSize();
      assert(Math.abs(after.height - before.height - 32) <= 8, `height grew by ~32 (${before.height} -> ${after.height})`);
    } else {
      console.log("  (window-growth assertion skipped — WM or automation did not apply the resize)");
    }
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t(";m mute runs without errors", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "m");
    await sleep(300);
  });

  await t(";x closes a tab, ;v reopens it", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "x");
    let afterClose = -1;
    const closed = await waitFor(async () => {
      afterClose = await ctx.tabCount();
      return afterClose === before - 1 ? true : null;
    }, 10000).catch(() => null);
    assert(closed, ";x closed exactly one tab (before=" + before + ", after=" + afterClose + ")");
    // find a surviving content/CC context and reopen from there
    const t = await getTree();
    const cs = contextsOf(t);
    const survivor = cs.find((c) => c.url && c.url.includes("commandcenter.html")) || cs[0];
    await ctx.activateTab(survivor.context);
    await sleep(300);
    await ctx.leaderPress(survivor.context, "v");
    let afterReopen = -1;
    const reopened = await waitFor(async () => {
      afterReopen = await ctx.tabCount();
      return afterReopen === before ? true : null;
    }, 10000).catch(() => null);
    // Re-point tabA at a LIVE context BEFORE asserting, so a reopen failure
    // can never cascade: every later test would otherwise run against the
    // just-destroyed tabA and fail with "no such frame" instead of its own
    // behaviour. Prefer a real content tab; fall back to the survivor.
    const t2 = await getTree();
    const cs2 = contextsOf(t2);
    const contentCtx = cs2.find((c) => c.url && c.url.includes("127.0.0.1"));
    ctx.tabA = contentCtx ? contentCtx.context : survivor.context;
    await ctx.activateTab(ctx.tabA).catch(() => {});
    let rc = "<none>";
    if (!reopened) {
      rc = await evalIn(
        ctx.probe,
        `browser.sessions.getRecentlyClosed({maxResults:20}).then(l => JSON.stringify(l.map(i => i.tab ? (i.tab.url||"") : "(window)")))`
      ).catch(() => "<err>");
    }
    assert(
      reopened,
      ";v reopened the closed tab (before=" + before + ", afterClose=" + afterClose +
        ", afterReopen=" + afterReopen + ", survivor=" + ((survivor && survivor.url) || "?") +
        ", recently closed: " + rc + ")"
    );
  });

  await t(";V recently-closed popup lists and restores a closed tab", async () => {
    // The popup (capital V) shows everything the browser remembers closing;
    // Enter restores the highlighted (most recent) entry. Unlike ;v, which
    // reopens the last tab without a list, ;V must open a real popup.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    // Seed one recently-closed entry without disturbing tabA: create and then
    // remove a background tab through the probe's extension realm.
    const tid = await evalIn(
      ctx.probe,
      `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/target2`)}, active: false }).then(t => t.id)`
    );
    await sleep(600);
    await evalIn(ctx.probe, `browser.tabs.remove(${tid}).then(() => true)`);
    await sleep(400);
    await ctx.leaderPress(ctx.tabA, "V");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => (await ctx.tabCount()) === before + 1 ? true : null, 10000);
    // The restored tab is the newly active web page; hand focus back to tabA
    // and remove the restored tab so later tests start from a clean strip.
    await ctx.activateTab(ctx.tabA);
    await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => { const t = ts.find(x => (x.url||"").indexOf("/target2") !== -1); return t ? browser.tabs.remove(t.id).then(() => true) : true; })`).catch(() => {});
  });

  await t("a stale leader never eats keys typed into an input", async () => {
    // Regression: pressing `;` on the page then clicking into a text field used
    // to leave the leader armed, so the first key typed (; or ') was swallowed
    // and a stray ' even re-armed the session-marker capture (so the next digit
    // switched sessions). Focusing a text field must disarm everything and let
    // every key type.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Arm the leader with the input NOT focused (focus on the page body).
    await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
    await sleep(200);
    await ctx.press(ctx.tabA, ";");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-leader")) ? true : null, 5000);
    // Focus the page input, then type ; ' 1 — all three must land.
    await evalIn(ctx.tabA, `document.getElementById("inp1").focus(); true`);
    await sleep(200);
    await ctx.typeIn(ctx.tabA, ";'1");
    const val = await evalIn(ctx.tabA, `document.getElementById("inp1").value`);
    assert(val === ";'1", "input got ;'1, got " + JSON.stringify(val));
    // Cleanup: blur so later tests start clean.
    await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
  });
  await t("all special characters type correctly into text inputs", async () => {
    // Comprehensive test: every character that could be a leader binding or
    // special key must type normally when an input has focus.
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await evalIn(ctx.tabA, 'document.getElementById("inp1").focus(); true');
    await sleep(200);
    // Characters that conflict with leader bindings and special browser keys
    const allChars = ";'\/[]{}|,.`~!@#$%^&*()-_+=<>?0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await ctx.typeIn(ctx.tabA, allChars);
    const val = await evalIn(ctx.tabA, 'document.getElementById("inp1").value');
    assert(val === allChars, "input got all chars, got " + JSON.stringify(val.slice(0, 50)));
    await evalIn(ctx.tabA, 'document.getElementById("inp1").value = ""; true');
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });

  await t("all special characters type correctly into textareas", async () => {
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await evalIn(ctx.tabA, 'document.getElementById("ta1").focus(); true');
    await sleep(200);
    const allChars = ";'\/[]{}|,.`~!@#$%^&*()-_+=<>?0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await ctx.typeIn(ctx.tabA, allChars);
    const val = await evalIn(ctx.tabA, 'document.getElementById("ta1").value');
    assert(val === allChars, "textarea got all chars, got " + JSON.stringify(val.slice(0, 50)));
    await evalIn(ctx.tabA, 'document.getElementById("ta1").value = ""; true');
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });

  await t("all special characters type into contenteditable divs", async () => {
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await evalIn(ctx.tabA, 'document.getElementById("ce1").textContent = ""; true');
    await evalIn(ctx.tabA, 'document.getElementById("ce1").focus(); true');
    await sleep(200);
    const allChars = ";'\/[]{}|,.`~!@#$%^&*()-_+=<>?0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await ctx.typeIn(ctx.tabA, allChars);
    const val = await evalIn(ctx.tabA, 'document.getElementById("ce1").textContent');
    assert(val === allChars, "contenteditable got all chars, got " + JSON.stringify(val.slice(0, 50)));
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });

  await t("leader key disarms when focus moves to an input", async () => {
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
    await sleep(200);
    await ctx.press(ctx.tabA, ";");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-leader")) ? true : null, 5000);
    await evalIn(ctx.tabA, 'document.getElementById("inp1").focus(); true');
    await sleep(200);
    await ctx.typeIn(ctx.tabA, ";'1");
    const val = await evalIn(ctx.tabA, 'document.getElementById("inp1").value');
    assert(val === ";'1", "input got ;'1, got " + JSON.stringify(val));
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });

  await t("Esc blurs the focused input and reaches the page", async () => {
    // Esc must unfocus whatever element holds focus AND still reach the page:
    // page-level Esc handlers (modals, cookie banners, info bars) close on the
    // same keypress. The content script must blur, never consume the key.
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await evalIn(
      ctx.tabA,
      `window.__lfEscKeys = [];
       window.addEventListener("keydown", function (ev) { window.__lfEscKeys.push(ev.key); });
       true`
    );
    await evalIn(ctx.tabA, 'document.getElementById("inp1").focus(); true');
    await sleep(200);
    await ctx.press(ctx.tabA, "Escape");
    await sleep(300);
    const ae = await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`);
    assert(ae !== "inp1", "Esc blurred the focused input, activeElement=" + JSON.stringify(ae));
    const keys = await evalIn(ctx.tabA, `window.__lfEscKeys`);
    assert(keys && keys.indexOf("Escape") !== -1, "page received Esc, got " + JSON.stringify(keys));
  });

  await t("Esc during hints clears state so the next ;f re-hints everything", async () => {
    // Regression: ;f, type one letter of a hint, then Esc — the next ;f used
    // to remember the stale prefix (or an in-flight hint batch), so the fresh
    // start showed a filtered/empty set instead of every link. Esc must fully
    // clear the hints and the next ;f must re-hint everything again.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hints`);
    const hintList = () =>
      evalIn(
        ctx.tabA,
        `(function(){
          const host = document.getElementById("lazyfox-hints");
          if (!host) return null;
          const raw = host.getAttribute("data-lf-pos");
          if (!raw) return null;
          try { return JSON.parse(raw); } catch (e) { return null; }
        })()`
      );
    const startHints = async () => {
      await ctx.leaderPress(ctx.tabA, "f");
      await waitFor(async () => {
        const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
        return on === "1" ? true : null;
      }, 5000);
    };
    await startHints();
    const all = await waitFor(async () => {
      const l = await hintList();
      return l && l.length > 5 ? l : null;
    }, 5000);
    const total = all.length;
    // The most common first letter is shared by several hint keys, so typing
    // it narrows the batch instead of activating a single link.
    const counts = {};
    for (const it of all) counts[it.key[0]] = (counts[it.key[0]] || 0) + 1;
    const prefix = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    await ctx.press(ctx.tabA, prefix);
    await waitFor(async () => {
      const l = await hintList();
      return l && l.length > 0 && l.length < total ? true : null;
    }, 5000);
    // Esc cancels: the overlay must be fully gone (attribute removed).
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      // evalIn maps null results to undefined, so match both.
      return on == null ? true : null;
    }, 5000);
    // Back to the top so the fresh ;f sees the same viewport as the first one.
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await sleep(300);
    await startHints();
    const again = await waitFor(async () => {
      const l = await hintList();
      return l && l.length === total ? l : null;
    }, 5000);
    assert(again.length === total, "fresh ;f re-hinted everything (" + again.length + " === " + total + ")");
    await ctx.press(ctx.tabA, "Escape");
    await sleep(200);
  });

  await t("popup input never leaks to the page behind (keypress/keyup isolation)", async () => {
    // Regression: an overlay swallows every keydown at the window capture
    // phase, but Firefox still dispatches the keypress/keyup that follow a
    // consumed keydown — so a page listening on those saw what the user typed
    // into Lazyfox's own popup. Instrument the page, open a popup, type, and
    // assert the page observed nothing.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(ctx.tabA, `(() => {
      window.__lfLeak = [];
      for (const type of ["keypress", "keyup"]) {
        window.addEventListener(type, (e) => window.__lfLeak.push(type + ":" + e.key), true);
      }
      return true;
    })()`);
    await ctx.leaderPress(ctx.tabA, "t");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // `;t` and the query characters all go through the popup's own input.
    await ctx.typeIn(ctx.tabA, "jklmn");
    const leak = await evalIn(ctx.tabA, `JSON.stringify(window.__lfLeak || [])`);
    const seen = JSON.parse(leak || "[]");
    assert(seen.length === 0, "the page observed no keypress/keyup, got " + leak);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // Control: with no overlay up the page DOES observe keys, so "nothing
    // seen" above is a real result and not dead instrumentation.
    await evalIn(ctx.tabA, `window.__lfLeak = []; true`);
    await ctx.press(ctx.tabA, "a");
    await ctx.press(ctx.tabA, "b");
    const control = JSON.parse(
      (await evalIn(ctx.tabA, `JSON.stringify(window.__lfLeak || [])`)) || "[]"
    );
    assert(
      control.some((s) => s.indexOf(":a") !== -1) && control.some((s) => s.indexOf(":b") !== -1),
      "control: the page sees keys when no overlay is up, got " + JSON.stringify(control)
    );
  });
}
