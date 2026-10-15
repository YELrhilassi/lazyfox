#!/usr/bin/env node
// Tests for the leader CONTROLLER: the armed state, the category grammar, the
// held-leader rule, and what happens to a chord the keymap does not know.
//
// The keymap itself — which chord means which action, and whether two chords
// collide — is tested in core/keymap_test.go and scripts/test/keymap.test.ts,
// because it is DATA now rather than a registry three hosts each mutate. What
// is left for this file is the state machine: what arms, what fires, what
// cancels, and what the controller does with a key it cannot resolve.
//
// The single most important assertion in here is the last suite. A key the
// leader declines used to be swallowed with no output, which is what made an
// unbound chord look like a key you had to press twice.

import { strict as assert } from "node:assert";
// Teaches Node's resolver the project's extensionless TS specifiers.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { LeaderController } = await import("../src/shared/leader.ts");
const { loadKeymap, specOf } = await import("../src/shared/keymap.ts");
const { makeLeaderActions, HOST_ACTIONS } = await import("../src/shared/popups/leader.ts");

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

// The keymap is fetched once at startup in the product. Here it is fetched
// explicitly, BEFORE any controller is built, because a controller buffers a
// chord that arrives before the table lands and this file is about the steady
// state.
await loadKeymap();

// `repeat` is the OS re-firing one press, and it is part of the dispatch
// decision rather than a detail of the transport — see the "a held key is
// reported once" case below.
const key = (
  k: string,
  mods: Partial<Record<"shift" | "ctrl" | "alt" | "meta", boolean>> & { repeat?: boolean } = {}
) =>
  ({
    key: k,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    repeat: !!mods.repeat,
    preventDefault() {},
    stopImmediatePropagation() {},
  }) as unknown as KeyboardEvent;

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

/** A controller that records the ACTION ids it runs, and the chords it misses. */
function makeLeader(opts: { enabled?: boolean } = {}) {
  const runs: string[] = [];
  const misses: string[] = [];
  const leader = new LeaderController(
    (action: string) => runs.push(action),
    () => opts.enabled !== false,
    () => {},
    (spec: string) => misses.push(spec)
  );
  return { leader, runs, misses };
}

/** Arm the leader the way a host does, without touching the DOM overlay. */
function arm(leader: any): any {
  leader.active = true;
  return leader;
}

/* ---------- a plain binding ---------- */

{
  const { leader, runs } = makeLeader();
  arm(leader);
  ok("a known chord is consumed", leader.handleKey(key("b")) === true);
  eq("and runs its action", runs.join(","), "bookmarks");
  ok("and disarms the leader", leader.active === false);
}

/* ---------- case and modifiers are real ---------- */

{
  const { leader, runs, misses } = makeLeader();
  // `;P` is the sessions popup. `;p` is a DIFFERENT chord and resolves to
  // nothing — it is not a second spelling of the same thing, which is the bug
  // this redesign was asked to end.
  arm(leader);
  leader.handleKey(key("P", { shift: true }));
  eq(";P runs sessions", runs.join(","), "sessions");

  arm(leader);
  leader.handleKey(key("p"));
  eq(";p runs nothing", runs.join(","), "sessions");
  eq("and says which chord it was", misses.join(","), "p");

  // A modified chord is not the plain one, and it is reported rather than
  // silently eaten.
  arm(leader);
  leader.handleKey(key("b", { ctrl: true }));
  eq(";Ctrl+b runs nothing", runs.join(","), "sessions");
  eq("and reports ctrl+b", misses.join(","), "p,ctrl+b");
}

/* ---------- a modifier on its own is not a chord ---------- */

{
  const { leader, runs } = makeLeader();
  arm(leader);
  // A real keyboard sends Shift BEFORE the character. Consuming that press is
  // what made a shifted binding feel like it needed pressing twice.
  eq("a bare Shift is not consumed", leader.handleKey(key("Shift", { shift: true })), false);
  eq("and runs nothing", runs.join(","), "");
  ok("and leaves the leader armed", leader.active === true);
  eq("the character after it still works", leader.handleKey(key("P", { shift: true })), true);
  eq("and runs the shifted binding", runs.join(","), "sessions");
}

/* ---------- a category: open, list, fire, end ---------- */

{
  const { leader, runs } = makeLeader();
  arm(leader);
  ok(";W is consumed", leader.handleKey(key("W", { shift: true })) === true);
  eq("and records the head as the prefix", leader.prefix, "W");
  ok("and arms a one-shot capture", leader.hasPending() === true);
  eq("and runs nothing by itself", runs.join(","), "");

  ok("a sub-key is consumed", leader.handlePending(key("|", { shift: true })) === true);
  eq("and runs its action", runs.join(","), "splitTab");
  ok("a fired chord ends the leader", leader.active === false);
  ok("and leaves no capture behind", leader.hasPending() === false);
  eq("and clears the prefix", leader.prefix, "");
}

{
  // The lowercase letter is not the head. This used to work by accident, via a
  // case-folding rule that applied to categories ONLY — so `;w` opened the
  // window menu while `;p` (which has a plain binding) did not open the
  // sessions menu. Inconsistent is worse than absent.
  const { leader, runs, misses } = makeLeader();
  arm(leader);
  leader.handleKey(key("w"));
  eq(";w is not the window category", runs.join(","), "");
  eq("and is reported as unknown", misses.join(","), "w");
  ok("and no category opened", leader.hasPending() === false);
}

/* ---------- a mistyped sub-key is reported, not swallowed ---------- */

{
  const { leader, runs, misses } = makeLeader();
  arm(leader);
  leader.handleKey(key("W", { shift: true }));
  ok("the category is open", leader.hasPending() === true);
  leader.handlePending(key("q"));
  eq("a sub-key that does not exist runs nothing", runs.join(","), "");
  eq("and is reported", misses.join(","), "q");
  ok("and the capture is spent", leader.hasPending() === false);
  ok("and the leader is disarmed, not left armed", leader.active === false);
}

/* ---------- a HELD key is reported once, not at the OS repeat rate ---------- */

{
  // The message names the chord the user pressed, so repeating it is
  // information-free — and a held key that misses is not a corner case: the
  // LEADER KEY itself is one, because an armed leader treats a second `;` as a
  // binding like any other key and `;` has no row of its own. Holding `;` used
  // to fire "no binding for ;;" ~30 times a second for as long as the key was
  // down, which is exactly the shape of "the leader looks unresponsive".
  // `;p` is the file's canonical MISS (a plain binding exists only as `;P`).
  const { leader, runs, misses } = makeLeader();
  arm(leader);
  ok("a repeat that names no binding is still consumed", leader.handleKey(key("p", { repeat: true })) === true);
  eq("but is not announced", misses.join(","), "");
  eq("and runs nothing", runs.join(","), "");

  // The first press is still announced: the fix must not silence misses.
  const b = makeLeader();
  arm(b.leader);
  b.leader.handleKey(key("p"));
  eq("a real miss is still reported", b.misses.join(","), "p");

  // And a held LEADER key, which is the common way to reach this path.
  const c = makeLeader();
  arm(c.leader);
  ok("a repeat of the leader key is consumed", c.leader.handleKey(key(";", { repeat: true })) === true);
  eq("and says nothing", c.misses.join(","), "");

  // Inside a category too: a held sub-key is one report, not thirty.
  const d = makeLeader();
  arm(d.leader);
  d.leader.handleKey(key("W", { shift: true }));
  ok("the menu is up", d.leader.hasPending() === true);
  d.leader.handlePending(key("q", { repeat: true }));
  eq("a held sub-key is not re-announced", d.misses.join(","), "");
}

/* ---------- a category capture never expires ---------- */

{
  const { leader, misses } = makeLeader();
  arm(leader);
  leader.handleKey(key("W", { shift: true }));
  await new Promise((r) => setTimeout(r, 150));
  ok("the category is still open after 150ms", leader.hasPending() === true);
  // The old timeout was 1500ms and it was shorter than reading a menu takes,
  // which is why sub-keys evaporated under the user's hand.
  leader.handlePending(key("u"));
}

/* ---------- the held leader: two actions, one press ---------- */

{
  const { leader, runs } = makeLeader();
  arm(leader);
  leader.sticky = true;
  leader.handleKey(key("g"));
  eq("the first action runs", runs.join(","), "back");
  ok("the leader stays armed", leader.active === true);
  leader.handleKey(key("l"));
  eq("the second action runs", runs.join(","), "back,forward");
  ok("and it is still armed", leader.active === true);
  leader.sticky = false;
  ok("releasing the key clears the hold", leader.sticky === false);
  ok("but must NOT disarm the leader", leader.active === true);
}

/* ---------- a held leader chains through a category too ---------- */

{
  const { leader, runs } = makeLeader();
  arm(leader);
  leader.sticky = true;
  leader.handleKey(key("Z", { shift: true }));
  ok("the category is open", leader.hasPending() === true);
  leader.handlePending(key("i"));
  eq("the sub-key action ran", runs.join(","), "zoomIn");
  ok("and the held leader survives the chord", leader.active === true);
  leader.handleKey(key("g"));
  eq("so the next action costs one keystroke", runs.join(","), "zoomIn,back");
}

/* ---------- a category ACTION publishes its own disarm ---------- */

// FOUND BY THE LONG SESSION SUITE (`scripts/e2e/suites/session`), which is the
// only test shape that can see it: after `;Z i` and `;Z r` the page's own mirror
// still said `data-lf-leader="1"`, and the chrome helper's cached signal still
// said `armed: true`, while the leader was demonstrably disarmed (the dispatch
// ring showed `armed 0→0` for the Escape that followed).
//
// The cause is an ORDERING the design deliberately has: a capture's handler runs
// BEFORE the capture disarms. A category sub-key that runs an action therefore
// hides the leader while its capture is still armed, so that hide publishes
// `armed: true` (the controller's signal is `active || capture.armed()`) — and
// the capture's own disarm used to say nothing at all, because the only thing it
// reported was a HINT change and a category's hint was already empty.
//
// So the assertion has to be about what was PUBLISHED, not about the state:
// `leader.signal()` computes the truth on demand and was always right, which is
// exactly why this shipped. Every host reads the last thing heard.
{
  const signals: boolean[] = [];
  const runs: string[] = [];
  const leader = new LeaderController(
    (action: string) => runs.push(action),
    () => true,
    () => signals.push(leader.signal().armed),
    () => {}
  );
  // Armed the way a host does it, without the DOM overlay (there is no document
  // in this process — see `arm` above).
  arm(leader);
  leader.handleKey(key("Z", { shift: true }));
  ok("the menu is open and published as armed", leader.signal().armed === true);
  leader.handlePending(key("i"));
  eq("the sub-key action ran", runs.join(","), "zoomIn");
  ok("the leader itself is disarmed", leader.active === false);
  ok("and nothing is armed any more", leader.signal().armed === false);
  eq(
    "the last thing PUBLISHED is the honest one (no Escape, no later key)",
    signals[signals.length - 1],
    false
  );
}

/* ---------- hide resets the readout ---------- */

{
  const { leader } = makeLeader();
  arm(leader);
  leader.prefix = "W";
  leader.hide();
  eq("hide clears the prefix", leader.prefix, "");
  ok("and disarms", leader.active === false);
}

/* ---------- unpaint / enabled: no DOM here, so these must be safe ---------- */

{
  const { leader } = makeLeader();
  arm(leader);
  leader.unpaint();
  ok("unpaint with no host is a no-op, not a throw", leader.active === true);
  leader.unpaint();
  ok("unpaint is idempotent", leader.active === true);
}

{
  const { leader } = makeLeader({ enabled: false });
  leader.show();
  ok("show() with painting disabled still arms — keys are still captured", leader.active === true);
  leader.hide();
}

/* ---------- every action the keymap names is implemented somewhere ---------- */

{
  // The chrome helper's four host actions are not in the shared table, so this
  // checks them the way the product does: shared table plus the documented
  // host list. An action in neither is a key that does nothing.
  const shared = Object.keys(makeLeaderActions(stubPopupCtx()));
  ok("the shared table is not empty", shared.length > 30);
  for (const h of HOST_ACTIONS) {
    ok(`host action ${h} is a name we can look for`, typeof h === "string" && h.length > 0);
  }
  // No action may be named by the keymap and by nothing.
  ok(
    "sessions is implemented",
    shared.includes("sessions")
  );
  ok(
    "the tab digits are all implemented",
    [1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => shared.includes("tabDigit" + n))
  );
}

/* ---------- `;W m` still names a POSITION, with multi-digit support ---------- */

{
  const { armTabPosition } = await import("../src/shared/popups/leader.ts");
  const { KEEP_ARMED } = await import("../src/shared/leadercapture.ts");
  const applied: number[] = [];
  // A FAITHFUL stand-in for LeaderCapture, and the fidelity is the point: the
  // handler is kept exactly when it answers KEEP_ARMED, the lease is what the
  // host hands back, and a lease can only act while ITS OWN generation is the
  // armed one — cancel() from a superseded lease is a no-op, exactly as
  // LeaderCapture.cancel(generation) is. Without that last part the test would
  // be modelling a capture that accepts cancellation from a previous arm, which
  // is the very race the block below exists to cover: the async count resolving
  // after the sequence had already been replaced or cancelled.
  let capture: ((e: { key: string }) => unknown) | null = null;
  let expect = "";
  let generation = 0;
  let countDelay = 0; // microtask hops before tabCount answers
  const disarm = (): void => {
    generation++;
    capture = null;
    expect = "";
  };
  const ctx: any = {
    ops: {
      tabCount: async () => {
        for (let i = 0; i < countDelay; i++) await Promise.resolve();
        return 12;
      },
      splitAddTabByIndex: (n: number) => applied.push(n),
    },
    armDigits: (fn: any, _ms: number, exp: string) => {
      const mine = ++generation;
      capture = fn;
      expect = exp;
      return {
        cancel: () => {
          if (mine !== generation) return;
          disarm();
        },
        retarget: (next: string) => {
          if (mine === generation) expect = next;
        },
        isActive: () => capture !== null && mine === generation,
      };
    },
  };
  const press = async (k: string) => {
    const fn = capture!;
    const res = fn({ key: k });
    if (res !== KEEP_ARMED) disarm();
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  armTabPosition(ctx, (n) => applied.push(n));
  await press("3");
  eq("one unambiguous digit resolves immediately", applied.join(","), "3");
  ok("and disarms", capture === null);

  armTabPosition(ctx, (n) => applied.push(n));
  await press("1");
  eq("an ambiguous prefix resolves nothing yet", applied.join(","), "3");
  ok("the capture stays armed for the second digit", capture !== null);
  await press("1");
  eq("the second digit completes the position", applied.join(","), "3,11");
  ok("and then disarms", capture === null);

  // THE RACE THE SEQUENCE USED TO LOSE.
  //
  // The tab count is a background round trip, so for a few milliseconds after
  // the first digit the sequence does not know whether it is finished. It used
  // to resolve the first digit through that await with the capture already
  // disarmed, so a second digit typed in the window was dispatched by the leader
  // as an unrelated binding — and then a capture was re-armed behind the user's
  // back, swallowing whatever key came next. Both halves are asserted here: the
  // digits accumulate into ONE position, and nothing is left armed.
  applied.length = 0;
  countDelay = 2; // make the count slow enough to race
  armTabPosition(ctx, (n) => applied.push(n));
  const racing = capture!;
  eq("a digit arriving while the count is in flight is consumed", racing({ key: "1" }), KEEP_ARMED);
  eq("and so is the next one", racing({ key: "1" }), KEEP_ARMED);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  eq("a position typed fast is never split into two chords", applied.join(","), "11");
  ok("and the sequence disarms itself once it resolves", capture === null);
  countDelay = 0;

  // A non-digit must be declined, not swallowed: the keystroke after `;W m`
  // has to stay predictable.
  armTabPosition(ctx, (n) => applied.push(n));
  const fn = capture!;
  capture = null;
  eq("a letter is not consumed", fn({ key: "q" }), false);
  eq("and runs no action", applied.join(","), "11");

  // A leading zero cannot start a position, and must not be eaten.
  armTabPosition(ctx, () => {});
  const fn2 = capture!;
  eq("a leading zero is not consumed", fn2({ key: "0" }), false);

  // A MODIFIED key is not a digit of a position, and declining it is what makes
  // the hosts' "the capture's answer is honoured" rule worth anything: `Ctrl+1`
  // is the session-marker hot-swap one layer out and `Alt+1` is the browser's
  // own tab switch, so answering either as "position 1" consumes a keystroke the
  // user aimed at something else. The digits themselves must keep working with
  // nothing held — that is the assertion pair below.
  applied.length = 0;
  armTabPosition(ctx, (n) => applied.push(n));
  const fn3 = capture!;
  eq("Ctrl+1 is not a position", fn3({ key: "1", ctrlKey: true }), false);
  eq("and runs no action", applied.join(","), "");
  armTabPosition(ctx, (n) => applied.push(n));
  const fn4 = capture!;
  eq("Alt+1 is not a position either", fn4({ key: "1", altKey: true }), false);
  armTabPosition(ctx, (n) => applied.push(n));
  const fn5 = capture!;
  eq("Meta+1 is not a position either", fn5({ key: "1", metaKey: true }), false);
  armTabPosition(ctx, (n) => applied.push(n));
  // Let the tab count land first, so the digits below are judged by a resolved
  // sequence rather than by the "count still in flight" branch.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const fn6 = capture!;
  eq("and a plain digit still is", fn6({ key: "1" }) !== false, true);
  // Still nothing APPLIED, and that is correct rather than a miss: with twelve
  // tabs `1` is a legal prefix of 10/11/12, so the sequence stays open and the
  // next digit decides. What this pair pins is that the modifier rule did not
  // turn the digits off with it.
  eq("and the sequence is still open", applied.join(","), "");
  eq("and its second digit completes it", fn6({ key: "2" }) !== false, true);
  eq("and that resolved to the position", applied.join(","), "12");
}

/* ---------- the capture's "what we need next" hint ---------- */

{
  const { leader } = makeLeader();
  eq("a fresh controller expects nothing", leader.pendingExpect, "");

  leader.armPending(() => true, { timeoutMs: 1000, expect: "1-9" });
  eq("arming records what it wants", leader.pendingExpect, "1-9");
  leader.handlePending({ key: "3" });
  eq("consuming the key clears the hint", leader.pendingExpect, "");
  leader.cancelPending();
  eq("cancelling clears the hint", leader.pendingExpect, "");

  let timedOut = false;
  leader.armPending(
    () => true,
    { timeoutMs: 10, onTimeout: () => { timedOut = true; }, expect: "1-9" }
  );
  await new Promise((r) => setTimeout(r, 40));
  ok("an unused capture runs its timeout", timedOut);

  // `timeoutMs: 0` is the category rule: no expiry at all.
  let expired = false;
  leader.armPending(() => true, { timeoutMs: 0, onTimeout: () => { expired = true; } });
  await new Promise((r) => setTimeout(r, 120));
  ok("a zero timeout never expires", expired === false);
  ok("and the capture is still armed", leader.hasPending() === true);
  ok("and still consumes its key", leader.handlePending({ key: "|" }) === true);
  ok("and disarms once used", leader.hasPending() === false);
}

/* ---------- a chord that beats the keymap is replayed, in order ---------- */

{
  const { resetKeymapForTest } = await import("../src/shared/keymap.ts");
  // The cold-start race in its real shape: a page whose table has not landed
  // yet. Every key of the chord arrives before it does, and a chord is more
  // than one key — so the whole thing has to come back, in order, with the
  // sub-key still belonging to the category its own head opened. A one-slot
  // buffer kept the last key and lost the head, and the chord then ran nothing.
  resetKeymapForTest();
  const { leader, runs, misses } = makeLeader();
  arm(leader);
  ok("the head is consumed while the table is missing", leader.handleKey(key("W", { shift: true })) === true);
  ok("and so is its sub-key", leader.handleKey(key("|", { shift: true })) === true);
  eq("nothing has run yet", runs.join(","), "");
  await loadKeymap();
  await new Promise((r) => setTimeout(r, 0));
  eq("the whole chord replays, in order", runs.join(","), "splitTab");
  eq("and no key of it is reported as unknown", misses.join(","), "");
  ok("and the leader is disarmed as usual", leader.active === false);

  // A cancelled chord must not come back to life when the table lands: the
  // user pressed Escape, and a replay seconds later would run the action they
  // backed out of with nothing on screen to explain it.
  resetKeymapForTest();
  const second = makeLeader();
  arm(second.leader);
  second.leader.handleKey(key("W", { shift: true }));
  second.leader.handleKey(key("Escape"));
  await loadKeymap();
  await new Promise((r) => setTimeout(r, 0));
  eq("a chord cancelled before the table landed runs nothing", second.runs.join(","), "");

  // And the table itself is back for every suite after this one.
  ok("the table is loaded again", (await import("../src/shared/keymap.ts")).keymapReady() === true);
}

/* ---------- specOf is the whole normalisation story ---------- */

{
  eq("a plain letter", specOf(key("a")), "a");
  eq("a shifted letter reported as a capital", specOf(key("A", { shift: true })), "shift+a");
  eq("a shifted letter reported as base+flag", specOf(key("a", { shift: true })), "shift+a");
  eq("a shifted letter reported as a capital with no flag", specOf(key("A")), "shift+a");
  eq("ctrl and shift", specOf(key("A", { ctrl: true })), "ctrl+shift+a");
  eq("modifier order is fixed", specOf(key("A", { meta: true, alt: true, shift: true, ctrl: true })), "ctrl+alt+shift+meta+a");
}

console.log(`\n${passed} checks passed.`);