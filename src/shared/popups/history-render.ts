// The history popup's RENDERING.
//
// Split out of openHistoryPopup (popups/history.ts) because drawing is the
// popup's largest half and the least interesting one: it is DOM construction
// with no decisions in it. Every decision — which rows are visible, what a hint
// letter means, what a key does — lives in history-groups.ts, history-state.ts
// and history-keys.ts, all of them pure.
//
// What stays here is the mapping from state to markup, and the two
// side-effects that are part of rendering rather than of it: scrolling the
// selection into view, and publishing the composed list event that the shared
// observability contract (and the e2e harness) reads out of a closed shadow
// root.

import { esc } from "../dom";
import { faviconFor, faviconHtml } from "../favicon";
import { publishListState } from "../observability";
import {
  currentRow,
  currentRowIndex,
  groupHints,
  visibleRows,
  type HistoryState,
} from "./history-state";
import type { RelatedRow } from "./history-related";
import type { HistoryRow } from "../types";

export interface HistoryViewDeps {
  state: HistoryState;
  listEl: HTMLElement;
  inputEl: HTMLInputElement;
  emptyEl: HTMLElement;
  detailEl: HTMLElement;
  relatedEl: HTMLElement;
  statusEl: HTMLElement | null;
  hintEl: HTMLElement | null;
  cols: HTMLElement[];
  // The related-history index (history-related.ts): asked for the rows that
  // belong to the primary row under the cursor.
  related: { for(it: HistoryRow): RelatedRow[] };
  // Called when a row or a related entry is activated with the mouse.
  onOpenRow(newTab: boolean | undefined): void;
  onOpenRelated(r: RelatedRow): void;
}

export interface HistoryView {
  render(): void;
  drawRelated(): void;
  updateFoot(): void;
  markCols(): void;
  setPane(p: "L" | "R"): void;
  publishState(): void;
}

// These hint strings are assigned via `innerHTML` INSIDE the popup build, on
// an element that may live in the chrome (XUL/XML) document. Its innerHTML
// setter runs the XML parser, which rejects the undefined HTML entity
// `&middot;` as "an invalid or illegal string" — a SyntaxError that would abort
// the whole build and deaden every key. Use the literal · (U+00B7) instead of
// the entity so the string parses in both the HTML fragment parser and the
// chrome XML parser.
const CMD_L_HINT =
  "<span class='lf-badge'>j/k</span> move \u00b7 <span class='lf-badge'>i</span> search \u00b7 " +
  "<span class='lf-badge'>Enter</span> open \u00b7 <span class='lf-badge'>o</span> current \u00b7 " +
  "<span class='lf-badge'>x</span> delete \u00b7 <span class='lf-badge'>X</span> clear all \u00b7 " +
  "<span class='lf-badge'>c+hint</span> toggle group \u00b7 <span class='lf-badge'>C</span> collapse \u00b7 " +
  "<span class='lf-badge'>O</span> expand \u00b7 <span class='lf-badge'>g/G</span> top/bottom \u00b7 " +
  "<span class='lf-badge'>Tab</span> details \u00b7 <span class='lf-badge'>Esc</span> close";
const INSERT_HINT =
  "<span class='lf-badge'>j/k</span> move \u00b7 <span class='lf-badge'>Enter</span> open \u00b7 " +
  "<span class='lf-badge'>Esc</span> done";

export function createHistoryView(deps: HistoryViewDeps): HistoryView {
  const { state, listEl, inputEl, emptyEl, detailEl, relatedEl, statusEl, hintEl, cols } = deps;

  // The transient status line: armed delete, armed clear-all, armed group
  // toggle, or the right pane's own guide.
  function setStatus(): void {
    if (!statusEl) return;
    if (state.armGroup) {
      const hs = groupHints(state);
      const parts = Object.keys(hs).map((b) => hs[b] + " " + b);
      statusEl.style.display = "";
      statusEl.textContent =
        "c + " + parts.join(" \u00b7 ") + " toggles that group \u00b7 c again = current \u00b7 Esc cancel";
      return;
    }
    if (state.armClear) {
      statusEl.style.display = "";
      statusEl.textContent = "press X again to clear ALL history";
      return;
    }
    if (state.armDelete) {
      statusEl.style.display = "";
      statusEl.textContent = "press x again to delete \u201C" + (state.armDelete.url || "") + "\u201D";
      return;
    }
    if (state.pane === "R") {
      statusEl.style.display = "";
      statusEl.textContent =
        "Tab list \u00b7 j/k related \u00b7 Enter open related \u00b7 o open selected \u00b7 Esc back";
      return;
    }
    statusEl.style.display = "none";
    statusEl.textContent = "";
  }

  // The bottom guide switches with the active context: command mode on the
  // list, insert mode (typing a filter), the details pane, and the armed group
  // toggle each show their own keys. setStatus() owns the transient messages
  // (armed deletes/clears, pane-R guide); updateFoot decides which span is
  // visible and what the static guide says.
  function updateFoot(): void {
    if (!hintEl || !statusEl) return;
    setStatus();
    if (statusEl.style.display !== "none") {
      hintEl.style.display = "none";
      return;
    }
    hintEl.style.display = "";
    hintEl.innerHTML = state.mode === "insert" ? INSERT_HINT : CMD_L_HINT;
  }

  function drawDetail(): void {
    detailEl.textContent = "";
    const it = currentRow(state);
    if (!it) return;
    const title = document.createElement("div");
    title.className = "lf-detail-title";
    title.textContent = it.title || it.url;
    title.title = it.title || it.url;
    const host = document.createElement("div");
    host.className = "lf-detail-host";
    host.textContent = it.host + " \u00b7 " + it.bucket;
    const url = document.createElement("div");
    url.className = "lf-detail-url";
    url.textContent = it.url || "";
    url.title = it.url || "";
    const meta = document.createElement("div");
    meta.className = "lf-detail-meta";
    meta.textContent =
      "Visited " + it.rel + (it.time ? " \u00b7 " + new Date(it.time).toLocaleString() : "");
    detailEl.appendChild(title);
    detailEl.appendChild(host);
    detailEl.appendChild(url);
    detailEl.appendChild(meta);
  }

  function emptyRelated(): void {
    const empty = document.createElement("div");
    empty.className = "lf-related-empty";
    empty.textContent = "no related history";
    relatedEl.appendChild(empty);
  }

  function drawRelated(): void {
    relatedEl.textContent = "";
    const ri = currentRowIndex(state);
    const it = ri >= 0 ? state.rows[ri] || null : null;
    if (ri !== state.lastPrimary) {
      state.lastPrimary = ri;
      state.relIdx = 0;
    }
    if (!it) {
      emptyRelated();
      return;
    }
    // The ranking itself lives in history-related.ts; this popup only asks.
    state.relatedRows = deps.related.for(it);
    if (state.relIdx >= state.relatedRows.length) {
      state.relIdx = Math.max(0, state.relatedRows.length - 1);
    }
    if (!state.relatedRows.length) {
      emptyRelated();
      return;
    }
    let lastSection = "";
    state.relatedRows.forEach((r, i) => {
      if (r.section !== lastSection) {
        const hd = document.createElement("div");
        hd.className = "lf-related-head";
        hd.textContent = r.section;
        relatedEl.appendChild(hd);
        lastSection = r.section;
      }
      const row = document.createElement("div");
      row.className = "lf-item lf-rel" + (i === state.relIdx && state.pane === "R" ? " selected" : "");
      row.innerHTML =
        "<div class='t'>" + esc(r.title) + "</div>" +
        "<div class='s'><span class='lf-host'>" + esc(r.host) + "</span>" +
        "<span class='lf-time'>" + esc(r.rel) + "</span></div>";
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        state.relIdx = i;
        drawRelated();
        deps.onOpenRelated(r);
      });
      relatedEl.appendChild(row);
    });
    const sel = relatedEl.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  // The two-pane history popup lives in a closed shadow root, so nothing
  // outside it can read the rows. Publish the same composed, bubbling contract
  // the shared overlay's popups use (shared/observability.ts) so page-level
  // observers — and the e2e harness — can follow this popup's render and
  // selection without reaching into the shadow DOM. The history popup builds
  // its own rows instead of using the shared selector, so this is the one place
  // it has to publish for itself.
  function publishState(): void {
    publishListState(listEl, inputEl, visibleRows(state).length, state.idx);
  }

  function render(): void {
    listEl.textContent = "";
    const vis = visibleRows(state);
    if (state.idx >= vis.length) state.idx = Math.max(0, vis.length - 1);
    if (!state.rows.length) {
      emptyEl.style.display = "block";
      detailEl.textContent = "";
      relatedEl.textContent = "";
      updateFoot();
      markCols();
      publishState();
      return;
    }
    emptyEl.style.display = "none";
    const visPos: Record<number, number> = {};
    vis.forEach((ri, p) => {
      visPos[ri] = p;
    });
    const frag = document.createDocumentFragment();
    let lastBucket = "";
    const hints = groupHints(state);
    state.rows.forEach((it, i) => {
      if (it.bucket !== lastBucket) {
        const count = state.rows.reduce((n, r) => n + (r.bucket === it.bucket ? 1 : 0), 0);
        const hd = document.createElement("div");
        hd.className =
          "lf-hgroup" +
          (state.collapsed[it.bucket] ? " lf-collapsed" : "") +
          (state.armGroup ? " lf-arm" : "");
        const hkey = hints[it.bucket];
        hd.innerHTML =
          (hkey ? "<span class='lf-hkey'>" + hkey + "</span>" : "") +
          esc(it.bucket) +
          "<span class='lf-hcount'>" + count + "</span>";
        hd.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          state.armGroup = false;
          state.collapsed[it.bucket] = !state.collapsed[it.bucket];
          render();
        });
        frag.appendChild(hd);
        lastBucket = it.bucket;
      }
      if (state.collapsed[it.bucket]) return;
      const vi = visPos[i]!;
      const armed = !!(state.armDelete && state.armDelete.url === it.url);
      const row = document.createElement("div");
      row.className =
        "lf-item lf-hist" + (vi === state.idx ? " selected" : "") + (armed ? " lf-armed" : "");
      row.innerHTML =
        "<div class='t'><span class='txt'>" + esc(it.title || it.url) + "</span></div>" +
        "<div class='s'><span class='lf-host'>" + esc(it.host) + "</span>" +
        "<span class='lf-url'>" + esc(it.url) + "</span>" +
        faviconHtml(faviconFor(it.url)) +
        "<span class='lf-time'>" + esc(it.rel) + "</span></div>";
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        state.idx = vi;
        state.relIdx = 0;
        render();
        deps.onOpenRow(undefined);
      });
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
    if (!vis.length) {
      const hint = document.createElement("div");
      hint.className = "lf-collapsed-hint";
      hint.textContent = "all groups collapsed \u2014 press O to expand";
      listEl.appendChild(hint);
    }
    const sel = listEl.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
    drawDetail();
    drawRelated();
    updateFoot();
    markCols();
    publishState();
  }

  function markCols(): void {
    for (let i = 0; i < cols.length; i++) {
      cols[i]!.classList.toggle("active", state.pane === "R" ? i === 1 : i === 0);
    }
  }

  function setPane(p: "L" | "R"): void {
    state.pane = p;
    markCols();
    updateFoot();
  }

  return { render, drawRelated, updateFoot, markCols, setPane, publishState };
}