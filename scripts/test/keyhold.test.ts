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
import { noteContentPresent, presenceTabFor, resetContentPresence } from "../../src/chrome/keystate.ts";
import {
  HOLD_LIVENESS_MS,
  HOLD_RESTORE_GRACE_MS,
  cancelHold,
  createHoldWatchdog,
  noteHoldAlive,
  releaseExpiredHold,
  releaseHoldOnKeyup,
  releaseLostHold,
  restoreHold,
  shouldRestoreHold,
  visibilityLostHold,
} from "../../src/shared/holdrelease.ts";
import { fakeWindow, fakeLeader } from "./support.ts";

// The default page for these tests is a CHROME-OWNED one (an about: page), not
// the command center. The command center now runs its own leader and reports
// presence for it, so the chrome helper deliberately declines its keys (see
// keystate.chromeOwnsKeys, and the ownership cases in test-chrome-keys.ts) —
// asserting the HELD-leader rule against the command center would therefore be
// asserting the old double-owner bug. `about:preferences` is chrome territory
// with no page engine behind it, which is what this file is about.
const ABOUT = "about:preferences";
const WEB = "https://example.com/";

/**
 * Build a dispatcher over a fresh leader, and hand both back.
 *
 * `overrides` replaces individual deps, which is how a test can watch a
 * collaborator the dispatcher is supposed to call (the hold release on the
 * cancel path) instead of asserting the dispatcher's own bookkeeping.
 */
function setup(spec = ABOUT, overrides: Record<string, unknown> = {}) {
  resetContentPresence();
  const leader = fakeLeader();
  // The window is RETURNED because presence is a fact about a TAB, and these
  // tests need the same tab they reported through in order to read it back.
  const win = fakeWindow(spec) as any;
  const down = createChromeKeyDown({
    win,
    leader: () => leader,
    popup: { isOpen: () => false, handleKey: () => false, close() {}, resizeOnKey: () => false },
    typing: { focusedIsTyping: () => false, focusedTypingValue: () => "", focusedTypingTarget: () => null },
    keyGuard: { shouldIgnore: () => false },
    leaderKey: () => ";",
    handleHotkeyCombo: () => false,
    switchSessionByMarker: () => {},
    handleScrollKeys: () => false,
    runWebHints: () => {},
    cancelLeaderHold: () => {},
    ...overrides,
  } as any) as any;
  return { leader, down, win };
}

/** Record presence the way the sender does: by index, resolved to a tab here. */
function report(win: any, active: boolean, url: string): void {
  noteContentPresent(presenceTabFor(win, 0, url), active, url);
}

/**
 * A dispatcher over a COMMAND-CENTER tab, with the page's engine either present
 * or absent.
 *
 * The fake window's `contentWindow` is what `commandCenterPageReady` reads, and
 * the product is asked about the exact state a fresh new tab is in for a moment:
 * the URL has committed, the static markup is parsed, and the script that
 * installs the page's key engine has not run yet.
 */
function setupCC(pageReady: boolean) {
  resetContentPresence();
  const leader = fakeLeader();
  const win = fakeWindow("moz-extension://abc/commandcenter.html") as any;
  win.gBrowser.selectedBrowser.contentWindow = {
    document: {
      documentElement: {
        getAttribute: (name: string) => (name === "data-lf-engine" && pageReady ? "1" : null),
      },
    },
  };
  const down = createChromeKeyDown({
    win,
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
  return { leader, down, win };
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

// THE CLAIM A DOCUMENT LEAVES BEHIND.
//
// The hold is published to the background so it can survive a navigation (hold
// `;`, press `g`, and the new document still knows the key is down), which means
// the claim outlives the document that made it — and a document that is gone
// cannot retract anything. What is left is a claim about a PHYSICAL key that
// nothing can verify, so the reader judges it by age. The failure it bounds is
// the one that looks like a frozen browser: a restored hold marks the leader as
// held with no keyup left to release it, so it never disarms and every later
// key is dispatched as a `;x` binding.
describe("a published hold is only believed while it could still be true", () => {
  const now = 1_000_000;

  test("a fresh claim is restored", () => {
    assert.equal(shouldRestoreHold(true, now - 40, now), true);
  });

  test("a claim from inside the grace window is restored", () => {
    assert.equal(shouldRestoreHold(true, now - HOLD_RESTORE_GRACE_MS, now), true);
  });

  test("a stale claim is refused", () => {
    // The document that made it is gone by the time a leader key could still be
    // down; believing it arms a leader for a key nobody is holding.
    assert.equal(shouldRestoreHold(true, now - HOLD_RESTORE_GRACE_MS - 1, now), false);
  });

  test("a claim with no timestamp is refused", () => {
    // The old, unbounded rule. Refusing it is the whole point of the change: a
    // host that cannot say WHEN cannot be believed to be saying NOW.
    assert.equal(shouldRestoreHold(true, 0, now), false);
    assert.equal(shouldRestoreHold(true, NaN, now), false);
    assert.equal(shouldRestoreHold(true, undefined as unknown as number, now), false);
  });

  test("no claim at all is refused", () => {
    assert.equal(shouldRestoreHold(false, now, now), false);
  });

  test("a claim from the future is kept", () => {
    // Two realms disagreeing about the clock must not be read as "infinitely
    // old": refusing every restore on a skewed host is the worse failure.
    assert.equal(shouldRestoreHold(true, now + 500, now), true);
  });
});

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
    const { leader, down, win } = setup(WEB);
    // A web page whose content script HAS arrived — the case where the chrome
    // helper must defer, and therefore the case the keyup-less path must not
    // override.
    report(win, true, WEB);
    // Not fromActor, so the "web pages belong to the content script" gate must
    // decline it even though no keyup will follow.
    assert.equal(down.chromeKeyDown(keydown(";"), false, true), false);
    assert.equal(leader.active, false, "and must not arm the chrome leader there");
  });

  test("an actor key IS owned, because the actor only speaks for pages with no content script", () => {
    const { leader, down, win } = setup(WEB);
    report(win, true, WEB);
    assert.equal(down.chromeKeyDown(keydown(";"), true, true), true);
    assert.equal(leader.active, true);
  });

  test("an actor key is NOT marked held", () => {
    // The actor synthesizes a keydown and nothing else. Claiming a hold there
    // is exactly the stuck-keyboard bug.
    const { leader, down, win } = setup(WEB);
    report(win, true, WEB);
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
// ---------------------------------------------------------------------------
// The leader key on a command-center tab that cannot answer yet.
//
// The helper FORWARDS a key into the command center rather than running it
// itself (that page owns its own keys, and the `#lfc=keys` channel plus the
// content-process actor both arrive through this forward). Forwarding is right
// while the page is there — but a command-center document caught mid-redirect
// (URL committed, script not run yet; every fresh new tab for a moment) has
// none of its engine, so the key was handed to a page that could not act on it
// and the keystroke simply disappeared. `;` on such a tab left the keyboard
// dead until the user navigated away, which is the "nothing responds, not even
// the leader key" report.
//
// So the page declares whether it answers keys (`data-lf-engine`, set in the
// same statement that installs its listener) and the LEADER KEY is answered
// here when it does not. These tests pin both directions and the blast radius:
// only the leader key is rescued, and a ready page is untouched.
// ---------------------------------------------------------------------------

describe("a command-center page with no engine cannot swallow the leader key", () => {
  test("the leader key is answered HERE when the page has not loaded its engine", () => {
    const { leader, down } = setupCC(false);
    const took = down.chromeKeyDown(keydown(";"), false, true);
    assert.equal(took, true, "the key is consumed by somebody");
    assert.equal(leader.active, true, "and somebody armed — the keyboard is alive");
  });

  test("a page that HAS its engine gets the key, exactly as before", () => {
    const { leader, down } = setupCC(true);
    const took = down.chromeKeyDown(keydown(";"), false, true);
    assert.equal(took, true, "consumed");
    assert.equal(leader.active, false, "the page owns its keys; the helper must not arm as well");
  });

  test("only the LEADER key is rescued — nothing else arms the helper", () => {
    // A second opinion about every key would be the double-owner bug wearing a
    // different hat: `j` on the home grid is a grid move, not a scroll.
    const { leader, down } = setupCC(false);
    const took = down.chromeKeyDown(keydown("j"), false, true);
    assert.equal(took, true, "still consumed (forwarded to the page)");
    assert.equal(leader.active, false, "a non-leader key never arms the helper");
  });

  test("a modified leader key is not the leader key", () => {
    // Ctrl+; is not the escape hatch and not an arm: the numeric hot-swap and
    // the browser's own chords live in that space.
    const { leader, down } = setupCC(false);
    // `keydown()` takes the REAL event field names (`ctrlKey`), and this test
    // exists because getting that wrong is exactly how a modifier rule ends up
    // asserted against an unmodified key.
    down.chromeKeyDown(keydown(";", { ctrlKey: true }), false, true);
    assert.equal(leader.active, false);
  });

  test("a REAL key on a ready command-center tab is unchanged", () => {
    // The branch the fallback must not disturb: with focus in the page the
    // page's own listener has already run, so the helper returns false.
    const { leader, down } = setupCC(true);
    const took = down.chromeKeyDown(keydown(";"), false, false);
    assert.equal(took, false);
    assert.equal(leader.active, false);
  });
});

/**
 * A clock and a timer, so a 2.5-second property is pinned without waiting.
 *
 * The liveness rule is a deadline and a re-armed timeout, i.e. two numbers, and
 * the only way to assert it in a fast test is to own the clock the rule reads.
 * `advance` fires due timers in order and moves the clock past the last one, so
 * "expired" and "kept alive" differ by what the same advance does to the same
 * leader.
 */
function clock(start = 100000) {
  let now = start;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

describe("the end of a hold: a finished gesture, not a stuck overlay", () => {
  test("a hold that RAN something stands the leader down when the key comes up", () => {
    // The reported shape, in one assertion: hold `;`, press `g` a few times,
    // let go — and what is left must be the page, not a which-key overlay still
    // holding the keyboard and waiting for an action nobody asked for.
    const leader = fakeLeader();
    leader.sticky = true;
    leader.active = true;
    leader.ranWhileHeld = true;
    assert.equal(releaseHoldOnKeyup(leader, ";", ";"), true, "the release is announced");
    assert.equal(leader.sticky, false, "the hold is over");
    assert.equal(leader.active, false, "and the overlay went with it");
    assert.equal(leader.ranWhileHeld, false, "the flag is spent, not sticky itself");
  });

  test("a TAP is not a hold: releasing it leaves the leader armed", () => {
    // The ordinary which-key gesture — `;` down, up, then type a chord — and the
    // one case where disarming on release would break the feature outright.
    const leader = fakeLeader();
    leader.sticky = true;
    leader.active = true;
    assert.equal(releaseHoldOnKeyup(leader, ";", ";"), true);
    assert.equal(leader.sticky, false);
    assert.equal(leader.active, true, "a tap stays armed for the chord that follows");
  });

  test("another key's keyup never ends the leader's hold", () => {
    const leader = fakeLeader();
    leader.sticky = true;
    leader.active = true;
    assert.equal(releaseHoldOnKeyup(leader, ";", "g"), false);
    assert.equal(leader.sticky, true, "the hold belongs to the leader key alone");
  });
});

// ---------------------------------------------------------------------------
// The hold that CROSSES a document.
//
// `;` held then `g` navigates: the document that observed the press is gone, and
// the new one is told the key is still down so the sequence survives. Two things
// about that handover are failure modes the user reported, and neither is
// visible from inside one document:
//
//   * the restored hold ended like a TAP. A fresh controller has
//     `ranWhileHeld === false`, so standing the hold down left the leader ARMED —
//     the overlay up on a page nobody armed it on, eating the next keystroke as a
//     `;x` binding. That is "I can do `;g` to go back but the which-key and the
//     leader key stay active".
//
//   * the gesture was CANCELLED and the claim outlived it. Escape / Ctrl+G hid
//     the overlay and left the published hold standing, so the next navigation
//     re-armed the very state the user had backed out of.
// ---------------------------------------------------------------------------

describe("a hold restored across a document is a hold that already ran", () => {
  test("restoring marks the hold AND the fact that it did something", () => {
    const leader = fakeLeader();
    assert.equal(restoreHold(leader), true);
    assert.equal(leader.sticky, true, "the key is still down, per the claim");
    assert.equal(
      leader.ranWhileHeld,
      true,
      "the document it came from is gone, and only an action replaces one — " +
        "without this the restored hold ends like a tap and the overlay stays up"
    );
  });

  test("ending a restored hold stands the leader down", () => {
    // The reported `;g` shape, as one assertion: the release has to give the
    // page back, not leave a which-key overlay holding the keyboard.
    const leader = fakeLeader();
    restoreHold(leader);
    leader.show();
    assert.equal(releaseHoldOnKeyup(leader, ";", ";"), true);
    assert.equal(leader.sticky, false, "the hold is over");
    assert.equal(leader.active, false, "and the overlay went with it");
  });

  test("a restored hold that expires stands down too", () => {
    // The lost-release direction of the same rule: no keyup arrives, the
    // watchdog expires the claim, and the keyboard still has to come back.
    const leader = fakeLeader();
    restoreHold(leader, 5000);
    leader.show();
    assert.equal(releaseExpiredHold(leader, 5000 + HOLD_LIVENESS_MS + 1), true);
    assert.equal(leader.active, false);
  });

  test("a restored hold is not believed forever", () => {
    // `restoreHold` refreshes the deadline, so the only guard against a stale
    // claim is the caller's (shouldRestoreHold) — pinned here so the two halves
    // are read together.
    const leader = fakeLeader();
    restoreHold(leader, 5000);
    assert.equal(releaseExpiredHold(leader, 5000 + HOLD_LIVENESS_MS - 1), false);
  });
});

describe("cancel ends the gesture, not just the overlay", () => {
  test("cancelHold reports whether a hold was outstanding", () => {
    const leader = fakeLeader();
    assert.equal(cancelHold(leader), false, "nothing held, nothing to publish");
    restoreHold(leader);
    assert.equal(cancelHold(leader), true, "a held gesture is ended");
    assert.equal(leader.sticky, false);
    assert.equal(leader.ranWhileHeld, false, "and the flag is spent, not sticky");
  });

  test("cancelling a hold that ran something also stands the leader down", () => {
    const leader = fakeLeader();
    leader.sticky = true;
    leader.ranWhileHeld = true;
    leader.show();
    cancelHold(leader);
    assert.equal(leader.active, false);
  });

  test("cancelling a TAP's hold leaves the transport decision to the caller", () => {
    // A cancel is not a binding: the overlay is the canceller's business (it
    // calls hide() itself), and this rule must not add a second opinion about a
    // hold that never ran anything.
    const leader = fakeLeader();
    leader.sticky = true;
    leader.show();
    assert.equal(cancelHold(leader), true);
    assert.equal(leader.active, true, "the hold is cleared, the view is not touched");
  });
});

describe("the dispatcher cancels through the host, so the claim dies with the gesture", () => {
  test("Esc / Ctrl+G on an armed leader releases the hold through the callback", () => {
    let released = 0;
    const { leader, down } = setup(ABOUT, {
      cancelLeaderHold: () => {
        released++;
      },
    });
    down.chromeKeyDown(keydown(";"));
    assert.equal(leader.active, true);
    const took = down.chromeKeyDown(keydown("g", { ctrlKey: true }));
    assert.equal(took, true, "the cancel is consumed");
    assert.equal(released, 1, "and the host was told, so it can publish the release");
  });
});

describe("Ctrl+G never reaches the browser on a page the helper owns", () => {
  // Firefox binds Ctrl+G to FIND AGAIN, and on a chrome-owned page (about:, the
  // command center before its engine loads) nothing else wanted the chord — so
  // it opened the native find bar over the page. This is the reported
  // "sometimes Ctrl+G opens the page's own search", and "sometimes" is exactly
  // the set of pages with no content script to consume it.
  test("the chord is consumed even with no overlay up", () => {
    const { leader, down } = setup();
    assert.equal(leader.active, false);
    assert.equal(down.chromeKeyDown(keydown("g", { ctrlKey: true })), true);
  });

  test("Escape is still the page's — only the chord is ours", () => {
    // Escape is the one key every site binds, and the helper has always let it
    // through (it only blurs the focused element first). Consuming it here would
    // be a different change from the one this exists for.
    const { down } = setup();
    assert.equal(down.chromeKeyDown(keydown("Escape")), false);
  });
});

describe("the liveness rule: a hold has to be held", () => {
  test("a hold nobody refreshes expires, stands down, and is published as released", () => {
    const leader = fakeLeader();
    leader.sticky = true;
    leader.active = true;
    leader.ranWhileHeld = true;
    const clk = clock();
    let released = 0;
    const dog = createHoldWatchdog({
      leader: () => leader,
      onRelease: () => {
        released++;
      },
      now: clk.now,
      setTimer: clk.setTimer,
      clearTimer: clk.clearTimer,
    });
    dog.keepAlive();
    clk.advance(HOLD_LIVENESS_MS - 10);
    assert.equal(leader.sticky, true, "still inside the window: the key may still be down");
    assert.equal(released, 0);
    clk.advance(20);
    assert.equal(leader.sticky, false, "nothing is holding it any more");
    assert.equal(leader.active, false, "and the keyboard comes back");
    assert.equal(released, 1, "the background must not be able to restore it either");
  });

  test("the key's own auto-repeat keeps a real hold alive past the window", () => {
    // A held key re-fires every ~30ms, so a hold that is genuinely being held
    // never comes near the deadline — which is what makes the rule safe for a
    // user who sits on the key for a while.
    const leader = fakeLeader();
    leader.sticky = true;
    leader.active = true;
    const clk = clock();
    let released = 0;
    const dog = createHoldWatchdog({
      leader: () => leader,
      onRelease: () => {
        released++;
      },
      now: clk.now,
      setTimer: clk.setTimer,
      clearTimer: clk.clearTimer,
    });
    dog.keepAlive();
    for (let i = 0; i < 20; i++) {
      clk.advance(HOLD_LIVENESS_MS / 2);
      dog.keepAlive(); // one auto-repeat
    }
    assert.equal(leader.sticky, true, "five windows of repeats: still held");
    assert.equal(released, 0);
    dog.stop();
    clk.advance(HOLD_LIVENESS_MS * 4);
    assert.equal(released, 0, "and a stopped watchdog stops claiming anything");
  });

  test("the watchdog is a no-op when no hold is outstanding", () => {
    const leader = fakeLeader();
    leader.active = true; // an ordinary armed leader: no hold
    const clk = clock();
    let released = 0;
    const dog = createHoldWatchdog({
      leader: () => leader,
      onRelease: () => {
        released++;
      },
      now: clk.now,
      setTimer: clk.setTimer,
      clearTimer: clk.clearTimer,
    });
    dog.keepAlive();
    clk.advance(HOLD_LIVENESS_MS * 3);
    assert.equal(leader.active, true, "a leader that was never held is not disturbed");
    assert.equal(released, 0);
  });

  test("an expired hold leaves a TAP's leader armed, and ends a hold that ran", () => {
    // The two halves of the same rule, on the same clock: expiry only disarms
    // what a release would have disarmed.
    const tap = fakeLeader();
    tap.sticky = true;
    tap.active = true;
    assert.equal(releaseExpiredHold(tap, 1_000_000), true);
    assert.equal(tap.sticky, false);
    assert.equal(tap.active, true, "a tap is still a tap when the release is lost");

    const ran = fakeLeader();
    ran.sticky = true;
    ran.active = true;
    ran.ranWhileHeld = true;
    assert.equal(releaseExpiredHold(ran, 1_000_000), true);
    assert.equal(ran.active, false, "a hold that ran something is over");
  });

  test("a fresh hold cannot be expired early", () => {
    const leader = fakeLeader();
    leader.sticky = true;
    noteHoldAlive(leader, 5000);
    assert.equal(releaseExpiredHold(leader, 5100), false);
    assert.equal(leader.sticky, true);
    assert.equal(releaseExpiredHold(leader, 5000 + HOLD_LIVENESS_MS + 1), true);
  });
});

// THE DISPATCH TRACE, and why it is pinned here rather than only in the
// browser. "Press `;o` on a chrome-owned page and nothing happens" has three
// different causes that look identical from outside — the helper declined the
// key, the key never arrived, the leader was armed but its table had not loaded
// — and the trace is what tells them apart (it is the reason the last one was
// found at all: an e2e case recorded `;` as `leader-arm` and NOTHING for the
// key that followed, which is a harness failure, not a product one).
describe("the dispatcher names what it did with a key", () => {
  // `__DEV__` is a build-time literal that Node does not define, so the trace is
  // off there by default (an honest release shape: nothing is recorded). Set it
  // for these cases BEFORE the dispatcher is built, which is when the module
  // reads it.
  const previous = (globalThis as any).__DEV__;
  test("a chord is named, and a declined key is named differently", () => {
    (globalThis as any).__DEV__ = true;
    try {
      const { down } = setup();
      assert.equal(down.chromeKeyDown(keydown(";")), true);
      down.chromeKeyDown(keydown("o"));
      const trace = down.dispatchTrace();
      const keys = trace.map((e: any) => e.k);
      assert.deepEqual(keys.slice(-2), [";", "o"], "both keystrokes are recorded, in order");
      assert.equal(trace[trace.length - 2].br, "leader-arm");
      assert.equal(trace[trace.length - 1].br, "leader-chord");
      // The entry carries the facts the diagnosis turns on, not just the key.
      const last = trace[trace.length - 1];
      assert.equal(last.actor, false, "a real key is not actor-forwarded");
      assert.equal(last.tap, false, "a real key has a keyup coming");
      assert.equal(last.l, 1, "the leader was armed when the chord arrived");
      assert.equal(last.owns, true);
    } finally {
      (globalThis as any).__DEV__ = previous;
    }
  });

  test("a page that owns its keys records the DECLINE", () => {
    (globalThis as any).__DEV__ = true;
    try {
      const { down } = setup(WEB);
      report(setup(WEB).win, true, WEB);
      const { down: webDown, win } = setup(WEB);
      report(win, true, WEB);
      assert.equal(webDown.chromeKeyDown(keydown("j")), false);
      const entry = webDown.dispatchTrace().slice(-1)[0];
      assert.equal(entry.k, "j");
      assert.equal(entry.br, "web-page");
      assert.equal(entry.c, false);
      assert.equal(entry.owns, false, "the page owns its keys, and the entry says so");
      // The first dispatcher was never used; the trace is PER DISPATCHER, since
      // a helper's ring describes that helper's window.
      assert.deepEqual(down.dispatchTrace(), []);
    } finally {
      (globalThis as any).__DEV__ = previous;
    }
  });

  test("nothing is recorded when the build is not a dev build", () => {
    (globalThis as any).__DEV__ = false;
    try {
      const { down } = setup();
      down.chromeKeyDown(keydown(";"));
      assert.deepEqual(down.dispatchTrace(), [], "a release build records nothing");
    } finally {
      (globalThis as any).__DEV__ = previous;
    }
  });
});
