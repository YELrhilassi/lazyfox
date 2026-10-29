// options tests (options). Split verbatim from the original
// options.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, focusPage, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "options/options";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });
  await t("options page loads and renders the form", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    // The form hydrates asynchronously (config load -> input values); wait
    // for the leader input to be POPULATED, not merely present.
    await ctx.waitExpr(ctx.tabA, `(document.querySelector("#leader")||{value:""}).value.length > 0`, true, 8000);
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
        keepStealth: q("#keepStealth") ? q("#keepStealth").checked : null,
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
    assert(f.keepStealth === false, "keepStealth unchecked by default: " + f.keepStealth);
    assert(f.save === true, "save button present");
  });
  await t("options page: Esc goes back", async () => {
    // Re-navigate from a known page so the options page has a clean history
    // entry to go back to, then move focus into the page before sending the
    // key (after browsingContext.navigate the URL bar can hold keyboard focus).
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await ctx.waitExpr(ctx.tabA, `!!document.querySelector("#leader")`, true, 8000);
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
    await ctx.waitExpr(ctx.tabA, `!!document.querySelector("#leader")`, true, 8000);
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
    await ctx.waitExpr(ctx.tabA, `(document.querySelector("#leader")||{value:""}).value.length > 0`, true, 8000);
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
    await ctx.waitExpr(ctx.tabA, `(document.querySelector("#leader")||{value:""}).value.length > 0`, true, 8000);
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

  // The add-ons page manages what is INSTALLED. It must list the browser's real
  // add-ons (the management permission is what makes that possible), control
  // them, and offer nothing to install.
  await t("add-ons page: lists installed add-ons, controls them, installs nothing", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "addons.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await waitFor(async () =>
      evalIn(ctx.tabA, `document.querySelectorAll("#list .row").length > 0 ? true : null`), 8000
    );
    const f = await evalIn(ctx.tabA, `(async () => {
      const rows = Array.from(document.querySelectorAll("#list .row"));
      const self = rows.filter((r) => /this add-on/.test(r.textContent || ""))[0];
      const other = rows.filter((r) => r !== self)[0];
      let all = [];
      try { all = await browser.management.getAll(); } catch (e) { all = []; }
      return {
        rows: rows.length,
        self: !!self,
        selfHasRemove: self ? !!self.querySelector("button[data-act=remove]") : null,
        selfHasToggle: self ? !!self.querySelector("button[data-act=toggle]") : null,
        all: all.length,
        otherHasToggle: other ? !!other.querySelector("button[data-act=toggle]") : null,
        installs: document.querySelectorAll("[data-act=install], input[type=file]").length,
        count: (document.getElementById("count") || {}).textContent || "",
      };
    })()`);
    assert(f.all > 0, "the management API answered with installed add-ons: " + JSON.stringify(f));
    assert(f.rows > 0, "the page renders a row per add-on: " + JSON.stringify(f));
    assert(f.self === true, "Lazyfox's own row is present: " + JSON.stringify(f));
    assert(f.selfHasRemove === false && f.selfHasToggle === false, "its own row offers no remove/toggle");
    assert(f.otherHasToggle === true, "another add-on's row offers the enable/disable control");
    assert(f.installs === 0, "nothing on the page installs an add-on");
    assert(/on/.test(f.count), "the count line reports the enabled total, got " + JSON.stringify(f.count));

    // `/` puts the caret in the filter, and a non-matching filter empties the
    // list rather than leaving every row in place.
    await evalIn(ctx.tabA, `(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
      return true;
    })()`);
    const focused = await evalIn(ctx.tabA, `document.activeElement === document.getElementById("filter")`);
    assert(focused === true, "/ focuses the filter");
    await evalIn(ctx.tabA, `(() => {
      const i = document.getElementById("filter");
      i.value = "zzzz-no-such-addon";
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const none = await waitFor(async () =>
      evalIn(ctx.tabA, `document.querySelectorAll("#list .row").length === 0 ? true : null`), 4000
    ).catch(() => null);
    assert(none === true, "a filter that matches nothing leaves no rows");
    await evalIn(ctx.tabA, `(() => {
      const i = document.getElementById("filter");
      i.value = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);

    // The home page's row opens it. From the home page the tab is replaced in
    // place, which is the rule every extension page follows there.
    await ctx.openCC(ctx.tabA);
    const clicked = await evalIn(ctx.tabA, `(() => {
      const rows = Array.prototype.slice.call(document.querySelectorAll("#results .result"));
      const row = rows.filter((r) => /Add-ons/.test(r.textContent || "") && !/manager/i.test(r.textContent || ""))[0];
      if (!row) return rows.map((r) => (r.textContent || "").trim().slice(0, 80)).join(" | ");
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return true;
    })()`);
    assert(clicked === true, "the home page has an Add-ons row; rows=" + JSON.stringify(clicked));
    const opened = await waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.find((x) => (x.url || "").includes("addons.html")) || null;
    }, 8000).catch(() => null);
    assert(opened, "the Add-ons row opens the add-ons page");
    await ctx.gotoUrl(ctx.tabA, ctx.ccUrl, "complete").catch(() => {});
  });
}
