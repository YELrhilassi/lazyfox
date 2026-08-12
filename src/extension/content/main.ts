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

  let chromeAlive = false;
  function loadChromeAlive() {
    void browser.storage.local.get("chromeAlive").then(
      (r: { chromeAlive?: boolean }) => {
        chromeAlive = !!(r && r.chromeAlive);
      },
      () => {}
    );
  }
  loadChromeAlive();

  browser.storage.onChanged.addListener((changes: { config?: { newValue?: Partial<Config> }; chromeAlive?: { newValue?: boolean } }, area: string) => {
    if (area === "local" && changes.config) {
      config = mergeConfig(changes.config.newValue || {});
    }
    if (area === "local" && changes.chromeAlive) {
      chromeAlive = !!changes.chromeAlive.newValue;
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
    if (chromeAlive) {
      // Chrome owns the leader key, popups and hotkeys. Content keeps
      // scroll keys (chrome can't scroll remote content) and Escape-blur.
      if (e.key === "Escape") {
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
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target as Element)) return;
      if (handleScrollKeys(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      return;
    }
    if (e.key === "Escape") {
      const had = hints.active || leader.active;
      if (hints.active) hints.exit();
      if (leader.active) leader.hide();
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
    if (leader.active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leader.handleKey(e);
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
