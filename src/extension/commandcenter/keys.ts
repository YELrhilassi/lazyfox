// Command center keyboard handling: the window keydown dispatcher, the
// resize/move key handlers, the leader-mode runner, the close-tab
// confirmation, and the insert-mode typing helpers. It reads state through
// the store and drives the renderer; it never touches the DOM directly except
// for the input element it focuses/types into.

import { core } from "../../shared/core";
import { send } from "../../shared/protocol";
import { MODES, openItem } from "./data";
import type { Renderer } from "./render";
import type { CCStore } from "./state";

export interface KeysRefs {
  input: HTMLInputElement;
  modeTag: HTMLSpanElement;
}

export interface KeysDeps {
  refs: KeysRefs;
  store: CCStore;
  renderer: Renderer;
  // Called when the input should be focused (insert mode).
  focusInput(): void;
}

export interface KeyHandler {
  // The window keydown listener. Returns nothing; it owns preventDefault.
  onKeyDown(e: KeyboardEvent): void;
  // ;x on the last tab closes the whole window — arm a confirmation first.
  closeTabConfirm(): void;
  startTyping(k: string): void;
}

export function createKeyHandler(deps: KeysDeps): KeyHandler {
  const { refs, store, renderer } = deps;
  const { input, modeTag } = refs;

  // Armed close: ;x on the LAST tab closes the whole window, so the first
  // press arms a confirmation and a second press within 2.5s actually closes.
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  function disarmClose(): void {
    store.patch({ closeArmed: false });
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function closeTabConfirm(): void {
    const state = store.get();
    if (state.closeArmed) {
      disarmClose();
      void send("closeTab", { force: true });
      return;
    }
    void send("closeTab", {}).then((r) => {
      if (r && r.last) {
        store.patch({ closeArmed: true });
        closeTimer = setTimeout(disarmClose, 2500);
        renderer.flashTag("last tab — press ;x again to close the window");
      }
    });
  }

  function handleResizeKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const fine = e.shiftKey ? 8 : 32;
    if (k === "ArrowLeft") {
      e.preventDefault();
      send("resizeWindow", { dx: -fine, dy: 0 }).then(renderer.updateResizeSize);
      return true;
    }
    if (k === "ArrowRight") {
      e.preventDefault();
      send("resizeWindow", { dx: fine, dy: 0 }).then(renderer.updateResizeSize);
      return true;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      send("resizeWindow", { dx: 0, dy: -fine }).then(renderer.updateResizeSize);
      return true;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      send("resizeWindow", { dx: 0, dy: fine }).then(renderer.updateResizeSize);
      return true;
    }
    if (k === "m") {
      e.preventDefault();
      send("maximize").then(renderer.updateResizeSize);
      return true;
    }
    if (k === "Escape") {
      e.preventDefault();
      renderer.toggleResize(false);
      return true;
    }
    return false;
  }

  function handleMoveKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const fine = e.shiftKey ? 8 : 32;
    if (k === "ArrowLeft") {
      e.preventDefault();
      send("moveWindow", { dx: -fine, dy: 0 }).then(renderer.updateMovePos);
      return true;
    }
    if (k === "ArrowRight") {
      e.preventDefault();
      send("moveWindow", { dx: fine, dy: 0 }).then(renderer.updateMovePos);
      return true;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      send("moveWindow", { dx: 0, dy: -fine }).then(renderer.updateMovePos);
      return true;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      send("moveWindow", { dx: 0, dy: fine }).then(renderer.updateMovePos);
      return true;
    }
    if (k === "Escape") {
      e.preventDefault();
      renderer.toggleMove(false);
      return true;
    }
    return false;
  }

  function runLeader(k: string): void {
    const modeMap: Record<string, string> = {
      s: "search", o: "url", t: "tabs", h: "history", b: "bookmarks", d: "downloads",
      1: "search", 2: "url", 3: "tabs", 4: "history", 5: "bookmarks", 6: "downloads",
    };
    if (modeMap[k]) {
      renderer.setMode(modeMap[k]);
      return;
    }
    if (k === "f") {
      // `;f` "find" on the home grid: focus the search box so typing filters
      // the apps/browser tiles (link-hint `;f` targets page links, which do
      // not exist on the chrome-extension command-center home — filtering is
      // its home-page equivalent).
      renderer.setStateTag("insert");
      deps.focusInput();
    } else if (k === "w") renderer.toggleResize(true);
    else if (k === "m") renderer.toggleMove(true);
    else if (k === "n") void send("newTab");
    else if (k === "x") closeTabConfirm();
    else if (k === "v") void send("reopenTab");
    else if (k === "a") void send("alternateTab");
    else if (k === "c") void send("duplicateTab");
    else if (k === "z") void send("zen");
    else if (k === "N") void send("stealthOpen");
    else if (k === "I") void send("openSetup"); // ;I — the standalone installer/setup page
    else if (k === "Q") void send("quit");
    else if (k === "?") toggleHelp();
    modeTag.textContent = store.get().mode;
  }

  function toggleHelp(): void {
    input.value = "";
    renderer.setMode("search");
  }

  function onEnter(): void {
    const state = store.get();
    const v = input.value.trim();
    // Act on the TYPED value whenever the visible list is empty or was built
    // for an earlier query (the 70ms debounce means it lags a fast typist).
    // In URL mode that means opening exactly what you typed, normalized —
    // never a stale row from a previous keystroke.
    if (!state.all.length || state.allQuery !== v) {
      if (state.mode === "search" && v) {
        void send("search", { query: v });
      } else if (state.mode === "url" && v) {
        void core.normalizeUrl(v).then((u) => send("openUrl", { url: u }));
      }
      return;
    }
    openItem(state.all[state.idx] || state.all[0], state.mode);
  }

  function startTyping(k: string): void {
    deps.focusInput();
    const s = input.selectionStart == null ? input.value.length : input.selectionStart;
    const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, s) + k + input.value.slice(en);
    try {
      input.setSelectionRange(s + 1, s + 1);
    } catch (err) {}
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function onKeyDown(e: KeyboardEvent): void {
    const k = e.key;
    const state = store.get();
    const inInput = document.activeElement === input;

    if (state.leaderPending) {
      e.preventDefault();
      store.patch({ leaderPending: false });
      if (k === "Escape") {
        modeTag.textContent = state.mode;
        return;
      }
      runLeader(k);
      return;
    }

    if (state.resizeOpen && handleResizeKey(e)) return;
    if (state.moveOpen && handleMoveKey(e)) return;
    if (state.resizeOpen || state.moveOpen) return;

    // Modifier shortcuts must never get swallowed by the typing path below:
    // let Ctrl+?/Alt+?/Meta+? fall through to the browser unless it is a
    // known leader combo (handled while leaderPending above).
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (k === "Tab") {
      e.preventDefault();
      renderer.cycleMode(e.shiftKey ? -1 : 1);
      return;
    }

    if (k === "Escape") {
      e.preventDefault();
      if (state.resizeOpen) {
        renderer.toggleResize(false);
      } else if (state.moveOpen) {
        renderer.toggleMove(false);
      } else if (input.value) {
        input.value = "";
        renderer.refresh();
        renderer.setStateTag("cmd");
        input.blur();
      } else if (inInput) {
        input.blur();
        renderer.setStateTag("cmd");
      }
      return;
    }

    // While the input is focused, every key types — including j/k and other
    // letters that double as shortcuts in command mode (the README's
    // contract: "every key types, so you can search for anything"). Only
    // Enter / the arrows act on the list; Esc leaves insert mode first.
    if (inInput) {
      if (k === "Enter") {
        e.preventDefault();
        onEnter();
      } else if (k === "ArrowDown") {
        e.preventDefault();
        renderer.move(0, 1);
      } else if (k === "ArrowUp") {
        e.preventDefault();
        renderer.move(0, -1);
      }
      return;
    }

    if (k === "Enter") {
      e.preventDefault();
      onEnter();
      return;
    }
    if (k === "ArrowDown" || k === "j") {
      e.preventDefault();
      renderer.move(0, 1);
      return;
    }
    if (k === "ArrowUp" || k === "k") {
      e.preventDefault();
      renderer.move(0, -1);
      return;
    }
    if (k === "ArrowRight" || k === "l") {
      e.preventDefault();
      renderer.move(1, 0);
      return;
    }
    if (k === "ArrowLeft" || k === "h") {
      e.preventDefault();
      renderer.move(-1, 0);
      return;
    }
    if (state.mode === "downloads" && (k === "x" || k === "o")) {
      const item = state.all[state.idx];
      if (item && item.key) {
        e.preventDefault();
        if (k === "x") void send("removeDownload", { id: item.key });
        else void send("openDownloadLocation", { id: item.key });
      }
      return;
    }
    if (/^[1-6]$/.test(k)) {
      e.preventDefault();
      renderer.setMode(MODES[Number(k) - 1]!);
      return;
    }
    if (k === ";") {
      e.preventDefault();
      store.patch({ leaderPending: true });
      modeTag.textContent = "LZ\u203A";
      return;
    }
    if (k === "i" || k === "I") {
      e.preventDefault();
      renderer.setStateTag("insert");
      deps.focusInput();
      return;
    }
    if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      renderer.setStateTag("insert");
      startTyping(k);
    }
  }

  return {
    onKeyDown,
    closeTabConfirm,
    startTyping,
  };
}
