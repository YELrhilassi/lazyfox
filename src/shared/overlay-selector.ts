// The list engine every Lazyfox popup is built on: one input, one filtered
// list, one highlighted row.
//
// The old chrome helper and the content script each carried their own copy of a
// "Selector" engine plus popup CSS; this is the merged, single implementation.
// Both contexts render the same panel chrome and navigate it with the same
// keys. The only difference is where the key events come from (content
// intercepts them at the window capture handler; the chrome helper binds a
// keydown listener on the input element) — which is exactly what the
// `manualText` option switches.
//
// The host frame is overlay-popup.ts; the style sheets are overlaycss.ts; this
// file is behaviour only.

import { publishListState } from "./observability";
import { manualTextKey } from "./manualtext";
import { resolveRefreshIndex } from "./selectorindex";
import type { SelectorCtl } from "./overlay-popup";

export interface SelectorOpts<T> {
  listEl: HTMLElement;
  inputEl: HTMLInputElement;
  emptyEl: HTMLElement;
  search(q: string): Promise<T[]>;
  render(item: T): string;
  onPick(item: T): void;
  emptyText?: string;
  itemClass?: string;
  debounceMs?: number;
  pageStep?: number;
  maxItems?: number;
  // j/k navigate the list in NORMAL mode. There used to be a `vimNav` switch
  // for popups that wanted them typable; the modal split below replaced it, so
  // a popup cannot leave the user hunting for arrow keys any more.
  // When true, onKey performs manual Backspace/Delete and printable-character
  // insertion. Required in the content script where the window-capture
  // keydown handler preventDefaults every key before the selector sees it.
  manualText?: boolean;
  extraKeys?: (e: KeyboardEvent, ctx: { empty: boolean; index: number; item: T | null; refresh(): void; refreshSoon(delayMs: number): void }) => boolean;
  // A STABLE identity for an item, used to carry the selection across a
  // refresh. See `search()` for why a refresh must not reset the cursor.
  keyOf?: (item: T) => string | number | undefined;
  // Where the selection lands when the list is FIRST filled. Absent means row
  // 0, which is right for every popup whose rows are a ranking; the navigation
  // stack is the one list that is not, and opening it with the top row lit
  // would put the cursor on an arbitrary end of the history instead of on the
  // page the user is looking at. Only consulted on the first fill, so a
  // refresh keeps the carried-over cursor.
  initial?: (items: T[]) => number;
  // Called when Enter is pressed. When it returns true the key is consumed
  // (the default "pick the highlighted item" is skipped). Lets popups whose
  // data source is debounced/async handle Enter deterministically from the
  // raw input value instead of racing the in-flight search.
  onEnter?: (value: string, item: T | null) => boolean;
  onChange?: (idx: number, item: T | null, count: number) => void;
  // Optional grouping: when an item's group differs from the previous item's,
  // a sticky header row is inserted before it. Headers are display-only
  // (not selectable, not clickable), so selection and pick semantics are
  // unchanged.
  groupBy?: (item: T) => string;
}

export function createSelector<T>(opts: SelectorOpts<T>): SelectorCtl {
  let shown: T[] = [];
  let idx = 0;
  // NORMAL MODE OWNS THE KEYS; INSERT MODE OWNS THE TEXT.
  //
  // The field used to be focused from the moment the popup opened, so every
  // printable key became a search character and j/k could only navigate while
  // the query was empty — "type to filter" and "j/k to move" were the same keys
  // fighting over the same press. The split is the vim one: the popup opens in
  // NORMAL mode, where j/k (and the arrows) walk the list; `i` enters INSERT
  // mode, where the field takes the text; Esc leaves it. Typing any other
  // printable character in normal mode starts insert mode with that character,
  // so a search never needs the extra keystroke — the history popup has always
  // worked this way, and this is that model made generic.
  let insert = false;
  // True once the user has *chosen* a row (arrow/vim/Home/End/PageUp/Down or a
  // click). A fresh search resets it, so Enter on a freshly-typed query is
  // treated as "open what I typed", not "open the first suggestion".
  let navigated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The pending DELAYED re-query. At most one ever exists: a mutating key
  // (close/move a tab) re-reads the strip twice — once now, once after the
  // browser has actually applied the change — and that second read used to be
  // an uncancellable `setTimeout` per keypress. Holding `;` and hammering `x`
  // queued one per press, each of which re-rendered the whole list (a favicon
  // <img> per row), and the pile-up is what made the popup freeze and stop
  // answering Escape. One timer, ever, collapses that to a single extra read.
  let soonTimer: ReturnType<typeof setTimeout> | null = null;
  const debounce = opts.debounceMs ?? 40;
  const step = opts.pageStep ?? 8;
  const maxItems = opts.maxItems ?? 100;

  function render() {
    const list = opts.listEl;
    list.textContent = "";
    if (!shown.length) {
      // "" hands the layout back to the stylesheet: `.lf-empty` is a centring
      // flex box, and an inline "block" from here would overwrite exactly that
      // and drop the message back to the top of the panel.
      opts.emptyEl.style.display = "";
      opts.emptyEl.textContent = opts.emptyText || "";
      if (opts.onChange) opts.onChange(idx, null, 0);
      return;
    }
    opts.emptyEl.style.display = "none";
    const frag = document.createDocumentFragment();
    const cls = "lf-item" + (opts.itemClass ? " " + opts.itemClass : "");
    let lastGroup = "";
    shown.forEach((item, i) => {
      if (opts.groupBy) {
        const g = opts.groupBy(item) || "";
        if (i === 0 || g !== lastGroup) {
          const head = document.createElement("div");
          head.className = "lf-ghead";
          head.textContent = g || "Other";
          frag.appendChild(head);
          lastGroup = g;
        }
      }
      const div = document.createElement("div");
      div.className = cls + (i === idx ? " selected" : "");
      div.innerHTML = opts.render(item);
      div.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        opts.onPick(item);
      });
      // No mouseenter selection hijack here: moving the highlight on hover
      // stole the keyboard selection (Enter opened the hovered row instead of
      // the typed value, and arrow navigation snapped back to the hovered row
      // on every re-render). Hover feedback is pure CSS; the selected row is
      // only changed by the keyboard (move/Home/End) or a real click.
      frag.appendChild(div);
    });
    list.appendChild(frag);
    const sel = list.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
    if (opts.onChange) opts.onChange(idx, shown[idx] || null, shown.length);
    // The popup lives in a closed shadow root, so nothing outside it can read
    // the rows. Publish the selection as a composed, bubbling event on the list
    // so page-level observers (and the e2e harness) can follow the popup without
    // reaching into the shadow DOM. See shared/observability.ts for the
    // contract and why the detail carries no row content.
    publishListState(list, opts.inputEl, shown.length, idx);
  }

  function search(q: string) {
    if (timer) clearTimeout(timer);
    const current = q;
    timer = setTimeout(() => {
      opts
        .search(current)
        .then((items) => {
          if (current !== (opts.inputEl.value || "")) return;
          const next = (items || []).slice(0, maxItems);
          // WHERE THE CURSOR LANDS AFTER A REFRESH.
          //
          // It used to be unconditionally `idx = 0`, because the only refresh
          // anyone had was a fresh search — where row 0 genuinely is the right
          // answer. The tab popup then reused refresh() for a different job
          // (re-reading the strip after a close or a move), and every one of
          // those throws the highlight to the top: close a tab at row 12 and
          // row 0 lit up, so deleting downwards walked the list back to the top
          // and no two deletes in a row ever acted on neighbouring tabs.
          //
          // With an identity function the cursor follows the row the user was
          // actually on. When that row is GONE — which is the normal case,
          // because closing the selected tab is the action — the index is kept
          // and clamped, so the next tab slides up under the cursor. That is
          // the natural deletion flow: the highlight stays where your eye is
          // and repeatedly closing walks steadily down the strip.
          const prevIdx = idx;
          const prevRows = shown;
          shown = next;
          // The cursor policy lives in selectorindex.ts as a pure function, so
          // it can be unit tested without the DOM this module needs. See that
          // file for why it is not simply `idx = 0`.
          idx = resolveRefreshIndex({ prevIdx, prev: prevRows, next, keyOf: opts.keyOf });
          if (opts.initial && !prevRows.length && next.length) {
            const want = opts.initial(next);
            if (want >= 0 && want < next.length) idx = want;
          }
          navigated = false;
          render();
        })
        .catch(() => {});
    }, debounce);
  }

  function refresh() {
    search(opts.inputEl.value || "");
  }

  // Re-read once, `delayMs` from now, for a change the browser has not
  // applied yet. COALESCED: an already-pending read is left alone rather than
  // replaced, so a burst of keypresses costs one extra read, not one each.
  // Replacing it instead would starve the read entirely on a fast enough burst.
  function refreshSoon(delayMs: number) {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = null;
      refresh();
    }, delayMs);
  }

  function move(d: number) {
    if (!shown.length) return;
    idx = (idx + d + shown.length) % shown.length;
    navigated = true;
    render();
  }

  // Caret movement inside the popup input, applied by hand because the
  // selector consumes the key event in BOTH paths (chrome binds keydown on
  // the input; content preventDefaults at the window). mode "word" moves in
  // delimiter-delimited chunks — what URLs and titles are made of. With
  // shift held it extends the selection like a native shift+arrow.
  function moveCaret(dir: number, mode: "char" | "word", extend: boolean): void {
    const input = opts.inputEl;
    const v = input.value || "";
    const s = input.selectionStart == null ? v.length : input.selectionStart;
    const e = input.selectionEnd == null ? v.length : input.selectionEnd;
    // An anchor for shift-extend: on the first extend, freeze the edge the
    // caret is moving away from; without shift, collapse first.
    let anchor: number;
    if (extend) {
      anchor = dir > 0 ? s : e;
      if (s === e) anchor = dir > 0 ? s : e;
    } else {
      anchor = dir > 0 ? e : s;
    }
    const isDelim = (c: string) => /[\s:/.?&=,#\-]/.test(c);
    let next: number;
    if (mode === "char") {
      next = dir > 0 ? Math.min(v.length, anchor + 1) : Math.max(0, anchor - 1);
    } else if (dir > 0) {
      next = anchor;
      while (next < v.length && isDelim(v[next]!)) next++;
      while (next < v.length && !isDelim(v[next]!)) next++;
    } else {
      next = anchor;
      while (next > 0 && isDelim(v[next - 1]!)) next--;
      while (next > 0 && !isDelim(v[next - 1]!)) next--;
    }
    try {
      if (extend) {
        input.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next));
      } else {
        input.setSelectionRange(next, next);
      }
    } catch {
      // input types without a text selection — nothing to move
    }
  }

  // The field is a real element in every popup except the key-only panels
  // (the tab chooser), whose input is detached by design. A detached field
  // cannot be typed into, so the modal keys stay inert there instead of
  // filtering the list down to nothing with text nobody can see.
  function fieldLive(): boolean {
    return !!opts.inputEl.isConnected;
  }

  function setInsert(on: boolean): void {
    insert = on && fieldLive();
    try {
      if (insert) {
        opts.inputEl.focus();
        const n = (opts.inputEl.value || "").length;
        opts.inputEl.setSelectionRange(n, n);
      } else {
        opts.inputEl.blur();
      }
    } catch {
      // a field without a selection must still be usable
    }
  }

  function onKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const empty = (opts.inputEl.value || "") === "";
    // Esc LEAVES THE FIELD, it does not always mean "close": one press drops
    // out of insert mode, the next one is unhandled and the host closes the
    // popup (as it already does for every selector that returns false).
    if (k === "Escape" && insert) {
      e.preventDefault();
      setInsert(false);
      return true;
    }
    // Left/Right with Shift or Alt are CURSOR MOVEMENT inside the input
    // (word jump / plain move) — the list navigation must not steal them.
    // Plain Left/Right still walk the list when the input is empty (nothing
    // to edit); when the input holds text they move the caret instead, since
    // mid-text list navigation is a footgun.
    if (k === "ArrowLeft" || k === "ArrowRight") {
      const dir = k === "ArrowRight" ? 1 : -1;
      // Caret movement belongs to the FIELD, so it only applies while the field
      // is the thing taking keys. In normal mode there is no caret on screen and
      // these keys are nobody's.
      if (insert && e.shiftKey) {
        moveCaret(dir, "word", true);
        return true;
      }
      if (insert && !empty) {
        moveCaret(dir, "char", false);
        return true;
      }
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      move(1);
      return true;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      move(-1);
      return true;
    }
    if (k === "PageDown") {
      e.preventDefault();
      move(step);
      return true;
    }
    if (k === "PageUp") {
      e.preventDefault();
      move(-step);
      return true;
    }
    if (k === "Home") {
      e.preventDefault();
      idx = 0;
      navigated = true;
      render();
      return true;
    }
    if (k === "End") {
      e.preventDefault();
      idx = shown.length - 1;
      navigated = true;
      render();
      return true;
    }
    if (e.ctrlKey && (k === "n" || k === "p")) {
      e.preventDefault();
      move(k === "n" ? 1 : -1);
      return true;
    }
    // j/k walk the list in NORMAL mode — whatever the query says. They used to
    // need an empty input, which made moving after typing impossible.
    if (!insert && !e.ctrlKey && !e.altKey && !e.metaKey && (k === "j" || k === "k")) {
      e.preventDefault();
      move(k === "j" ? 1 : -1);
      return true;
    }
    // A MODIFIED Enter belongs to the popup, not to this branch. Ctrl+Enter
    // is the search popup's "into this tab" variant (see openSearchPopup), and
    // it can only reach extraKeys if the plain-Enter path lets it past — this
    // branch matches on the key alone and would otherwise eat the chord.
    if (k === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const value = opts.inputEl.value || "";
      // Only hand the highlighted row to onEnter when the user actually moved
      // to it. Right after typing, idx is 0 with no navigation, so onEnter sees
      // null and can open the typed value instead of the first suggestion.
      const item = navigated ? (shown[idx] || null) : null;
      if (opts.onEnter && opts.onEnter(value, item)) {
        return true;
      }
      const pick = shown[idx];
      if (pick) opts.onPick(pick);
      return true;
    }
    // IN INSERT MODE THE FIELD OWNS THE LETTERS. A popup's action keys (`x` to
    // delete, `n` for a new session, a digit to jump) are NORMAL-mode keys —
    // letting them fire while the user is typing made those characters
    // impossible to type. Tab and modified chords still reach extraKeys, since
    // a text field has no use for them.
    const insertTyping =
      insert && k !== "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (opts.extraKeys && !insertTyping) {
      if (
        opts.extraKeys(
          e,
          {
            empty: empty,
            index: idx,
            item: shown[idx] || null,
            refresh: refresh,
            refreshSoon: refreshSoon,
          }
        ) === true
      ) {
        return true;
      }
    }
    // INSERT MODE OWNS THE TEXT. The content script must insert by hand (its
    // window capture handler preventDefaults every key); the chrome helper's
    // field is a real focused input, so the browser does it.
    if (insert) {
      if (opts.manualText) {
        if (manualTextKey(e, opts.inputEl)) {
          e.preventDefault();
          return true;
        }
      }
      return false;
    }

    // NORMAL MODE. `i` enters the field keeping what is there (so a filter can
    // be refined); any other printable character enters it AND types itself.
    if (fieldLive() && !e.ctrlKey && !e.altKey && !e.metaKey && k && k.length === 1) {
      e.preventDefault();
      const typeIt = k !== "i";
      setInsert(true);
      if (typeIt) manualTextKey(e, opts.inputEl);
      return true;
    }
    return false;
  }

  opts.inputEl.addEventListener("input", refresh);
  // CLICKING THE FIELD IS ENTERING IT. Without this the flag and the DOM
  // disagree after a click: the caret is in the field, but the selector still
  // thinks it is in normal mode and eats j/k as navigation.
  opts.inputEl.addEventListener("focus", () => {
    insert = true;
  });
  opts.inputEl.addEventListener("blur", () => {
    insert = false;
  });

  refresh();

  return {
    onKey,
    refresh,
    refreshSoon,
    close: () => {
      if (soonTimer) {
        clearTimeout(soonTimer);
        soonTimer = null;
      }
    },
  };
}