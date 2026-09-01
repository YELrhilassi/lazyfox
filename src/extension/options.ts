// Options page: saves config + chrome hotkeys to storage and pushes them to
// the chrome helper over the #lfc=cfg URL channel (fragment built by the Go
// core). Also owns the quick-launch web-app editor (config.apps). The keyboard
// handling for this page lives in optionskeys.ts.

import { CHROME_HOTKEY_DEFAULTS, CONFIG_DEFAULTS, defaultApps } from "../shared/config";
import { core } from "../shared/core";
import { favicon } from "../shared/dom";
import { send } from "../shared/protocol";
import type { QuickApp } from "../shared/types";

(function () {
  "use strict";

  const leader = document.getElementById("leader") as HTMLInputElement;
  const hintChars = document.getElementById("hintChars") as HTMLInputElement;
  const scrollKeys = document.getElementById("scrollKeys") as HTMLInputElement;
  const openInNewTab = document.getElementById("openInNewTab") as HTMLInputElement;
  const hoverReveal = document.getElementById("hoverReveal") as HTMLInputElement;
  const whichKey = document.getElementById("whichKey") as HTMLInputElement;
  const statusBar = document.getElementById("statusBar") as HTMLInputElement;
  const statusBarPosition = document.getElementById("statusBarPosition") as HTMLSelectElement;
  const autoRestore = document.getElementById("autoRestore") as HTMLInputElement;
  const saveBtn = document.getElementById("save") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLSpanElement;

  const CH_KEYS = Object.keys(CHROME_HOTKEY_DEFAULTS);
  const chEls: { [k: string]: HTMLInputElement } = {};
  for (const k of CH_KEYS) {
    chEls[k] = document.getElementById("ch" + k[0]!.toUpperCase() + k.slice(1)) as HTMLInputElement;
  }
  const chStatusEl = document.getElementById("chStatus") as HTMLSpanElement;
  let chTimer: ReturnType<typeof setTimeout> | null = null;

  /* ------------------------- quick-launch apps editor ------------------------- */

  const appsList = document.getElementById("appsList") as HTMLDivElement;
  const addAppBtn = document.getElementById("addApp") as HTMLButtonElement;

  // Live favicon preview uses the shared helper (same source as the
  // command-center tiles), so each row shows the site's real icon.
  function renderAppRow(app: QuickApp): void {
    const row = document.createElement("div");
    row.className = "app-row";

    const en = document.createElement("input");
    en.type = "checkbox";
    en.className = "en";
    en.checked = app.enabled;
    en.addEventListener("change", () => updatePreview(row));

    const ic = document.createElement("div");
    ic.className = "ic";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "name";
    name.placeholder = "Name";
    name.value = app.name;

    const url = document.createElement("input");
    url.type = "text";
    url.className = "url";
    url.placeholder = "https://…";
    url.value = app.url;
    url.addEventListener("input", () => updatePreview(row));

    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "\u00d7";
    rm.title = "Remove";
    rm.addEventListener("click", () => row.remove());

    row.appendChild(en);
    row.appendChild(ic);
    row.appendChild(name);
    row.appendChild(url);
    row.appendChild(rm);
    row.dataset.appId = app.id;

    appsList.appendChild(row);
    updatePreview(row);
  }

  function updatePreview(row: HTMLElement): void {
    const url = (row.querySelector(".url") as HTMLInputElement).value;
    const ic = row.querySelector(".ic") as HTMLDivElement;
    ic.textContent = "";
    const icUrl = favicon(url);
    if (icUrl) {
      const img = document.createElement("img");
      img.src = icUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      ic.appendChild(img);
    } else {
      ic.textContent = "\u2026";
    }
  }

  function addAppRow(app: QuickApp): void {
    renderAppRow(app);
  }

  function appsFromForm(): QuickApp[] {
    const out: QuickApp[] = [];
    let n = 0;
    for (const row of Array.from(appsList.querySelectorAll<HTMLElement>(".app-row"))) {
      const name = ((row.querySelector(".name") as HTMLInputElement).value || "").trim();
      const url = ((row.querySelector(".url") as HTMLInputElement).value || "").trim();
      const enabled = (row.querySelector(".en") as HTMLInputElement).checked;
      const id = row.dataset.appId || "app" + n;
      if (name || url) {
        out.push({ id, name: name || url.split("/")[2] || url, url, enabled });
      }
      n++;
    }
    return out;
  }

  addAppBtn.addEventListener("click", () => {
    addAppRow({ id: "app" + Date.now().toString(36), name: "", url: "https://", enabled: true });
    (appsList.lastElementChild!.querySelector(".name") as HTMLInputElement).focus();
  });

  function chBindingsFromForm() {
    const bindings: { [k: string]: string } = {};
    for (const k of CH_KEYS) {
      bindings[k] =
        (chEls[k]!.value || "").trim() || CHROME_HOTKEY_DEFAULTS[k as keyof typeof CHROME_HOTKEY_DEFAULTS];
    }
    return bindings;
  }

  function formConfig() {
    return {
      leader: leader.value || CONFIG_DEFAULTS.leader,
      hintChars: hintChars.value || CONFIG_DEFAULTS.hintChars,
      scrollKeys: scrollKeys.checked,
      openInNewTab: openInNewTab.checked,
      hoverReveal: hoverReveal.checked,
      whichKey: whichKey.checked,
      statusBar: statusBar.checked,
      statusBarPosition: statusBarPosition.value === "top" ? "top" : "bottom",
      autoRestore: autoRestore.checked,
      apps: appsFromForm()
    };
  }

  function pushChromeBindings() {
    const payload = { bindings: chBindingsFromForm(), config: formConfig() };
    const nonce =
      Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    chStatusEl.textContent = "pushing\u2026";
    void core.lfcCfg(nonce, encodeURIComponent(JSON.stringify(payload))).then((hash) => {
      const base = location.href.split("#")[0];
      location.replace(base + "#" + hash);
    });
    if (chTimer) clearTimeout(chTimer);
    chTimer = setTimeout(() => {
      chStatusEl.textContent =
        "no response from the chrome script \u2014 is chrome/userChrome.uc.js installed?";
    }, 3000);
  }

  window.addEventListener("hashchange", () => {
    const h = location.hash;
    if (h.indexOf("#lfc=ok.") === 0) {
      if (chTimer) clearTimeout(chTimer);
      chStatusEl.textContent = "chrome script updated";
      setTimeout(() => (chStatusEl.textContent = ""), 2000);
    } else if (h.indexOf("#lfc=err.") === 0) {
      if (chTimer) clearTimeout(chTimer);
      chStatusEl.textContent = "chrome script rejected the config";
    }
  });

  // Component versions (the Components panel).
  void send("components").then((c) => {
    if (!c) return;
    const set = (id: string, v: string | null | undefined) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v || "n/a";
    };
    set("cExt", c.extension);
    set("cWasm", c.wasm);
    set("cHost", c.nativeHost ? c.nativeHost + (c.nativeProtocol ? " (proto " + c.nativeProtocol + ")" : "") : null);
    set("cChrome", c.chromeHelper);
  });

  browser.storage.local.get(["config", "chromeBindings"]).then((r: any) => {
    const c = Object.assign({}, CONFIG_DEFAULTS, r.config || {});
    leader.value = c.leader;
    hintChars.value = c.hintChars;
    scrollKeys.checked = c.scrollKeys !== false;
    openInNewTab.checked = c.openInNewTab !== false;
    hoverReveal.checked = c.hoverReveal !== false;
    whichKey.checked = c.whichKey !== false;
    statusBar.checked = c.statusBar !== false;
    statusBarPosition.value = c.statusBarPosition === "top" ? "top" : "bottom";
    autoRestore.checked = c.autoRestore !== false;
    // Apps: fall back to defaults when absent (linked by reference via spread).
    const apps: QuickApp[] = Array.isArray(c.apps) && c.apps.length ? c.apps : defaultApps();
    appsList.textContent = "";
    apps.forEach((a) => addAppRow(a));
    const cb = Object.assign({}, CHROME_HOTKEY_DEFAULTS, r.chromeBindings || {});
    for (const k of CH_KEYS) {
      chEls[k]!.value = cb[k];
    }
  });

  // Horizontal logo (icon + wordmark) in the settings header.
  try {
    const img = document.getElementById("logoImg") as HTMLImageElement;
    img.src = browser.runtime.getURL("lazyfox-logo.svg");
  } catch (e) {
    // ignore
  }

  saveBtn.addEventListener("click", () => {
    browser.storage.local
      .set({
        config: formConfig(),
        chromeBindings: chBindingsFromForm()
      })
      .then(() => {
        statusEl.textContent = "saved";
        setTimeout(() => (statusEl.textContent = ""), 1500);
      });
    pushChromeBindings();
  });
})();