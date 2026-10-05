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
  // When false, the empty-query j/k navigation shortcuts are disabled
  // (search/url popups use them for nothing and j/k must stay typable).
  vimNav?: boolean;
  // When true, onKey performs manual Backspace/Delete and printable-character
  // insertion. Required in the content script where the window-capture
  // keydown handler preventDefaults every key before the selector sees it.
  manualText?: boolean;
  extraKeys?: (e: KeyboardEvent, ctx: { empty: boolean; index: number; item: T | null; refresh(): void }) => boolean;
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
  // True once the user has *chosen* a row (arrow/vim/Home/End/PageUp/Down or a
  // click). A fresh search resets it, so Enter on a freshly-typed query is
  // treated as "open what I typed", not "open the first suggestion".
  let navigated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounce = opts.debounceMs ?? 40;
  const step = opts.pageStep ?? 8;
  const maxItems = opts.maxItems ?? 100;

  function render() {
    const list = opts.listEl;
    list.textContent = "";
    if (!shown.length) {
      opts.emptyEl.style.display = "block";
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
          shown = (items || []).slice(0, maxItems);
          idx = 0;
          navigated = false;
          render();
        })
        .catch(() => {});
    }, debounce);
  }

  function refresh() {
    search(opts.inputEl.value || "");
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

  function onKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const empty = (opts.inputEl.value || "") === "";
    // Left/Right with Shift or Alt are CURSOR MOVEMENT inside the input
    // (word jump / plain move) — the list navigation must not steal them.
    // Plain Left/Right still walk the list when the input is empty (nothing
    // to edit); when the input holds text they move the caret instead, since
    // mid-text list navigation is a footgun.
    if (k === "ArrowLeft" || k === "ArrowRight") {
      const dir = k === "ArrowRight" ? 1 : -1;
      // Shift+arrow = word-extend, plain arrow with text = caret move (list
      // navigation on a non-empty input is a footgun), plain arrow on an
      // empty input still walks the list below.
      if (e.shiftKey) {
        moveCaret(dir, "word", true);
        return true;
      }
      if (!empty) {
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
    if (opts.vimNav !== false && empty && k === "j") {
      e.preventDefault();
      move(1);
      return true;
    }
    if (opts.vimNav !== false && empty && k === "k") {
      e.preventDefault();
      move(-1);
      return true;
    }
    if (k === "Enter") {
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
    if (opts.extraKeys) {
      if (
        opts.extraKeys(e, { empty: empty, index: idx, item: shown[idx] || null, refresh: refresh }) === true
      ) {
        return true;
      }
    }
    if (opts.manualText) {
      if (manualTextKey(e, opts.inputEl)) {
        e.preventDefault();
        return true;
      }
    }
    return false;
  }

  opts.inputEl.addEventListener("input", refresh);

  refresh();

  return { onKey, refresh, close: () => {} };
}