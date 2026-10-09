// DEV-only trace of the home page's key path, mirrored onto <html>.
//
// The content script has had this from the start (`data-lf-lastkey`,
// `data-lf-active`, `data-lf-popup` — see content/main.ts) and the BiDi suite
// reads it. The command center, which now runs the SAME key engine a web page
// does, had nothing: a chord that did not take effect there left no trace at
// all. That made a whole class of failure unanswerable from the outside, because
// every mirror it does publish is transient by design — the toast clears itself
// after 1.4s and `lead-expect` when the capture is consumed. A test that reads
// them seconds later can only report silence, and silence reads identically
// whether the page refused the chord (and said why, too late to be read) or the
// keys never reached the page's leader.
//
// So this records the two things that separate those cases, with the newest
// value winning:
//
//   data-lf-keytrace  the last few keys the dispatcher SAW, each tagged with the
//                     state it arrived in (`;:cmd` = command mode, `a:ins` =
//                     typed into the search box) — so a chord that was typed as
//                     text instead of run is visible as such.
//   data-lf-lead-trace the last DECISION: an armed leader, an overlay that took
//                     the key, the action a leaf ran, or the chord that did not
//                     resolve.
//
// Both are plain attributes rather than log output because the reader is a
// program (scripts/e2e), not a human, and an attribute survives exactly as long
// as the page does. Guarded on `__DEV__` so a release build folds all of it away.

import { mirror } from "../../shared/observability";

// Long enough to hold a chord and the key before it, short enough that the
// attribute stays readable in a failure message.
const MAX_KEYS = 6;

const keys: string[] = [];

/** Record one key the dispatcher saw, tagged with the state it arrived in. */
export function traceKey(k: string, state: string, mods = ""): void {
  if (!__DEV__) return;
  keys.push(k + mods + ":" + state);
  if (keys.length > MAX_KEYS) keys.shift();
  mirror("keytrace", keys.join(" "));
}

/** Record what was decided about a key: the armed leader, the action it ran, or
 * the chord that did not resolve. NEWEST WINS — this is a "last thing that
 * happened" readout, not a log. */
export function traceDecision(s: string): void {
  if (!__DEV__) return;
  mirror("lead-trace", s);
}
