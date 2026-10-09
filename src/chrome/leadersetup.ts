// The chrome helper's leader: its binding table and the controller that runs
// it.
//
// Extracted from main.ts because the composition root was carrying a second
// job: not just "build these modules and wire them together", but also "here is
// the list of keys the chrome helper answers, and here is when each one is
// legal". Those are different reasons to change — adding a module is a
// composition change, adding or moving a binding is a keymap change — and
// mixing them in one 769-line file is what made both harder to see.
//
// Everything context-specific arrives as an argument. Nothing here reads a
// global, and nothing here knows about the status bar, the channel or the
// window beyond what it is handed, so the table can be read as a table.

import { LeaderController } from "../shared/leader";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";
import { openNavPopup } from "../shared/popups/nav";
import { toast } from "../shared/overlay";

export interface LeaderSetupDeps {
  // The popup context, which carries the ops adapter and the popup host.
  ctx: PopupCtx;
  /** May the which-key overlay paint right now? Same predicate as the key path. */
  overlayAllowed(): boolean;
  /** Called on every arm/disarm, so the status-bar indicator tracks the key. */
  onChange(): void;
  /** Records the binding that ran, for the debug snapshot. */
  noteAction(action: string): void;
}

/**
 * Builds the leader controller AND the chrome-side action overrides.
 *
 * The overrides exist because four actions are genuinely chrome-specific and
 * cannot live in the shared table — they need a host object the shared table
 * has no access to:
 *
 *   backStack / forwardStack  open the nav-stack popup, which reads THIS
 *         window's history.
 *   scrollRegionNext / Prev  cycle the scroll region, which the CONTENT script
 *         owns on web pages. Here they answer with a clear note instead of a
 *         silent no-op — which is also what the keymap's own coverage test
 *         insists on: a named host action that answers nothing is a key that
 *         lies.
 *
 * Nothing here names a KEY. The keymap (core/keymap.go) owns that, which is why
 * this file can no longer produce a binding that shadows another one.
 */
export interface ChromeLeader {
  leader: LeaderController;
  /**
   * The action table, so the composition root can layer its own page-type
   * routing on top (see the `startHints` split in main.ts) without rebuilding
   * it.
   */
  actions: Record<string, () => void>;
}

export function createChromeLeader(deps: LeaderSetupDeps): ChromeLeader {
  const { ctx } = deps;
  const leaderActions: Record<string, () => void> = makeLeaderActions(ctx);

  leaderActions["backStack"] = () => openNavPopup(ctx);
  leaderActions["forwardStack"] = () => openNavPopup(ctx);
  leaderActions["scrollRegionNext"] = () => toast("scroll regions: web pages only");
  leaderActions["scrollRegionPrev"] = () => toast("scroll regions: web pages only");

  const leader = new LeaderController(
    (action) => {
      deps.noteAction(action);
      runLeaderAction(leaderActions, action);
    },
    deps.overlayAllowed,
    deps.onChange,
    // A chord the keymap does not know is reported, not swallowed. The leader
    // owns the keyboard while it is armed, so the key is consumed either way —
    // but silence here is what made an unbound chord look like a key that had
    // to be pressed twice.
    (spec) => toast("no binding for ;" + spec)
  );

  return { leader, actions: leaderActions };
}
