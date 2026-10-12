// shared/keyguard.ts — the one place that stops keys typed into a Lazyfox
// overlay from leaking to the page/browser behind it.
//
// The bug these pin: both tails of a consumed physical press must be swallowed,
// repeated keypress tails must remain owned during auto-repeat, and a missing
// keyup must not make the next physical press untypeable.
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
  test("both keypress and keyup tails of a consumed keydown are owned", () => {
    const g = new KeyGuard();
    g.consume(ev("j"));
    assert.equal(g.ownsTail({ ...ev("j"), type: "keypress" }), true);
    assert.equal(g.ownsTail({ ...ev("j"), type: "keyup" }), true);
  });

  test("keypress tails are owned until keyup closes the physical press", () => {
    const g = new KeyGuard();
    g.consume(ev("j"));
    assert.equal(g.ownsTail({ ...ev("j"), type: "keypress" }), true);
    assert.equal(g.ownsTail({ ...ev("j"), type: "keypress" }), true, "auto-repeat keypresses stay owned");
    assert.equal(g.ownsTail({ ...ev("j"), type: "keyup" }), true);
    assert.equal(g.ownsTail({ ...ev("j"), type: "keyup" }), false, "keyup closes the record");
  });

  test("a repeated keydown does not clear the original press record", () => {
    const g = new KeyGuard();
    g.consume(ev("j"));
    g.beginPress({ ...ev("j"), repeat: true });
    assert.equal(g.ownsTail({ ...ev("j"), type: "keypress" }), true);
    assert.equal(g.ownsTail({ ...ev("j"), type: "keyup" }), true);
  });
});

describe("a stale record can never swallow a legitimate press", () => {
  // The short-circuit regression: a tail is reconciled once and can never
  // swallow a later, legitimate press of the same key.
  test("a later ; typed into an input is not owned", () => {
    const g = new KeyGuard();
    g.consume(ev(";"));
    assert.equal(g.ownsTail({ ...ev(";"), type: "keyup" }), true, "the consumed ; keyup is owned");
    g.consume(ev(";"));
    g.beginPress(ev(";"));
    assert.equal(g.ownsTail({ ...ev(";"), type: "keypress" }), false, "but the user's next ; is not");
  });
});

describe("a consumed keydown has exactly one tail to reconcile", () => {
  // Auto-repeat keydowns are part of the same physical press. They must not
  // erase or duplicate the record: every repeated keypress is owned, then one
  // keyup closes it.
  test("auto-repeat keydowns preserve one record until keyup", () => {
    const g = new KeyGuard();
    g.consume(ev("x"));
    g.beginPress({ ...ev("x"), repeat: true });
    g.consume(ev("x"));
    assert.equal(g.ownsTail({ ...ev("x"), type: "keypress" }), true);
    assert.equal(g.ownsTail({ ...ev("x"), type: "keyup" }), true);
    assert.equal(g.ownsTail({ ...ev("x"), type: "keyup" }), false);
  });
});

describe("the same key with a different physical code is a different key", () => {
  test("a differing code is not the same key", () => {
    const g = new KeyGuard();
    g.consume(ev("Enter", "NumpadEnter"));
    assert.equal(g.ownsTail({ ...ev("Enter", "Enter"), type: "keyup" }), false);
  });

  test("a matching code is owned", () => {
    const g = new KeyGuard();
    g.consume(ev("Enter", "NumpadEnter"));
    assert.equal(g.ownsTail({ ...ev("Enter", "NumpadEnter"), type: "keyup" }), true);
  });

  test("a modifier change does not change physical-key ownership", () => {
    const g = new KeyGuard();
    g.consume(ev("!", "Digit1"));
    assert.equal(g.ownsTail({ ...ev("1", "Digit1"), type: "keypress" }), true);
    assert.equal(g.ownsTail({ ...ev("1", "Digit1"), type: "keyup" }), true);
  });

  test("events without a physical code still match by key", () => {
    const g = new KeyGuard();
    g.consume(ev("a"));
    assert.equal(g.ownsTail({ ...ev("a"), type: "keyup" }), true);
  });
});

describe("unconsumed keys are never owned", () => {
  test("an unconsumed keypress is not owned", () => {
    assert.equal(new KeyGuard().ownsTail({ ...ev("a"), type: "keypress" }), false);
  });
});

describe("only a key THIS handler consumed is recorded", () => {
  // The reported "I have to type some keys twice": Firefox inserts a character
  // on the keypress default action, so a record written for a keydown Lazyfox
  // never took swallows that character — and the shape that produces it is a
  // page (or another extension) preventing the keydown first, which the old
  // `if (e.defaultPrevented) consume(e)` could not tell apart from its own
  // preventDefault. See consumeIfNewlyPrevented.
  test("a key some other script had already prevented is not ours", () => {
    const g = new KeyGuard();
    g.consumeIfNewlyPrevented(ev("a"), true, true);
    assert.equal(g.ownsTail({ ...ev("a"), type: "keypress" }), false, "the character must still print");
    assert.equal(g.ownsTail({ ...ev("a"), type: "keyup" }), false);
  });

  test("a key this handler prevented IS ours", () => {
    const g = new KeyGuard();
    g.consumeIfNewlyPrevented(ev("a"), false, true);
    assert.equal(g.ownsTail({ ...ev("a"), type: "keypress" }), true);
    assert.equal(g.ownsTail({ ...ev("a"), type: "keyup" }), true);
  });

  test("a key nobody prevented is not ours", () => {
    const g = new KeyGuard();
    g.consumeIfNewlyPrevented(ev("a"), false, false);
    assert.equal(g.ownsTail({ ...ev("a"), type: "keyup" }), false);
  });
});

describe("clear() drops everything", () => {
  // Called when the window loses focus mid-key — the same "something happened
  // that I did not cause" moment the leader's blur release handles.
  test("clear drops pending tails", () => {
    const g = new KeyGuard();
    g.consume(ev("q"));
    g.clear();
    assert.equal(g.ownsTail({ ...ev("q"), type: "keyup" }), false);
  });
});

describe("the record set is bounded", () => {
  // A keydown whose keyup never arrives cannot grow the set without limit.
  test("recent keys are still tracked", () => {
    const g = new KeyGuard();
    for (let i = 0; i < 200; i++) g.consume(ev("k" + i));
    assert.equal(g.ownsTail({ ...ev("k199"), type: "keyup" }), true);
  });

  test("the oldest keys have fallen off", () => {
    const g = new KeyGuard();
    for (let i = 0; i < 200; i++) g.consume(ev("k" + i));
    assert.equal(g.ownsTail({ ...ev("k0"), type: "keyup" }), false);
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