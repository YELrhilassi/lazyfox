// Keybindings help popup (`;?`).
//
// A grouped, searchable reference for every leader binding. The list is
// rendered with sticky group headers (groupBy in the shared selector) so a long
// table stays navigable, and the search box filters by the binding's key, its
// label AND its group — typing "tab" or "split" narrows to the relevant rows
// instead of scanning the whole table.
//
// vimNav is disabled on purpose: in this popup j/k must type into the search
// box (that is the whole point of the popup), while the arrow keys move the
// selection. Enter runs the highlighted binding.
import { esc } from "../dom";
import type { WkItem } from "../types";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

export function openHelpPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Keybindings",
      "search shortcuts — key, name or group",
      "<span class='lf-badge'>Enter</span> run &middot; " +
        "<span class='lf-badge'>&uarr;&darr;</span> move &middot; " +
        "<span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<WkItem>(ctx, root, {
        debounceMs: 20,
        // j/k are search characters here, not navigation.
        vimNav: false,
        emptyText: "no matching shortcut",
        groupBy: (h) => h.group || "Other",
        search: async (q) => {
          const all = await ctx.bindings();
          const ql = q.trim().toLowerCase();
          if (!ql) return all.slice();
          return all.filter(
            (h) =>
              h.label.toLowerCase().indexOf(ql) !== -1 ||
              h.key.toLowerCase().indexOf(ql) !== -1 ||
              (h.group || "").toLowerCase().indexOf(ql) !== -1
          );
        },
        render: (h) => {
          const label = h.native ? h.key : ";" + h.key;
          const tag = h.native ? "<span class='lf-native-tag'>native</span>" : "";
          return (
            "<div class='t'>" +
            "<span class='kbd'>" + esc(label) + "</span>" +
            tag +
            esc(h.label) +
            "</div>"
          );
        },
        onPick: (h) => {
          ctx.close();
          if (h.native) {
            // Native rows are informational: running them would need a browser
            // shortcut, which Lazyfox deliberately does not synthesize. Say so
            // rather than silently doing nothing.
            ctx.toast("Press " + h.key + " directly — this one is Firefox's own.");
            return;
          }
          ctx.runAction(h.key);
        },
      })
  );
}
