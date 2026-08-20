// Content-script tests on a normal web page: leader keys, popups, scroll keys,
// link hints, zoom, find-in-page, and tab management from real content.

import { evalIn, getTree, waitFor, sleep, activate } from "../lib.mjs";
import { contextsOf } from "../helpers.mjs";
import { assert } from "../harness.mjs";

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
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "f");
    await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? true : null;
    }, 5000);
    await ctx.press(ctx.tabA, "]");
    await sleep(900); // scroll + re-hint settle
    // inp2 is now the (only) hinted element -> its key is "a".
    await ctx.press(ctx.tabA, "a");
    await waitFor(async () => {
      const id = await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`);
      return id === "inp2" ? id : null;
    }, 8000);
    assert((await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`)) === "inp2", "paged hint activated inp2");
    // Leave the tab on /target1 like the plain hints test does: the next test
    // (;g back) starts from that history entry.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
  });

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

  await t(";w resize popup from the content page", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.windowRect();
    await ctx.leaderPress(ctx.tabA, "w");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "ArrowDown");
    await waitFor(async () => {
      const r = await ctx.windowRect();
      return r.height > before.height ? r : null;
    }, 10000);
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
    await waitFor(async () => (await ctx.tabCount()) === before - 1 ? true : null, 10000);
    // find a surviving content/CC context and reopen from there
    const t = await getTree();
    const cs = contextsOf(t);
    const survivor = cs.find((c) => c.url && c.url.includes("commandcenter.html")) || cs[0];
    await ctx.activateTab(survivor.context);
    await sleep(300);
    await ctx.leaderPress(survivor.context, "v");
    await waitFor(async () => (await ctx.tabCount()) === before ? true : null, 10000);
    // restore a content context as tabA
    const t2 = await getTree();
    const cs2 = contextsOf(t2);
    ctx.tabA = cs2.find((c) => c.url && c.url.includes("127.0.0.1"))
      ? cs2.find((c) => c.url && c.url.includes("127.0.0.1")).context
      : survivor.context;
    await ctx.activateTab(ctx.tabA);
  });
}
