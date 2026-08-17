// Command center rendering: building the list DOM from state, switching
// modes, grid-aware navigation, and the resize/move panel toggles. Pure view
// logic — it reads the store and writes the DOM, never talks to the
// background directly (data.ts owns that).

import { send } from "../../shared/protocol";
import { EMPTY_TEXTS, MODES, PLACEHOLDERS, getItems, quickCommands, renderItem, type QuickActions } from "./data";
import type { CCStore } from "./state";

export interface CCRefs {
  input: HTMLInputElement;
  resultsEl: HTMLUListElement;
  emptyEl: HTMLDivElement;
  modeTag: HTMLSpanElement;
  stateEl: HTMLSpanElement;
  resizePanel: HTMLDivElement;
  resizeSize: HTMLSpanElement;
  movePanel: HTMLDivElement;
  movePos: HTMLSpanElement;
}

export interface RenderDeps {
  refs: CCRefs;
  store: CCStore;
  quick: QuickActions;
  openItem(item: any, mode: string): void;
}

export interface Renderer {
  setMode(m: string): void;
  refresh(): void;
  cycleMode(d: number): void;
  move(dx: number, dy: number): void;
  toggleResize(open?: boolean): void;
  toggleMove(open?: boolean): void;
  updateResizeSize(): void;
  updateMovePos(): void;
  setStateTag(label: string): void;
  flashTag(msg: string): void;
}

const GRID_COLS = 3;

export function createRenderer(deps: RenderDeps): Renderer {
  const { refs, store } = deps;
  const { input, resultsEl, emptyEl, modeTag, stateEl, resizePanel, resizeSize, movePanel, movePos } = refs;

  function setMode(m: string): void {
    store.patch({ mode: m });
    modeTag.textContent = m;
    input.placeholder = PLACEHOLDERS[m] || "";
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.classList.toggle("on", (b as HTMLElement).dataset.mode === m);
    });
    refresh();
  }

  function refresh(): void {
    const v = input.value.trim();
    if (!v && store.get().mode === "search") {
      store.patch({ quickView: true, all: quickCommands(deps.quick), idx: 0 });
      render();
      return;
    }
    store.patch({ quickView: false });
    renderMode(v);
  }

  function renderMode(q: string): void {
    const state = store.patch({ allQuery: q });
    getItems(state.mode, q).then((items) => {
      if (q !== input.value.trim()) return;
      store.patch({ all: items, idx: 0 });
      render();
    });
  }

  function render(): void {
    const state = store.get();
    resultsEl.textContent = "";
    resultsEl.classList.toggle("quick", state.quickView);
    if (!state.all.length) {
      emptyEl.style.display = "block";
      emptyEl.textContent = EMPTY_TEXTS[state.mode] || "";
      return;
    }
    emptyEl.style.display = "none";
    const frag = document.createDocumentFragment();
    // Home screen: insert a section header whenever the group changes.
    let lastGroup = "";
    state.all.slice(0, 60).forEach((item, i) => {
      if (state.quickView && item.group && item.group !== lastGroup) {
        const hd = document.createElement("li");
        hd.className = "sec";
        hd.textContent = item.group;
        frag.appendChild(hd);
        lastGroup = item.group;
      }
      const li = document.createElement("li");
      li.className = "result" + (i === state.idx ? " selected" : "");
      li.dataset.i = String(i);
      li.innerHTML = renderItem(item, state.mode, state.quickView);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        deps.openItem(item, state.mode);
      });
      li.addEventListener("mouseenter", () => {
        if (store.get().idx !== i) {
          store.patch({ idx: i });
          markSelected();
        }
      });
      frag.appendChild(li);
    });
    resultsEl.appendChild(frag);
    markSelected();
  }

  function markSelected(): void {
    const kids = resultsEl.children;
    const idx = store.get().idx;
    for (let i = 0; i < kids.length; i++) {
      kids[i]?.classList.toggle("selected", Number((kids[i] as HTMLElement).dataset.i) === idx);
    }
    const sel = resultsEl.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  // Grid-aware navigation. In the home grid, j/k move between rows (three
  // columns wide) and h/l move between columns; in the flat list views j/k
  // step one row at a time and h/l do nothing.
  function move(dx: number, dy: number): void {
    const state = store.get();
    if (!state.all.length) return;
    if (state.quickView) {
      const col = state.idx % GRID_COLS;
      const row = Math.floor(state.idx / GRID_COLS);
      let ncol = col + dx;
      let nrow = row + dy;
      if (dx !== 0) {
        nrow = Math.min(nrow, Math.floor((state.all.length - 1) / GRID_COLS));
        if (ncol < 0 || ncol >= GRID_COLS) {
          nrow = (nrow + dy + Math.floor((state.all.length - 1) / GRID_COLS) + 1) % (Math.floor((state.all.length - 1) / GRID_COLS) + 1);
          ncol = (ncol + GRID_COLS) % GRID_COLS;
        }
        store.patch({ idx: Math.min(nrow * GRID_COLS + ncol, state.all.length - 1) });
      } else {
        store.patch({
          idx: Math.min(
            Math.max(nrow, 0),
            Math.floor((state.all.length - 1) / GRID_COLS)
          ) * GRID_COLS + col,
        });
        const s = store.get();
        store.patch({ idx: Math.min(s.idx, state.all.length - 1) });
      }
    } else {
      store.patch({ idx: (state.idx + dy + state.all.length) % state.all.length });
    }
    markSelected();
  }

  function cycleMode(d: number): void {
    const state = store.get();
    const i = MODES.indexOf(state.mode);
    setMode(MODES[(i + d + MODES.length) % MODES.length]!);
  }

  function toggleResize(open?: boolean): void {
    const state = store.get();
    const next = open == null ? !state.resizeOpen : open;
    store.patch({ resizeOpen: next });
    resizePanel.classList.toggle("on", next);
    if (store.get().moveOpen) toggleMove(false);
    if (next) updateResizeSize();
  }

  function toggleMove(open?: boolean): void {
    const state = store.get();
    const next = open == null ? !state.moveOpen : open;
    store.patch({ moveOpen: next });
    movePanel.classList.toggle("on", next);
    if (store.get().resizeOpen) toggleResize(false);
    if (next) updateMovePos();
  }

  function updateResizeSize(): void {
    send("windowSize").then((r: any) => {
      if (r) {
        resizeSize.textContent = r.width + " \u00d7 " + r.height +
          (r.state === "maximized" ? " (maximized)" : "");
      }
    });
  }

  function updateMovePos(): void {
    send("windowSize").then((r: any) => {
      if (r) {
        movePos.textContent = r.left + ", " + r.top +
          (r.state === "maximized" ? " (maximized)" : "");
      }
    });
  }

  function setStateTag(label: string): void {
    const inInsert = label === "insert";
    store.patch({ inInsert });
    stateEl.textContent = inInsert ? "insert" : "cmd";
    stateEl.classList.toggle("bright", inInsert);
  }

  function flashTag(msg: string): void {
    const prev = store.get().mode;
    modeTag.textContent = msg;
    setTimeout(() => {
      if (modeTag.textContent === msg) modeTag.textContent = prev;
    }, 2200);
  }

  return {
    setMode,
    refresh,
    cycleMode,
    move,
    toggleResize,
    toggleMove,
    updateResizeSize,
    updateMovePos,
    setStateTag,
    flashTag,
  };
}
