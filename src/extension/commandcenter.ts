// Command center: the vim-style home tab where modes are switched with
// `;s`/`;o`/`;t`/etc and `;leader` style commands run without the chrome
// helper. This file is the composition root: it grabs the DOM refs, builds
// the state store, wires the data/render/keys modules together, and attaches
// the event listeners. All logic lives in commandcenter/{state,data,render,keys}.

import { mergeConfig } from "../shared/config";
import { core, ensureCore } from "../shared/core";
import { LeaderController, isCancel } from "../shared/leader";
import { mirror, mirrorFlag } from "../shared/observability";
import { openPopup as overlayOpenPopup, toast, type PopupCtl } from "../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";
import { send } from "../shared/protocol";
import { readKey, vBoolean, vConfig, vStealth, vString } from "./store";
import type { Config, QuickApp } from "../shared/types";
import { openItem } from "./commandcenter/data";
import { createKeyHandler } from "./commandcenter/keys";
import { createRenderer, type CCRefs } from "./commandcenter/render";
import { createStore } from "./commandcenter/state";
import { createContentOps } from "./content/ops";
import { traceDecision } from "./commandcenter/trace";
import type { ContentPopupShell } from "./content/find";

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
  // The page's own view of the config. It used to read only `apps`, because the
  // leader lived in the chrome helper; now that the page arms the shared leader
  // itself it needs the same two settings every other host reads: the leader key
  // and whether the which-key overlay is enabled.
  let config: Config = mergeConfig(undefined);
  function applyConfig(c: Partial<Config> | undefined): void {
    config = mergeConfig(c);
    apps = config.apps;
    renderer.refresh();
  }
  void readKey("config", vConfig, {}).then(applyConfig);
  browser.storage.onChanged.addListener((changes: any, area: any) => {
    if (area === "local" && changes.config && changes.config.newValue) {
      applyConfig(changes.config.newValue);
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
      } catch (e) {
        // openOptionsPage is unavailable in some contexts; the rest of the command
        // center stays usable without it.
      }
    },
    openSetup: () => void send("openSetup"),
    openPage: (url: string) => void send("openPage", { url }),
    setMode: (m: string) => renderer.setMode(m),
    stealthOpen: () => void send("stealthOpen"),
  };

  /* ===================== the shared leader ===================== */

  // THE HOME PAGE RUNS THE SAME KEYMAP AS EVERY OTHER PAGE.
  //
  // Everything behind `;` here used to be this page's own private table: a
  // dozen hand-written branches that had drifted from the shared one in both
  // directions. Keys the rest of the browser has were missing outright — `;a`
  // (alternate tab), `;G`/`;L` (the navigation stack), `;P` (sessions), the
  // whole two-key category grammar, the digit jumps — while the keys it did
  // have were spelled differently. That is what "the home page uses its own
  // shortcuts" was, and why `;f` here behaved unlike `;f` everywhere else.
  //
  // So this is the same three-piece construction the content script builds:
  //
  //   createContentOps     the ActionOps adapter (protocol messages plus the
  //                        shared popups) — already written, already shared
  //   makeLeaderActions    the ONE action table; which CHORD runs which action
  //                        is core/keymap.go, fetched by keymap.ts, and it is
  //                        the same table `;W` / `;Z` / `;K` are rows of
  //   LeaderController     the armed state, the which-key overlay, the captures
  //
  // What stays page-specific is only what is genuinely about THIS page: `;f`
  // arms hint-PICK on the home grid rather than drawing link hints, and the grid
  // itself (hjkl, Enter, the quick-view filters) is untouched.
  let currentPopup: PopupCtl | null = null;

  function closePopup(): void {
    if (currentPopup) {
      try {
        currentPopup.close();
      } catch (e) {
        // ignore — a popup that fails to close must not wedge the page
      }
      currentPopup = null;
    }
  }

  const shell: ContentPopupShell = {
    open: (html, build) => {
      closePopup();
      leader.hide();
      const ctl = overlayOpenPopup(html, (root: HTMLElement) => build(root), () => {
        currentPopup = null;
      });
      currentPopup = ctl;
      return ctl;
    },
    close: closePopup,
  };

  // `;f` on the home grid: every tile gets a letter badge and the next key runs
  // that tile — the home-page equivalent of web link hints. Anywhere else it
  // focuses the search box, which is what the chrome helper's `lazyfox-find`
  // signal does too.
  function startGridHints(): void {
    if (renderer.isHome()) {
      store.patch({ hintArmed: true });
      renderer.refresh();
      return;
    }
    renderer.setStateTag("insert");
    focusInput();
  }

  const ccOps = createContentOps({
    shell: shell,
    config: () => config,
    startHints: startGridHints,
    focusFirstInput: focusInput,
    // The page has no window-level bar of its own; the chrome helper owns the
    // single one, and this is how a find running in THIS page reaches it.
    setFindState: (s) => {
      void send("syncFind", s ? { cur: s.cur, count: s.count } : { cur: 0, count: -1 });
    },
  });

  const ctx: PopupCtx = {
    ops: ccOps,
    open: shell.open,
    close: closePopup,
    toast: toast,
    runAction: (k) => {
      // The leaf that ran, by ACTION ID — the page's answer to chrome's
      // `lastAction`, and the difference between "the chord never resolved" and
      // "the action ran and the op behind it did not".
      traceDecision("action:" + k);
      runLeaderAction(leaderActions, k);
    },
    bindings: () => leader.bindings(),
    armDigits: (apply, timeoutMs, expect) => {
      leader.armPending(apply, { timeoutMs: timeoutMs || 3000, expect });
    },
    // The popup's input lives in a CLOSED shadow root, so no real keystroke ever
    // reaches it and the selector has to insert text itself. Same setting as the
    // content script, for the same reason.
    manualText: true,
  };
  const leaderActions = makeLeaderActions(ctx);
  // The home page is a PAGE: it runs the same key engine a web page does, from
  // the same keymap and the same action table. There is no second keymap here
  // to keep in step, which is what "the home page uses its own shortcuts" used
  // to mean.
  const leader = new LeaderController(
    (action) => runLeaderAction(leaderActions, action),
    () => config.whichKey !== false,
    () => {
      // Mirror the readout onto <html> and send it to the chrome helper's bar,
      // exactly as the content script does: the which-key overlay is in a closed
      // shadow root, so nothing outside it can see whether the leader is armed
      // without this.
      const sig = leader.signal();
      mirrorFlag("leader", sig.armed);
      mirror("lead-expect", sig.expect || null);
      void send("syncLeader", { signal: sig });
    },
    // An unknown chord is reported rather than swallowed, exactly as on a web
    // page. The home page is where a new key is most often tried first.
    (spec) => {
      traceDecision("miss:" + spec);
      toast("no binding for ;" + spec);
    }
  );

  // The page's analogue of a host's key dispatcher. A popup gets first refusal
  // (its own onKey, so the sessions popup can cancel a pending copy instead of
  // closing); then the leader — cancel first, so ONE Escape backs all the way
  // out of a category, then the armed capture, then the binding.
  function overlayKey(e: KeyboardEvent): boolean {
    if (currentPopup) {
      traceDecision("popup");
      e.preventDefault();
      e.stopImmediatePropagation();
      try {
        if (currentPopup.onKey && currentPopup.onKey(e)) return true;
      } catch (err) {
        closePopup();
        return true;
      }
      if (isCancel(e)) closePopup();
      return true;
    }
    if (leader.active || leader.hasPending()) {
      // WHICH surface took the key matters: a stale one-shot capture (";W m"s
      // digit capture, never fed) eats the NEXT chord's leader key, and the
      // whole sequence silently shifts by one. Naming the surface is what makes
      // that readable instead of mysterious.
      traceDecision(leader.hasPending() ? "capture" : "leader");
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isCancel(e)) {
        leader.cancelPending();
        leader.hide();
        return true;
      }
      if (leader.hasPending()) leader.handlePending(e);
      else leader.handleKey(e);
      return true;
    }
    return false;
  }

  // REPORT IN, exactly as a content script does.
  //
  // The chrome helper has to know whether this page owns its own keys before it
  // may claim them, and it cannot find out for itself (`contentDocument` is null
  // for an out-of-process tab). Without this report the helper treated the
  // command center as chrome territory and armed its OWN leader for the same
  // keypress the page was handling — so a key ran twice when the tab happened to
  // be in-process, and the two answers disagreed (";f works sometimes").
  const reportPresence = (active: boolean) => {
    let href = "";
    try {
      href = location.href;
    } catch (e) {
      // ignore — an unreadable location simply reports no URL
    }
    return send("syncContent", { active, url: href });
  };
  void reportPresence(true);
  try {
    window.addEventListener("pagehide", () => void reportPresence(false), { capture: true });
  } catch (e) {
    // ignore — presence is re-derived on the next load regardless
  }

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
      isHome: () => renderer.isHome(),
    },
    focusInput,
    overlayKey,
    showLeader: () => {
      traceDecision("arm");
      leader.show();
    },
    leaderKey: () => config.leader,
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

  // The chrome helper owns `;f` on the home tab when it is in-process (it
  // owns the leader there). It signals through this event: on the home grid
  // that arms hint-pick (letter = run tile), in any other mode it focuses the
  // search box. Out-of-process CC pages arm hint-pick via their own leader.
  document.addEventListener("lazyfox-find", () => {
    startGridHints();
  });

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
    } catch (e) {
      // The runtime API is missing entirely in a stripped build. Nothing this
      // block starts is essential; the rest of the command center still works.
    }
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
      // Two keys, so this is the one place the store's one-key-at-a-time
      // rule is worth bending: the meta line is one string assembled from
      // both, and an extra storage round-trip to render half of it would be
      // the only cost. Read in parallel, never sequentially.
      void Promise.all([
        readKey("lfCurrentSession", vString, ""),
        readKey("lfProfileName", vString, ""),
      ]).then(([sess, prof]) => renderMeta(sess, prof));
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
    void readKey("chromeAlive", vBoolean, false).then(refreshInstallBanner);
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
    // Command mode is keyboard-first (hjkl navigate, `;` arms the leader,
    // `;f` arms hint-pick, Enter opens the selection). A fresh new tab can
    // leave focus in TWO wrong places: the search input (which silently
    // switches the page into insert mode) or Firefox's URL bar (which
    // swallows every key entirely). Blur the input and pull focus onto the
    // page body — tabindex makes the body focusable — so keys land in the
    // grid. Typing any printable key re-enters insert mode, so searching
    // still works.
    if (document.activeElement === refs.input) refs.input.blur();
    const body = document.body;
    try {
      body.setAttribute("tabindex", "-1");
      if (document.activeElement !== body) {
        body.focus({ preventScroll: true });
      }
    } catch (e) {
      try {
        body.focus();
      } catch (e2) {
        // ignore — chrome's TabSelect focus covers this
      }
    }
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
      const { containers } = await readKey("lfStealth", vStealth, { containers: [] });
      if (containers.indexOf(t.cookieStoreId) !== -1) {
        document.documentElement.classList.add("lf-stealth");
      }
    } catch (e) {
      // ignore — the page still works without the stealth badge
    }
  })();
})();
