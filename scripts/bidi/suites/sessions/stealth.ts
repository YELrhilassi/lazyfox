// stealth tests (sessions). Split verbatim from the original
// sessions.ts monolith — behavior unchanged, timing fixed separately.
import { activate, createTab, evalIn, getTree, waitFor } from "../../lib.ts";
import { assert } from "../../harness.ts";
export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("sessions", name, fn);
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
    const saved = await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfstealth)`);
      return r && r.tabs && r.tabs.some((t) => t.stealth === true) ? r : null;
    }, 8000);
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
    // The restore tears down the window (including the probe tab), so the
    // pointer can only be read through a FRESH one.
    await ctx.waitCurrentSession("lfstealth");
    const restored = await waitFor(async () => {
      const ts = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, cs: t.cookieStoreId})))`);
      return ts.find((t) => t.cs && t.cs !== "firefox-default") || null;
    }, 15000).catch(() => null);
    const stealthTab = restored;
    assert(stealthTab, "restore re-opened a stealth container tab");
    assert(stealthTab.cs !== opened.cs, "restored stealth tab uses a fresh container");
    // Clean up: remove the stealth tab, the session, and the default-jar cookie.
    await evalIn(ctx.probe, `browser.tabs.remove(${stealthTab.id})`).catch(() => {});
    await evalIn(ctx.probe, `browser.cookies.remove({ url: ${origin}, name: "lfiso", storeId: "firefox-default" }).catch(() => true); browser.runtime.sendMessage({ action: "sessionDelete", data: { name: "lfstealth" } }); true`);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA).catch(() => {});
  });
}
