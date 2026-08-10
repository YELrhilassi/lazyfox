(function () {
  "use strict";

  const leader = document.getElementById("leader");
  const hintChars = document.getElementById("hintChars");
  const scrollKeys = document.getElementById("scrollKeys");
  const openInNewTab = document.getElementById("openInNewTab");
  const hoverReveal = document.getElementById("hoverReveal");
  const saveBtn = document.getElementById("save");
  const statusEl = document.getElementById("status");

  const CH_DEFAULTS = {
    preferences: "Ctrl+Alt+O",
    addons: "Ctrl+Alt+A",
    history: "Ctrl+Alt+H",
    downloads: "Ctrl+Alt+D"
  };
  const CH_KEYS = Object.keys(CH_DEFAULTS);
  const chEls = {};
  for (const k of CH_KEYS) {
    chEls[k] = document.getElementById("ch" + k[0].toUpperCase() + k.slice(1));
  }
  const chStatusEl = document.getElementById("chStatus");
  let chTimer = null;

  function chBindingsFromForm() {
    const bindings = {};
    for (const k of CH_KEYS) {
      bindings[k] = (chEls[k].value || "").trim() || CH_DEFAULTS[k];
    }
    return bindings;
  }

  function formConfig() {
    return {
      leader: leader.value || ";",
      hintChars: hintChars.value || "asdfjkl;gh",
      scrollKeys: scrollKeys.checked,
      openInNewTab: openInNewTab.checked,
      hoverReveal: hoverReveal.checked
    };
  }

  function pushChromeBindings() {
    const payload = { bindings: chBindingsFromForm(), config: formConfig() };
    const nonce =
      Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    chStatusEl.textContent = "pushing\u2026";
    const base = location.href.split("#")[0];
    location.replace(
      base + "#lfc=cfg." + nonce + "." + encodeURIComponent(JSON.stringify(payload))
    );
    clearTimeout(chTimer);
    chTimer = setTimeout(() => {
      chStatusEl.textContent =
        "no response from the chrome script \u2014 is chrome/userChrome.uc.js installed?";
    }, 3000);
  }

  window.addEventListener("hashchange", () => {
    const h = location.hash;
    if (h.indexOf("#lfc=ok.") === 0) {
      clearTimeout(chTimer);
      chStatusEl.textContent = "chrome script updated";
      setTimeout(() => (chStatusEl.textContent = ""), 2000);
    } else if (h.indexOf("#lfc=err.") === 0) {
      clearTimeout(chTimer);
      chStatusEl.textContent = "chrome script rejected the config";
    }
  });

  browser.storage.local.get(["config", "chromeBindings"]).then((r) => {
    const c = Object.assign(
      { leader: ";", hintChars: "asdfjkl;gh", scrollKeys: true, openInNewTab: true, hoverReveal: true },
      r.config || {}
    );
    leader.value = c.leader;
    hintChars.value = c.hintChars;
    scrollKeys.checked = c.scrollKeys !== false;
    openInNewTab.checked = c.openInNewTab !== false;
    hoverReveal.checked = c.hoverReveal !== false;
    const cb = Object.assign({}, CH_DEFAULTS, r.chromeBindings || {});
    for (const k of CH_KEYS) chEls[k].value = cb[k];
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
