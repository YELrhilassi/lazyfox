// Command center: the vim-style home tab where modes are switched with
// `;s`/`;o`/`;t`/etc and `;leader` style commands run without the chrome
// helper. This file is the composition root: it grabs the DOM refs, builds
// the state store, wires the data/render/keys modules together, and attaches
// the event listeners. All logic lives in commandcenter/{state,data,render,keys}.

import { mergeConfig } from "../shared/config";
import { core, ensureCore } from "../shared/core";
import { send } from "../shared/protocol";
import type { QuickApp } from "../shared/types";
import { openItem } from "./commandcenter/data";
import { createKeyHandler } from "./commandcenter/keys";
import { createRenderer, type CCRefs } from "./commandcenter/render";
import { createStore } from "./commandcenter/state";

(function () {
  "use strict";

  const refs: CCRefs = {
    input: document.getElementById("input") as HTMLInputElement,
    resultsEl: document.getElementById("results") as HTMLUListElement,
    emptyEl: document.getElementById("empty") as HTMLDivElement,
    modeTag: document.getElementById("modeTag") as HTMLSpanElement,
    stateEl: document.getElementById("state") as HTMLSpanElement,
    resizePanel: document.getElementById("resizePanel") as HTMLDivElement,
    resizeSize: document.getElementById("resizeSize") as HTMLSpanElement,
    movePanel: document.getElementById("movePanel") as HTMLDivElement,
    movePos: document.getElementById("movePos") as HTMLSpanElement,
  };

  const store = createStore();

  // Enabled quick-launch apps for the home grid. Kept mutable so a config
  // change (options page) refreshes the grid live.
  let apps: QuickApp[] = [];
  function getApps(): QuickApp[] {
    return apps;
  }
  void browser.storage.local.get("config").then((r: any) => {
    apps = mergeConfig(r && r.config).apps;
    renderer.refresh();
  });
  browser.storage.onChanged.addListener((changes: any, area: any) => {
    if (area === "local" && changes.config && changes.config.newValue) {
      apps = mergeConfig(changes.config.newValue).apps;
      renderer.refresh();
    }
  });

  const quick = {
    newTab: () => void send("newTab"),
    reopenTab: () => void send("reopenTab"),
    duplicateTab: () => void send("duplicateTab"),
    closeTab: () => keyHandler.closeTabConfirm(),
    zen: () => void send("zen"),
    openResize: () => renderer.toggleResize(true),
    openMove: () => renderer.toggleMove(true),
    quit: () => void send("quit"),
    openOptions: () => {
      try {
        browser.runtime.openOptionsPage();
      } catch (e) {}
    },
    openSetup: () => void send("openSetup"),
    openPage: (url: string) => void send("openPage", { url }),
    setMode: (m: string) => renderer.setMode(m),
    stealthOpen: () => void send("stealthOpen"),
  };

  // The renderer owns the view; the key handler owns input. They depend on
  // each other (renderer drives the grid, keys drive the renderer), so wire
  // them with a late-bound reference.
  let renderer!: ReturnType<typeof createRenderer>;
  const keyHandler = createKeyHandler({
    refs,
    store,
    renderer: {
      // Delegate to the real renderer once it exists.
      setMode: (m) => renderer.setMode(m),
      refresh: () => renderer.refresh(),
      cycleMode: (d) => renderer.cycleMode(d),
      move: (dx, dy) => renderer.move(dx, dy),
      toggleResize: (o) => renderer.toggleResize(o),
      toggleMove: (o) => renderer.toggleMove(o),
      updateResizeSize: () => renderer.updateResizeSize(),
      updateMovePos: () => renderer.updateMovePos(),
      setStateTag: (l) => renderer.setStateTag(l),
      flashTag: (m) => renderer.flashTag(m),
    },
    focusInput,
  });

  renderer = createRenderer({
    refs,
    store,
    quick,
    openItem,
    getApps,
  });

  function focusInput(): void {
    try {
      refs.input.focus({ preventScroll: true });
    } catch (e) {
      refs.input.focus();
    }
  }

  window.addEventListener("keydown", keyHandler.onKeyDown, true);

  refs.input.addEventListener("focus", () => {
    renderer.setStateTag("insert");
  });
  refs.input.addEventListener("blur", () => {
    renderer.setStateTag("cmd");
  });

  refs.input.addEventListener("input", () => {
    const v = refs.input.value.trim();
    const finish = () => {
      if (inputTimer) clearTimeout(inputTimer);
      inputTimer = setTimeout(() => renderer.refresh(), 70);
    };
    const mode = store.get().mode;
    if (mode === "search" && v) {
      void core.isLikelyUrl(v).then((likely) => {
        if (likely) {
          renderer.setMode("url");
          return;
        }
        finish();
      });
      return;
    }
    if (mode === "url" && v) {
      void core.isLikelyUrl(v).then((likely) => {
        if (!likely) {
          renderer.setMode("search");
          return;
        }
        finish();
      });
      return;
    }
    finish();
  });

  let inputTimer: ReturnType<typeof setTimeout> | null = null;

  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.addEventListener("click", () => {
      focusInput();
      renderer.setMode((b as HTMLElement).dataset.mode!);
    });
  });

  document.querySelectorAll("#resizePanel .rp-btns button").forEach((b) => {
    b.addEventListener("click", () => {
      send("resizeWindow", { dx: Number((b as HTMLElement).dataset.dx) || 0, dy: Number((b as HTMLElement).dataset.dy) || 0 }).then(renderer.updateResizeSize);
      focusInput();
    });
  });
  document.querySelectorAll("#movePanel .rp-btns button").forEach((b) => {
    b.addEventListener("click", () => {
      send("moveWindow", { dx: Number((b as HTMLElement).dataset.mx) || 0, dy: Number((b as HTMLElement).dataset.my) || 0 }).then(renderer.updateMovePos);
      focusInput();
    });
  });
  document.getElementById("rpMax")!.addEventListener("click", () => {
    send("maximize").then(renderer.updateResizeSize);
    focusInput();
  });

  renderer.setMode("search");
  renderer.updateResizeSize();

  // Brand logo: ship the horizontal lockup (icon + wordmark). It is a
  // transparent SVG so it sits on the page background with no box behind it.
  try {
    const logo = document.getElementById("brandLogo");
    if (logo) {
      const img = document.createElement("img");
      img.src = browser.runtime.getURL("lazyfox-logo.svg");
      img.alt = "Lazyfox";
      logo.appendChild(img);
    }
  } catch (e) {
    // keep the empty brand area if the logo is unavailable
  }

  // Footer meta: the active session name (falling back to the active Firefox
  // profile name, which is always present), Firefox version, Lazyfox version.
  // The session/profile parts re-render on storage changes; the Firefox version
  // resolves async and re-renders once known (it used to stay "firefox ?").
  const meta = document.getElementById("footerMeta");
  if (meta) {
    const esc = (s: string) =>
      s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[c]!);
    let fxVer = "firefox ?";
    try {
      void browser.runtime
        .getBrowserInfo()
        .then((i: any) => {
          fxVer = "firefox " + (i && i.version ? i.version : "?");
          refreshMeta();
        })
        .catch(() => {});
    } catch (e) {}
    const renderMeta = (sess: string, prof: string): void => {
      const manifest = browser.runtime.getManifest();
      const parts: string[] = [];
      if (sess) parts.push("session <b>" + esc(sess) + "</b>");
      else if (prof) parts.push("profile <b>" + esc(prof) + "</b>");
      parts.push(fxVer);
      parts.push("lazyfox " + (manifest && manifest.version ? manifest.version : "?"));
      meta.innerHTML = parts.join(" &middot; ");
    };
    const refreshMeta = (): void => {
      void browser.storage.local.get(["lfCurrentSession", "lfProfileName"]).then((r: any) => {
        renderMeta((r && r.lfCurrentSession) || "", (r && r.lfProfileName) || "");
      });
    };
    refreshMeta();
    browser.storage.onChanged.addListener((changes: any, area: any) => {
      if (area === "local" && (changes.lfCurrentSession || changes.lfProfileName)) refreshMeta();
    });
  }

  // First-run install indicator: once the chrome helper is alive, Lazyfox is
  // fully installed and the banner stays hidden. Shown (amber) otherwise.
  const banner = document.getElementById("installBanner");
  const installBtn = document.getElementById("installGo");
  function refreshInstallBanner(alive: boolean | undefined): void {
    if (!banner) return;
    const missing = alive !== true;
    banner.classList.toggle("show", missing);
  }
  if (installBtn) {
    installBtn.addEventListener("click", () => void send("openSetup"));
  }
  if (banner) {
    void browser.storage.local.get("chromeAlive").then((r: any) => refreshInstallBanner(r.chromeAlive));
    browser.storage.onChanged.addListener((changes: any, area: any) => {
      if (area === "local" && changes.chromeAlive) refreshInstallBanner(!!changes.chromeAlive.newValue);
    });
  }

  // Warm the Go core off the critical path so the first keystroke's URL-vs-
  // search detection and Enter's URL normalization are instant instead of
  // paying a cold wasm instantiation (the home grid renders regardless).
  void ensureCore().catch(() => {});
  // Start in COMMAND mode with the input blurred: the home grid is keyboard-
  // first, so hjkl/arrows navigate the tiles, Enter opens the selection, and
  // `;` arms the leader (so ;I / ;f and ctrl/shift combos reach their actions)
  // with no need to click first. Typing any other printable key focuses the
  // input and starts a search (the key handler drives that).
  renderer.setStateTag("cmd");
  window.addEventListener("load", () => {
    renderer.setStateTag("cmd");
    document.body.classList.add("ready");
  });

  // Stealth home: when this command center is shown inside a stealth tab
  // (one of our isolated containers, e.g. after `;N` from a blank tab or a
  // new tab opened inside a stealth tab), render it with a distinct look so
  // it is obvious at a glance that the tab is sandboxed and wipes on close.
  (async function detectStealthHome() {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const t = tabs && tabs[0];
      if (!t || !t.cookieStoreId || t.cookieStoreId === "firefox-default") return;
      const r = await browser.storage.local.get("lfStealth");
      const containers = r && r.lfStealth && r.lfStealth.containers;
      if (Array.isArray(containers) && containers.indexOf(t.cookieStoreId) !== -1) {
        document.documentElement.classList.add("lf-stealth");
      }
    } catch (e) {
      // ignore — the page still works without the stealth badge
    }
  })();
})();
