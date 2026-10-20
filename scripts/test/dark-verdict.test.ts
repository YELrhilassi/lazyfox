// What the window bar is told about dark mode, and when.
//
// Two rules live in dark/verdict.ts, and this file is where both are pinned
// without a browser:
//
//   * the MAPPING. The bar shows `native` both for a page wearing the site's own
//     theme and for one we stood down from because it was already dark — and
//     that second case is visible only in the decision's reason. It is a string
//     match on purpose, so it lives in one place with a test, rather than in a
//     message callback where a stray edit changes what the user reads.
//   * the LATCH. MEASURED in a real Firefox on a quiet page: ~22 verdicts a
//     second, every one of them identical, every one a content -> background ->
//     relay -> helper round trip. A pass is not news; a changed verdict is.
//
// The near-miss in the mapping is here too: `shouldApply` reports a forced paint
// as "forced on (already-dark pages included)" — a HYPHEN, and a page we are
// actively darkening. Reading that as a stand-down would label our own theme
// "site", so the regex's requirement of a space is asserted rather than assumed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { barVerdict, createVerdictLatch, verdictKey } from "../../src/extension/content/dark/verdict.ts";

const state = (over: Partial<{ on: boolean; mode: string; engine: string; reason: string }> = {}) => ({
  on: true,
  mode: "auto",
  engine: "dynamic",
  reason: "light page → dark · dynamic engine",
  ...over,
});

describe("the verdict the bar renders", () => {
  test("a theme of ours is passed through as it is decided", () => {
    assert.deepEqual(barVerdict(state()), { on: true, mode: "auto", engine: "dynamic" });
    assert.deepEqual(barVerdict(state({ engine: "filter" })), { on: true, mode: "auto", engine: "filter" });
    assert.deepEqual(barVerdict(state({ on: false, mode: "off", engine: "auto" })), {
      on: false,
      mode: "off",
      engine: "auto",
    });
  });

  test("the site's own theme is native", () => {
    const v = barVerdict(state({ on: false, engine: "native", reason: "the site's own dark theme (color-scheme)" }));
    assert.equal(v.engine, "native");
    assert.equal(v.on, false, "nothing of ours is painting");
    assert.equal(v.mode, "auto", "and the mode that asked for it is still reported");
  });

  test("standing down because the page is ALREADY dark is the site's theme too", () => {
    // Nothing of ours is installed on such a page, so the only honest label is
    // the site's. The engine field itself is `auto` here — the reason is the
    // whole signal.
    const v = barVerdict(state({ on: false, engine: "auto", reason: "the page is already dark" }));
    assert.equal(v.engine, "native");
    assert.equal(v.on, false);
  });

  test("a HYPHENATED already-dark is the opposite: our paint, not the site's", () => {
    // `shouldApply`'s "forced on (already-dark pages included)" is a page we are
    // darkening. Mapping it to native would relabel our own theme as the site's
    // — and it is one character away from the stand-down phrase above.
    const v = barVerdict(state({ on: true, engine: "dynamic", reason: "forced on (already-dark pages included) · dynamic engine" }));
    assert.equal(v.engine, "dynamic");
  });

  test("the mapping does not touch the state it is given", () => {
    const s = state({ engine: "native" });
    barVerdict(s);
    assert.equal(s.engine, "native");
  });
});

describe("the verdict key", () => {
  test("every field the segment reads is part of it", () => {
    assert.notEqual(verdictKey({ on: true, mode: "auto", engine: "dynamic" }), verdictKey({ on: false, mode: "auto", engine: "dynamic" }));
    assert.notEqual(verdictKey({ on: true, mode: "auto", engine: "dynamic" }), verdictKey({ on: true, mode: "light", engine: "dynamic" }));
    assert.notEqual(verdictKey({ on: true, mode: "auto", engine: "dynamic" }), verdictKey({ on: true, mode: "auto", engine: "filter" }));
    assert.equal(verdictKey({ on: true, mode: "auto", engine: "dynamic" }), verdictKey({ on: true, mode: "auto", engine: "dynamic" }));
  });
});

describe("the publish latch", () => {
  test("the first verdict is published", () => {
    const latch = createVerdictLatch();
    assert.equal(latch.send({ on: true, mode: "auto", engine: "dynamic" }), true);
  });

  test("the same verdict again is not news, however often it is decided", () => {
    // The measured case: a pass every 60ms reporting the same three values.
    const latch = createVerdictLatch();
    const v = { on: true, mode: "auto", engine: "dynamic" };
    assert.equal(latch.send(v), true);
    for (let i = 0; i < 50; i++) assert.equal(latch.send({ ...v }), false);
  });

  test("a change in ANY of the three fields is published", () => {
    const latch = createVerdictLatch();
    assert.equal(latch.send({ on: true, mode: "auto", engine: "dynamic" }), true);
    assert.equal(latch.send({ on: true, mode: "auto", engine: "filter" }), true);
    assert.equal(latch.send({ on: true, mode: "light", engine: "filter" }), true);
    assert.equal(latch.send({ on: false, mode: "light", engine: "filter" }), true);
    assert.equal(latch.send({ on: false, mode: "light", engine: "filter" }), false, "and settles again");
  });

  test("returning to an earlier verdict IS published", () => {
    // A page that goes dark -> off -> dark has changed twice, and the bar has to
    // hear about both: the latch compares against the last thing SENT, not the
    // set of things ever sent.
    const latch = createVerdictLatch();
    const dark = { on: true, mode: "auto", engine: "dynamic" };
    const off = { on: false, mode: "off", engine: "auto" };
    assert.equal(latch.send(dark), true);
    assert.equal(latch.send(off), true);
    assert.equal(latch.send(dark), true);
  });

  test("reset re-asserts: the next verdict is published even if it repeats", () => {
    // For the events that may have removed the surface — a config write re-decides
    // every page at once, and follows a helper restart.
    const latch = createVerdictLatch();
    const v = { on: true, mode: "auto", engine: "dynamic" };
    assert.equal(latch.send(v), true);
    assert.equal(latch.send(v), false);
    latch.reset();
    assert.equal(latch.send(v), true);
    assert.equal(latch.send(v), false, "and the latch is armed again");
  });
});
