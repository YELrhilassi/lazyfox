// Keybindings help popup (`;?`).
//
// A grouped, searchable reference for every leader binding. The list is
// rendered with sticky group headers (groupBy in the shared selector) so a long
// table stays navigable, and the search box filters by the binding's key, its
// label AND its group — typing "tab" or "split" narrows to the relevant rows
// instead of scanning the whole table.
//
// THE TABLE IS THE KEYMAP, AND SO IS WHAT ENTER RUNS. Rows come from the Go
// keymap (via core.bindings()), and Enter resolves the row's chord back to an
// ACTION ID through the same table the dispatcher matches against. The chord is
// printed and the id is run because they are two views of one row — passing the
// printed chord to a table keyed by id would be a second, silently different
// spelling of the same lookup, which is exactly the drift this keymap removed.
//
// CATEGORIES ARE INDEXED HERE, ONE LEAF AT A TIME. The which-key overlay shows
// `;W` as ONE row (a twelve-row head is one row; that is its job). This popup
// has the opposite job: it is the flat index of everything pressable, so it
// also lists `;W z`, `;K c` and the rest — otherwise searching "split" or
// "zoom" in the reference would return nothing at all.
//
// vimNav is disabled on purpose: in this popup j/k must type into the search
// box (that is the whole point of the popup), while the arrow keys move the
// selection. Enter runs the highlighted binding.
import { esc } from "../dom";
import type { WkItem } from "../types";
import { actionForChord, keymapLeafRows, loadKeymap, type KeymapLeafRow } from "../keymap";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

/** A row of the reference: a core row, or one leaf of a category. */
type HelpRow = WkItem & { action?: string };

export function openHelpPopup(ctx: PopupCtx): void {
  async function rows(): Promise<HelpRow[]> {
    // The keymap is fetched once on boot, but the popup must not depend on
    // having won that race: awaiting the (cached) fetch here means the leaf
    // rows are present on the first `;?` of a cold start too.
    await loadKeymap();
    const all: HelpRow[] = (await ctx.bindings()).slice();
    const leaves: KeymapLeafRow[] = keymapLeafRows();
    for (const leaf of leaves) {
      all.push({
        key: leaf.key,
        label: leaf.label,
        group: leaf.group,
        native: false,
        action: leaf.action,
      });
    }
    // Resolve every non-native, non-leaf row's action id once, here, so the
    // picker below cannot run a row by a different spelling than the dispatcher.
    for (const h of all) {
      if (!h.native && !h.action) h.action = actionForChord(h.key);
    }
    return all;
  }
  ctx.open(
    basePanel(
      "Keybindings",
      "search shortcuts — key, name or group",
      "<span class='lf-badge'>Enter</span> run &middot; " +
        "<span class='lf-badge'>&uarr;&darr;</span> move &middot; " +
        "<span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<HelpRow>(ctx, root, {
        debounceMs: 20,
        // j/k are search characters here, not navigation.
        vimNav: false,
        emptyText: "no matching shortcut",
        groupBy: (h) => h.group || "Other",
        search: async (q) => {
          const all = await rows();
          const ql = q.trim().toLowerCase();
          if (!ql) return all;
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
          if (h.action) {
            ctx.runAction(h.action);
            return;
          }
          // No action and not native: a category head. Its leaves are listed
          // further down the same popup (grouped under its own name), and
          // pressing it here would run nothing at all, so say where they are.
          ctx.toast(";" + h.key + " opens a menu — its keys are listed below");
        },
      })
  );
}
