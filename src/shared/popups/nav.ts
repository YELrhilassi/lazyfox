// The navigation-stack popup (`;G` and `;L`): where this tab has been, as a
// bounded tree with the root pinned and redirects called out.
//
// The windowing, the depth bookkeeping and the loop detection all live in
// shared/navtree.ts as PURE functions, because the two things that are easy to
// get wrong here — which rows are visible, and whether the user is trapped in a
// redirect — are both arithmetic over a list, and arithmetic over a list is
// exactly what can be unit-tested. This file is the part that cannot be: the
// panel, the keys, the walking.
//
// WHAT THE USER SEES. A short list, not their whole history. Eleven rows,
// centred on where they are, with the root pinned into the first row no matter
// how far they have walked. Rows behind the cursor go back, rows ahead go
// forward, and the marker on each row is the number of steps it is — so `;G`
// then Enter on a row three back is three steps back, said out loud in the row
// rather than computed in the user's head.
//
// THE REDIRECT CASE. A site that redirects to itself is invisible in a flat
// stack: the list just grows. When the current entry's URL has already been
// visited inside the window, the panel says so in its title and offers the way
// out — the root row is one keystroke away, and `0` jumps straight to it.
// That is the whole feature: not preventing the loop (nothing client-side can)
// but making the exit one key rather than an unknown number of Back presses.

import { esc } from "../dom";
import { toast } from "../overlay";
import { buildNavTree, navStep, type NavEntryIn, type NavNode } from "../navtree";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

export async function fetchNavStack(ctx: PopupCtx): Promise<{
  canBack: boolean;
  canForward: boolean;
  index: number;
  entries: NavEntryIn[];
} | null> {
  try {
    // Through the HOST, not the protocol. Only the chrome helper can read the
    // browser's real session history (see chrome/ops.ts); the content script
    // gets the background's reconstructed track. Asking `ctx.ops` means the
    // popup does not have to know which of the two it is talking to — and the
    // protocol route it used to take could only ever answer with the rebuilt
    // side, so the chrome pages were paying for the weaker source.
    const r = await ctx.ops.navStack();
    return r || null;
  } catch {
    return null;
  }
}

/** One row of the popup, derived from a tree node. */
interface NavRow {
  kind: "nav";
  node: NavNode;
  title: string;
  url: string;
  /** Steps from here: negative back, positive forward, 0 the current page. */
  step: number;
  active: boolean;
  time: number;
}

/** Short relative time, or "" when the host gave no timestamp. */
function relTime(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

export function openNavPopup(ctx: PopupCtx): void {
  void (async () => {
    const stack = await fetchNavStack(ctx);
    if (!stack || !stack.entries.length) {
      toast("no history on this tab");
      return;
    }
    const tree = buildNavTree(stack.entries, stack.index);
    if (!tree.nodes.length) {
      toast("no history on this tab");
      return;
    }
    const items: NavRow[] = tree.nodes.map((node) => ({
      kind: "nav",
      node,
      title: node.title,
      url: node.url,
      step: navStep(tree, node.stackIndex),
      active: node.stackIndex === tree.current,
      time: node.time,
    }));

    const go = (row: NavRow): void => {
      if (row.step === 0) return;
      ctx.ops.navGoto(row.step);
    };

    // The title carries the two facts the user cannot get by looking at rows:
    // which edge they are at, and whether the site is bouncing them.
    const title =
      "Navigation stack" +
      (stack.canBack ? "" : " — at root") +
      (stack.canForward ? "" : " — at end") +
      (tree.stuck ? " — redirect loop, this page is a repeat" : "");
    const foot =
      "<span class='lf-badge'>Enter</span> go" +
      (tree.root ? " &middot; <span class='lf-badge'>0</span> back to start" : "") +
      (tree.truncated ? ` &middot; ${tree.truncated} older entr${tree.truncated === 1 ? "y" : "ies"}` : "") +
      " &middot; <span class='lf-badge'>Esc</span> close";

    ctx.open(
      basePanel(title, "no history", foot),
      (root) =>
        makeSelector<NavRow>(ctx, root, {
          debounceMs: 0,
          emptyText: "no history",
          // j/k walk the rows while the field is empty. Every other list in the
          // app navigates this way; this one used to require the arrow keys for
          // no reason a user could see.
          vimNav: true,
          // Open WITH the cursor on the page you are on. The rows are not a
          // ranking — they are a position — so lighting row 0 (the pinned root,
          // or the oldest entry in the window) would put the selection as far
          // from where the user is as the list allows, and Enter would then take
          // them somewhere they did not ask to go.
          initial: (rows) => rows.findIndex((r) => r.node.stackIndex === tree.current),
          search: async () => items,
          render: (it) => {
            const n = it.node;
            const mark = it.active ? "<span class='dot'></span>" : "";
            const dir = it.step < 0 ? "\u2190" : it.step > 0 ? "\u2192" : "";
            const stepBadge =
              it.step !== 0 && Math.abs(it.step) <= 9
                ? "<span class='lf-marker'>" + (it.step < 0 ? it.step : "+" + it.step) + "</span>"
                : "";
            // A row the site bounced the user to is marked, so the repeated
            // pages in a redirect chain are visible as a group rather than
            // looking like ordinary history.
            const loop = n.loop ? "<span class='lf-rel'>\u21ba</span>" : "";
            const root = n.root ? "<span class='lf-rel'>\u2302</span>" : "";
            const when = relTime(n.time);
            return (
              "<div class='t'>" + stepBadge + mark + dir + root + loop +
              esc(it.title || "") +
              (n.visits > 1 ? " <span class='lf-rel'>\u00d7" + n.visits + "</span>" : "") +
              "</div><div class='s'>" +
              esc(it.url || "") + (when ? " \u00b7 " + when : "") +
              "</div>"
            );
          },
          // Root first, then back, current, forward — so the way out of a
          // redirect is the first row and `0` reaches it without scrolling.
          groupBy: (it) =>
            it.node.root
              ? "Start"
              : it.step < 0
                ? "Back"
                : it.step === 0
                  ? "Current"
                  : "Forward",
          onPick: (it) => {
            ctx.close();
            go(it);
          },
          onChange: (_idx, item, _count) => {
            // The digits-in-the-popup shortcut, kept: a row whose step is
            // unambiguous resolves on the last digit, exactly as `;11` does.
            const inputEl = root.querySelector(".lf-input") as HTMLInputElement | null;
            const q = ((inputEl && inputEl.value) || "").trim();
            if (!/^-?\d+$/.test(q) || !item) return;
            const want = Number(q);
            if (item.step !== want || count2(items, want) !== 1) return;
            ctx.close();
            go(item);
          },
          extraKeys: (e, sel) => {
            if (e.key === "0" && tree.root) {
              // The escape from a redirect loop: one key to where the session
              // began, whatever the site has done since.
              e.preventDefault();
              const rootItem = items.find((i) => i.node.root);
              if (!rootItem) return false;
              ctx.close();
              go(rootItem);
              return true;
            }
            if (e.key === "p" && sel.item && sel.item.step !== 0) {
              // "Parent": step back to the previous entry, for walking the
              // chain without leaving the popup.
              e.preventDefault();
              const target = sel.item.step - 1;
              const row = items.find((i) => i.step === target);
              if (!row) return false;
              ctx.close();
              go(row);
              return true;
            }
            return false;
          },
        })
    );
  })();
}

/** How many rows sit exactly `step` steps from the current entry. */
function count2(items: NavRow[], step: number): number {
  let n = 0;
  for (const i of items) if (i.step === step) n++;
  return n;
}
