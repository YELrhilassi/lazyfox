// Options page: saves config + chrome hotkeys to storage and pushes them to
// the chrome helper over the #lfc=cfg URL channel (fragment built by the Go
// core). The keyboard handling for this page lives in optionskeys.ts.

import { CHROME_HOTKEY_DEFAULTS, CONFIG_DEFAULTS } from "../shared/config";
import { core } from "../shared/core";

(function () {
  "use strict";

  const leader = document.getElementById("leader") as HTMLInputElement;
  const hintChars = document.getElementById("hintChars") as HTMLInputElement;
  const scrollKeys = document.getElementById("scrollKeys") as HTMLInputElement;
  const openInNewTab = document.getElementById("openInNewTab") as HTMLInputElement;
  const hoverReveal = document.getElementById("hoverReveal") as HTMLInputElement;
  const whichKey = document.getElementById("whichKey") as HTMLInputElement;
  const saveBtn = document.getElementById("save") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLSpanElement;

  const CH_KEYS = Object.keys(CHROME_HOTKEY_DEFAULTS);
  const chEls: { [k: string]: HTMLInputElement } = {};
  for (const k of CH_KEYS) {
    chEls[k] = document.getElementById("ch" + k[0].toUpperCase() + k.slice(1)) as HTMLInputElement;
  }
  const chStatusEl = document.getElementById("chStatus") as HTMLSpanElement;
  let chTimer: ReturnType<typeof setTimeout> | null = null;

  function chBindingsFromForm() {
    const bindings: { [k: string]: string } = {};
    for (const k of CH_KEYS) {
      bindings[k] =
        (chEls[k].value || "").trim() || CHROME_HOTKEY_DEFAULTS[k as keyof typeof CHROME_HOTKEY_DEFAULTS];
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
      whichKey: whichKey.checked
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

  browser.storage.local.get(["config", "chromeBindings"]).then((r: any) => {
    const c = Object.assign({}, CONFIG_DEFAULTS, r.config || {});
    leader.value = c.leader;
    hintChars.value = c.hintChars;
    scrollKeys.checked = c.scrollKeys !== false;
    openInNewTab.checked = c.openInNewTab !== false;
    hoverReveal.checked = c.hoverReveal !== false;
    whichKey.checked = c.whichKey !== false;
    const cb = Object.assign({}, CHROME_HOTKEY_DEFAULTS, r.chromeBindings || {});
    for (const k of CH_KEYS) {
      chEls[k].value = cb[k];
    }
  });

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
