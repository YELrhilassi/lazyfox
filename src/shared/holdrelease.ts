// A HELD leader key: what keeps it held, and what ends it.
//
// "Held" is a claim about a key's LIFECYCLE, not about timing: the leader is
// held from a keydown until the matching keyup arrives. Three things end that
// claim, and they are not the same thing:
//
//   1. The real keyup. The user let go.
//   2. Losing the hold. A keyup can be LOST rather than never sent — press `;`,
//      alt-tab before releasing, and the release is delivered wherever focus
//      ended up. The window that pressed it never sees it.
//   3. NOBODY IS HOLDING IT ANY MORE. A hold that outlives the operating
//      system's auto-repeat is a claim about a physical key that has stopped
//      being true — the key is not down, or its release went somewhere this
//      document cannot see. Both hosts used to clear the hold on a keyup or a
//      blur only, so a claim that missed both was permanent.
//   4. THE USER CANCELLED IT. Escape and Ctrl+G end the gesture, so they end
//      the hold — and they must end the claim the background is keeping too,
//      or the next navigation restores a hold nobody is making.
//
// All four go through one body (endHold below), because four ways to write
// "the hold is over" is four ways for one of them to forget half of it.
//
// The third one is why this file has a clock in it. `sticky` is not cosmetic:
// while it is set, every binding RUNS AND LEAVES THE LEADER ARMED, so a hold
// nobody is holding turns the whole keyboard into a chain of `;x` bindings —
// the reported "the which-key and the leader key stay active and then nothing
// responds the way I expect", and, when a chained binding happens to be a
// destructive one, worse than that.
//
// A hold is therefore kept alive by EVIDENCE, and the evidence is the key's own
// auto-repeat: a physically down leader key re-fires keydown roughly every 30ms
// (the OS rate), which both hosts already see and drop for arming purposes. The
// repeats are kept for exactly this. A hold that has seen neither a repeat nor a
// release for HOLD_LIVENESS_MS is not a hold — see noteHoldAlive,
// releaseExpiredHold and createHoldWatchdog, which is what both hosts run.
//
// WHY THE END OF A HOLD DIFFERS FROM THE END OF A TAP — the rule a user feels.
// A TAP (`;` down, up, then a binding) must leave the leader armed: that is the
// ordinary which-key gesture, and disarming on release would break it. A HOLD
// THAT ALREADY RAN SOMETHING is finished the moment the key comes up: the user
// asked for `;` held + `g g g g g`, i.e. five actions in one gesture, and what
// they get back when they let go must be the page — not an overlay still
// holding the keyboard and waiting for a sixth action. So the leader stands
// down, and only when something ran during the hold (`ranWhileHeld`, set by the
// leader itself in runOrStay).

// WHY THIS IS A MODULE. Both hosts need this rule — the chrome helper
// (src/chrome/main.ts) and the content script (src/extension/content/main.ts)
// — and both need it on `blur` and on `visibilitychange`. They were written
// twice, as closures buried in two large init functions, which meant:
//
//   * the two copies could drift, and nobody would know;
//   * NEITHER could be unit-tested, because a closure inside a module that
//     boots the whole chrome layer cannot be imported.
//
// The second point is the one that mattered. scripts/test/keyhold.test.ts
// could only pin the RULE by re-implementing it, which is a test that passes
// when the implementation is deleted — and the mutation gate proved exactly
// that: reverting the real release path left every test green.

/** The minimum a leader has to be for these rules to apply. */
export interface ReleasableLeader {
  /** True while a keyup for the leader key is still outstanding. */
  sticky?: boolean;
  /** True while the leader is armed (showing its overlay / awaiting a key). */
  active?: boolean;
  /**
   * True once a binding ran while the hold was outstanding.
   *
   * Written by the leader controller (LeaderController.runOrStay), read here:
   * it is the difference between "the user held the leader and did something"
   * and "the user tapped the leader and is about to type a chord".
   */
  ranWhileHeld?: boolean;
  /**
   * When this hold stops being believable (epoch ms). Refreshed by every piece
   * of evidence that the key is still down — the press itself, and each of its
   * auto-repeats. 0/absent means "no evidence yet", which expires immediately.
   */
  holdUntil?: number;
  /** Hide the overlay / disarm. Idempotent. */
  hide?: () => void;
}

/**
 * How long a hold survives without evidence.
 *
 * The same number as HOLD_RESTORE_GRACE_MS and for the same reason: the gap a
 * navigation takes (a few hundred milliseconds) with room to spare, and short
 * enough that a claim about a key nobody is holding cannot hold the keyboard for
 * a user-noticeable time. The auto-repeat interval is two orders of magnitude
 * smaller, so a genuinely held key never comes near it.
 */
export const HOLD_LIVENESS_MS = 2500;

/**
 * End the hold, and stand the leader down if the hold had already run something.
 *
 * The single body for every way a hold ends, so the three callers cannot drift:
 * the real keyup, a lost keyup (blur / visibility) and expiry. Returns whether a
 * hold was actually outstanding, so the caller can publish the release.
 */
function endHold(leader: ReleasableLeader | null | undefined): boolean {
  if (!leader) return false;
  if (!leader.sticky) return false;
  leader.sticky = false;
  leader.holdUntil = 0;
  const ran = !!leader.ranWhileHeld;
  leader.ranWhileHeld = false;
  // A hold that ran an action is a FINISHED GESTURE when the key comes up: the
  // overlay must not stay up holding the keyboard for the next keystroke. A hold
  // that ran nothing is a tap, and a tap leaves the leader armed.
  if (ran && leader.active && typeof leader.hide === "function") leader.hide();
  return true;
}

/**
 * Record that the leader key is still physically down.
 *
 * Called from the press and from every auto-repeat of the leader key, in both
 * hosts. A repeat used to be dropped and forgotten; it is the only evidence a
 * hold can have that does not depend on the release arriving.
 */
export function noteHoldAlive(leader: ReleasableLeader | null | undefined, now = Date.now()): void {
  if (!leader) return;
  if (!leader.sticky) return;
  leader.holdUntil = Number(now) + HOLD_LIVENESS_MS;
}

/**
 * End the hold on a real keyup — and only for the leader key.
 *
 * Returns true when a hold was actually released, so a caller can publish it to
 * the background. Any other key's keyup is ignored: it belongs to whatever else
 * the user is doing, and treating it as the leader's release would disarm the
 * leader mid-sequence.
 */
export function releaseHoldOnKeyup(
  leader: ReleasableLeader | null | undefined,
  leaderKey: string,
  key: string,
): boolean {
  if (!leader) return false;
  if (key !== leaderKey) return false;
  return endHold(leader);
}

/**
 * Re-arm a hold that a document which no longer exists went on record about.
 *
 * The claim itself is judged by the caller (see shouldRestoreHold): this only
 * writes it, and it writes one thing the naive restore forgot.
 *
 * A RESTORED HOLD IS A HOLD THAT ALREADY DID SOMETHING, and saying so is the
 * difference between a gesture that ends and an overlay that never does. The
 * document that published the hold is gone; the only thing that replaces a
 * document mid-hold is an action the hold ran — `;g`, `;x`, a tab switch. A
 * fresh document, however, has no memory of that: `ranWhileHeld` starts false,
 * so ending the restored hold looked exactly like ending a TAP and left the
 * leader ARMED. That is the reported "I can do `;g` to go back but the which-key
 * and the leader key stay active": the overlay is up on a page the user never
 * opened it on, and every key from then on is dispatched as a `;x` binding
 * instead of reaching the page.
 *
 * The deadline is refreshed here as well, because the press this claim describes
 * is what the deadline is about — the caller has no other evidence that the key
 * is down until the next auto-repeat arrives.
 */
export function restoreHold(
  leader: ReleasableLeader | null | undefined,
  now = Date.now(),
): boolean {
  if (!leader) return false;
  leader.sticky = true;
  leader.ranWhileHeld = true;
  noteHoldAlive(leader, now);
  return true;
}

/**
 * End the hold because the user CANCELLED the gesture — Escape, or Ctrl+G.
 *
 * The same body as every other end-of-hold, deliberately: a cancel has to do
 * everything a release does, and the part that is easy to leave out is the
 * PUBLISHED claim. `hide()` alone clears the pixels and not the claim the
 * background is holding, so the next navigation restored a hold the user had
 * explicitly backed out of — an armed leader, and with it the dead keyboard,
 * on a page where nobody had pressed the leader key at all.
 *
 * Returns whether a hold was actually outstanding, so the host can publish the
 * release and stop its watchdog.
 */
export function cancelHold(leader: ReleasableLeader | null | undefined): boolean {
  return endHold(leader);
}

/**
 * End a hold that has stopped being believable, if its deadline has passed.
 *
 * The self-heal for a hold whose release was never delivered AND whose window
 * never blurred — the state both hosts used to hold forever. `holdUntil` of 0 is
 * treated as expired rather than trusted: a hold nobody ever refreshed is a hold
 * with no evidence behind it.
 */
export function releaseExpiredHold(
  leader: ReleasableLeader | null | undefined,
  now = Date.now(),
): boolean {
  if (!leader) return false;
  if (!leader.sticky) return false;
  const until = Number(leader.holdUntil) || 0;
  if (until && Number(now) < until) return false;
  return endHold(leader);
}

/**
 * End a hold whose keyup was LOST, because the window or page stopped being
 * the thing the user is looking at.
 *
 * Idempotent and cheap — it is wired to `blur` and to every
 * `visibilitychange`, so it runs often — and a no-op unless a hold is actually
 * outstanding, so it cannot disturb a leader that was never held. It stands the
 * leader down on the same terms as a release: losing focus is not the user
 * changing their mind about a TAP, but a hold that already ran something is over
 * either way.
 */
export function releaseLostHold(leader: ReleasableLeader | null | undefined): boolean {
  return endHold(leader);
}

/**
 * Should a visibility change release the hold?
 *
 * Only when the document became hidden. Becoming visible again releases
 * nothing, because by then the blur handler has already done it — and running
 * both is harmless but pointless.
 */
export function visibilityLostHold(visibilityState: string): boolean {
  return visibilityState !== "visible";
}

/** What a host runs while a hold is outstanding. */
export interface HoldWatchdog {
  /** Evidence the leader key is still down: (re-)arms the expiry timer. */
  keepAlive(): void;
  /** Give up watching — the hold is over, or the host is going away. */
  stop(): void;
}

/**
 * The timer half of the liveness rule, so both hosts run the same one.
 *
 * Deliberately takes its clock and its timer functions: the rule is then
 * testable in Node with no DOM, no browser and no waiting, which is the only way
 * a 2.5-second property gets pinned in a fast test.
 *
 * `onRelease` is the host's own "publish the release" call: the background keeps
 * a per-tab hold so a navigation can restore it, and a hold that expires locally
 * must not be restorable afterwards. The timeout uses the same fixed liveness
 * interval as the deadline calculation, so the two cannot drift.
 */
export function createHoldWatchdog(opts: {
  /**
   * The leader, or a GETTER for it. Both hosts construct their leader after
   * some of the listeners that use it, so a value captured here would be the
   * `null` it was before construction — which is a watchdog that never expires
   * the very hold it exists for. The getter makes that unrepresentable.
   */
  leader: ReleasableLeader | null | undefined | (() => ReleasableLeader | null | undefined);
  onRelease?: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): HoldWatchdog {
  const resolve = (): ReleasableLeader | null | undefined =>
    typeof opts.leader === "function" ? opts.leader() : opts.leader;
  const now = opts.now || (() => Date.now());
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((handle) => clearTimeout(handle as never));
  let handle: unknown = null;

  const stop = (): void => {
    if (handle == null) return;
    clearTimer(handle);
    handle = null;
  };

  const keepAlive = (): void => {
    // Resolve once: a dynamic host getter must not let one event update one
    // leader and schedule expiry against a different one.
    const leader = resolve();
    noteHoldAlive(leader, now());
    if (!leader?.sticky) {
      stop();
      return;
    }
    stop();
    handle = setTimer(() => {
      handle = null;
      if (releaseExpiredHold(resolve(), now())) {
        if (opts.onRelease) opts.onRelease();
      }
    }, HOLD_LIVENESS_MS + 1);
  };

  return { keepAlive, stop };
}

/**
 * How long a published hold is still believable.
 *
 * A hold is a claim about a PHYSICAL key: the leader key is down and its keyup
 * has not arrived yet. It is published to the background so it can survive a
 * navigation (see content/main.ts: `;` held across `;g`), which means the claim
 * outlives the document that made it — and a document that is gone cannot
 * retract anything. A claim about a held key is therefore only worth believing
 * while the key could still plausibly BE held: long enough to cover the gap a
 * navigation takes (a few hundred milliseconds), short enough that a claim from
 * a document that died mid-release cannot arm a leader nobody is holding.
 *
 * The failure it bounds is the worst shape this class of bug has. A restored
 * hold marks the leader as physically held with no keyup left to release it, so
 * the leader never disarms: every later key is dispatched as a `;x` binding
 * (Chrome loses a tab, `g` navigates) while the which-key overlay — if it is
 * even enabled — looks exactly as it does during a normal sequence. That is the
 * reported "it stops responding to any input and then starts again and I never
 * know why".
 *
 * The RESTORE is bounded by this; the restored HOLD is bounded by the watchdog
 * above, which is what actually gives the keyboard back in that case.
 */
export const HOLD_RESTORE_GRACE_MS = 2500;

/**
 * May a hold published by an earlier document be re-armed here?
 *
 * `publishedAt` is the wall-clock time the document that observed the press
 * wrote the claim (0/NaN for a claim from a host that did not record one, which
 * is refused rather than trusted). A claim that arrived without a timestamp is
 * the old, unbounded rule, and refusing it is the whole point of the change.
 */
export function shouldRestoreHold(
  hold: boolean,
  publishedAt: number,
  now: number,
): boolean {
  if (!hold) return false;
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) return false;
  const age = Number(now) - publishedAt;
  // A claim from the future is a clock the two realms disagree about; treating
  // it as fresh is the safe direction (the alternative is refusing every
  // restore on a host whose clock is skewed backwards).
  if (age < 0) return true;
  return age <= HOLD_RESTORE_GRACE_MS;
}