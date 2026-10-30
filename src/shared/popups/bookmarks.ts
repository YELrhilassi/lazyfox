// Bookmarks popup.
import { esc } from "../dom";
import { faviconFor, faviconHtml } from "../favicon";
import type { PopupItem } from "../types";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

export function openBookmarksPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Bookmarks",
      "no bookmarks",
      "<span class='lf-badge'>i</span> search &middot; <span class='lf-badge'>j/k</span> move &middot; " +
        "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close",
      "i to search bookmarks"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        emptyText: "no bookmarks",
        search: (q) => ctx.ops.bookmarks(q),
        render: (it) =>
          "<div class='t'><span class='txt'>" + esc(it.title || "") + "</span>" + faviconHtml(faviconFor(it.url)) + "</div>" +
          "<div class='s'>" + esc(it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          ctx.ops.openUrl(it.url || "");
        },
      })
  );
}

