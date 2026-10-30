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
        // Appearance is its own section, separate from Dark mode: five presets,
        // a live accent/background override and a preview strip.
        appearanceNav: !!document.querySelector('a[data-sec="sec-appearance"]'),
        presetCount: document.querySelectorAll("#presets .preset").length,
        presetOn: !!document.querySelector("#presets .preset.on"),
        uiAccent: q("#uiAccent") ? q("#uiAccent").value : null,
        uiBackground: q("#uiBackground") ? q("#uiBackground").value : null,
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
    assert(f.appearanceNav === true, "Appearance section in the settings nav");
    assert(f.presetCount === 5, "five UI presets offered: " + f.presetCount);
    assert(f.presetOn === true, "the current preset is marked");
    assert(/^#[0-9a-f]{6}$/i.test(f.uiAccent || ""), "accent swatch shows a hex colour: " + f.uiAccent);
    assert(/^#[0-9a-f]{6}$/i.test(f.uiBackground || ""), "background swatch shows a hex colour: " + f.uiBackground);
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
  // The palette is not a picture of the palette: picking a preset has to
  // actually repaint the page, save it, and come back after a reload. The
  // computed colour is the check that the tokens reached the document rather
  // than only the radio being marked.
  await t("options page: a preset repaints the page, saves and returns", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await ctx.waitExpr(
      ctx.tabA,
      `document.querySelectorAll("#presets .preset").length === 5`,
      true,
      8000,
    );
    const after = await evalIn(ctx.tabA, `(() => {
      const btn = [...document.querySelectorAll("#presets .preset")]
        .find((b) => (b.title || "").indexOf("Catppuccin") === 0);
      if (!btn) return { error: "no Catppuccin preset" };
      btn.click();
      return {
        bg: getComputedStyle(document.body).backgroundColor,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--lf-accent").trim(),
        marked: !!document.querySelector("#presets .preset.on"),
      };
    })()`);
    assert(!after.error, after.error || "");
    // Catppuccin Mocha's base is #1e1e2e.
    assert(after.bg === "rgb(30, 30, 46)", "the page repainted in the preset's ground, got " + after.bg);
    assert(after.accent === "#89b4fa", "the accent token moved with the preset, got " + after.accent);
    assert(after.marked === true, "the chosen preset is marked");
    await evalIn(ctx.tabA, `document.querySelector("#save").click()`);
    await waitFor(async () => {
      const s = await evalIn(ctx.tabA, `document.querySelector("#status").textContent`);
      return s === "saved" ? true : null;
    }, 5000);
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await ctx.waitExpr(
      ctx.tabA,
      `document.querySelectorAll("#presets .preset").length === 5`,
      true,
      8000,
    );
    const stored = await evalIn(ctx.tabA, `browser.storage.local.get("config").then((r) => (r.config.theme || {}).preset)`);
    assert(stored === "catppuccin", "the preset persisted under config.theme, got " + JSON.stringify(stored));
    const back = await evalIn(ctx.tabA, `getComputedStyle(document.body).backgroundColor`);
    assert(back === "rgb(30, 30, 46)", "the reloaded page paints the saved preset, got " + back);
  });

  // The appearance pass is judged on two things a screenshot cannot assert:
  // that the preview is the same flat bar the product draws (one accent, 1px
  // gaps, mute last), and that every ink stays readable on the LIGHT preset —
  // the case that used to paint white text on paper.
  await t("appearance: the bar preview is flat and the light preset stays readable", async () => {
    const u = ctx.ccUrl.replace("commandcenter.html", "options.html");
    await ctx.gotoUrl(ctx.tabA, u, "complete");
    await ctx.waitExpr(ctx.tabA, `document.querySelectorAll("#presets .preset").length === 5`, true, 8000);
    const r = await evalIn(ctx.tabA, `(() => {
      const rgb = (s) => (String(s).match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const lum = (s) => { const c = rgb(s); return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };
      const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };
      const sun = Array.from(document.querySelectorAll("#presets .preset"))
        .find((b) => /Solarized/.test(b.textContent || ""));
      sun.click();
      const bar = document.getElementById("tpBar");
      const pills = bar.querySelectorAll(".sesspill");
      const active = bar.querySelector(".sesspill.active");
      const idle = bar.querySelector(".sesspill:not(.active)");
      const body = getComputedStyle(document.body);
      return {
        light: document.documentElement.getAttribute("data-lf-ui"),
        bodyRatio: ratio(body.color, body.backgroundColor),
        cardRatio: ratio(getComputedStyle(document.querySelector(".card")).color,
                        getComputedStyle(document.querySelector(".card")).backgroundColor),
        activeInk: ratio(getComputedStyle(active).color, getComputedStyle(active).backgroundColor),
        idleInk: ratio(getComputedStyle(idle).color, getComputedStyle(idle).backgroundColor),
        activeBg: getComputedStyle(active).backgroundColor,
        idleBg: getComputedStyle(idle).backgroundColor,
        gap: getComputedStyle(pills[1]).marginLeft,
        clip: getComputedStyle(active).clipPath,
        barHeight: getComputedStyle(bar).height,
        barFont: getComputedStyle(bar).fontSize,
        pillFont: getComputedStyle(active).fontSize,
        mkFont: getComputedStyle(active.querySelector(".mk")).fontSize,
        oldCell: bar.querySelectorAll(".seg.sess, .sess").length,
        icons: bar.querySelectorAll("svg").length,
        last: bar.lastElementChild ? bar.lastElementChild.className : "",
        logo: (document.getElementById("logoImg") || {}).src || "",
      };
    })()`);
    assert(r.light === "light", "the light preset marks the document as light: " + r.light);
    assert(r.bodyRatio >= 7, "body ink on the light ground = " + r.bodyRatio.toFixed(1) + ":1");
    assert(r.cardRatio >= 7, "card ink on its panel = " + r.cardRatio.toFixed(1) + ":1");
    assert(r.activeInk >= 4.5, "active pill ink on the accent = " + r.activeInk.toFixed(1) + ":1");
    assert(r.idleInk >= 4.5, "idle pill ink on its fill = " + r.idleInk.toFixed(1) + ":1");
    assert(r.activeBg !== r.idleBg, "only the active session wears the accent: " + r.activeBg + " vs " + r.idleBg);
    assert(r.gap === "1px", "session pills are separated by 1px, got " + r.gap);
    // The preview has to show the pills as they ship: a chevron with a notch on
    // its left edge and a point on its right, not a rounded box.
    assert(/polygon\(/.test(r.clip), "the pill is the shipped chevron, got " + r.clip);
    assert(/5px 50%/.test(r.clip), "the pill's left edge is a notch, got " + r.clip);
    // The type was enlarged WITHOUT growing the strip; the paddings paid for it.
    assert(r.barHeight === "18px", "the preview keeps the real bar's 18px height, got " + r.barHeight);
    assert(r.barFont === "15px", "the bar's type is 15px, got " + r.barFont);
    assert(r.pillFont === "15px", "session names inherit the bar's 15px, got " + r.pillFont);
    assert(r.mkFont === "16px", "the marker id leads the pill's scale at 16px, got " + r.mkFont);
    assert(r.oldCell === 0, "the separate current-session cell is gone");
    assert(r.icons >= 4, "the bar uses the shared icon set, got " + r.icons + " svg");
    assert(/\bmute\b/.test(r.last), "the muted badge is the last segment, got " + r.last);
    assert(/lazyfox-logo-light\.svg$/.test(r.logo), "the light UI uses the dark wordmark: " + r.logo);
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
