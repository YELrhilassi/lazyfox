// The "last used tab" list behind `;a`, as pure arithmetic.
//
// WHY A LIST AND NOT A PAIR. `;a` was two fields per window — the tab that was
// active, and the one before it — which answers exactly one toggle and nothing
// else. Two things break that shape:
//
//   * a tab that CLOSES while it is the remembered partner leaves a dead id, so
//     the next `;a` is a silent no-op: the lookup throws, the entry is dropped,
//     and nothing is re-armed until the user happens to activate a tab again.
//     Nothing in the UI says the key stopped working.
//   * the pair is only right if EVERY activation was seen, so an activation
//     that happened while a session rebuild was in progress (`onActivated` is
//     deliberately suppressed then) or while the background was suspended
//     poisons it permanently.
//
// A most-recently-used list answers both honestly: the target is "the newest
// entry that is not the tab you are on", dead ids are simply absent, and
// `forgetTab` is a filter rather than a pile of special cases.

/** How many tabs back the toggle can reach. Bounded so a window that never
 *  stops switching cannot grow this without limit. */
export const ALT_MRU_MAX = 12;

/** Record an activation: the tab goes to the front, and appears once. */
export function noteActivation(mru: number[], tabId: number): number[] {
  if (tabId == null) return mru;
  const next = [tabId];
  for (const id of mru) {
    if (id !== tabId) next.push(id);
  }
  return next.slice(0, ALT_MRU_MAX);
}

/** Drop a tab, whatever position it holds. A no-op when it is absent. */
export function forgetTab(mru: number[], tabId: number): number[] {
  const next = mru.filter((id) => id !== tabId);
  return next.length === mru.length ? mru : next;
}

/**
 * The tab `;a` should switch to, or null when there is nowhere to go.
 *
 * The CURRENT tab is skipped rather than assumed absent. The list is fed by
 * activations and may lag the newest one — an activation the background has not
 * processed yet, or the very first one after a restart — so "the most recent
 * tab that is not this one" is the question that stays right either way. It is
 * also what makes the key a TOGGLE rather than a history walk: after the switch
 * the tab you left is the most recent, so pressing it again goes straight back.
 */
export function alternateTarget(mru: number[], current: number): number | null {
  for (const id of mru) {
    if (id !== current) return id;
  }
  return null;
}

/**
 * Fold an older list (one restored from storage) behind a newer one.
 *
 * First occurrence wins, so the result is `newer`'s order with only the entries
 * it lacks appended — recency is preserved whatever order the two lists arrived
 * in. This is what makes restoring the list independent of the startup race:
 * `primeActivation` and the storage read can land either way round, and neither
 * can put a tab ahead of one that was active more recently.
 */
export function mergeMru(newer: number[], older: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of newer.concat(older)) {
    // Tab ids are positive integers; anything else came from a corrupt or
    // older stored value and has no tab to point at.
    if (typeof id !== "number" || !isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= ALT_MRU_MAX) break;
  }
  return out;
}

/**
 * Every place `;a` could go, newest first.
 *
 * `alternateTarget` answers with ONE candidate, which is all a pure list can
 * answer — but a candidate is not necessarily a PLACE. Its tab may have closed,
 * or it may be plumbing (a relay page, the split-panel companion) that the user
 * was never really on. So the caller walks this list and checks each one, and
 * that is why the order is the list's order with the current tab removed rather
 * than a single answer.
 */
export function alternateCandidates(mru: number[], current: number): number[] {
  const out: number[] = [];
  for (const id of mru) {
    if (id !== current) out.push(id);
  }
  return out;
}
