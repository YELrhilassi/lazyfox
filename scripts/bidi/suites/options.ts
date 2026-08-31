// Options page and action-popup tests.

import { navigate, evalIn, waitFor, sleep, focusPage } from "../lib.ts";
import { assert } from "../harness.ts";

export const group = "options";

export async function run(ctx) {
  const t = (name, fn) => ctx.runTest(group, name, fn);

  console.log("\n== Options and popup pages ==");

  await t("options page loads and renders the form", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await navigate(ctx.tabA, u, "complete");
    await sleep(500);
    const f = await evalIn(ctx.tabA, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        leader: q("#leader") ? q("#leader").value : null,
        hintChars: q("#hintChars") ? q("#hintChars").value : null,
        scrollKeys: q("#scrollKeys") ? q("#scrollKeys").checked : null,
        openInNewTab: q("#openInNewTab") ? q("#openInNewTab").checked : null,
        whichKey: q("#whichKey") ? q("#whichKey").checked : null,
        hoverReveal: q("#hoverReveal") ? q("#hoverReveal").checked : null,
        statusBar: q("#statusBar") ? q("#statusBar").checked : null,
        statusBarPosition: q("#statusBarPosition") ? q("#statusBarPosition").value : null,
        autoRestore: q("#autoRestore") ? q("#autoRestore").checked : null,
        save: !!q("#save"),
        title: document.title,
      };
    })()`);
    assert(f.leader === ";", "leader input = ;");
    assert(f.hintChars && f.hintChars.length > 0, "hint chars set");
    assert(f.scrollKeys === true, "scrollKeys checked");
    assert(f.openInNewTab === true, "openInNewTab checked");
    assert(f.whichKey === true, "whichKey checked");
    assert(f.statusBar === true, "statusBar checked");
    assert(f.statusBarPosition === "bottom" || f.statusBarPosition === "top", "status bar position select present: " + f.statusBarPosition);
    assert(f.autoRestore === true, "autoRestore checked");
    assert(f.save === true, "save button present");
  });

  await t("options page: Esc goes back", async () => {
    // Re-navigate from a known page so the options page has a clean history
    // entry to go back to, then move focus into the page before sending the
    // key (after browsingContext.navigate the URL bar can hold keyboard focus).
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await navigate(ctx.tabA, u, "complete");
    await sleep(300);
    await focusPage(ctx.tabA).catch(() => {});
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => {
      const u2 = await evalIn(ctx.tabA, `location.href`).catch(() => null);
      return u2 && u2.includes(ctx.base) ? u2 : null;
    }, 10000);
  });

  await t("popup page (action popup) renders", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "popup.html");
    await navigate(ctx.tabA, u, "complete");
    await sleep(500);
    const f = await evalIn(ctx.tabA, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        body: document.body ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 120) : "",
        links: [...document.querySelectorAll("a,button")].map((a) => a.textContent.trim()).filter(Boolean).slice(0, 8),
      };
    })()`);
    assert(f.body.length > 0, "popup body renders: " + f.body);
  });
}
