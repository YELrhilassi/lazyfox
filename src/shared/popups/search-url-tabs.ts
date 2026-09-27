import { esc } from "../dom";
import { core } from "../core";
import type { PopupItem } from "../types";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

export function openSearchPopup(ctx: PopupCtx, replace = false): void {
  ctx.open(
    basePanel(
      replace ? "Search in current tab" : "Search",
      "type to search",
      "<span class='lf-badge'>Enter</span> search &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "type to search",
        search: (q) => ctx.ops.searchSuggest(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.subtitle || "search the web") + "</div>",
        onPick: (it) => {
          ctx.close();
          // ;S (replace) opens the result in the current tab; ;s defers to the
          // openInNewTab config (new tab by default).
          ctx.ops.search(it.query || "", replace ? false : undefined);
        },
      })
  );
}


export function openUrlPopup(ctx: PopupCtx, replace = false): void {
  ctx.open(
    basePanel(
      replace ? "Open URL in current tab" : "Open URL",
      "type a URL or a site name",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 70,
        vimNav: false,
        emptyText: "type a URL or a site name",
        search: (q) => ctx.ops.urlSuggest(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.subtitle || it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          // ;O (replace) opens in the current tab; ;o defers to the
          // openInNewTab config (new tab by default).
          ctx.ops.openUrl(it.url || "", replace ? false : undefined);
        },
        // Enter must work even when the debounced suggestions haven't loaded
        // yet (empty list): fall back to opening the typed value, normalized
        // exactly like the command-center input. Otherwise a fast Enter does
        // nothing, and a scheme-less word would be handed to the browser raw
        // (which fails to load it). A highlighted row (e.g. a history entry
        // the user navigated to) still wins via the default pick.
        onEnter: (value, item) => {
          if (item) return false;
          const v = (value || "").trim();
          if (!v) return false;
          ctx.close();
          core
            .normalizeUrl(v)
            .then((u) => ctx.ops.openUrl(u, replace ? false : undefined))
            .catch(() => ctx.ops.openUrl(v, replace ? false : undefined));
          return true;
        },
      })
  );
}


export function openTabsPopup(ctx: PopupCtx): void {
  // The picker shows each tab's jump number on the left. Digits 1-9 jump
  // straight to the matching tab while the search box is empty (matching the
  // `;1`-`;9` bindings); once you type into the box, digits filter as usual.
  ctx.open(
    basePanel(
      "Tabs",
      "no tabs",
      "<span class='lf-badge'>1-9</span> jump &middot; <span class='lf-badge'>Enter</span> switch &middot; " +
        "<span class='lf-badge'>x</span> close &middot; <span class='lf-badge'>h/l</span> move &middot; " +
        "<span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 40,
        itemClass: "lf-tab",
        emptyText: "no tabs",
        search: (q) => ctx.ops.listTabs(q),
        render: (t) => {
          // t.number is the 1-based strip position, the same identity ;1-;9
          // address. Only the first nine get a number (there is no ;10).
          const n = t.number != null && t.number <= 9 ? '<span class="lf-marker">' + t.number + "</span>" : "";
          return (
            "<div class='t'>" +
            n +
            (t.active ? "<span class='dot'></span>" : "") +
            (t.pinned ? "\uD83D\uDCCC " : "") +
            (t.muted ? "\uD83D\uDD07 " : "") +
            (t.stealth ? "\uD83D\uDD75 " : "") +
            esc(t.title || "") +
            "</div><div class='s'>" +
            (t.realId != null ? "id " + t.realId + " \u00b7 " : "") +
            esc(t.url || "") +
            "</div>"
          );
        },
        onPick: (t) => {
          ctx.close();
          if (t.id != null) ctx.ops.activateTab(t.id);
        },
        extraKeys: (e, sel) => {
          const k = e.key;
          if (!sel.empty || sel.item == null || sel.item.id == null) return false;
          // 1-9 jump straight to that tab, exactly like ;1-;9 (the picker
          // shows the number on each row).
          if (k >= "1" && k <= "9") {
            e.preventDefault();
            ctx.close();
            ctx.ops.tabJump(Number(k));
            return true;
          }
          if (k === "x") {
            e.preventDefault();
            ctx.ops.closeTab(sel.item.id);
            sel.refresh();
            return true;
          }
          if (k === "l" || k === "]") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, 1);
            sel.refresh();
            return true;
          }
          if (k === "h" || k === "[") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, -1);
            sel.refresh();
            return true;
          }
          return false;
        },
      })
  );
}


// Compact relative time for the related-history pane (the Go core owns the
// main list's buckets/rel time; these rows are computed in JS from the cached
// history snapshot, so they format their own age).
