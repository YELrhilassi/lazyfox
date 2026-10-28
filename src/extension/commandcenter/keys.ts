// Command center keyboard handling: the window keydown dispatcher, the
// resize/move key handlers, the leader-mode runner, the close-tab
// confirmation, and the insert-mode typing helpers. It reads state through
// the store and drives the renderer; it never touches the DOM directly except
// for the input element it focuses/types into.

import { core } from "../../shared/core";
import { isCancel } from "../../shared/leader";
import { copyText } from "../../shared/dom";
import { send } from "../../shared/protocol";
import { windowStep } from "../../shared/resize";
import { MODES, openItem } from "./data";
import { traceDecision, traceKey } from "./trace";
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
  // THE SHARED SURFACES, which own the keyboard while they are up: the leader
  // (armed or holding a capture) and any of its popups. Returns true when the
  // key was consumed. This is the whole reason the home page now behaves like
  // every other page — see the note at the top of onKeyDown.
  overlayKey(e: KeyboardEvent): boolean;
  // Show the shared leader, exactly as `;` does on a web page. The page owns
  // the keydown, so it is the page that arms it.
  showLeader(): void;
  // The configured leader key (config.leader).
  leaderKey(): string;
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
  const { input } = refs;

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
    const fine = windowStep(e);
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
    const fine = windowStep(e);
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

  function onEnter(): void {
    const state = store.get();
    const v = input.value.trim();
    // A TYPED QUERY OUTRANKS THE HIGHLIGHT.
    //
    // This used to decide from `quickView` alone. The list is rebuilt on a 70ms
    // debounce, so an Enter pressed inside that window — a fast typist, or one
    // who typed and hit Enter in the same breath — still saw the HOME GRID and
    // ran whichever tile happened to be lit: the reported "I typed a search,
    // hit Enter, and it opened one of the quick-launch items". The typed value
    // is checked first now, and the highlight is only in charge when the user
    // actually put it somewhere (`navigated`).
    if (state.quickView && !v) {
      // The home grid has no typed query, so Enter opens the selected tile.
      openItem(state.all[state.idx] || state.all[0], state.mode);
      return;
    }
    if (v && !state.navigated) {
      if (state.mode === "search") {
        void send("search", { query: v });
        return;
      }
      if (state.mode === "url") {
        void core.normalizeUrl(v).then((u) => send("openUrl", { url: u }));
        return;
      }
    }
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
    // A CHARACTER INVALIDATES THE HIGHLIGHT: whatever row was selected belongs
    // to the previous query, so Enter must not open it. The debounced refresh
    // resets this too, but an Enter inside that window would otherwise act on
    // a row the user is no longer looking at.
    store.patch({ navigated: false });
    deps.focusInput();
    const s = input.selectionStart == null ? input.value.length : input.selectionStart;
    const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, s) + k + input.value.slice(en);
    try {
      input.setSelectionRange(s + 1, s + 1);
    } catch (err) {
      // setSelectionRange throws on input types that do not support selection
      // (number, email). The character is already inserted; only the caret
      // position is then wrong.
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Home-grid hint-pick (;f): the next printable key runs the tile labeled
  // with that letter (a = first tile, b = second, ...). Esc leaves hint mode
  // with nothing selected; any other key just ends it and does nothing.
  const HINT_CHARS = "abcdefghijklmnopqrstuvwxyz";
  function handleHintPick(e: KeyboardEvent): void {
    const k = e.key;
    e.preventDefault();
    const hint = HINT_CHARS.indexOf(k);
    store.patch({ hintArmed: false });
    if (k === "Escape" || hint < 0) {
      renderer.refresh();
      return;
    }
    const item = store.get().all[hint];
    renderer.refresh();
    if (item) openItem(item, store.get().mode);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const k = e.key;
    const state = store.get();
    const inInput = document.activeElement === input;

    // Dev-only: record the key and the state it arrived in, BEFORE any branch
    // can consume it. See commandcenter/trace.ts for why the page needs this at
    // all — the mirrors it already publishes are transient by design.
    if (__DEV__) {
      traceKey(
        k,
        inInput ? "ins" : "cmd",
        (e.ctrlKey ? "+c" : "") + (e.altKey ? "+a" : "") + (e.metaKey ? "+m" : "") + (e.shiftKey ? "+s" : "")
      );
    }

    // THE SHARED SURFACES OWN THE KEYBOARD WHILE THEY ARE UP.
    //
    // This page used to answer every `;`-sequence from its OWN table, and that
    // is exactly why it behaved unlike every other page: `;a` (alternate tab),
    // `;G`/`;L` (the navigation stack), `;P` (sessions), the tab digits and the
    // whole category grammar were either missing here or spelled differently.
    // Now the leader and its popups come from shared/popups/leader.ts, the same
    // table a web page and the chrome helper run — one keymap, one set of
    // popups, and a key added anywhere works here too.
    if (deps.overlayKey(e)) return;

    // While hint-pick is armed on the home grid, every PLAIN key is a hint
    // letter (or Esc to cancel) — before leader/typing/resize handling.
    //
    // A MODIFIED key is not a hint letter, and here the alphabet is all
    // twenty-six, so `Ctrl+G` used to be the letter `g`: instead of backing out
    // it OPENED whichever tile was labelled `g`. The universal cancel must never
    // be re-spelled by whatever happens to be on screen, so it cancels here, and
    // any other modified key drops the pick and belongs to the browser (not
    // prevented — Ctrl+T is still Ctrl+T).
    if (store.get().hintArmed && (e.ctrlKey || e.altKey || e.metaKey)) {
      store.patch({ hintArmed: false });
      renderer.refresh();
      if (isCancel(e)) e.preventDefault();
      return;
    }
    if (store.get().hintArmed) {
      // THE LEADER KEY ALWAYS WINS OVER A HINT PICK — the same rule the content
      // script states for its own hint layer (see content/main.ts, "THE LEADER
      // ALWAYS WINS OVER A HINT LAYER"), and here it was the opposite: `;` was
      // not in HINT_CHARS, so it fell into handleHintPick's "any other key ends
      // the pick" branch and was spent CANCELING instead of arming. Arming the
      // leader after glancing at the badges therefore cost two presses of the
      // leader key — the reported "the leader key needs pressing twice" — and
      // the key a user reaches for to DO something was the key that undid what
      // they had just asked for. The pick is dropped and this key falls through
      // to the leader branch below, exactly as if no pick had been armed.
      //
      // A MODIFIED key never reaches here — the branch above already dropped the
      // pick and returned for those — so this is only ever a plain `;`.
      if (k === deps.leaderKey()) {
        store.patch({ hintArmed: false });
        renderer.refresh();
      } else {
        handleHintPick(e);
        return;
      }
    }

    if (state.resizeOpen && handleResizeKey(e)) return;
    if (state.moveOpen && handleMoveKey(e)) return;
    if (state.resizeOpen || state.moveOpen) {
      // The modal key handlers only own their arrows and Escape. Ctrl+G must
      // still be an unconditional cancel rather than falling through this
      // modal's early-return and opening Firefox's native Find Again.
      if (isCancel(e) && k !== "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (state.resizeOpen) renderer.toggleResize(false);
        if (state.moveOpen) renderer.toggleMove(false);
      }
      return;
    }

    // THE UNFOCUS CHORD, the same rule the content script follows: while the
    // caret is in the input, Ctrl+G leaves the field and nothing else. It sits
    // ABOVE the modifier fall-through below, which is why it was previously
    // unreachable here — a chord with Ctrl in it was handed straight to the
    // browser, so the one key a user reaches for to leave an input did nothing
    // on Lazyfox's own page either. Escape is left alone on purpose: on this
    // page Escape clears the typed query first, and a key that empties the box
    // is not the key that leaves it.
    if (inInput && isCancel(e) && k !== "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      input.blur();
      renderer.setStateTag("cmd");
      return;
    }

    // Ctrl+G IS THE ABORT CHORD HERE TOO, AND IT MUST NOT REACH THE BROWSER.
    //
    // Nothing is left to cancel at this point — a popup or an armed leader is
    // handled in overlayKey above, a hint pick in its own branch, and the caret
    // case in the unfocus chord just above — so this branch exists for one
    // reason: the page has no find bar of its own, so an unconsumed Ctrl+G is
    // Firefox's FIND AGAIN, and it opened the native find bar over the home
    // grid. The universal cancel must never be re-interpreted as the one thing
    // it most looks like.
    if (isCancel(e) && k !== "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

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
    // TYPING WINS ONCE A QUERY EXISTS, even if the box lost focus.
    //
    // The grid owns h/j/k/l in command mode, which is the vim contract and the
    // footer says so — but a box that ALREADY holds a search is a different
    // state: the next letter belongs to the query, not to the cursor. Without
    // this, a search whose text was interrupted by a focus loss (a reload, a
    // mode click, a window switch) could not be continued with `h`, `j`, `k`
    // or `l` — they moved the grid instead, which is exactly the reported "I
    // can't type j/k/h/l".
    if (
      input.value.trim() !== "" &&
      (k === "h" || k === "j" || k === "k" || k === "l") &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      renderer.setStateTag("insert");
      startTyping(k);
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
    if (state.mode === "downloads" && (k === "x" || k === "o" || k === "r" || k === "y")) {
      const item = state.all[state.idx];
      if (item && item.key) {
        e.preventDefault();
        if (k === "x") void send("removeDownload", { id: item.key });
        else if (k === "r") {
          if (item.state === "failed" || item.state === "paused") {
            void send("retryDownload", { id: item.key });
            renderer.flashTag(item.state === "paused" ? "resuming download" : "retrying download");
          } else {
            renderer.flashTag("nothing to retry");
          }
        } else if (k === "y") {
          void copyText(item.url || "").then((ok) =>
            renderer.flashTag(ok ? "copied download link" : "copy failed")
          );
        } else void send("openDownloadLocation", { id: item.key });
      }
      return;
    }
    if (/^[1-6]$/.test(k)) {
      e.preventDefault();
      renderer.setMode(MODES[Number(k) - 1]!);
      return;
    }
    if (k === deps.leaderKey() && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // `;` arms the SHARED leader — the same one a web page arms, with the
      // same overlay, the same categories and the same bindings. `e.repeat` is
      // dropped for the same reason it is dropped there: a held key re-fires at
      // the OS repeat rate, and re-arming on every repeat tears a held sequence
      // apart between two actions.
      e.preventDefault();
      if (e.repeat) return;
      deps.showLeader();
      return;
    }
    if (k === "i" || k === "I") {
      // THE EXPLICIT WAY INTO THE BOX. Command mode owns h/j/k/l for the grid,
      // so `i` is what makes a query that STARTS with one of them typeable;
      // without a key that says "the letters belong to the box now" there was
      // no way to search for "hello" at all. It is also the repair for every
      // ambiguous state — a clicked-away caret, a mode button, a fuzzy-focus
      // page — and it always lands the caret at the END of what is already
      // typed, so pressing it mid-edit continues the query instead of
      // prepending to it.
      e.preventDefault();
      renderer.setStateTag("insert");
      deps.focusInput();
      try {
        const n = input.value.length;
        input.setSelectionRange(n, n);
      } catch {
        // an input type without selection support keeps the caret where it is
      }
      return;
    }
    if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      traceDecision("type:" + k);
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
