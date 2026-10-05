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

import { LeaderController, leaderSequences } from "../shared/leader";
import { CATEGORY_TIMEOUT_MS, leaderCategories } from "../shared/popups/categories";
import { digitExpect } from "../shared/leadersignal";
import { makeLeaderActions, runLeaderAction, type PopupCtx } from "../shared/popups";
import { openNavPopup } from "../shared/popups/nav";
import { toast } from "../shared/overlay";

export interface LeaderSetupDeps {
  // The popup context, which carries the ops adapter and the popup host.
  ctx: PopupCtx;
  // Switches to the session carrying that marker (`;'` then a digit).
  switchSessionByMarker(marker: number): void;
  /** May the which-key overlay paint right now? Same predicate as the key path. */
  overlayAllowed(): boolean;
  /** Called on every arm/disarm, so the status-bar indicator tracks the key. */
  onChange(): void;
  /** Does a PLAIN binding exist for this key? (A plain binding beats a category.) */
  hasBinding(key: string): boolean;
  /** Records the binding that ran, for the debug snapshot. */
  noteAction(key: string): void;
}

/**
 * Builds the leader controller AND the chrome-side binding overrides.
 *
 * The overrides exist because a few bindings are genuinely chrome-specific and
 * cannot live in the shared table:
 *
 *   ;'   arms a digit capture, which needs the leader's own one-shot slot —
 *         only the controller can hand out that capture.
 *   ;G/;L  open the nav-stack popup as PLAIN bindings on the shifted keys. They
 *         used to be two-key sequences so the shifted keys could "never shadow"
 *         a plain binding, but Shift already makes G a different key from g, so
 *         the extra key bought nothing and cost the whole feature: `;G` armed a
 *         capture, showed nothing, and on timeout fell through to a plain `G`
 *         action that does not exist. The which-key table advertised
 *         ";G = back history stack" throughout, so the menu promised a key that
 *         did nothing.
 *   ;F/;B  cycle the scroll region, which the CONTENT script owns on web pages.
 *         They appear in the shared table, so answer them here with a clear note
 *         instead of a silent no-op.
 *
 * The categories (`;W`, `;Z`) are NOT overridden: they come from the shared
 * table in categories.ts, so the chrome helper and the content script cannot
 * drift into disagreeing about what `;W |` does.
 */
export interface ChromeLeader {
  leader: LeaderController;
  /**
   * The binding table, so the composition root can layer its own page-type
   * routing on top (see the `f` split in main.ts) without rebuilding it.
   */
  actions: Record<string, () => void>;
}

export function createChromeLeader(deps: LeaderSetupDeps): ChromeLeader {
  const { ctx } = deps;
  const leaderActions: Record<string, () => void> = makeLeaderActions(ctx);

  const leader = new LeaderController(
    (k) => {
      deps.noteAction(k);
      runLeaderAction(leaderActions, k);
    },
    deps.overlayAllowed,
    deps.onChange,
    deps.hasBinding
  );

  // The shared table's own entries are the default; these are the additions and
  // replacements layered on top of it.
  leaderActions["'"] = () =>
    leader.armPending(
      (k) => {
        if (/^[1-9]$/.test(k)) {
          deps.switchSessionByMarker(Number(k));
          return true;
        }
        return false;
      },
      {
        timeoutMs: 3000,
        // Markers are 1-9 by construction (core.assignSessionMarker), so this
        // names the whole legal set rather than a hand-typed subset.
        expect: digitExpect(9),
      }
    );

  leaderActions["G"] = () => openNavPopup(ctx);
  leaderActions["L"] = () => openNavPopup(ctx);

  for (const [head, final] of Object.entries(leaderCategories(ctx))) {
    leaderSequences[head] = { final, timeoutMs: CATEGORY_TIMEOUT_MS };
  }

  leaderActions["F"] = () => toast("scroll regions: web pages only");
  leaderActions["B"] = () => toast("scroll regions: web pages only");

  return { leader, actions: leaderActions };
}
