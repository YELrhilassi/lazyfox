// The cache policy's DECISIONS, separate from the background plumbing that
// carries them out.
//
// Split out of cache.ts for the same reason `chrome/actorscroll.ts` was split
// out of its composition root: this is the only part of the feature with a
// judgement in it, cache.ts cannot be imported outside a browser (it reads
// `browser.tabs` and `browser.browserSettings`), and a judgement no test can
// reach is a judgement that gets made wrong. Everything in here is pure.
//
// The two decisions, and why each is written down:
//
//   1. WHAT THE BROWSER-WIDE SWITCH MUST BE. `browserSettings.cacheEnabled` is
//      one boolean for the whole browser and it OUTLIVES the policy that set it.
//      Setting it only for the `global` scope meant a user who tried "no cached
//      copies everywhere" and then settled on "this tab only" had turned the
//      cache off for everything and been told the opposite.
//   2. WHAT THE PANEL SAYS. The note used to be built from the stored record
//      alone, so it described the policy the user chose rather than the state
//      the browser is in. It takes the switch's real value and reports every way
//      the two disagree.

import type { CacheMode, CacheScope } from "../shared/types";

/**
 * What the browser-wide cache switch must be set to for a policy.
 *
 * The switch is the GLOBAL scope's mechanism and the only part of the feature
 * that leaks outside its scope: `browserSettings.cacheEnabled` is one boolean
 * for the whole browser, with no per-tab knob. So it is set from the policy's
 * scope every time a policy is applied, and NOT only when the scope is `global`.
 *
 * Otherwise a user who tries "Everywhere · no cached copies" and then settles on
 * "This tab only · Firefox default" has turned the cache off for the entire
 * browser and been told the opposite: the narrow scopes are enforced by the
 * chrome helper, so nothing else would ever turn the global switch back on, and
 * the panel's own "In force" row would describe a state the browser is not in.
 * A narrow policy means "these tabs, and the rest of the browser behaves
 * normally", which is exactly this value.
 */
export function globalSwitchFor(scope: CacheScope, mode: CacheMode): boolean {
  return !(scope === "global" && mode === "off");
}

// The base sentence for a policy: what it does, and where.
//
// The scope is named in EVERY sentence, including "normal". It used to be
// dropped for that mode, on the theory that "Firefox's default cache behaviour"
// is the same everywhere — but the sentence sits in the panel under a scope
// selector, and "the default" for a per-tab policy is a statement about those
// tabs, not about the browser. A summary that has to be read next to a control
// to be unambiguous is not a summary.
function scopeSentence(scope: CacheScope, mode: CacheMode): string {
  const where = scope === "global" ? "Everywhere" : scope === "session" ? "This session's tabs" : "This tab only";
  if (mode === "normal") return where + ": Firefox's default cache behaviour.";
  const what = mode === "off" ? "no cached copies (every request hits the network)" : "revalidate every load";
  return where + ": " + what + ".";
}

/**
 * The sentence the panel shows under the policy: what is in force, plus every
 * way the browser is NOT doing what the policy record says.
 *
 * Pure, and takes the facts as arguments, for the same reason `actorScroll` does:
 * this is the only part of the feature with a decision in it, and the whole point
 * of the decision is that the panel must not describe a policy as in force when
 * something outside it (a switch left off by an earlier choice, another add-on, a
 * missing helper) has the last word. Each sentence below is the honest answer to
 * "what would surprise the user about the state I am about to describe".
 */
export function cacheNote(
  scope: CacheScope,
  mode: CacheMode,
  facts: { globalOn: boolean | null; chromeAlive: boolean },
): string {
  let note = scopeSentence(scope, mode);
  // The one mode the background cannot enforce alone: "fresh everywhere" needs
  // the helper's revalidate pref, so say it is not live instead of implying it.
  if (scope === "global" && mode === "fresh" && !facts.chromeAlive) {
    note += " (Needs the Lazyfox window chrome to actually revalidate — install it, then apply again.)";
  }
  // ONE rule for the switch, in both directions, because the mismatch is the
  // same fact either way: the browser-wide setting is not where this policy
  // wants it, so something other than this policy has the last word. A narrow
  // policy with the switch off is the more surprising of the two (nothing on the
  // machine is using a cache, not just the tabs named above) so it says what to
  // do about it; a global policy whose own switch did not move says who else
  // could have moved it.
  const wants = globalSwitchFor(scope, mode);
  if (facts.globalOn !== null && facts.globalOn !== wants) {
    note +=
      scope === "global"
        ? wants
          ? " Firefox's cache switch is still OFF — this build refused to turn it back on."
          : " Firefox's cache switch is ON — the policy is not in force (another add-on may have changed it)."
        : " Firefox's own cache switch is OFF as well (an earlier global policy, or another add-on), so this applies to every tab until a global policy is applied.";
  }
  return note;
}
