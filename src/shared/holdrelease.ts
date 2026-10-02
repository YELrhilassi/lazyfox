// Releasing a HELD leader key.
//
// "Held" is a claim about a key's LIFECYCLE, not about timing: the leader is
// held from a keydown until the matching keyup arrives. Two things end that
// claim, and they are not the same thing:
//
//   1. The real keyup. The user let go.
//   2. Losing the hold. A keyup can be LOST rather than never sent — press `;`,
//      alt-tab before releasing, and the release is delivered wherever focus
//      ended up. The window that pressed it never sees it.
//
// Without (2), a genuine hold outlives the window's attention and the user
// comes back to a lit indicator, a leader that never disarms, and a keyboard
// whose next keystrokes are eaten as bindings.
//
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
//
// Both properties below touch `sticky` and nothing else. Releasing a hold must
// never disarm the leader: a held leader that stays armed is the feature, and
// one that disarms on release would run exactly one action.

/** The minimum a leader has to be for these rules to apply. */
export interface ReleasableLeader {
  /** True while a keyup for the leader key is still outstanding. */
  sticky?: boolean;
  /** True while the leader is armed (showing its overlay / awaiting a key). */
  active?: boolean;
}

/**
 * End the hold on a real keyup — and only for the leader key.
 *
 * Returns true when a hold was actually released, so a caller can log or count
 * it. Any other key's keyup is ignored: it belongs to whatever else the user
 * is doing, and treating it as the leader's release would disarm the leader
 * mid-sequence.
 */
export function releaseHoldOnKeyup(
  leader: ReleasableLeader | null | undefined,
  leaderKey: string,
  key: string,
): boolean {
  if (!leader) return false;
  if (key !== leaderKey) return false;
  if (!leader.sticky) return false;
  leader.sticky = false;
  return true;
}

/**
 * End a hold whose keyup was LOST, because the window or page stopped being
 * the thing the user is looking at.
 *
 * Idempotent and cheap — it is wired to `blur` and to every
 * `visibilitychange`, so it runs often — and a no-op unless a hold is actually
 * outstanding, so it cannot disturb a leader that was never held.
 *
 * Returns true when a hold was actually released.
 */
export function releaseLostHold(leader: ReleasableLeader | null | undefined): boolean {
  if (!leader) return false;
  if (!leader.sticky) return false;
  leader.sticky = false;
  return true;
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