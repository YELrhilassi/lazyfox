// stealth tests (sessions). Split verbatim from the original
// sessions.ts monolith — behavior unchanged, timing fixed separately.
import { activate, createTab, evalIn, getTree, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "sessions/stealth";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });
  await t("stealth: isolated jar, never saved, wiped on close", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const origin = JSON.stringify(`${ctx.base}/`);
    // `;N n` opens a FRESH empty stealth tab in this window's jar (an isolated
    // cookie jar) — it starts on the command center, NOT a clone of tabA.
    // `;N` is a category now, so the destination key is part of the chord.
    const beforeCtxs = (await getTree()).map((c) => c.context);
    await ctx.leaderSeq(ctx.tabA, ["N", "n"]);
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
    // 20s, not 8: on a filtered run this test is the FIRST thing to ask the
    // chrome helper anything, and its #lfc=state reply channel boots with the
    // window (measured: the reply can take well over 8s cold, then arrive in
    // tens of milliseconds once the helper is up). Whether the badge is drawn
    // is a product question; when the channel answers is not.
    const st = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("stealth") !== -1 ? s : null;
    }, 20000).catch(() => null);
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
    const stealthTag = await evalIn(
      stealthCtx.context,
      `(() => { const el = document.getElementById("stealthNote"); return el ? getComputedStyle(el).display : "missing"; })()`
    );
    assert(stealthTag !== "none" && stealthTag !== "missing",
      "stealth home shows the stealth footer badge (got: " + stealthTag + ")");
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
    // A link opened FROM the stealth jar must stay in that jar. This is the
    // path a hint pick (`;f`) takes: the background resolves the container from
    // the ACTIVE tab of the sender's window, which on a content-script request
    // IS the page that asked. So put a real page in the jar, make it active, and
    // ask the background for a new tab the way the content script does. (On the
    // command center `openUrl` deliberately reuses the tab in place, which is
    // why the request is not sent from there with the home page still active.)
    const jarPage = await evalIn(
      ctx.probe,
      `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/`)}, cookieStoreId: ${JSON.stringify(opened.cs)}, active: true }).then(t => t.id)`
    );
    const linkUrl = `${ctx.base}/?lfstealth=link`;
    await evalIn(stealthCtx.context,
      `browser.runtime.sendMessage({ action: "openUrl", data: { url: ${JSON.stringify(linkUrl)}, newTab: true } }).then(() => true)`);
    const openedLink = await waitFor(async () => {
      const ts = await evalIn(ctx.probe, `browser.tabs.query({}).then(ts => ts.map(t => ({id: t.id, url: t.url, cs: t.cookieStoreId})))`);
      const hit = (ts || []).find((x: any) => x.url === linkUrl);
      return hit || null;
    }, 10000).catch(() => null);
    assert(openedLink, "a link opened from the stealth jar did not open at all");
    assert(openedLink.id !== jarPage, "the link was not opened in a new tab (it reused the page)");
    assert(openedLink.cs === opened.cs,
      "a link opened from a stealth tab landed in another jar: " + openedLink.cs + " (wanted " + opened.cs + ")");
    await evalIn(ctx.probe,
      `browser.tabs.remove([${openedLink.id}, ${jarPage}]).catch(() => true); true`).catch(() => {});
    // The command center tab in the jar came back to the front.
    await ctx.activateTab(stealthCtx.context).catch(() => {});
    // Session save must NOT record the stealth tab (nor its URL). The tab is
    // open and ACTIVE while this runs, which is the case that used to write it
    // down.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionSave", data: { name: "lfstealth" } }); true`);
    const saved = await waitFor(async () => {
      const r = await evalIn(ctx.probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.lfstealth)`);
      return r && Array.isArray(r.tabs) ? r : null;
    }, 8000).catch(() => null);
    assert(saved && saved.tabs.length > 0, "the session saved nothing at all: " + JSON.stringify(saved && saved.tabs));
    assert(!saved.tabs.some((t) => t.stealth === true),
      "session still marks a stealth tab: " + JSON.stringify(saved.tabs.map((t) => t.stealth)));
    assert(!saved.tabs.some((t) => (t.url || "").indexOf("commandcenter.html") === 0),
      "session saved the stealth tab's home page: " + JSON.stringify(saved.tabs.map((t) => t.url)));
    // ONE JAR PER WINDOW. A second `;Nn` from inside the sandbox joins the SAME
    // cookie store — one sandbox, not one container per tab — and closing that
    // tab while the first is still open must wipe nothing.
    const secondOk = await evalIn(stealthCtx.context,
      `browser.runtime.sendMessage({ action: "stealthOpen", data: {} }).then(r => !!(r && r.ok === true))`);
    assert(secondOk === true, "a second stealth tab could not be opened from the sandbox");
    const jarTabs = await waitFor(async () => {
      const ts = await evalIn(ctx.probe, `browser.tabs.query({ cookieStoreId: ${JSON.stringify(opened.cs)} }).then(ts => ts.map(t => t.id))`);
      return (ts || []).length >= 2 ? ts : null;
    }, 10000).catch(() => null);
    assert(jarTabs && jarTabs.length >= 2,
      "a second stealth tab did not join the window's jar: " + JSON.stringify(jarTabs));
    const extraId = (jarTabs || []).filter((id: number) => id !== opened.id).pop();
    await evalIn(ctx.probe, `browser.tabs.remove(${extraId}).catch(() => true); true`).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    const stillThere = await evalIn(ctx.probe,
      `browser.contextualIdentities.query({}).then(cs => cs.map(c => c.cookieStoreId))`).catch(() => []);
    assert((stillThere || []).includes(opened.cs),
      "closing one stealth tab wiped the jar its other tabs are still using");
    // TRACES OUTSIDE THE JAR. Firefox records the pages a container loads in
    // Places and the downloads it starts in the download list, and neither is
    // container-scoped — so the jar remembers them itself and deletes them when
    // it goes. A normal page plus a download that always fails, both marked with
    // a token unique to this run.
    // The download is an ATTACHMENT navigation (a 200 with Content-Disposition)
    // from inside the jar: that is the path a real "save this file" click takes,
    // and it is the one whose DownloadItem has to carry the container id.
    const beforeDlIds = await evalIn(ctx.probe,
      `browser.downloads.search({}).then(rs => rs.map(r => r.id))`).catch(() => []);
    const histUrl = `${ctx.base}/?lfstealth=hist`;
    const dlUrl = `${ctx.base}/slowfile?lfstealth=dl`;
    const histTab = await evalIn(ctx.probe,
      `browser.tabs.create({ url: ${JSON.stringify(histUrl)}, cookieStoreId: ${JSON.stringify(opened.cs)}, active: true }).then(t => t.id)`);
    const inHistory = await waitFor(async () => {
      const hits = await evalIn(ctx.probe,
        `browser.history.search({ text: "lfstealth=hist", startTime: 0, maxResults: 20 }).then(hs => hs.map(h => h.url))`);
      return (hits || []).some((u: string) => String(u).indexOf("lfstealth=hist") !== -1) ? true : null;
    }, 15000).catch(() => null);
    assert(inHistory === true, "the jar's page never reached history, so the purge cannot be observed");
    const dlTab = await evalIn(ctx.probe,
      `browser.tabs.create({ url: ${JSON.stringify(dlUrl)}, cookieStoreId: ${JSON.stringify(opened.cs)}, active: true }).then(t => t.id)`);
    const dl = await waitFor(async () => {
      // BY ID DIFF, not by startTime: DownloadItem's time is not guaranteed to
      // be an ISO string on every build (a Date compares wrong as text), and the
      // only thing this test needs is "the download this navigation started".
      const rs = await evalIn(ctx.probe,
        `browser.downloads.search({}).then(rs => rs.filter(r => ${JSON.stringify(beforeDlIds)}.indexOf(r.id) === -1).map(r => ({ id: r.id, cs: r.cookieStoreId || "", file: String(r.filename || "") })))`);
      const hit = (rs || []).find((r: any) => /lf-slow\.bin/.test(r.file));
      return hit || null;
    }, 20000).catch(() => null);
    assert(dl, "the download started from the stealth jar was never listed");
    assert(dl.cs === opened.cs,
      "the download from the stealth jar is not attributed to it: " + dl.cs + " (wanted " + opened.cs + ")");
    // Seed the stealth jar with its OWN cookie so we can prove close wipes the
    // DATA, not just the container identity.
    await evalIn(ctx.probe, `browser.cookies.set({ url: ${origin}, name: "lfst", value: "1", storeId: ${JSON.stringify(opened.cs)} }).then(() => true)`);
    const seeded = await evalIn(ctx.probe, `browser.cookies.getAll({ storeId: ${JSON.stringify(opened.cs)} }).then(cs => cs.map(c => c.name))`);
    assert((seeded || []).includes("lfst"), "stealth jar accepts its own cookie");
    // Close every remaining tab of the jar -> the container is wiped +
    // removed, data included, and the traces it left behind go with it.
    await evalIn(ctx.probe,
      `browser.tabs.remove([${histTab}, ${dlTab}]).catch(() => true); true`).catch(() => {});
    await evalIn(ctx.probe, `browser.tabs.remove(${opened.id})`).catch(() => {});
    const gone = await waitFor(async () => {
      const cis = await evalIn(ctx.probe, `browser.contextualIdentities.query({}).then(cs => cs.map(c => c.cookieStoreId))`);
      return cis && cis.indexOf(opened.cs) === -1 ? true : null;
    }, 8000).catch(() => null);
    assert(gone === true, "container removed after closing the stealth tab");
    const wiped = await evalIn(ctx.probe, `browser.cookies.getAll({ storeId: ${JSON.stringify(opened.cs)} }).then(cs => cs.map(c => c.name)).catch(() => [])`);
    assert(!(wiped || []).includes("lfst"), "closing wiped the stealth jar's data");
    // The two traces that live OUTSIDE the cookie store.
    const histGone = await waitFor(async () => {
      const hits = await evalIn(ctx.probe,
        `browser.history.search({ text: "lfstealth=hist", startTime: 0, maxResults: 20 }).then(hs => hs.map(h => h.url))`);
      return (hits || []).length === 0 ? true : null;
    }, 15000).catch(() => null);
    assert(histGone === true, "closing the jar left its pages in history");
    const dlGone = await waitFor(async () => {
      const n = await evalIn(ctx.probe, `browser.downloads.search({ id: ${(dl && dl.id) || 0} }).then(rs => rs.length)`);
      return n === 0 ? true : null;
    }, 15000).catch(() => null);
    assert(dlGone === true, "closing the jar left its download in the list");
    // Restore the session: nothing may come back in a container. This is the
    // `;V` / session-switch path, and it used to re-open the stealth tab in a
    // fresh jar — the opposite of "the jar ends with the tab".
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfstealth" } }); true`);
    await ctx.waitCurrentSession("lfstealth");
    // The rebuild creates its tabs after the pointer moves, so let it land
    // before reading the strip — and re-make the probe, which the restore may
    // have torn down with the window it rebuilt.
    await new Promise((r) => setTimeout(r, 1500));
    await ctx.ensureProbe().catch(() => {});
    const restored = await evalIn(
      ctx.probe,
      `browser.tabs.query({}).then(ts => ts.map(t => ({id: t.id, cs: t.cookieStoreId})))`
    ).catch(() => null);
    assert(Array.isArray(restored) && restored.length > 0,
      "the restored window could not be read: " + JSON.stringify(restored));
    const containers = (restored || []).filter((t) => t.cs && t.cs !== "firefox-default");
    assert(containers.length === 0,
      "restore re-opened stealth container tabs: " + JSON.stringify(containers));
    // Clean up: the session and the default-jar cookie.

    await evalIn(ctx.probe, `browser.cookies.remove({ url: ${origin}, name: "lfiso", storeId: "firefox-default" }).catch(() => true); browser.runtime.sendMessage({ action: "sessionDelete", data: { name: "lfstealth" } }); true`);
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA).catch(() => {});
  });
}
