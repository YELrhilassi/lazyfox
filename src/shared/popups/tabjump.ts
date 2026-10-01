// The tab-position chooser: shown only when a digit the user pressed is a
// prefix of more than one tab number (`;1` with twelve tabs open could mean
// tab 1, 10, 11 or 12).
//
// It is deliberately NOT a search popup. There is nothing to search — the
// candidate set is a handful of known positions — so a text field would be a
// lie about what is going on, and it would also swallow the digits that are
// the only keys this popup has. What it is instead is a keypad: one row per
// candidate, the digit that continues that number printed beside it, and
// pressing that digit jumps.
//
// The exact match (`;1` and tab 1) has no digit of its own, because `;1` `1`
// has to mean tab 11. It sorts first, so it is the highlighted row and Enter
// takes it — which also means the chooser is never a dead end for the number
// the user actually typed first.

import { esc } from "../dom";
import { faviconHtml } from "../favicon";
import type { PopupItem } from "../types";
import { keyPanel, makeSelector, type PopupCtx } from "./kit";
import { extendTabPrefix, tabCandidates, tabQuickKey } from "../tabjump";

export function tabChooserPanel(prefix: string): string {
  return keyPanel(
    "Tab " + prefix + "\u2026",
    "no tab " + prefix,
    "<span class='lf-badge'>0-9</span> continue &middot; " +
      "<span class='lf-badge'>&uarr;&darr;</span> move &middot; " +
      "<span class='lf-badge'>Enter</span> go &middot; " +
      "<span class='lf-badge'>Esc</span> close"
  );
}

/**
 * Opens the chooser for `prefix` in a window of `count` tabs.
 *
 * `rows` supplies the tab metadata (title, url, favicon) for the candidate
 * numbers. It may be shorter than the candidate list — a tab that closed
 * between the count and the rows simply has no title, and the number still
 * works, because the number is what the user is choosing.
 */
export function openTabChooser(
  ctx: PopupCtx,
  prefix: string,
  count: number,
  rows: PopupItem[]
): void {
  const byNumber = new Map<number, PopupItem>();
  for (const r of rows) {
    if (r.number != null) byNumber.set(r.number, r);
  }
  let current = prefix;
  ctx.open(
    tabChooserPanel(current),
    (root) =>
      makeSelector<number>(ctx, root, {
        debounceMs: 0,
        itemClass: "lf-tab",
        emptyText: "no tab " + current,
        vimNav: true,
        // Re-derived from the shared planner on every render, so the list can
        // never disagree with what a digit press would do.
        search: async () => tabCandidates(count, current),
        render: (n) => {
          const t = byNumber.get(n);
          const qk = tabQuickKey(n, current);
          return (
            "<div class='t'>" +
            "<span class='lf-marker'>" + n + "</span>" +
            (qk ? "<span class='lf-badge'>" + qk + "</span>" : "") +
            (t && t.active ? "<span class='dot'></span>" : "") +
            "<span class='txt'>" + esc((t && t.title) || "tab " + n) + "</span>" +
            (t ? faviconHtml(t.favIconUrl) : "") +
            "</div><div class='s'>" +
            esc((t && t.url) || "") +
            "</div>"
          );
        },
        onPick: (n) => {
          ctx.close();
          ctx.ops.tabJump(n);
        },
        extraKeys: (e, sel) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return false;
          const next = extendTabPrefix(count, current, e.key);
          if (!next) return false;
          e.preventDefault();
          current = next.prefix;
          if (next.plan.kind === "jump") {
            ctx.close();
            ctx.ops.tabJump(next.plan.n);
            return true;
          }
          // Still ambiguous: retitle to the wider prefix and let the search
          // re-run through the (already debounced-at-zero) refresh.
          const title = root.querySelector(".lf-title");
          if (title) title.textContent = "Tab " + current + "\u2026";
          sel.refresh();
          return true;
        },
      })
  );
}
