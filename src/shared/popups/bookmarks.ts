// Bookmarks popup.
import { esc } from "../dom";
import type { PopupItem } from "../types";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

export function openBookmarksPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Bookmarks",
      "type to search bookmarks",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "type to search bookmarks",
        search: (q) => ctx.ops.bookmarks(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          ctx.ops.openUrl(it.url || "");
        },
      })
  );
}

