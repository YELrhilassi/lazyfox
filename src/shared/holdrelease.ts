// A HELD leader key: what keeps it held, and what ends it.
//
// "Held" is a claim about a key's LIFECYCLE, not timing: leader is held from
// keydown until the matching keyup. Four things end that claim, and all four
// go through one body (endHold) because four ways to write "the hold is over"
// are four ways for one of them to forget half of it:
//
//   1. the real keyup (the user let go);
//   2. a LOST keyup (press `;`, alt-tab before releasing — the release is
//      delivered wherever focus ended up);
//   3. EXPIRY: sticky is not cosmetic — while set, every binding RUNS AND
//      LEAVES THE LEADER ARMED, so a hold nobody is holding turns the whole
//      keyboard into a chain of `;x` bindings ("the leader key stays active
//      and nothing responds"). A hold is kept alive by EVIDENCE, and the
//      evidence is the key's own auto-repeat (~30ms while physically down,
//      which both hosts already see and drop for arming purposes). A hold
//      with no repeat/release for HOLD_LIVENESS_MS is not a hold;
//   4. the USER CANCELLING (Escape / Ctrl+G) — which must also end the claim
//      the background keeps, or the next navigation restores a hold nobody
//      is making.
//
// WHY THE END OF A HOLD DIFFERS FROM THE END OF A TAP: a tap (`;` down, up,
// then a binding) must leave the leader armed — the ordinary which-key
// gesture. A hold that already ran something is finished when the key comes
// up: the user asked for `;` held + `g g g g`, and what they get back when
// they let go is the page, not an overlay waiting for a sixth action. So the
// leader stands down only where `ranWhileHeld` says something ran.
//
// WHY THIS IS A MODULE: both hosts (chrome/main.ts, content/main.ts) need it
// on blur and visibilitychange. As buried closures the two copies could
// drift, and neither could be unit-tested — keyhold.test.ts could only pin
// the rule by re-implementing it (which passes when the implementation is
// deleted; the mutation gate proved exactly that).

/** The minimum a leader has to be for these rules to apply. */
export interface ReleasableLeader {
  /** True while a keyup for the leader key is still outstanding. */
  sticky?: boolean;
  /** True while the leader is armed. */
  active?: boolean;
  /**
   * Set by the leader controller when a binding ran during the hold — the
   * difference between "the user held the leader and did something" and "the
   * user tapped the leader and is about to type a chord".
   */
  ranWhileHeld?: boolean;
  /**
   * When this hold stops being believable (epoch ms), refreshed by the press
   * and every auto-repeat. 0/absent means "no evidence yet" — expires at
   * once.
   */
  holdUntil?: number;
  /** Hide the overlay / disarm. Idempotent. */
  hide?: () => void;
}

// Same number as HOLD_RESTORE_GRACE_MS for the same reason: covers the gap a
// navigation takes, short enough that a claim about a key nobody is holding
// cannot hold the keyboard noticeably. The auto-repeat interval is two orders
// of magnitude smaller, so a genuinely held key never comes near it.
export const HOLD_LIVENESS_MS = 2500;

/**
 * End the hold, and stand the leader down if the hold had already run
 * something. One body for every way a hold ends. Returns whether a hold was
 * actually outstanding, so the caller can publish the release.
 */
function endHold(leader: ReleasableLeader | null | undefined): boolean {
  if (!leader) return false;
  if (!leader.sticky) return false;
  leader.sticky = false;
  leader.holdUntil = 0;
  const ran = !!leader.ranWhileHeld;
  leader.ranWhileHeld = false;
  // A hold that ran an action is a FINISHED gesture when the key comes up; a
  // hold that ran nothing is a tap, and a tap leaves the leader armed.
  if (ran && leader.active && typeof leader.hide === "function") leader.hide();
  return true;
}

/** The press and every auto-repeat are the only hold evidence that does not depend on the release arriving. */
export function noteHoldAlive(leader: ReleasableLeader | null | undefined, now = Date.now()): void {
  if (!leader) return;
  if (!leader.sticky) return;
  leader.holdUntil = Number(now) + HOLD_LIVENESS_MS;
}

/** End the hold on the LEADER key's real keyup; any other key's keyup is somebody else's. */
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
 * Re-arm a hold published by a document that no longer exists (the claim
 * itself is judged by shouldRestoreHold).
 *
 * A RESTORED HOLD IS A HOLD THAT ALREADY DID SOMETHING: a fresh document's
 * `ranWhileHeld` starts false, so ending the restored hold looked like ending
 * a TAP and left the leader ARMED ("`;g` goes back but the which-key and the
 * leader key stay active" — an overlay up on a page the user never armed it
 * on, keys dispatched as `;x` bindings). The deadline is refreshed too: the
 * press this claim describes drives it until a repeat arrives.
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
 * End the hold because the user CANCELLED the gesture. The same body as
 * every other end-of-hold, deliberately: `hide()` alone clears the pixels
 * and not the published claim, so the next navigation restored a hold the
 * user explicitly backed out of.
 */
export function cancelHold(leader: ReleasableLeader | null | undefined): boolean {
  return endHold(leader);
}

/** End a hold whose release was never delivered and whose window never blurred. `holdUntil` of 0 is expired, never trusted: no evidence is no hold. */
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

/** End a hold whose keyup was LOST (wired to blur + visibilitychange; a no-op unless a hold is outstanding). Losing focus is not a user changing their mind about a TAP, but a hold that already ran something is over either way. */
export function releaseLostHold(leader: ReleasableLeader | null | undefined): boolean {
  return endHold(leader);
}

/** Release on a visibility change only when the document became hidden; becoming visible re-releases nothing the blur handler has not already done. */
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
 * The timer half of the liveness rule, shared by both hosts.
 *
 * Takes its clock and timer functions so the 2.5-second property is testable
 * in Node with no DOM and no waiting. `onRelease` is the host's "publish the
 * release": the background keeps a per-tab hold for restoral across a
 * navigation, and a locally-expired hold must not be restorable afterwards.
 * `leader` may be a GETTER because both hosts construct their leader after
 * some of the listeners that use it — a captured value would be null, i.e. a
 * watchdog that never expires the very hold it exists for.
 */
export function createHoldWatchdog(opts: {
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
    // Resolve once: one event must not update one leader and schedule expiry
    // against a different one.
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
 * A hold is a claim about a PHYSICAL key, published to the background so it
 * can survive a navigation (`;` held across `;g`) — so the claim outlives the
 * document that made it, and a gone document cannot retract anything. It is
 * believable only while the key could still plausibly BE held: long enough to
 * cover a navigation, short enough that a document that died mid-release
 * cannot arm a leader nobody is holding. The failure it bounds is the worst
 * shape of this bug class: a restored hold has no keyup left to release it,
 * so the leader never disarms and every later key is dispatched as a `;x`
 * binding ("it stops responding to any input, then starts again, and I never
 * know why"). The restored HOLD is in turn bounded by the watchdog above.
 */
export const HOLD_RESTORE_GRACE_MS = 2500;

/**
 * May a hold published by an earlier document be re-armed here?
 *
 * `publishedAt` is the wall-clock time the sending document recorded the
 * claim; a claim without a usable timestamp is the old, unbounded rule and is
 * refused. A claim from the future (skewed clocks) counts as fresh — refusing
 * every restore on a backwards-skewed host is the worse direction.
 */
export function shouldRestoreHold(
  hold: boolean,
  publishedAt: number,
  now: number,
): boolean {
  if (!hold) return false;
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) return false;
  const age = Number(now) - publishedAt;
  if (age < 0) return true;
  return age <= HOLD_RESTORE_GRACE_MS;
}
