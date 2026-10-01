// The navigation-stack popup: the active tab's back/forward history as one
// list, current entry highlighted. Rows before the current entry walk back,
// rows after it walk forward (the delta is sent to the background, which
// walks goBack/goForward — each step is instant via bfcache).
//
// Opened with the leader sequences `;Gk` / `;Lk` (Shift — plain `;g` / `;l`
// stay quick back/forward) in both contexts. Shows the at-root / at-end edges
// so a long stack is never a guessing game.

import { esc } from "../dom";
import { toast } from "../overlay";
import { basePanel, makeSelector, type PopupCtx } from "./kit";
import type { NavEntry } from "../types";

export async function fetchNavStack(): Promise<{
  canBack: boolean;
  canForward: boolean;
  index: number;
  entries: NavEntry[];
} | null> {
  try {
    const { send } = await import("../protocol");
    const r = await send("navStack");
    return r || null;
  } catch {
    return null;
  }
}

export function openNavPopup(ctx: PopupCtx): void {
  void (async () => {
    const { send } = await import("../protocol");
    const stack = await fetchNavStack();
    if (!stack || !stack.entries.length) {
      toast("no history on this tab");
      return;
    }
    const items = stack.entries.map((e, i) => ({
      kind: "nav",
      url: e.url,
      title: e.title || e.url,
      // The delta the background walks: negative = back, positive = forward.
      number: i - stack.index,
      active: i === stack.index,
      time: 0,
    }));
    const atRoot = !stack.canBack;
    const atEnd = !stack.canForward;

    ctx.open(
      basePanel(
        "Navigation stack" +
          (atRoot ? " \u2014 at root" : atEnd ? " \u2014 at end" : ""),
        "no history",
        "<span class='lf-badge'>Enter</span> go &middot; " +
          "<span class='lf-badge'>Esc</span> close" +
          (atRoot ? " &middot; root of history" : "") +
          (atEnd ? " &middot; newest entry" : "")
      ),
      (root) =>
        makeSelector<typeof items[number]>(ctx, root, {
          debounceMs: 0,
          emptyText: "no history",
          search: async () => items,
          render: (it) => {
            const mark = it.active
              ? "<span class='dot'></span>"
              : it.number < 0
                ? "<span class='lf-rel'>\u2190</span>"
                : "<span class='lf-rel'>\u2192</span>";
            const step = it.number !== 0 && Math.abs(it.number) <= 9
              ? "<span class='lf-marker'>" + (it.number < 0 ? it.number : "+" + it.number) + "</span>"
              : "";
            return (
              "<div class='t'>" + step + mark + esc(it.title || "") + "</div>" +
              "<div class='s'>" + esc(it.url || "") + "</div>"
            );
          },
          groupBy: (it) => (it.number < 0 ? "Back" : it.number === 0 ? "Current" : "Forward"),
          onPick: async (it) => {
            ctx.close();
            if (it.number === 0) return;
            await send("navGoto", { index: it.number });
          },
          extraKeys: () => false,
        })
    );
  })();
}
