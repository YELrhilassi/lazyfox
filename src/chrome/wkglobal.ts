// THE WHICH-KEY MENU, PAINTED BY THE WINDOW.
//
// On a normal page the content script owns the menu: it arms the leader and
// draws the closed-shadow host into its own document. That is the right place —
// the page fills the window. In a native split view it is the wrong place: each
// page owns HALF the window, so the menu appears at the corner of that pane and
// reads as the tab's UI rather than the window's (reported). A page cannot draw
// across its pane, so the page sends the RENDERED menu and the chrome helper
// paints it over the whole window instead (see LeaderController.useRemotePanel).
//
// This is a separate host from the helper's own which-key panel: both can be
// alive at once (the helper's leader on a chrome page, a mirror for a split
// pane), and they must be able to disappear independently.

import type { LeaderPanelHtml } from "../shared/leadersignal";
import { LeaderPanel } from "../shared/leaderpanel";

export interface GlobalWhichKey {
  /** Paint the page's menu, or take it down when `panel` is null. */
  set(index: number, panel: LeaderPanelHtml | null): void;
  /** Take the menu down without touching the state that produced it. */
  clear(): void;
  /**
   * Re-check the pane that is painting, after the selection moved. A mirror left
   * up while the user is looking at a tab that is neither the pane nor its split
   * partner is the ghost overlay every other teardown path exists to prevent.
   */
  revalidate(): void;
  /** Is the window painting a pane's menu right now? (debug/assertion only) */
  shown(): boolean;
}

export function createGlobalWhichKey(deps: {
  /**
   * Is which-key allowed by config? `;q` must remove a painted mirror too.
   *
   * Checked when the SELECTION moves, not when a panel arrives: a fresh panel is
   * the sending page's own verdict, and that page refuses to paint at all while
   * its which-key is off. Refusing the arrival as well made the mirror depend on
   * the WINDOW's cached copy arriving from the background first — a cross-process
   * race that dropped a menu the page had every right to show (the same shape as
   * "it shows for a few times and then stops showing").
   */
  enabled(): boolean;
  /**
   * Can the user SEE the tab at this strip index — is it the selected tab, or
   * the other pane of the split the selected tab is in?
   *
   * The gate used to be "is this the selected tab", and in a split that is the
   * WRONG question: the pane that is receiving the keystrokes is not always the
   * one Firefox reports as selected (a pane can hold the keyboard while the
   * selection still names its sister), so the honest half of the window was
   * refused while the other half painted. Both panes of the split are on screen,
   * so either one may paint; nothing else may.
   */
  visible(index: number): boolean;
}): GlobalWhichKey {
  // A distinct host id: the helper's own leader uses `lazyfox-leader`.
  const panel = new LeaderPanel("lazyfox-page-leader");
  // Which pane's menu is up, in strip coordinates, so a later selection change
  // can tell whether it is still visible. -1 = nothing to re-check.
  let source = -1;
  const down = (): void => {
    source = -1;
    panel.setShown(false);
  };
  return {
    set(index, html) {
      // A stale signal from a pane the user cannot see must not paint over the
      // one they are looking at; a null takes the menu down whoever sent it.
      if (!html || !deps.visible(index)) {
        down();
        return;
      }
      source = index;
      panel.ensure();
      panel.fill(html.head, html.body, html.foot);
      panel.setShown(true);
    },
    clear: down,
    revalidate() {
      if (source < 0) return;
      if (!deps.enabled() || !deps.visible(source)) down();
    },
    shown() {
      return panel.shown();
    },
  };
}
