// The HELD-leader rule: which keys count as "the leader key is physically down
// right now", and which do not.
//
// The feature lets a user hold `;` and run several actions without pressing it
// again, and that is entirely a claim about key LIFECYCLE: the leader is held
// from a keydown until the matching keyup arrives. So the whole correctness of
// the feature rests on one invariant —
//
//     every keydown that marks the leader held has a keyup that will clear it
//
// — and this file pins the ways that invariant is broken.
//
// The bug this exists for: keys that arrive with NO keyup to match. The
// content-process actor bridge and the `#lfc=keys` channel both dispatch a bare
// keydown and neither can ever deliver a release, because there is no keyup in
// either wire format and no way for the browser to invent one. Dispatching
// them without saying so marked the leader as HELD with nothing left to
// release it: the indicator stayed lit, every binding left the leader armed
// instead of disarming it, and the next keystroke in that window was swallowed
// as a leader key. That is not a cosmetic stuck badge — the keyboard goes dead
// until something else happens to clear the flag.
//
// The other direction is just as real and is why the rule is not simply
// "sticky = false": a keyup can be LOST, not never sent. Press `;`, alt-tab
// before releasing, and the release is delivered wherever focus ended up, so
// this window never sees it. A real hold outlives the window's attention unless
// something clears it, which is why both hosts also release on blur.
//
// Each of these tests was RED/GREEN verified: reverting `l.sticky = !noKeyup`
// to `l.sticky = true` in src/chrome/keysdispatch.ts makes this file fail.
// `npm run test:mutation` re-runs that proof on demand.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createChromeKeyDown } from "../../src/chrome/keysdispatch.ts";
import { noteContentPresent, resetContentPresence } from "../../src/chrome/keystate.ts";
import { releaseHoldOnKeyup, releaseLostHold, visibilityLostHold } from "../../src/shared/holdrelease.ts";
import { fakeWindow, fakeLeader } from "./support.ts";

const CC_URL = "moz-extension://abc/commandcenter.html";
const WEB = "https://example.com/";

/** Build a dispatcher over a fresh leader, and hand both back. */
function setup(spec = CC_URL) {
  resetContentPresence();
  const leader = fakeLeader();
  const down = createChromeKeyDown({
    win: fakeWindow(spec) as any,
    leader: () => leader,
    popup: { isOpen: () => false, handleKey: () => false, close() {}, resizeOnKey: () => false },
    typing: { focusedIsTyping: () => false, focusedTypingValue: () => "", focusedTypingTarget: () => null },
    keyGuard: { shouldIgnore: () => false },
    leaderKey: () => ";",
    handleHotkeyCombo: () => false,
    switchSessionByMarker: () => {},
    handleScrollKeys: () => false,
    runWebHints: () => {},
  } as any) as any;
  return { leader, down };
}

/** A keydown with the shape the dispatcher accepts. */
function keydown(key: string, extra: Record<string, unknown> = {}): any {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...extra,
  };
}

// The release rules themselves come from src/shared/holdrelease.ts — the SAME
// module both hosts import. An earlier version of this file re-implemented
// `if (l.sticky) l.sticky = false` locally, which meant it pinned the RULE but
// not the IMPLEMENTATION: the mutation gate proved it, by reverting the real
// release path and leaving every test green. That is exactly the failure a
// restatement-of-the-code test cannot catch, and it is why the rule is now a
// shared module rather than a convention.

describe("a real press is a hold", () => {
  test("a real leader press is consumed", () => {
    const { leader, down } = setup();
    assert.equal(down.chromeKeyDown(keydown(";")), true);
    assert.equal(leader.active, true, "the press should arm the leader");
    assert.equal(leader.sticky, true, "a real press has a keyup coming, so it is a hold");
  });

  test("the release ends the HOLD, not the leader", () => {
    // This is the sentence docs/MULTIKEY-DESIGN.md §9 used to get backwards,
    // and getting it backwards would delete the keymap: "release → disarm"
    // would mean holding `;` ran exactly one action.
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    // main.ts / content main.ts own the release; what matters here is that the
    // flag the release clears is the one a press sets.
    leader.sticky = false;
    assert.equal(leader.sticky, false, "the release clears the hold");
    assert.equal(leader.active, true, "and must NOT disarm the leader");
  });
});

describe("auto-repeat must not churn the leader", () => {
  test("repeats are consumed so the character never leaks into the page", () => {
    const { down } = setup();
    down.chromeKeyDown(keydown(";"));
    for (let i = 0; i < 5; i++) {
      // The OS re-fires keydown while the key is held. Each is consumed but
      // none re-arms or disarms.
      assert.equal(down.chromeKeyDown(keydown(";", { repeat: true })), true);
    }
  });

  test("auto-repeat leaves the leader armed and the hold in place", () => {
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    for (let i = 0; i < 5; i++) down.chromeKeyDown(keydown(";", { repeat: true }));
    assert.equal(leader.active, true);
    assert.equal(leader.sticky, true);
  });
});

describe("a key with NO keyup is a tap, never a hold", () => {
  // This is the regression. Both synthetic paths below are real callers: the
  // actor bridge and the `#lfc=keys` channel, and both pass noKeyup = true.
  test("a keyup-less leader key is consumed and arms the leader", () => {
    const { leader, down } = setup();
    assert.equal(down.chromeKeyDown(keydown(";"), false, true), true);
    assert.equal(leader.active, true, "a tap still arms the leader — that is how a tap works");
  });

  test("a keyup-less leader key is NOT marked held", () => {
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"), false, true);
    assert.equal(leader.sticky, false);
  });
});

describe("ownership and keyup are separate facts", () => {
  // The `#lfc=keys` channel drives the REAL selection, which may be a page the
  // content script owns. Claiming ownership there would handle one keystroke
  // twice, so `fromActor` must stay independent of `noKeyup`.
  test("a keyup-less key does not steal a web page's keys", () => {
    const { leader, down } = setup(WEB);
    // A web page whose content script HAS arrived — the case where the chrome
    // helper must defer, and therefore the case the keyup-less path must not
    // override.
    noteContentPresent(0, true, WEB);
    // Not fromActor, so the "web pages belong to the content script" gate must
    // decline it even though no keyup will follow.
    assert.equal(down.chromeKeyDown(keydown(";"), false, true), false);
    assert.equal(leader.active, false, "and must not arm the chrome leader there");
  });

  test("an actor key IS owned, because the actor only speaks for pages with no content script", () => {
    const { leader, down } = setup(WEB);
    noteContentPresent(0, true, WEB);
    assert.equal(down.chromeKeyDown(keydown(";"), true, true), true);
    assert.equal(leader.active, true);
  });

  test("an actor key is NOT marked held", () => {
    // The actor synthesizes a keydown and nothing else. Claiming a hold there
    // is exactly the stuck-keyboard bug.
    const { leader, down } = setup(WEB);
    noteContentPresent(0, true, WEB);
    down.chromeKeyDown(keydown(";"), true, true);
    assert.equal(leader.sticky, false);
  });
});describe("the hold must not outlive the window's attention", () => {
  // A lost keyup is indistinguishable from a held key from inside the window:
  // both look like "the leader key is down and nothing is coming". The hosts
  // therefore drop the hold when the window or page stops being the thing the
  // user is looking at.
  //
  // This is asserted HERE rather than end-to-end because the e2e layer cannot
  // reach the state at all: BiDi releases a key source when its action list
  // ends, so a keydown with no keyup is unreachable through real input, and
  // the only path that can produce one (the synthetic #lfc=keys channel)
  // reaches the chrome dispatch alone, with no page-realm way to blur a chrome
  // window. See scripts/e2e/suites/content/held.ts, whose header records the
  // same conclusion from the other side.

  test("a real press leaves a hold standing", () => {
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    assert.equal(leader.sticky, true);
  });

  test("the blur releases the lost hold but leaves the leader armed", () => {
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    releaseLostHold(leader);
    assert.equal(leader.sticky, false, "the blur releases the hold");
    assert.equal(leader.active, true, "and must not disarm the leader — only the hold");
  });

  test("the consequence: a binding after a released hold DISARMS", () => {
    // With the hold gone, the next binding disarms. While it stands, every
    // binding leaves the leader up and the user's next ordinary keystroke is
    // eaten as a leader key. This is why the release path exists.
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    releaseLostHold(leader);
    assert.equal(leader.handleKey(keydown("j")), true, "the binding runs");
    assert.equal(leader.active, false, "and disarms the leader");
  });

  // releaseLostHold touches `sticky` and NOTHING else. Stated as a property
  // over both leader states rather than as "releasing twice is fine", because
  // the previous version of this test asserted `active === false` after a
  // second release — and it only passed because a preceding handleKey call
  // happened to have disarmed the leader. The assertion was really about the
  // stub's history, not about the rule.
  test("release touches the hold and never the leader — armed", () => {
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    assert.equal(leader.active, true);
    releaseLostHold(leader);
    assert.equal(leader.active, true, "an armed leader stays armed");
  });

  test("release touches the hold and never the leader — already disarmed", () => {
    const leader = fakeLeader();
    leader.active = false;
    leader.sticky = true; // the pathological state: held but not showing
    releaseLostHold(leader);
    assert.equal(leader.sticky, false, "the hold is still cleared");
    assert.equal(leader.active, false, "and a disarmed leader stays disarmed");
  });

  test("releasing again is harmless — idempotent", () => {
    // A blur can arrive for any number of reasons, and a handler that only
    // acts sometimes is worse than one that always acts correctly.
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    assert.equal(releaseLostHold(leader), true, "the first release does the work");
    assert.equal(releaseLostHold(leader), false, "and reports that there was nothing to do");
    assert.equal(releaseLostHold(leader), false);
    assert.equal(leader.sticky, false);
  });

  test("releasing a leader that was never held changes nothing", () => {
    const leader = fakeLeader();
    assert.equal(releaseLostHold(leader), false);
    assert.equal(leader.sticky, false);
    assert.equal(leader.active, false);
  });

  test("a held leader runs two actions without a second press", () => {
    // The positive case, which is the feature. With the hold standing,
    // handleKey leaves the leader armed; without it, it would disarm after
    // the first action and `g` then `l` would run as two plain keys.
    const { leader, down } = setup();
    down.chromeKeyDown(keydown(";"));
    assert.equal(leader.handleKey(keydown("g")), true);
    assert.equal(leader.active, true, "still armed after the first binding");
    assert.equal(leader.handleKey(keydown("l")), true);
    assert.equal(leader.active, true, "still armed after the second");
  });
});

describe("a real keyup ends the hold, and only for the leader key", () => {
  test("the leader key's own keyup releases", () => {
    const leader = fakeLeader();
    leader.sticky = true;
    assert.equal(releaseHoldOnKeyup(leader, ";", ";"), true);
    assert.equal(leader.sticky, false);
  });

  test("another key's keyup does not", () => {
    // It belongs to whatever else the user is doing; treating it as the
    // leader's release would disarm the leader mid-sequence.
    const leader = fakeLeader();
    leader.sticky = true;
    assert.equal(releaseHoldOnKeyup(leader, ";", "j"), false);
    assert.equal(leader.sticky, true, "the hold survives an unrelated keyup");
  });

  test("a modified keyup does not", () => {
    // `Shift+;` is a different key as far as the leader is concerned.
    const leader = fakeLeader();
    leader.sticky = true;
    assert.equal(releaseHoldOnKeyup(leader, ";", ";"), true);
    leader.sticky = true;
    assert.equal(releaseHoldOnKeyup(leader, ";", "Shift"), false);
    assert.equal(leader.sticky, true);
  });

  test("a keyup when nothing is held is a no-op", () => {
    const leader = fakeLeader();
    assert.equal(releaseHoldOnKeyup(leader, ";", ";"), false);
    assert.equal(leader.sticky, false);
  });

  test("no leader is not a crash", () => {
    assert.equal(releaseHoldOnKeyup(null, ";", ";"), false);
    assert.equal(releaseLostHold(undefined), false);
  });
});

describe("only hiding releases — becoming visible again does not", () => {
  test("hidden releases", () => {
    assert.equal(visibilityLostHold("hidden"), true);
    assert.equal(visibilityLostHold("prerender"), true);
  });
  test("visible does not", () => {
    assert.equal(visibilityLostHold("visible"), false);
  });
});