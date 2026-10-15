// scroll tests (content). Split verbatim from the original
// content.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, waitFor, sleep } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/scroll";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });
  await t("scroll keys j k d u gg G", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); true`);
    await ctx.waitExpr(ctx.tabA, `window.scrollY`, 0);
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
          `JSON.stringify({hasFocus: document.hasFocus(), active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), scrollY: window.scrollY})`
        );
        // What the PAGE's dispatcher saw, pulled on demand — the product writes
        // nothing per keystroke, so this is the only honest way to ask.
        const trace = await ctx.dispatchTrace(ctx.tabA).catch(() => null);
        throw new Error("scroll " + label + " did not move: " + d + " trace=" + JSON.stringify(trace));
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
    // ONE PRESS OF `g` MUST NOT VANISH — the reported "I have to type keys like
    // `g` twice for it to register once". The arming press of the gesture used
    // to be consumed and then do nothing at all: no scroll, no message, no
    // character. It is now left to the page, so the user's key always has an
    // owner — and the page is asked directly whether it received it.
    const s3 = await evalIn(ctx.tabA, `window.scrollY`);
    await evalIn(
      ctx.tabA,
      `(() => {
         window.__lfSeenKeys = [];
         window.addEventListener("keydown", (e) => window.__lfSeenKeys.push(e.key), true);
         return true;
       })()`
    );
    await ctx.press(ctx.tabA, "g");
    await sleep(200);
    const seen = await evalIn(ctx.tabA, `JSON.stringify(window.__lfSeenKeys || [])`);
    assert(
      JSON.parse(String(seen)).indexOf("g") !== -1,
      "a lone `g` reached the page instead of being swallowed (the page saw " + seen + ")"
    );
    assert(
      (await evalIn(ctx.tabA, `window.scrollY`)) === s3,
      "a lone `g` moves nothing — `gg` is the gesture, and it has not completed yet"
    );
    // ...and the press that COMPLETES it still works, inside the window.
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
    await ctx.waitExpr(ctx.tabA, `window.scrollY`, 0);
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
    // G -> bottom and gg -> top follow the same target. "Bottom" is the pane's
    // own scrollHeight minus its clientHeight — the h*0.8 heuristic that stood
    // here was calibrated on a shorter harness window and broke (bottom reached
    // exactly, 2910 < 3029) the moment the inner height grew; the real bottom
    // condition does not care about the viewport.
    await ctx.press(ctx.tabA, "G");
    await waitFor(async () => {
      const p = await evalIn(ctx.tabA, `document.getElementById("pane").scrollTop`);
      const max = await evalIn(ctx.tabA, `document.getElementById("pane").scrollHeight - document.getElementById("pane").clientHeight`);
      return max > 0 && p > max - 5 ? true : null;
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
    await ctx.waitExpr(ctx.tabA, `window.scrollY`, 0);
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
}
