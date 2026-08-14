// Content script entry: lazyfox standalone mode (chrome helper absent) and
// scroll keys / hints while the chrome helper is alive. All popups, the leader
// and its actions come from ../shared/* behind the ActionOps adapter
// (content/ops.ts); this file only owns config state, chrome-alive gating and
// the window-level key dispatch.

import { CONFIG_DEFAULTS, mergeConfig } from "../../shared/config";
import { ensureCore } from "../../shared/core";
import { isTypingTarget } from "../../shared/dom";
import { dbg } from "../../shared/dev";
import { LeaderController } from "../../shared/leader";
import { openPopup as overlayOpenPopup, toast, type PopupCtl } from "../../shared/overlay";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../../shared/popups";
import { send } from "../../shared/protocol";
import { StatusBar } from "../../shared/statusbar";
import type { Config } from "../../shared/types";
import { createLinkHints, focusFirstInput } from "./hints";
import { createContentOps, type ContentPopupShell } from "./ops";

(function () {
  "use strict";

  try {
    if (window.top !== window) return;
  } catch (e) {
    // ignore
  }

  let config: Config = mergeConfig(undefined);

  function loadConfig() {
    void browser.storage.local.get("config").then(
      (r: { config?: Partial<Config> }) => {
        if (r && r.config) config = mergeConfig(r.config);
      },
      () => {}
    );
  }
  loadConfig();

  browser.storage.onChanged.addListener((changes: { config?: { newValue?: Partial<Config> } }, area: string) => {
    if (area === "local" && changes.config) {
      config = mergeConfig(changes.config.newValue || {});
      ensureStatusBar();
    }
  });

  /* ===================== link hints ===================== */

  const hints = createLinkHints(() => config.hintChars);

  /* ===================== popup shell ===================== */

  let currentPopup: PopupCtl | null = null;

  function closePopup(): void {
    if (currentPopup) {
      try {
        currentPopup.close();
      } catch (e) {
        // ignore
      }
      currentPopup = null;
    }
  }

  const shell: ContentPopupShell = {
    open: (html, build) => {
      closePopup();
      leader.hide();
      const ctl = overlayOpenPopup(html, (root) => build(root), () => {
        currentPopup = null;
      });
      currentPopup = ctl;
      return ctl;
    },
    close: closePopup,
  };

  /* ===================== leader + shared popups ===================== */

  const contentOps = createContentOps({
    shell: shell,
    config: () => config,
    startHints: () => void hints.start(),
    focusFirstInput: focusFirstInput,
  });

  let leader: LeaderController;
  const ctx: PopupCtx = {
    ops: contentOps,
    open: shell.open,
    close: closePopup,
    toast: toast,
    runAction: (k) => runLeaderAction(leaderActions, k),
    bindings: () => leader.bindings(),
    manualText: true,
  };
  const leaderActions = makeLeaderActions(ctx);
  leader = new LeaderController(
    (k) => runLeaderAction(leaderActions, k),
    () => config.whichKey !== false
  );
  // ;' = quick switch: capture the next digit and jump to the marked session.
  leaderActions["'"] = () =>
    leader.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        contentOps.switchSessionByMarker(Number(k));
        return true;
      }
      return false;
    }, 3000);

  /* ==================== status bar (tmux-style) ==================== */

  const statusBar = new StatusBar();
  let statusInfo = {
    name: "default",
    marker: 0,
    tabIndex: 1,
    tabCount: 0,
    sessions: [] as { marker: number; name: string; current: boolean }[],
  };

  function ensureStatusBar(): void {
    if (config.statusBar === false) {
      statusBar.hide();
      return;
    }
    statusBar.setPosition(config.statusBarPosition || "bottom");
    statusBar.show();
  }

  function renderStatus(): void {
    const mode = currentPopup
      ? "POPUP"
      : hints.active
        ? "HINTS"
        : leader.active
          ? "LEADER"
          : "NORMAL";
    statusBar.setData({ mode: mode });
  }

  function fetchStatus(): void {
    void send("sessionState").then((r) => {
      if (r) {
        statusInfo = {
          name: r.name || "default",
          marker: r.marker || 0,
          tabIndex: r.tabIndex || 1,
          tabCount: r.tabCount || 0,
          sessions: r.sessions || [],
        };
        statusBar.setData(statusInfo);
        renderStatus();
      }
    });
  }

  /* ==================== scroll keys ==================== */

  let lastG = false;
  function handleScrollKeys(e: KeyboardEvent): boolean {
    if (config.scrollKeys === false) return false;
    const k = e.key;
    if (k === "j") {
      window.scrollBy(0, 60);
      return true;
    }
    if (k === "k") {
      window.scrollBy(0, -60);
      return true;
    }
    if (k === "d") {
      window.scrollBy(0, Math.max(120, window.innerHeight * 0.5));
      return true;
    }
    if (k === "u") {
      window.scrollBy(0, -Math.max(120, window.innerHeight * 0.5));
      return true;
    }
    if (k === "G") {
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
      return true;
    }
    if (k === "g") {
      if (lastG) {
        window.scrollTo(0, 0);
        lastG = false;
      } else {
        lastG = true;
        setTimeout(() => {
          lastG = false;
        }, 600);
      }
      return true;
    }
    return false;
  }

  /* ==================== key dispatch ==================== */

  function onKeyDown(e: KeyboardEvent) {
    if (__DEV__) {
      // Dev-only trace: the last key the content script saw and the state it
      // dispatched under (page realm reads these attributes in the BiDi suite).
      try {
        const d = document.documentElement;
        d.setAttribute("data-lf-lastkey", e.key);
        d.setAttribute("data-lf-active", leader ? (leader.active ? "1" : "0") : "?");
        d.setAttribute("data-lf-popup", currentPopup ? "1" : "0");
      } catch (x) {
        // ignore
      }
    }
    if (e.isComposing) return;
    if (currentPopup) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        closePopup();
        return;
      }
      try {
        if (currentPopup.onKey) currentPopup.onKey(e);
      } catch (err) {
        closePopup();
      }
      return;
    }
    if (hints.active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hints.handleKey(e);
      return;
    }
    // NOTE: the chrome helper announces itself as "alive" and was meant to own
    // the leader key everywhere, but current Firefox never forwards keys typed
    // into remote web content to the chrome window's listener (frame scripts
    // are inert for remote content too). So on web pages the content script
    // MUST own the leader, popups, hints, Esc and scroll keys itself — the
    // chrome helper only receives keys on in-process pages (about:, the
    // command center), where this content script does not run.
    if (e.key === "Escape") {
      const had = hints.active || leader.active || leader.hasPending();
      if (hints.active) hints.exit();
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.handlePending("Escape");
      if (had) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) {
        e.preventDefault();
        e.stopImmediatePropagation();
        try {
          (ae as HTMLElement).blur();
        } catch (err) {
          // ignore
        }
      }
      return;
    }
    if (leader.hasPending()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.handlePending(e.key);
      return;
    }
    if (leader.active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.handleKey(e);
      if (__DEV__) {
        try {
          document.documentElement.setAttribute("data-lf-dispatched", e.key);
        } catch (x) {
          // ignore
        }
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isTypingTarget(e.target as Element)) return;
    if (handleScrollKeys(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === config.leader) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.show();
    }
  }

  function syncTypingAttr() {
    const ae = document.activeElement;
    const typing = isTypingTarget(ae);
    if (typing) document.documentElement.setAttribute("data-lf-typing", "1");
    else document.documentElement.removeAttribute("data-lf-typing");
    void send("syncTyping", { typing: typing });
  }

  /* ==================== boot ==================== */

  // Warm the wasm core so the first leader press is already synchronous.
  ensureCore()
    .then(() => {
      if (!__DEV__) return;
      try {
        document.documentElement.setAttribute("data-lf-debug", "core-ok");
      } catch (e) {
        // ignore
      }
    })
    .catch((e) => {
      if (!__DEV__) return;
      dbg("content core init failed", (e && e.message) || String(e));
      try {
        document.documentElement.setAttribute("data-lf-debug", "core-failed");
      } catch (x) {
        // ignore
      }
    });

  window.addEventListener("keydown", onKeyDown, true);

  ensureStatusBar();
  fetchStatus();
  setInterval(renderStatus, 400);
  setInterval(fetchStatus, 3000);

  window.addEventListener("blur", () => {
    if (currentPopup) closePopup();
    if (hints.active) hints.exit();
    if (leader.active) leader.hide();
  });
  document.addEventListener("focusin", syncTypingAttr);
  document.addEventListener("focusout", syncTypingAttr);
  document.addEventListener("focus", syncTypingAttr);

  browser.runtime.onMessage.addListener(
    (msg: { action?: string }) => {
      if (msg && msg.action === "startHints") {
        void hints.start();
        return Promise.resolve({ ok: true });
      }
      if (msg && msg.action === "focusFirstInput") {
        focusFirstInput();
        return Promise.resolve({ ok: true });
      }
      return undefined;
    }
  );
})();
