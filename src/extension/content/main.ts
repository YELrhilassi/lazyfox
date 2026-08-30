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

  // The chrome helper (userChrome.uc.js) draws the ONE window-level status bar
  // and shrinks the content area so pages never render under it. When it is
  // alive this per-page fixed bar must stay hidden, or the two would double up
  // and the fixed bar would overlap content while scrolling. Only in standalone
  // mode (chrome helper absent) does the content script draw its own bar.
  //
  // This is decided AUTHORITATIVELY by asking the background (the chromeLayer
  // message), never by a storage flag: background storage is a racy write an
  // onStartup reset can clobber, so trusting it is exactly how a second bar
  // slipped in on top of the chrome window bar. The decision defaults to
  // HIDDEN until the background explicitly confirms the chrome layer is absent,
  // so exactly one bar can ever render — and the moment the background flips to
  // alive (via the storage listener below, which the background still writes),
  // any errant bar is torn down.
  //   null = not determined yet -> hide (safe default, no double bar)
  //   true = chrome layer alive -> hide
  //   false = chrome layer confirmed absent -> draw standalone bar
  let chromeAlive: boolean | null = null;

  function refreshChromeAlive(): void {
    void send("chromeLayer").then((r) => {
      const next = (r && r.alive) ? true : false;
      if (chromeAlive === null || next !== chromeAlive) {
        chromeAlive = next;
        ensureStatusBar();
      }
    });
  }
  // Ask immediately and keep re-asking (the interval below also covers it) so
  // a slow announce latches cleanly.
  refreshChromeAlive();

  browser.storage.onChanged.addListener(
    (changes: { config?: { newValue?: Partial<Config> }; chromeAlive?: { newValue?: boolean } }, area: string) => {
      if (area !== "local") return;
      if (changes.config) {
        config = mergeConfig(changes.config.newValue || {});
        ensureStatusBar();
      }
      // The background flips storage.chromeAlive when the helper announces;
      // keep the bar in step via the direct query so authority stays with the
      // background, mirroring it here only as a fast-path to re-ask.
      if (changes.chromeAlive && chromeAlive !== !!changes.chromeAlive.newValue) {
        refreshChromeAlive();
      }
    }
  );

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
    // Live find count: feed the standalone status bar AND relay it to the
    // chrome helper's window-level bar (whose status bar is the one drawn on
    // real setups) so "N/M" follows the find widget everywhere.
    setFindState: (s) => {
      statusBar.setData({ find: s });
      // count -1 = the widget closed (hide the bar segment); 0 = a query with
      // no matches (red 0); >0 = live cur/count.
      void send("syncFind", s ? { cur: s.cur, count: s.count } : { cur: 0, count: -1 });
    },
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
    () => config.whichKey !== false,
    // The chrome helper owns the single window-level status bar and draws its
    // pulsing LEADER chevron from the per-tab leader state it caches from the
    // background's leaderState push. Report every arm/disarm so the chevron
    // tracks the content-script leader on web pages (where the content
    // script owns the leader key and the chrome helper's own leader never
    // arms).
    () => void send("syncLeader", { active: leader.active })
  );
  // Clear any stale leader state this tab carried from a previous page (the
  // leader starts disarmed on every fresh load).
  void send("syncLeader", { active: false });
  // ;' = quick switch: capture the next digit and jump to the marked session.
  leaderActions["'"] = () =>
    leader.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        contentOps.switchSessionByMarker(Number(k));
        return true;
      }
      return false;
    }, 3000);
  // ;+1-9 = move tab N into the current split view.
  leaderActions["+"] = () =>
    leader.armPending((k) => {
      if (/^[1-9]$/.test(k)) {
        contentOps.splitAddTabByIndex(Number(k));
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
    inSplit: false,
    splitOrientation: undefined as "horizontal" | "vertical" | undefined,
    activeStealth: false,
    sessions: [] as { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[],
  };

  function ensureStatusBar(): void {
    // The chrome helper owns the single window-level bar whenever it is alive
    // (web pages, chrome pages, and split panes). This per-page fixed bar only
    // appears in standalone mode, where it pads the page to reserve its space.
    // chromeAlive === null means "not known yet": hide until proven standalone.
    if (config.statusBar === false || chromeAlive !== false || statusInfo.inSplit) {
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
          inSplit: !!r.inSplit,
          splitOrientation: r.splitOrientation,
          activeStealth: !!r.activeStealth,
          sessions: r.sessions || [],
        };
        ensureStatusBar();
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
      // The popup's own onKey gets first refusal (the sessions popup consumes
      // Esc to cancel a pending copy/move or step back to the left pane);
      // only when it declines does Esc close the popup.
      try {
        if (currentPopup.onKey && currentPopup.onKey(e)) return;
      } catch (err) {
        closePopup();
        return;
      }
      if (e.key === "Escape") closePopup();
      return;
    }
    if (hints.active) {
      if (isTypingTarget(e.target as Element)) {
        // The user focused a text field mid-hints: the hint batch must not
        // eat what they type there. Drop the hints and let the key through.
        hints.exit();
      } else if (e.key === "Escape") {
        // Esc exits the hints (clearing every hint's state) but is NOT
        // consumed here — it falls through to the shared Esc handling below,
        // which also blurs focus and lets the page close its own overlays.
        hints.exit();
      } else {
        e.preventDefault();
        e.stopImmediatePropagation();
        hints.handleKey(e);
        return;
      }
    }
    // NOTE: the chrome helper announces itself as "alive" and was meant to own
    // the leader key everywhere, but current Firefox never forwards keys typed
    // into remote web content to the chrome window's listener (frame scripts
    // are inert for remote content too). So on web pages the content script
    // MUST own the leader, popups, hints, Esc and scroll keys itself — the
    // chrome helper only receives keys on in-process pages (about:, the
    // command center), where this content script does not run.
    if (e.key === "Escape") {
      // Esc is the universal cancel key. Clear every Lazyfox overlay state so
      // the next invocation starts fresh: link hints (typed prefix, items,
      // pool), the leader and any one-shot capture.
      if (hints.active) hints.exit();
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.handlePending("Escape");
      // Unfocus whatever element holds focus (an input, a button, a link) so
      // the page returns to its default state.
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) {
        try {
          (ae as HTMLElement).blur();
        } catch (err) {
          // ignore
        }
      }
      // Deliberately NOT consumed: the page must also receive Esc so it can
      // close its own popups, info bars, cookie banners and fullscreen video.
      // preventDefault/stopImmediatePropagation here used to keep those open.
      return;
    }
    // Focus is in a text field. A stale leader or one-shot capture must never
    // eat what the user is typing: pressing `;` on the page and then clicking
    // into a search box used to swallow the first character (and a stray `'`
    // re-armed the marker capture, so the next digit switched sessions).
    // Disarm both and let the key reach the field.
    if (isTypingTarget(e.target as Element)) {
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
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
    // Ctrl+1-9: hot-swap to the session with that marker (tmux-style). Skips
    // text fields so Ctrl+1 inside an input is untouched.
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      if (!isTypingTarget(e.target as Element)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        contentOps.switchSessionByMarker(Number(e.key));
      }
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
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
  // Firefox's native typeahead quick-find is bound to the `keypress` of `/`
  // and `'`, so it fires even after the leader has consumed the `keydown`
  // (the keydown preventDefault does not cancel the keypress). Suppress it
  // outside text fields so `;/` opens the Lazyfox find popup, not the native
  // find bar.
  window.addEventListener(
    "keypress",
    (e) => {
      if (e.key !== "/" && e.key !== "'") return;
      if (!isTypingTarget(e.target as Element)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // The bar is decided by refreshChromeAlive's first read (and the storage
  // listener after that); drawing it here, before the flag is known, is what
  // produced a second bar on top of the chrome helper's during session
  // restore. fetchStatus still runs so the standalone bar gets its data.
  fetchStatus();
  setInterval(renderStatus, 400);
  setInterval(fetchStatus, 3000);
  // Keep re-asking the authoritative chromeLayer question so a slow announce
  // latches even without a storage event (and any errant errand bar is torn
  // down the moment the background confirms the chrome layer is alive).
  setInterval(refreshChromeAlive, 1500);

  // Hide the status bar (and release its reserved space) while any element
  // is fullscreen — a full-screen video would otherwise keep the strip, and
  // the page padding it reserves, on top of the content. Re-show on exit.
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) statusBar.hide();
    else ensureStatusBar();
  });

  window.addEventListener("blur", () => {
    if (currentPopup) closePopup();
    if (hints.active) hints.exit();
    if (leader.active) leader.hide();
  });
  document.addEventListener("focusin", (e) => {
    syncTypingAttr();
    // A stale leader or one-shot capture must never eat what the user types.
    // Disarm when focus moves to an editable element (e.g. clicking into a
    // search box after pressing `;` on the page).
    if (isTypingTarget(e.target as Element)) {
      if (leader.active) leader.hide();
      if (leader.hasPending()) leader.cancelPending();
    }
  });
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
