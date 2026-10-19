// History popup: two-pane (grouped list | details + related), command/insert
// modes, armed delete/clear, and the related-history index.
//
// This file is the popup's WIRING and nothing else. Every decision it used to
// make inline now lives in a module that can be read — and tested — on its own:
//
//   history-groups.ts    which rows are visible, which hint letter names which
//                        group                        (pure, tested)
//   history-keys.ts      which intent a key is         (pure, tested)
//   history-state.ts     the mutable state, and the pure reads over it
//   history-render.ts    state -> markup
//   history-actions.ts   intent -> effect
//   history-related.ts   the related-history ranking  (pure, tested)
//
// What is left here is the part that genuinely needs the whole popup at once:
// fetching the snapshot once, re-organizing it through the Go core on every
// filter keystroke, binding the state to the view and the actions, and handing
// back the controller the popup host expects.
import { core } from "../core";
import { manualTextKey } from "../overlay";
import type { PopupItem } from "../types";
import { type PopupCtx } from "./kit";
import { historyIntent } from "./history-keys";
import { applyHistoryIntent } from "./history-actions";
import { createHistoryView } from "./history-render";
import {
  createHistoryState,
  currentRow,
  disarmAll,
  hintBucketFor,
  visibleRows,
  type HistoryState,
} from "./history-state";
import { createRelatedIndex, type RelatedRow } from "./history-related";

export function openHistoryPopup(ctx: PopupCtx): void {
  // Raw history items are fetched once; the Go core turns them into organized
  // rows (host, bucket, relative time, fuzzy filtering) on every keystroke so
  // grouping/filtering live in one tested place. The popup is modal: command
  // mode (j/k navigate, i searches, c/C/O collapse groups, x/X delete/clear)
  // vs insert mode (typing filters). The input stays focused throughout — in
  // the chrome helper keys only reach onKey through the focused input — so the
  // mode is virtual. Tab flips between the left (grouped list) and right
  // (minimal details + related history) panes.
  const state: HistoryState = createHistoryState();
  let loaded: Promise<void> | null = null;
  let orgTimer: ReturnType<typeof setTimeout> | null = null;

  // Related-history index, built once from the cached snapshot so the right
  // pane can answer "same site" and "similar title" instantly per selection.
  // The ranking itself is history-related.ts: pure computation over plain data.
  const related = createRelatedIndex();

  const ensureLoaded = (): Promise<void> => {
    if (!loaded) {
      loaded = ctx.ops.history("").then((items) => {
        state.all = (items || []).filter((it: PopupItem) => it && it.url);
        related.build(state.all);
      });
    }
    return loaded;
  };

  // The core buckets and relativizes times against the LOCAL offset, so it is
  // told it once here rather than per row.
  const tz = -new Date().getTimezoneOffset();

  ctx.open(
    "<div class='lf-panel wide'><div class='lf-title'>History</div>" +
      "<div class='lf-split'>" +
      "<div class='lf-col'>" +
      "<div class='lf-main'><div class='lf-list'></div><div class='lf-empty' style='display:none'>no history yet</div></div>" +
      "<input class='lf-input lf-cmd' placeholder='i to search \u00b7 j/k move' spellcheck='false'/>" +
      "</div>" +
      "<div class='lf-col'><div class='lf-col-head'>Details</div>" +
      "<div class='lf-detail'></div><div class='lf-related'></div></div>" +
      "</div>" +
      "<div class='lf-foot'><span class='lf-hint'>" +
      "<span class='lf-badge'>j/k</span> move &middot; <span class='lf-badge'>i</span> search &middot; " +
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>o</span> current &middot; " +
      "<span class='lf-badge'>x</span> delete &middot; <span class='lf-badge'>X</span> clear all &middot; " +
      "<span class='lf-badge'>c+hint</span> toggle group &middot; <span class='lf-badge'>C</span> collapse &middot; " +
      "<span class='lf-badge'>O</span> expand &middot; <span class='lf-badge'>g/G</span> top/bottom &middot; " +
      "<span class='lf-badge'>Tab</span> details &middot; <span class='lf-badge'>Esc</span> close</span>" +
      "<span class='lf-status' style='display:none'></span></div>" +
      "</div>",
    (root) => {
      const listEl = root.querySelector(".lf-list") as HTMLElement;
      const inputEl = root.querySelector(".lf-input") as HTMLInputElement;
      const emptyEl = root.querySelector(".lf-empty") as HTMLElement;
      const detailEl = root.querySelector(".lf-detail") as HTMLElement;
      const relatedEl = root.querySelector(".lf-related") as HTMLElement;
      const statusEl = root.querySelector(".lf-status") as HTMLElement | null;
      const hintEl = root.querySelector(".lf-hint") as HTMLElement | null;

      // The chrome helper re-creates dropped form controls without the class;
      // re-assert the command-mode dimming here.
      inputEl.classList.add("lf-cmd");

      const view = createHistoryView({
        state,
        listEl,
        inputEl,
        emptyEl,
        detailEl,
        relatedEl,
        statusEl,
        hintEl,
        cols: Array.from(root.querySelectorAll(".lf-col")) as HTMLElement[],
        related,
        onOpenRow: (newTab) => openRow(newTab),
        onOpenRelated: (r) => openRelated(r),
      });
      const { render, updateFoot, setPane } = view;

      // Re-run the core's organize + fuzzy filter over the cached snapshot. A
      // stale reply is dropped by comparing the query it was issued for against
      // the one in the input now.
      const organize = (): void => {
        const q = (inputEl.value || "").trim();
        const raw = state.all.map((it) => ({
          url: it.url || "",
          title: it.title || "",
          time: it.time || 0
        }));
        void core.organizeHistory(raw, q, Date.now(), tz).then((out) => {
          if ((inputEl.value || "").trim() !== q) return; // stale reply
          state.rows = out || [];
          if (state.idx >= state.rows.length) state.idx = Math.max(0, state.rows.length - 1);
          render();
        });
      };

      const openRow = (newTab: boolean | undefined): void => {
        const it = currentRow(state);
        if (!it) return;
        ctx.close();
        ctx.ops.openUrl(it.url, newTab);
      };

      const openRelated = (r: RelatedRow): void => {
        ctx.close();
        ctx.ops.openUrl(r.url, undefined);
      };

      const move = (d: number): void => {
        const vis = visibleRows(state);
        if (!vis.length) return;
        const n = vis.length;
        if (d === Number.NEGATIVE_INFINITY) state.idx = 0;
        else if (d === Number.POSITIVE_INFINITY) state.idx = n - 1;
        else state.idx = (state.idx + d + n) % n;
        disarmAll(state);
        state.relIdx = 0;
        render();
      };

      const moveRelated = (d: number): void => {
        if (!state.relatedRows.length) return;
        const n = state.relatedRows.length;
        if (d === Number.NEGATIVE_INFINITY) state.relIdx = 0;
        else if (d === Number.POSITIVE_INFINITY) state.relIdx = n - 1;
        else state.relIdx = (state.relIdx + d + n) % n;
        view.drawRelated();
      };

      const toggleCurrentGroup = (): void => {
        const it = currentRow(state);
        if (!it) return;
        state.collapsed[it.bucket] = !state.collapsed[it.bucket];
        render();
      };

      const collapseAll = (): void => {
        for (const r of state.rows) state.collapsed[r.bucket] = true;
        render();
      };

      const expandAll = (): void => {
        state.collapsed = {};
        render();
      };

      // `x` deletes the row under the cursor, but only after a second `x`
      // within 2.5s — an armed row is marked, so the gesture is visible.
      const onX = (): void => {
        const it = currentRow(state);
        if (!it) return;
        if (state.armDelete && state.armDelete.url === it.url) {
          const url = it.url;
          disarmAll(state);
          ctx.ops.removeHistory(url);
          state.all = state.all.filter((a) => a.url !== url);
          related.build(state.all);
          organize();
          return;
        }
        disarmAll(state);
        state.armDelete = {
          url: it.url,
          timer: setTimeout(() => {
            state.armDelete = null;
            render();
          }, 2500)
        };
        render();
      };

      const onXBig = (): void => {
        if (state.armClear) {
          disarmAll(state);
          ctx.ops.clearHistory();
          state.all = [];
          // Clear the related index through its own API rather than reaching
          // into the documents it indexed — the popup has no business knowing
          // how the ranking is stored.
          related.build([]);
          state.rows = [];
          state.idx = 0;
          render();
          return;
        }
        disarmAll(state);
        state.armClear = true;
        state.armClearTimer = setTimeout(() => {
          state.armClear = false;
          render();
        }, 2500);
        render();
      };

      inputEl.addEventListener("input", () => {
        if (orgTimer) clearTimeout(orgTimer);
        orgTimer = setTimeout(organize, 60);
      });
      void ensureLoaded().then(() => organize());
      setPane("L");

      // Named rather than an anonymous arrow: the armed group toggle has to
      // RE-DISPATCH the same event once the arm is dropped, and a const arrow
      // cannot reference itself inside its own initializer.
      const onKey = (e: KeyboardEvent): boolean => {
        // history-keys.ts is the pure half (which intent is this?); this is the
        // half that ACTS on it.
        const k = e.key;
        const noMods = !e.ctrlKey && !e.altKey && !e.metaKey;
        // When the group toggle is armed, the arm claims the NEXT key. If that
        // key names no group, the arm is dropped and the SAME key is dispatched
        // again as an ordinary one, so a mis-aimed hint letter still does what
        // it would have done without the arm.
        const armed = state.armGroup;
        const hit = hintBucketFor(state, k);
        const intent = historyIntent({
          key: k,
          shiftKey: e.shiftKey,
          noMods,
          mode: state.mode,
          pane: state.pane,
          armGroupLive: armed,
          // The dispatcher re-checks noMods/length itself, so a hint hit here
          // only has to answer "does this letter name a bucket?".
          groupHintHit: !!hit,
          manualText: ctx.manualText,
        });

        if (intent === "pass") {
          if (armed) {
            state.armGroup = false;
            updateFoot();
            // Re-dispatch as an ordinary command-mode key: the arm is gone, so
            // this key is judged by the normal keymap.
            return onKey(e);
          }
          // Not ours: chrome lets the focused input receive it natively.
          return false;
        }
        if (intent === "close") {
          // Deliberately NOT preventDefaulted: returning false is how the popup
          // contract says "not mine, close me", and the key must stay
          // un-consumed for the host to act on it.
          return false;
        }

        // `startSearchNative` is the ONE intent that is not ours to consume.
        //
        // It means "switch to insert mode, but let the focused INPUT insert the
        // character" — the chrome popup host emulates native text insertion
        // itself and uses `defaultPrevented` as the signal that it must NOT:
        //
        //     const notCanceled = input.dispatchEvent(keydown);
        //     ... maybeInsertText(input, ev, notCanceled);
        //
        // So preventDefaulting here is not "this key is handled", it is
        // "do not type this" — and since the key is synthetic, the browser's
        // own native insertion never runs as a fallback either. The character
        // was simply gone.
        //
        // That made the FIRST printable key typed into a freshly-opened popup
        // disappear, every time, and only the first: `startSearchNative` is
        // reachable only from command mode, and every later character arrives
        // in insert mode as `pass`, which returns before this line. Traced key
        // by key on the history popup — `h` left the filter empty, then `e`,
        // `l`, `l`, `o` all landed — which reads exactly like a filter that
        // searched for `ello` instead of `hello`.
        if (intent !== "startSearchNative") {
          // Every other intent is ours, so the key is consumed and can never
          // reach the page behind the popup.
          e.preventDefault();
        }
        return applyHistoryIntent(intent, {
          state,
          inputEl,
          key: k,
          hit,
          event: () => e,
          manualTextKey,
          render,
          updateFoot,
          setPane,
          move,
          moveRelated,
          openRow,
          openRelatedAtCursor: () => {
            const r = state.relatedRows[state.relIdx];
            if (r) openRelated(r);
          },
          toggleCurrentGroup,
          collapseAll,
          expandAll,
          deleteEntry: onX,
          clearAll: onXBig,
          organize,
        });
      };

      return {
        onKey,
        refresh: () => {
          void ensureLoaded().then(() => organize());
        },
        close: () => {},
        focus: () => inputEl.focus(),
      };
    }
  );
}