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
const { makeLeaderActions } = await import("../src/shared/popups/leader.ts");
const { leaderCategories, categoryHint, registerCategories, CATEGORY_TIMEOUT_MS } = await import(
  "../src/shared/popups/categories.ts"
);
const { armTabPosition } = await import("../src/shared/popups/leader.ts");

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

// The REAL plain-binding table, not a stub: the point of the shadowing rule is
// that it holds against the keymap we actually ship, so a category registered
// on a key that later gains a plain binding is caught here rather than in the
// browser.
const leaderBindings: Record<string, () => void> = makeLeaderActions(
  stubPopupCtx()
);

function stubPopupCtx(): any {
  const noop = () => {};
  const ops: any = new Proxy({}, { get: () => noop });
  return {
    ops,
    open: noop,
    close: noop,
    toast: noop,
    runAction: noop,
    bindings: () => Promise.resolve([]),
    armDigits: noop,
    manualText: false,
  };
}

// `hasBinding` is optional here so the older sequence tests can omit it; the
// shadowing tests pass the REAL table so the rule is proven against the
// keymap we ship.
function makeLeader(
  runs: string[],
  enabled: () => boolean = () => true,
  hasBinding?: (k: string) => boolean
): Ctl {
  return new LeaderController(
    (k) => runs.push(k),
    enabled,
    () => {},
    hasBinding
  ) as unknown as Ctl;
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


/* ---------- a category must NEVER shadow a plain binding ---------- */
//
// This is the ;G / ;L bug, and it is the reason the rule lives in the
// controller rather than in registration discipline. Those keys were briefly
// registered as two-key sequences so they "could never shadow" a plain binding,
// and the effect was the opposite: `;G` armed a silent capture, showed nothing,
// and on timeout fell through to a plain `G` action that did not exist. The
// which-key menu advertised `;G` the whole time.
//
// So the guarantee is enforced against the host's own binding table, which is
// the only thing that can answer "does a plain binding already exist here?".

{
  const fired: string[] = [];
  // `t` already has a plain binding (the tab switcher).
  leaderSequences["t"] = { final: { z: () => fired.push("z") }, timeoutMs: 50 };
  const plain: string[] = [];
  const l = makeLeader(plain, () => true, (k) => !!leaderBindings[k]);
  l.active = true;
  ok(
    "a key with BOTH a sequence and a plain binding runs the plain binding",
    l.handleKey(key("t")) === true
  );
  eq("the plain action ran", plain.join(","), "t");
  ok("no sequence capture was armed", l.hasPending() === false);
  eq("no sequence action fired", fired.join(","), "");
  delete leaderSequences["t"];
}

{
  // With no plain binding for the head, the same key DOES arm the category.
  // Both halves matter: a rule that always refuses the sequence would make
  // `;W` and `;Z` dead, which is the bug in the opposite direction.
  const fired: string[] = [];
  leaderSequences["W"] = { final: { "|": () => fired.push("split") }, timeoutMs: 50 };
  const l = makeLeader([], () => true, (k) => !!leaderBindings[k]);
  l.active = true;
  ok("a free key arms the category", l.handleKey(key("W")) === true);
  eq("the prefix records the category head", l.prefix, "W");
  ok("a one-shot capture is armed for the sub-key", l.hasPending() === true);
  ok("a registered sub-key is consumed", l.handlePending("|") === true);
  eq("the sub-key action fired", fired.join(","), "split");
  // Regression: a fired chord must END the leader. Leaving it armed meant the
  // next keystroke was swallowed as a leader key and the action the user
  // reached for never ran.
  ok("a fired chord disarms the leader", l.active === false);
  ok("and leaves no one-shot capture behind", l.hasPending() === false);
  delete leaderSequences["W"];
}

{
  // The held-leader exception: while `;` is physically down, a chord leaves
  // the leader standing so a second action costs one keystroke.
  const fired: string[] = [];
  leaderSequences["W"] = { final: { "|": () => fired.push("split") }, timeoutMs: 50 };
  const l = makeLeader([], () => true, (k) => !!leaderBindings[k]);
  l.active = true;
  l.sticky = true;
  l.handleKey(key("W"));
  l.handlePending("|");
  eq("the sub-key action still fired while held", fired.join(","), "split");
  ok("a HELD leader stays armed after a chord", l.active === true);
  l.sticky = false;
  delete leaderSequences["W"];
}

{
  // An unregistered sub-key must leave the leader ALONE. Yanking it here would
  // make the keystroke after a mistyped `;W x` do something unasked.
  leaderSequences["W"] = { final: { "|": () => {} }, timeoutMs: 50 };
  const l = makeLeader([], () => true, (k) => !!leaderBindings[k]);
  l.active = true;
  l.handleKey(key("W"));
  l.handlePending("q");
  ok("a mistyped sub-key leaves the leader armed", l.active === true);
  eq("and clears the prefix", l.prefix, "");
  delete leaderSequences["W"];
}

{
  // An unknown sub-key must consume NOTHING. A category that silently ate an
  // arbitrary keypress would make the next keystroke after `;W` unpredictable.
  leaderSequences["W"] = { final: { "|": () => {} }, timeoutMs: 50 };
  const plain: string[] = [];
  const l = makeLeader(plain, () => true, (k) => !!leaderBindings[k]);
  l.active = true;
  l.handleKey(key("W"));
  eq("an unregistered sub-key is not consumed", l.handlePending("q"), false);
  eq("and runs no plain action either", plain.join(","), "");
  delete leaderSequences["W"];
}

/* ---------- the SHIPPED categories, against the SHIPPED plain table ---------- */

{
  const cats = leaderCategories(stubPopupCtx());
  const heads = Object.keys(cats).sort();
  eq("the shipped categories are K, W and Z", heads.join(","), "K,W,Z");
  for (const h of heads) {
    // A category head that also has a plain binding is unreachable: the
    // controller's rule sends the key to the plain action and the category is
    // silently dead. Better caught here than as "the split shortcut stopped
    // working" a release later.
    ok(`;${h} does not collide with a plain binding`, !leaderBindings[h]);
    ok(`;${h} has a title`, !!cats[h].label);
  }

  // Every advertised sub-key must exist, and every real sub-key must be
  // advertised. The hints string is what the overlay renders, so a drift here
  // is a menu that lies.
  for (const h of heads) {
    const advertised = categoryHint(cats[h]).keys.split(" ").filter(Boolean);
    for (const s of advertised) {
      ok(`;${h} ${s} is a real sub-key`, !!cats[h].items.find((i) => i.key === s));
    }
    for (const s of cats[h].items) {
      ok(`;${h} ${s.key} appears in the hints`, advertised.includes(s.key));
      // The overlay labels each row from this table, so an unlabelled sub-key
      // is a row that renders as a bare key with nothing to say.
      ok(`;${h} ${s.key} has a label`, !!s.label);
    }
  }

  // `;L` was the obvious head for Links and is NOT available: it is a live
  // binding (the forward history stack) registered by the HOSTS, so it is not
  // in this shared action table at all. core/session_test.go pins that the
  // shipped table keeps Links on `;K` instead.

  // Sub-keys live inside a one-shot capture, so they cannot shadow anything at
  // top level — `;W m` coexisting with a top-level `m` is safe by
  // construction, and this pins that reading of the layout.
  ok("a split sub-key also exists at top level", !!leaderBindings["m"]);

  // The category capture must NOT expire. It used to be 1500ms, which is
  // shorter than reading eleven sub-keys takes: the menu painted, the keys
  // evaporated, and every keystroke after that went to the page. A category is
  // something you read, not a chord you fly through.
  eq("a category capture never expires on its own", CATEGORY_TIMEOUT_MS, 0);
}

/* ---------- a category head works in either case; other heads do not ---------- */
//
// `;w` is what a keyboard produces without Shift, and it used to do nothing at
// all. But the fix must NOT be a blanket case-insensitive lookup: `;G` is a
// sequence head, so matching either case everywhere would make `;g` — plain
// Back — arm that capture instead of going back. Both halves are pinned.

{
  registerCategories(stubPopupCtx());
  const plain: string[] = [];
  const l = makeLeader(plain, () => false, (k) => !!leaderBindings[k]);

  l.active = true;
  l.handleKey(key("w"));
  ok("lowercase ;w arms the category", l.prefix === "w");
  eq("and does not run a plain binding", plain.join(","), "");
  l.handlePending("Escape");

  // `;G` is NOT a category, so its capital is meaningful and `;g` stays Back.
  l.active = true;
  l.handleKey(key("g"));
  eq("lowercase ;g still runs plain Back", plain.join(","), "g");
  l.hide();

  delete leaderSequences["W"];
  delete leaderSequences["Z"];
  delete leaderSequences["K"];
}

/* ---------- `;W m` names a POSITION, and positions are now multi-digit ---------- */
//
// The split-move target used to take a bare single digit. The moment a window
// passed nine tabs the target it named no longer existed, so the feature went
// quietly unreachable with no error anywhere — the worst kind of failure,
// because nothing looked broken. It now resolves digits through the same
// planner `;1` uses, and these pin that it actually asks for the count.

{
  // A stub host whose digit capture is a real one-shot queue, so the test
  // exercises armTabPosition's own re-arming rather than a permissive stub.
  const applied: number[] = [];
  let capture: ((k: string) => boolean) | null = null;
  const ctx: any = {
    ops: { tabCount: async () => 12, splitAddTabByIndex: (n: number) => applied.push(n) },
    armDigits: (fn: any) => {
      capture = fn;
    },
  };
  armTabPosition(ctx, (n) => applied.push(n));
  const press = async (k: string) => {
    const fn = capture!;
    capture = null;
    fn(k);
    // The tab count resolves on a microtask; let it land before the next key.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  // Tab 3 in a twelve-tab window is a complete answer on one digit.
  await press("3");
  eq("one unambiguous digit resolves immediately", applied.join(","), "3");
  ok("the capture disarmed after resolving", capture === null);

  // Tab 11 needs two: "1" is ambiguous (1, 10, 11, 12), so the capture must
  // STAY armed rather than falling through to an unrelated binding.
  armTabPosition(ctx, (n) => applied.push(n));
  await press("1");
  eq("an ambiguous prefix resolves nothing yet", applied.join(","), "3");
  ok("the capture stays armed for the second digit", capture !== null);
  await press("1");
  eq("the second digit completes the position", applied.join(","), "3,11");
  ok("and then disarms", capture === null);
}

{
  // A non-digit must not be swallowed: the keystroke after `;W m` has to stay
  // predictable.
  const applied: number[] = [];
  let capture: ((k: string) => boolean) | null = null;
  const ctx: any = {
    ops: { tabCount: async () => 12 },
    armDigits: (fn: any) => {
      capture = fn;
    },
  };
  armTabPosition(ctx, (n) => applied.push(n));
  const fn = capture!;
  capture = null;
  eq("a letter is not consumed", fn("q"), false);
  eq("and runs no action", applied.join(","), "");
}

{
  // A leading zero cannot start a position, and must not be eaten.
  let capture: ((k: string) => boolean) | null = null;
  const ctx: any = {
    ops: { tabCount: async () => 12 },
    armDigits: (fn: any) => {
      capture = fn;
    },
  };
  armTabPosition(ctx, () => {});
  const fn = capture!;
  capture = null;
  eq("a leading zero is not consumed", fn("0"), false);
}

/* ---------- the capture's "what we need next" hint ---------- */
//
// The status bar's indicator shows what the armed capture wants, so this is
// not decoration: it is the only thing that tells the user a keystroke is
// about to be swallowed. These pin the four ways a capture can end, because a
// hint that outlives its capture is a hint to press a dead key.

{
  const l = makeLeader([]) as any;
  eq("a fresh controller expects nothing", l.pendingExpect, "");

  l.armPending(() => true, { timeoutMs: 1000, expect: "1-9" });
  eq("arming records what it wants", l.pendingExpect, "1-9");

  l.handlePending("3");
  eq("consuming the key clears the hint", l.pendingExpect, "");

  l.armPending(() => true, { timeoutMs: 1000, expect: "0 1 2" });
  l.cancelPending();
  eq("cancelling clears the hint", l.pendingExpect, "");

  let timedOut = false;
  l.armPending(() => true, {
    timeoutMs: 10,
    onTimeout: () => { timedOut = true; },
    expect: "1-9",
  });
  await new Promise((r) => setTimeout(r, 40));
  ok("an unused capture runs its timeout", timedOut);

  // `timeoutMs: 0` is the category rule: no expiry at all. The old 1500ms
  // was shorter than reading eleven sub-keys takes, so the menu painted, the
  // keys evaporated, and the keystroke after that went to the page — which is
  // what made `;W` feel broken rather than fast.
  let expired = false;
  l.armPending(() => true, { timeoutMs: 0, onTimeout: () => { expired = true; } });
  await new Promise((r) => setTimeout(r, 120));
  ok("a zero timeout never expires", expired === false);
  ok("and the capture is still armed", l.hasPending() === true);
  let took = false;
  ok("and still consumes its key", l.handlePending("|") === true);
  took = l.hasPending() === false;
  ok("and disarms once used", took);
  eq("a timed-out capture drops its hint", l.pendingExpect, "");
}

{
  // Re-arming is the ordinary case for a two-digit position, and the hint has
  // to narrow with the prefix rather than keep promising the first digit's
  // range — a bar that still said "1-9" after `;W m 1` would be describing a
  // state the user had already left.
  const armed: Array<{ fn: (k: string) => boolean; ms: number; expect?: string }> = [];
  const ctx: any = {
    ops: { tabCount: async () => 12 },
    armDigits: (fn: any, ms: number, expect?: string) => armed.push({ fn, ms, expect }),
  };
  armTabPosition(ctx, () => {});
  eq("the first arm asks for any first digit", armed[0]!.expect, "1-9");
  // `;W m 1` with twelve tabs: 1/10/11/12, so 0/1/2 continue and nothing else.
  armed[0]!.fn("1");
  // The count is fetched on first use, so the re-arm lands a microtask later.
  await new Promise((r) => setTimeout(r, 0));
  eq("the re-arm narrows to the live digits", armed[1]!.expect, "0 1 2");
  // `1` `1` is tab 11 — a jump, so no capture is left armed at all.
  eq("a resolved position arms nothing further", armed.length, 2);
}
console.log(`
${passed} checks passed.`);
