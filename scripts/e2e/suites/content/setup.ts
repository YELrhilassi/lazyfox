// setup tests (content). Split verbatim from the original
// content.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, getTree, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
import { contextsOf } from "../../fixture.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/setup";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });
  await t("the home page's install row opens the setup page with a GitHub Releases installer download", async () => {
    // The store add-on cannot write profile files itself, so the setup page ——
    // reached from the home page's "Complete the install" row (`;I` is gone, a
    // one-time install step does not deserve a chord) — directs the user to
    // download the standalone Go installer from GitHub Releases. The page must
    // render its status + steps and point its Download control at a
    // releases/latest/download asset URL.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const setupTab = await ctx.openSetupFromHome(ctx.tabA);
    assert(setupTab, "the install row opened a setup.html tab");
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
    const setupTab = await ctx.openSetupFromHome(ctx.tabA);
    assert(setupTab, "the install row opened a setup.html tab");
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

  await t("setup page: a newer published installer is one quiet line, and silence otherwise", async () => {
    // The installer is what writes the chrome layer, so "is there a newer
    // installer?" is answered against the chrome version — not the add-on's.
    // The page must say it once, quietly, and say nothing at all when the two
    // match. The release answer is seeded (fresh, so no request is made): this
    // is a test of the rule, not of GitHub being reachable.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const setupTab = await ctx.openSetupFromHome(ctx.tabA);
    assert(setupTab, "the install row opened a setup.html tab");
    const setupCtx = contextsOf(await getTree()).find((c) => (c.url || "").includes("setup.html"));
    assert(setupCtx, "found the setup page context");
    const ver = String(
      await evalIn(setupCtx.context, `browser.runtime.getBrowserInfo().then((i) => String(i.version || "")).catch(() => "")`)
    );
    const channel = /[ab]\d+$/.test(ver) ? "nightly" : "stable";
    const seeded = {
      chromeAlive: true,
      chromeHelperVersion: "0.5.9",
      lfProfileName: "lf-e2e-profile",
      lfProfileDir: "/tmp/lf-e2e",
      lfInstallerCheck: { channel, version: "9.9.9", at: Date.now() },
    };
    await evalIn(setupCtx.context, `browser.storage.local.set(${JSON.stringify(seeded)}).then(() => true)`);
    await evalIn(setupCtx.context, `document.getElementById("verify").click(); true`);
    const snap = () =>
      evalIn(
        setupCtx.context,
        `JSON.stringify({
          hidden: document.getElementById("updateAvailable").hidden,
          text: (document.getElementById("updateAvailable") || {}).textContent || "",
          href: (document.getElementById("updateAvailable") || {}).href || "",
          dl: (document.getElementById("dl") || {}).href || "",
          dlVer: (document.getElementById("dlVer") || {}).textContent || "",
          dl2Ver: (document.getElementById("dl2Ver") || {}).textContent || "",
        })`
      );
    const shown = await waitFor(async () => {
      const s = JSON.parse(await snap());
      return s.hidden ? null : s;
    }, 5000).catch(() => null);
    assert(shown, "a published installer newer than the chrome shows the notice");
    assert(/9\.9\.9/.test(shown.text), "the notice names the published version, got " + shown.text);
    assert(
      shown.href === shown.dl,
      "the notice points at the same channel-correct asset as the download, got " + shown.href
    );
    assert(shown.dlVer === "9.9.9", "the install card's download is labelled with the version, got " + JSON.stringify(shown.dlVer));
    assert(shown.dl2Ver === "9.9.9", "the uninstall card's download carries the same label, got " + JSON.stringify(shown.dl2Ver));

    // Same version on disk: the normal state, and it must be silent.
    await evalIn(setupCtx.context, `browser.storage.local.set({ chromeHelperVersion: "9.9.9" }).then(() => true)`);
    await evalIn(setupCtx.context, `document.getElementById("verify").click(); true`);
    const quiet = await waitFor(async () => {
      const s = JSON.parse(await snap());
      return s.hidden ? s : null;
    }, 5000).catch(() => null);
    assert(quiet, "an installer equal to the chrome layer says nothing");
    assert(quiet.text === "", "the quiet state keeps no leftover text, got " + JSON.stringify(quiet.text));

    await evalIn(
      setupCtx.context,
      `browser.storage.local.remove(["chromeAlive", "chromeHelperVersion", "lfInstallerCheck", "lfProfileName", "lfProfileDir"]).then(() => true)`
    );
    await evalIn(setupCtx.context, `browser.tabs.remove(${setupTab.id})`).catch(() => {});
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });
}
