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
