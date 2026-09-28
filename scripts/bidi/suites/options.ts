// Options page and action-popup tests.

import { evalIn, waitFor, sleep, focusPage } from "../lib.ts";
import { assert } from "../harness.ts";

export const group = "options";

export async function run(ctx) {
  const t = (name, fn) => ctx.runTest(group, name, fn);

  console.log("\n== Options and popup pages ==");

  await t("options page loads and renders the form", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
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
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await sleep(300);
    await focusPage(ctx.tabA).catch(() => {});
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => {
      const u2 = await evalIn(ctx.tabA, `location.href`).catch(() => null);
      return u2 && u2.includes(ctx.base) ? u2 : null;
    }, 10000);
  });

  // The write path went through the typed store in this batch, and nothing
  // else in the suite covered it: a save that silently wrote nothing, or wrote
  // under a key the reader does not use, would leave every other test green.
  await t("options page: save persists and survives a reload", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await sleep(400);
    await evalIn(ctx.tabA, `(() => {
      document.querySelector("#leader").value = ",";
      document.querySelector("#save").click();
      return true;
    })()`);
    // The confirmation is set by the Promise.all over both store writes, so
    // waiting for it is waiting for the writes, not for the click handler.
    await waitFor(async () => {
      const s = await evalIn(ctx.tabA, `document.querySelector("#status").textContent`);
      return s === "saved" ? true : null;
    }, 5000);
    const stored = await evalIn(ctx.tabA, `browser.storage.local.get("config").then((r) => r.config.leader)`);
    assert(stored === ",", "the write landed under the config key the reader uses, got " + JSON.stringify(stored));

    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await sleep(400);
    const back = await evalIn(ctx.tabA, `document.querySelector("#leader").value`);
    assert(back === ",", "the reloaded page reads back what it wrote, got " + JSON.stringify(back));

    // Put it back: a suite that leaves a changed preference behind makes every
    // later run depend on the order the tests happen to run in.
    await evalIn(ctx.tabA, `browser.storage.local.get("config").then((r) => {
      const c = r.config; c.leader = ";";
      return browser.storage.local.set({ config: c });
    })`);
  });

  // Per-field validation is the new behaviour, and the assertion that matters
  // is the one about what SURVIVES: a corrupt field must fall back to its
  // default without taking the user's valid fields down with it.
  await t("options page: a corrupt config field falls back, the rest survives", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await evalIn(ctx.tabA, `browser.storage.local.get("config").then((r) => {
      const c = r.config || {};
      c.leader = ",";
      c.statusBarPosition = "sideways";
      c.scrollKeys = "yes-please";
      c.apps = "open.spotify.com";
      return browser.storage.local.set({ config: c });
    })`);
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await sleep(400);
    const f = await evalIn(ctx.tabA, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        leader: q("#leader").value,
        position: q("#statusBarPosition").value,
        scrollKeys: q("#scrollKeys").checked,
        appRows: document.querySelectorAll("#appsList .app-row").length,
        rendered: document.body.innerText.length,
      };
    })()`);
    assert(f.leader === ",", "a valid field next to a corrupt one survives: " + JSON.stringify(f.leader));
    assert(f.position === "bottom", "the corrupt position falls back to the default, got " + f.position);
    assert(f.scrollKeys === true, "the corrupt boolean falls back to the default, got " + f.scrollKeys);
    assert(f.appRows > 0, "a corrupt apps array falls back to the default tiles, got " + f.appRows);
    assert(f.rendered > 0, "the page rendered at all");

    await evalIn(ctx.tabA, `browser.storage.local.remove("config")`);
  });

  await t("popup page (action popup) renders", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "popup.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
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
