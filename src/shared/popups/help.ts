// Keybindings help popup.
import { esc } from "../dom";
import type { WkItem } from "../types";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

export function openHelpPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Keybindings",
      "no matches",
      "<span class='lf-badge'>;key</span> run &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<WkItem>(ctx, root, {
        debounceMs: 30,
        emptyText: "no matches",
        search: async (q) => {
          const all = await ctx.bindings();
          const ql = q.trim().toLowerCase();
          if (!ql) return all.slice();
          return all.filter(
            (h) =>
              h.label.toLowerCase().indexOf(ql) !== -1 ||
              h.key.toLowerCase().indexOf(ql) !== -1
          );
        },
        render: (h) => {
          const label = h.native ? h.key : ";" + h.key;
          const tag = h.native ? "<span class='lf-native-tag'>native</span>" : "";
          return (
            "<div class='t'><span class='kbd'>" + esc(label) + "</span>" +
            tag + esc(h.label) + "</div>"
          );
        },
        onPick: (h) => {
          ctx.close();
          if (h.native) return;
          ctx.runAction(h.key);
        },
      })
  );
}

