import { esc } from "../dom";
import { core } from "../core";
import { faviconHtml } from "../favicon";
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
        // yet (empty list): fall back to opening the typed value. A highlighted
        // row (e.g. a history entry) still wins via the default pick.
        //
        // A bare word is a SEARCH, not a host. The old code normalized
        // everything with normalizeUrl, which prepends https:// — so `;o`
        // then "doodle" navigated to https://doodle, failed DNS, and dropped
        // the user on a Firefox error page. Nothing works there: no content
        // script runs on it, so neither the leader nor the which-key overlay
        // can be reached, and the UI that would let them type a URL is hidden.
        // That is a dead end reached by typing one ordinary word.
        //
        // The command-center input has always made this distinction with
        // core.isLikelyUrl (scheme, a domain dot, or localhost => URL, anything
        // else => search). `;o` now uses the same rule instead of guessing, so
        // a word searches and only something that looks like a host is opened.
        onEnter: (value, item) => {
          if (item) return false;
          const v = (value || "").trim();
          if (!v) return false;
          ctx.close();
          void core
            .isLikelyUrl(v)
            .then((likely) => {
              if (!likely) {
                ctx.ops.search(v, replace ? false : undefined);
                return;
              }
              core
                .normalizeUrl(v)
                .then((u) => ctx.ops.openUrl(u, replace ? false : undefined))
                .catch(() => ctx.ops.openUrl(v, replace ? false : undefined));
            })
            // If the core is unavailable, fall back to opening it rather than
            // dropping the keystroke: that is the old behaviour, and a wrong
            // guess that still navigates beats a dead key.
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
        // j/k walk the list while the input is empty — the tab switcher's
        // arrow keys move the selection regardless (handled unconditionally
        // in the selector), but vim-style letters match the rest of the app.
        vimNav: true,
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
            "<span class='txt'>" + esc(t.title || "") + "</span>" +
            // Favicon pinned to the far right of the row; nothing at all
            // when the tab has none.
            faviconHtml(t.favIconUrl) +
            "</div><div class='s'>" +
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
          // Mutating actions re-query twice: once immediately (the content
          // path's send() has already landed by the time it resolves) and
          // once after a short delay (the chrome path's native close/move is
          // async, so the immediate refresh can still show the old strip).
          const refreshSoon = () => {
            sel.refresh();
            setTimeout(sel.refresh, 250);
          };
          if (k === "x") {
            e.preventDefault();
            ctx.ops.closeTab(sel.item.id);
            refreshSoon();
            return true;
          }
          if (k === "l" || k === "]") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, 1);
            refreshSoon();
            return true;
          }
          if (k === "h" || k === "[") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, -1);
            refreshSoon();
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
