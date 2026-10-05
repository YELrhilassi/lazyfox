// The two-key leader sequence grammar.
//
// `;<first>;<final>` style prefixes: the first key arms a one-shot capture for
// the second, and the whole rule set for what happens then lives here rather
// than inline in the controller's key handler. It is the subtlest part of the
// leader — five separate ways it can end (fired, unregistered sub-key, timeout
// into a plain binding, escape mid-sequence, sticky-held) — and each of those
// five rules exists because the other four were once wrong.
//
// Everything the rules need is passed in, so this module knows nothing about
// the controller's state; it is given verbs and returns what the caller should
// arm.

/** What a sequence head hands back to the controller, which arms it as a capture. */
export interface SequenceArm {
  /** The capture callback: consumes the second key. */
  consume: (finalKey: string) => boolean;
  /** How long the head waits before giving up and running the plain binding. */
  timeoutMs: number | undefined;
  /** The human-readable sub-keys, shown on the bar for the life of the capture. */
  expect: string;
  /** Runs when the capture expires unused: the head may itself be a plain binding. */
  onTimeout: () => void;
}

export interface SequenceContext {
  /** The final-key table the head dispatches through. */
  final: Record<string, () => void>;
  /** The head's own binding, recomputed from SEQUENCES/hasBinding by the caller. */
  timeoutMs?: number;
  /** True while the leader is still up. A stray timer must not fire into a page. */
  isActive: () => boolean;
  /** True while the leader key is physically held, so a fired chord stays armed. */
  isSticky: () => boolean;
  /** Clear the committed prefix and repaint the readout. */
  setPrefix: (v: string) => void;
  /** Disarm: what a plain binding does when the leader is not held. */
  hide: () => void;
  /** Run the head as a plain binding, disarming unless the leader is held. */
  runOrStay: (combo: string) => void;
  /** The head's own key combination, for the timeout fallback. */
  combo: string;
  /** Renders the final-key table as the capture's "what we need next" hint. */
  describe: (keys: string[]) => string;
}

/**
 * Builds the capture for one registered sequence head.
 *
 * Note what is NOT here: the shadow rule. A plain binding for the head always
 * wins, so the caller never reaches this function for such a key — the check
 * belongs to the caller because it needs the host's `hasBinding` predicate,
 * which the controller has and this module does not.
 */
export function buildSequenceArm(ctx: SequenceContext): SequenceArm {
  return {
    timeoutMs: ctx.timeoutMs,
    // The sub-keys, from the SAME table the capture dispatches through, so the
    // bar advertises exactly what pressing one will do. A category used to show
    // a bare `;W` for its whole 1.5s: the user can see that something is wanted
    // and no idea what, with the overlay off there being nothing else on
    // screen to look at.
    expect: ctx.describe(Object.keys(ctx.final)),
    onTimeout: () => {
      // Timed out unused. The head key may itself carry a plain binding
      // (;b = bookmarks shares its head with a ;b… sequence), so run the plain
      // action — registering a sequence must not break it. Only while the
      // leader is still up: dismissing the leader cancels the intent, and a
      // stray timer must never fire an action into a page.
      if (!ctx.isActive()) return;
      ctx.runOrStay(ctx.combo);
    },
    consume: (k2) => {
      ctx.setPrefix("");
      const fn = ctx.final[k2];
      // An unregistered sub-key consumes nothing AND leaves the leader
      // standing: the user may still pick a top-level binding, and yanking the
      // leader out from under them would make the very next keystroke do
      // something they did not ask for.
      if (!fn) return false;
      // A FIRED chord ends the leader exactly like a plain binding does.
      // Leaving it armed was a real bug: after `;W |` the overlay stayed up and
      // the next keystroke was swallowed as a leader key, so the action the
      // user reached for simply never happened. A two-key chord is one action,
      // and one action ends the leader — except while the leader key is
      // physically held, where staying armed is the whole point.
      fn();
      if (ctx.isSticky()) return true;
      ctx.hide();
      return true;
    }
  };
}