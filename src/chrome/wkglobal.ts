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
  /** Is the window painting a pane's menu right now? (debug/assertion only) */
  shown(): boolean;
}

export function createGlobalWhichKey(deps: {
  /** Is which-key allowed by config? `;q` must remove a painted mirror too. */
  enabled(): boolean;
  /** The tab-strip index of the selected tab, or -1 when it cannot be read. */
  selectedIndex(): number;
}): GlobalWhichKey {
  // A distinct host id: the helper's own leader uses `lazyfox-leader`.
  const panel = new LeaderPanel("lazyfox-page-leader");
  return {
    set(index, html) {
      // Only the SELECTED pane can be driving the keys. A signal from another
      // pane is a leftover (a tab switch mid-sequence) and must not paint over
      // the pane the user is looking at.
      if (!html || !deps.enabled() || index !== deps.selectedIndex()) {
        panel.setShown(false);
        return;
      }
      panel.ensure();
      panel.fill(html.head, html.body, html.foot);
      panel.setShown(true);
    },
    clear() {
      panel.setShown(false);
    },
    shown() {
      return panel.shown();
    },
  };
}
