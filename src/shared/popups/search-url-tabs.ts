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
      "<span class='lf-badge'>Enter</span> search &middot; " +
        "<span class='lf-badge'>Ctrl+Enter</span> in this tab &middot; " +
        "<span class='lf-badge'>Esc</span> close"
    ),
    (root) => {
      // WHERE THE RESULT OPENS IS A KEY, NOT A SECOND KEYMAP ENTRY.
      //
      // `;s` and `;S` are one popup with two destinations, and the destination
      // belongs HERE rather than in a second keymap entry: the popup is already
      // the thing holding the query, so Enter (defer to the openInNewTab
      // config) and Ctrl+Enter (always this tab) are keys inside it. `;S` is
      // the same popup opened in replace mode, which is how the top-level
      // spelling and this chord cannot drift apart.
      const go = (q: string, here: boolean) => {
        ctx.close();
        ctx.ops.search(q, here ? false : undefined);
      };
      return makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "type to search",
        search: (q) => ctx.ops.searchSuggest(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.subtitle || "search the web") + "</div>",
        onPick: (it) => go(it.query || "", replace),
        extraKeys: (e, sel) => {
          if (e.ctrlKey && e.key === "Enter") {
            e.preventDefault();
            const input = root.querySelector(".lf-input") as HTMLInputElement | null;
            const typed = ((input && input.value) || "").trim();
            // The typed query wins over the highlighted suggestion: Ctrl+Enter
            // is pressed on the way out of typing, when the row under the
            // cursor may still be a suggestion for an earlier keystroke.
            const q = typed || (sel.item && sel.item.query) || "";
            if (q) go(String(q), true);
            return true;
          }
          return false;
        },
      });
    }
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


// `;K e` — edit the current page's address in a popup and go there.
//
// An EDITABLE ADDRESS, not an editable link: one field, pre-filled with the
// page you are on, Enter navigates. It is the correction the address bar
// cannot make for you — strip a tracking parameter, fix a typo, jump to the
// same page on another host — done without leaving the keyboard's owner, so
// the leader-hold chain survives the trip.
//
// The value is normalized by the same `core.isLikelyUrl` rule `;o` uses, so a
// bare word here searches rather than navigating to https://<word> and landing
// on a DNS error page (see openUrlPopup for why that failure is a dead end).
export function openEditUrlPopup(ctx: PopupCtx): void {
  void (async () => {
    const current = await ctx.ops.pageUrl();
    // Navigate in place (`replace = true`): the user is fixing the address of
    // the page they are already on, and opening a second tab for it is a
    // surprise. A value that does not look like a host searches instead, by
    // the same core.isLikelyUrl rule `;o` uses, so a bare word never becomes
    // https://<word> and a DNS error page.
    const go = (value: string): void => {
      const v = (value || "").trim();
      if (!v) return;
      ctx.close();
      void core
        .isLikelyUrl(v)
        .then((likely) => (likely ? core.normalizeUrl(v).catch(() => v) : null))
        .then((url) => {
          if (url) ctx.ops.openUrl(url, true);
          else ctx.ops.search(v, true);
        });
    };
    ctx.open(
      basePanel(
        "Edit page URL",
        "type a URL or a site name",
        "<span class='lf-badge'>Enter</span> go &middot; <span class='lf-badge'>Esc</span> cancel"
      ),
      (root) => {
        // Built on the SHARED selector, not a hand-rolled key handler, and that
        // is not tidiness — it is the only way the field is typable at all.
        //
        // The popup's input lives in a CLOSED shadow root, so real key events
        // never reach it: the content script preventDefaults every key at the
        // window and the selector has to insert characters itself
        // (`manualText`). A popup built from a bare onKey looked correct and
        // had an input that silently swallowed every keystroke — found by the
        // e2e suite typing into it, not by typecheck.
        //
        // There are no rows: this popup filters nothing. `onEnter` takes the
        // field's raw value, which is the point — it is an address bar, not a
        // search box with suggestions.
        const ctl = makeSelector<never>(ctx, root, {
          debounceMs: 0,
          emptyText: "",
          search: async () => [],
          render: () => "",
          onPick: () => {},
          onEnter: (value) => {
            go(value);
            return true;
          },
        });
        const input = root.querySelector(".lf-input") as HTMLInputElement | null;
        // Pre-fill AFTER the selector is built, then put the caret at the end
        // so the user can keep typing instead of selecting all first.
        if (input) {
          input.value = current;
          input.focus();
          try {
            input.setSelectionRange(input.value.length, input.value.length);
          } catch {
            // An input type without a text selection: only the caret is wrong.
          }
        }
        return ctl;
      }
    );
  })();
}


export function openTabsPopup(ctx: PopupCtx): void {
  // The picker shows each tab's jump number on the left, and typing digits
  // narrows by that number rather than by the text of the title. The two are
  // the same idea the leader uses, so `;t` `1` `1` lands on tab 11 exactly as
  // `;11` does. When the digits resolve to a single tab the popup switches to
  // it on the last digit — the same "one keystroke when it is unambiguous"
  // rule the leader follows, and the reason a search box is not needed here.
  ctx.open(
    basePanel(
      "Tabs",
      "no tabs",
      "<span class='lf-badge'>1-9</span> jump &middot; <span class='lf-badge'>Enter</span> switch &middot; " +
        "<span class='lf-badge'>x</span> close &middot; <span class='lf-badge'>h/l</span> move &middot; " +
        "<span class='lf-badge'>Esc</span> close"
    ),
    (root) => {
      const inputEl = root.querySelector(".lf-input") as HTMLInputElement | null;
      return makeSelector<PopupItem>(ctx, root, {
        debounceMs: 40,
        itemClass: "lf-tab",
        emptyText: "no tabs",
        // j/k walk the list while the input is empty — the tab switcher's
        // arrow keys move the selection regardless (handled unconditionally
        // in the selector), but vim-style letters match the rest of the app.
        vimNav: true,
        search: (q) => ctx.ops.listTabs(q),
        render: (t) => {
          // t.number is the 1-based strip position, the same identity the
          // digit bindings address. Every tab gets one now: past nine, the
          // number is still reachable, as a longer digit sequence.
          const n = t.number != null ? '<span class="lf-marker">' + t.number + "</span>" : "";
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
        // The digits resolve to exactly one tab: go there without waiting for
        // an Enter. This is the tab popup's half of the shared rule — the
        // leader's other half is the chooser, and both ask the same planner.
        onChange: (_idx, item, count) => {
          const q = ((inputEl && inputEl.value) || "").trim();
          if (!/^[0-9]+$/.test(q) || count !== 1 || !item) return;
          ctx.close();
          if (item.id != null) ctx.ops.activateTab(item.id);
        },
        // The strip's identity is the browser's tab id, so the highlight can
        // follow the tab across a re-read instead of snapping to row 0.
        keyOf: (t) => t.id,
        extraKeys: (e, sel) => {
          const k = e.key;
          if (!sel.empty || sel.item == null || sel.item.id == null) return false;
          // Mutating actions re-query twice: once immediately (the content
          // path's send() has already landed by the time it resolves) and once
          // after a short delay (the chrome path's native close/move is async,
          // so the immediate refresh can still show the old strip).
          //
          // The delayed half is COALESCED inside the selector. It used to be a
          // bare `setTimeout(sel.refresh, 250)` per keypress with nothing able
          // to cancel it, so holding `;` and hammering `x` queued one per press
          // — each one re-reading and fully re-rendering a hundred rows with a
          // favicon image apiece. The pile-up is what froze the popup and made
          // it stop answering Escape.
          const refreshSoon = () => {
            sel.refresh();
            sel.refreshSoon(250);
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
      });
    }
  );
}


// Compact relative time for the related-history pane (the Go core owns the
// main list's buckets/rel time; these rows are computed in JS from the cached
// history snapshot, so they format their own age).
