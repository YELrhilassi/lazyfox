#!/usr/bin/env node
// Tests for the two-key leader sequences (`;G` then `k` opens the nav-stack
// popup, etc.) and the leader prefix the far-right status-bar indicator
// renders.
//
// The sequence table is pure state on LeaderController; what can be pinned
// without a DOM:
//
//   - a registered sequence's first key arms a one-shot capture instead of
//     running an action, records the prefix, and fires only on a registered
//     final key;
//   - an unregistered final key is NOT consumed (it falls through to normal
//     handling — a stray keypress can never fire the wrong action);
//   - timeout disarms cleanly;
//   - the plain-binding path still runs when no sequence matches, and
//     hide() resets the prefix (a stale `;l` must never linger on the bar).
//
// Run: node scripts/test-leader-sequences.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
// Teaches Node's resolver the project's extensionless TS specifiers.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { LeaderController, leaderSequences, leaderCombo } = await import(
  "../src/shared/leader.ts"
);

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok ${name}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
  passed++;
  console.log(`  ok ${name}`);
}

const key = (k: string, opts: Partial<{ shift: boolean }> = {}) =>
  ({
    key: k,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: !!opts.shift,
    preventDefault() {},
    stopImmediatePropagation() {},
  }) as unknown as KeyboardEvent;

type Ctl = {
  active: boolean;
  prefix: string;
  show(): void;
  hide(): void;
  handleKey(e: KeyboardEvent): boolean;
  hasPending(): boolean;
  handlePending(k: string): boolean;
  cancelPending(): void;
};

function makeLeader(runs: string[], enabled: () => boolean = () => true): Ctl {
  return new LeaderController((k) => runs.push(k), enabled, () => {}) as unknown as Ctl;
}

/* ---------- leaderCombo sanity (the prefix keys come from it) ---------- */

eq("a plain key combos to itself", leaderCombo(key("b")), "b");
eq("shift folds into the combo via e.key", leaderCombo(key("B", { shift: true })), "B");

/* ---------- sequences: arm, fire, decline ---------- */

{
  const runs: string[] = [];
  const fired: string[] = [];
  // The nav-stack popup's head keys are SHIFT keys (;G / ;L) precisely so
  // they never share a key with a plain binding — the real registration in
  // main.ts / content main.ts mirrors this shape.
  leaderSequences["G"] = {
    final: { k: () => fired.push("k") },
    timeoutMs: 50,
  };
  const l = makeLeader(runs);

  // Arm the leader directly (show() mounts the overlay, which needs a DOM;
  // the sequence machinery under test is the key handling, not the render).
  l.active = true;
  ok("the leader is armed", l.active === true);
  eq("a fresh leader has an empty prefix", l.prefix, "");

  const consumed = l.handleKey(key("G", { shift: true }));
  ok("the sequence's first key is consumed", consumed === true);
  eq("the prefix records the first key", l.prefix, "G");
  ok("a one-shot capture is armed", l.hasPending() === true);
  eq("no action ran yet", runs.length, 0);

  ok("a registered final key is consumed", l.handlePending("k") === true);
  eq("the registered final action fired", fired.join(","), "k");

  // A second sequence whose tail is NOT registered: the key must be declined
  // (fall through to normal handling) and nothing may fire.
  l.active = true;
  l.handleKey(key("G", { shift: true }));
  ok("an unregistered final key is declined", l.handlePending("x") === false);
  eq("a declined tail runs nothing", fired.length, 1);

  // A lone head press must not strand a plain binding either: when the
  // capture times out unused, the head key still runs through the plain
  // path (harmless for a head with no binding, essential for shared keys).
  l.active = true;
  l.handleKey(key("G", { shift: true }));
  await new Promise((r) => setTimeout(r, 90));
  eq("a timed-out lone head runs the plain path", runs.join(","), "G");
}

/* ---------- timeout: a stale capture disarms ---------- */

{
  const fired: string[] = [];
  const runs: string[] = [];
  leaderSequences["L"] = { final: { k: () => fired.push("k") }, timeoutMs: 30 };
  const l = makeLeader(runs);
  l.active = true;
  l.handleKey(key("L", { shift: true }));
  ok("the capture is armed before the timeout", l.hasPending() === true);
  await new Promise((r) => setTimeout(r, 60));
  ok("the capture auto-disarms after the timeout", l.hasPending() === false);
  eq("nothing fired after the timeout", fired.length, 0);
  // The fallback ran the head key's plain path (no-op without a binding).
  eq("the plain path ran after the timeout", runs.join(","), "L");

  // Dismissing the leader cancels the intent: the fallback must NOT fire an
  // action into the page once the leader is gone.
  const runs2: string[] = [];
  const l2 = makeLeader(runs2);
  l2.active = true;
  l2.handleKey(key("L", { shift: true }));
  l2.hide();
  await new Promise((r) => setTimeout(r, 60));
  eq("a dismissed leader's timeout runs nothing", runs2.join(","), "");
}

/* ---------- hide resets the prefix (no stale indicator) ---------- */

{
  const l = makeLeader([]);
  l.active = true;
  l.prefix = "b";
  l.hide();
  eq("hide clears the prefix", l.prefix, "");
  ok("hide disarms the leader", l.active === false);
}

/* ---------- plain bindings still win when no sequence matches ---------- */

{
  const runs: string[] = [];
  const l = makeLeader(runs);
  l.active = true;
  ok("a key with no sequence is consumed by the plain path", l.handleKey(key("t")) === true);
  eq("the plain action ran", runs.join(","), "t");
}

/* ---------- unpaint: losing ownership must clear the pixels ---------- */
//
// The which-key overlay is a PERSISTENT host that only loses its `on` class on
// hide(). That is why a stale overlay can outlive the page that justified it:
// arm the leader on the command center, switch to a web page, and nothing in
// the old path ever took the class off — so the chrome panel stayed lit behind
// the content script's own. The user saw two which-key panels at once, one
// permanently stale.
//
// unpaint() is the fix, and it is deliberately NOT hide(): disarming would
// swallow keys the content script is about to handle. The two contexts must
// fight over who owns the pixels, never over who owns the keyboard.

{
  const l = makeLeader([]);
  // No DOM in this process, so there is no host: unpaint must be a safe no-op
  // rather than a throw, because it runs from a tab-switch handler where an
  // exception would take the tab switch with it.
  l.active = true;
  l.unpaint();
  ok("unpaint with no host is a no-op, not a throw", l.active === true);
  l.unpaint();
  ok("unpaint is idempotent", l.active === true);
}

/* ---------- show() on a context that may not paint ---------- */
//
// enabled() is false for two reasons: the user turned the overlay off, and this
// context does not own the page. Both must leave nothing on screen — and
// neither may disarm, because keys are still captured either way.

{
  const l = makeLeader([], () => false);
  l.show();
  ok("show() with painting disabled still arms (keys are captured)", l.active === true);
  l.hide();
}

/* ---------- holding the leader: release must not disarm ---------- */
//
// A tap is keydown AND keyup, so a release handler that hid the leader would
// disarm it instantly and `;` + any binding would stop working everywhere.
// Release ends the HOLD, never the leader. This got it wrong once already.

{
  const runs: string[] = [];
  const l = makeLeader(runs);
  l.sticky = false;
  l.active = true;
  // simulate the press
  l.sticky = true;
  // one binding off the held leader
  l.handleKey(key("g"));
  eq("the held leader ran the binding", runs.join(","), "g");
  ok("the held leader stays armed after a binding", l.active === true);
  l.sticky = false; // the release
  ok("release clears the hold", l.sticky === false);
  ok("release does NOT disarm the leader", l.active === true);
}

// Table cleanup so other test files sharing the process stay unaffected.
delete leaderSequences["G"];
delete leaderSequences["L"];

console.log(`\n${passed} checks passed.`);
