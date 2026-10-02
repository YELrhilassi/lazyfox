// shared/keyguard.ts — the one place that stops keys typed into a Lazyfox
// overlay from leaking to the page/browser behind it.
//
// The bug these pin: a consumed keydown's keypress/keyup tail must be
// swallowed, but only ONCE. An implementation that short-circuits past
// ownsTail() (or makes it non-consuming) leaves a stale record that later
// swallows a legitimate press of the same key while the user is typing — which
// broke `;` in a text field.
//
// Each of the eight concerns below was previously a bare `{ … }` block of
// `ok()` calls, where the first failure hid the rest. They are now independent
// tests, each constructing its own guard — so no test can be affected by what
// an earlier one did to shared state, which is the same class of fix applied
// to the e2e suite's shared fixture.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { KeyGuard, backdropWheel } from "../../src/shared/keyguard.ts";

const ev = (key: string, code?: string): { key: string; code?: string } =>
  code === undefined ? { key } : { key, code };

describe("the tail of a consumed key is owned exactly once", () => {
  test("the first keypress/keyup after a consumed keydown is owned", () => {
    const g = new KeyGuard();
    g.consume(ev("j"));
    assert.equal(g.ownsTail(ev("j")), true);
  });

  test("the same tail is not owned twice", () => {
    const g = new KeyGuard();
    g.consume(ev("j"));
    g.ownsTail(ev("j"));
    assert.equal(g.ownsTail(ev("j")), false, "a second claim must find nothing");
  });
});

describe("a stale record can never swallow a legitimate press", () => {
  // The short-circuit regression: a tail is reconciled once and can never
  // swallow a later, legitimate press of the same key.
  test("a later ; typed into an input is not owned", () => {
    const g = new KeyGuard();
    g.consume(ev(";"));
    assert.equal(g.ownsTail(ev(";")), true, "the consumed ; tail is owned");
    assert.equal(g.ownsTail(ev(";")), false, "but the user's own ; is not");
  });
});

describe("a consumed keydown has exactly one tail to reconcile", () => {
  // Firefox does not fire keypress for a preventDefaulted keydown, so in
  // practice the record is spent by the keyup; duplicate records for the same
  // key collapse instead of growing (a double-tap's second tail is covered by
  // the overlay still being up).
  test("duplicate records collapse, nothing left over", () => {
    const g = new KeyGuard();
    g.consume(ev("x"));
    g.consume(ev("x"));
    assert.equal(g.ownsTail(ev("x")), true, "one tail owned for a repeated key");
    assert.equal(g.ownsTail(ev("x")), false, "and nothing beyond it");
  });
});

describe("the same key with a different physical code is a different key", () => {
  test("a differing code is not the same key", () => {
    const g = new KeyGuard();
    g.consume(ev("Enter", "NumpadEnter"));
    assert.equal(g.ownsTail(ev("Enter", "Enter")), false);
  });

  test("a matching code is owned", () => {
    const g = new KeyGuard();
    g.consume(ev("Enter", "NumpadEnter"));
    assert.equal(g.ownsTail(ev("Enter", "NumpadEnter")), true);
  });
});

describe("unconsumed keys are never owned", () => {
  test("an unconsumed keypress is not owned", () => {
    assert.equal(new KeyGuard().ownsTail(ev("a")), false);
  });
});

describe("clear() drops everything", () => {
  // Called when the window loses focus mid-key — the same "something happened
  // that I did not cause" moment the leader's blur release handles.
  test("clear drops pending tails", () => {
    const g = new KeyGuard();
    g.consume(ev("q"));
    g.clear();
    assert.equal(g.ownsTail(ev("q")), false);
  });
});

describe("the record set is bounded", () => {
  // A keydown whose keyup never arrives cannot grow the set without limit.
  test("recent keys are still tracked", () => {
    const g = new KeyGuard();
    for (let i = 0; i < 200; i++) g.consume(ev("k" + i));
    assert.equal(g.ownsTail(ev("k199")), true);
  });

  test("the oldest keys have fallen off", () => {
    const g = new KeyGuard();
    for (let i = 0; i < 200; i++) g.consume(ev("k" + i));
    assert.equal(g.ownsTail(ev("k0")), false);
  });
});

describe("only a wheel on the overlay backdrop is swallowed", () => {
  // backdropWheel is an IDENTITY check (`target === backdrop`), not a
  // structural one. That distinction is the whole point: the popup holds one
  // reference to its own backdrop element, and "is this wheel on me" is
  // answered by whether the event's target IS that element. Two structurally
  // identical objects are therefore NOT the backdrop, and the test below pins
  // that so a refactor to a `kind` comparison is caught rather than assumed
  // harmless.
  const backdrop = { kind: "backdrop" } as unknown;

  test("wheel on the backdrop itself is swallowed", () => {
    assert.equal(backdropWheel(backdrop, backdrop), true);
  });

  test("wheel inside the panel is left alone", () => {
    assert.equal(backdropWheel({ kind: "panel" }, backdrop), false);
  });

  test("a structurally identical but distinct object is not the backdrop", () => {
    assert.equal(backdropWheel({ kind: "backdrop" }, backdrop), false);
  });

  test("wheel with no target is left alone", () => {
    assert.equal(backdropWheel(null, backdrop), false);
  });

  test("a missing backdrop swallows nothing", () => {
    assert.equal(backdropWheel(backdrop, null), false);
    assert.equal(backdropWheel(null, null), true, "except the degenerate both-null case");
  });
});