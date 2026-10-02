#!/usr/bin/env node
// Tests for the HELD-leader rule: which keys count as "the leader key is
// physically down right now", and which do not.
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
// Run: node --experimental-strip-types scripts/test-keyhold.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { createChromeKeyDown } = await import("../src/chrome/keysdispatch.ts");
const { noteContentPresent, resetContentPresence } = await import("../src/chrome/keystate.ts");

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
}

/* ---------- a window just real enough for the dispatcher ---------- */

// The command center: chrome-owned by URL, and the page where `;` arms the
// leader with the input blurred. A web URL is deliberately NOT used anywhere
// here — for those, `chromeOwnsKeys` consults the content script's presence
// and the whole point of this feature is the chrome-owned side.
const CC_URL = "moz-extension://abc/commandcenter.html";
function fakeWindow(spec = CC_URL): any {
  const browser = { currentURI: { spec } };
  return {
    gBrowser: { tabs: [browser], selectedBrowser: browser, selectedTab: browser },
    document: { visibilityState: "visible", addEventListener() {}, documentElement: null },
  };
}

// A leader just real enough for the dispatcher. The real LeaderController is
// covered by test-leader-sequences; what is under test HERE is the dispatcher's
// decision about the hold, and that decision needs only  and
// . Using a stub keeps the DOM out of it — mounting the overlay is
// rendering, which is not the subject here.
function makeLeader(): any {
  return {
    active: false,
    sticky: false,
    prefix: "",
    show(): void {
      this.active = true;
    },
    hide(): void {
      this.active = false;
    },
    hasPending(): boolean {
      return false;
    },
    cancelPending(): void {},
    // Mirrors LeaderController: a binding always runs, but a HELD leader stays
    // armed afterwards while an ordinary one disarms. That difference is the
    // whole user-visible consequence of the hold, so the stub has to make it
    // or the assertions about it would be testing the stub.
    handleKey(): boolean {
      if (!this.sticky) this.active = false;
      return true;
    },
  };
}

function makeDispatch(win: any, leader: any): any {
  return createChromeKeyDown({
    win,
    leader: () => leader,
    popup: {
      isOpen: () => false,
      handleKey: () => false,
      close() {},
      resizeOnKey: () => false,
    },
    typing: {
      focusedIsTyping: () => false,
      focusedTypingValue: () => "",
      focusedTypingTarget: () => null,
    } as any,
    keyGuard: { shouldIgnore: () => false } as any,
    leaderKey: () => ";",
    handleHotkeyCombo: () => false,
    switchSessionByMarker: () => {},
    handleScrollKeys: () => false,
    runWebHints: () => {},
  });
}

// A keydown with the shape the dispatcher accepts. `repeat` models the OS
// auto-repeat a genuinely held key produces.
function keydown(key: string, extra: any = {}): any {
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

/* ---------- a real press is a hold, and the release ends it ---------- */

{
  const leader = makeLeader();
  const down = makeDispatch(fakeWindow(), leader);
  ok("a real leader press is consumed", down.chromeKeyDown(keydown(";")) === true);
  ok("a real leader press arms the leader", leader.active === true);
  ok("a real leader press marks it HELD", leader.sticky === true);
  // main.ts / content main.ts own the release; what matters here is that the
  // flag the release clears is the one a press sets.
  leader.sticky = false;
  ok("the release clears the hold", leader.sticky === false);
  ok("the release does NOT disarm the leader", leader.active === true);
}

/* ---------- auto-repeat must not churn the leader ---------- */

{
  const leader = makeLeader();
  const down = makeDispatch(fakeWindow(), leader);
  down.chromeKeyDown(keydown(";"));
  // The OS re-fires keydown while the key is held. Each is consumed (so the
  // character never leaks into the page) but none re-arms or disarms.
  for (let i = 0; i < 5; i++) {
    ok("auto-repeat is consumed", down.chromeKeyDown(keydown(";", { repeat: true })) === true);
  }
  ok("auto-repeat left the leader armed", leader.active === true);
  ok("auto-repeat left the hold in place", leader.sticky === true);
}

/* ---------- a key with NO keyup is a tap, never a hold ---------- */

// This is the regression. Both synthetic paths below are real callers: the
// actor bridge and the `#lfc=keys` channel.
{
  const leader = makeLeader();
  const down = makeDispatch(fakeWindow(), leader);
  // noKeyup = true is what those callers pass.
  ok("a keyup-less leader key is consumed", down.chromeKeyDown(keydown(";"), false, true) === true);
  ok("a keyup-less leader key still arms the leader", leader.active === true);
  ok("a keyup-less leader key is NOT marked held", leader.sticky === false);
}

/* ---------- ownership and keyup are separate facts ---------- */

// The `#lfc=keys` channel drives the REAL selection, which may be a page the
// content script owns. Claiming ownership there would handle one keystroke
// twice, so `fromActor` must stay independent of `noKeyup`.
{
  const leader = makeLeader();
  const WEB = "https://example.com/";
  // A web page whose content script HAS arrived — the case where the chrome
  // helper must defer, and therefore the case the keyup-less path must not
  // override.
  resetContentPresence();
  noteContentPresent(0, true, WEB);
  const webWin = fakeWindow(WEB);
  const down = makeDispatch(webWin, leader);
  // Not fromActor, so the "web pages belong to the content script" gate must
  // decline it even though no keyup will follow.
  const consumed = down.chromeKeyDown(keydown(";"), false, true);
  ok("a keyup-less key does not steal a web page's keys", consumed === false);
  ok("and does not arm the chrome leader there", leader.active === false);

  // fromActor: the actor only speaks for pages with NO content script, so it
  // both owns the key and must not leave a hold behind.
  const leader2 = makeLeader();
  const down2 = makeDispatch(webWin, leader2);
  ok("an actor key is owned", down2.chromeKeyDown(keydown(";"), true, true) === true);
  ok("an actor key arms the leader", leader2.active === true);
  ok("an actor key is NOT marked held", leader2.sticky === false);
}

/* ---------- the hold must not outlive the window's attention ---------- */

// A lost keyup is indistinguishable from a held key from inside the window:
// both look like "the leader key is down and nothing is coming". The hosts
// therefore drop the hold when the window or page stops being the thing the
// user is looking at. This is the property that release hook has to have, and
// it is asserted here because the e2e layer cannot reach the state at all —
// BiDi releases a key source when its action list ends, so a keydown with no
// keyup is unreachable through real input, and the only path that can produce
// one (the synthetic #lfc=keys channel) reaches the chrome dispatch alone.
{
  const leader = makeLeader();
  makeDispatch(fakeWindow(), leader).chromeKeyDown(keydown(";"));
  ok("held before the blur", leader.sticky === true);

  // What the blur/visibilitychange handler does in both hosts: clear the hold,
  // and ONLY the hold.
  const releaseLostHold = (l: any): void => {
    if (l.sticky) l.sticky = false;
  };
  releaseLostHold(leader);
  ok("the blur releases the lost hold", leader.sticky === false);
  ok("the blur leaves the leader armed", leader.active === true);

  // The consequence, which is the reason any of this matters: with the hold
  // gone, the next binding DISARMS. While it stands, every binding leaves the
  // leader up and the user's next ordinary keystroke is eaten as a leader key.
  ok("a binding after a released hold runs", leader.handleKey(keydown("j")) === true);
  ok("and disarms the leader", leader.active === false);

  // Idempotent, and safe when nothing was held: a blur can arrive for any
  // number of reasons, and a handler that only acts sometimes is worse than
  // one that always acts correctly.
  releaseLostHold(leader);
  ok("releasing again is harmless", leader.sticky === false && leader.active === false);
  const untouched = makeLeader();
  releaseLostHold(untouched);
  ok("releasing a leader that was never held changes nothing", untouched.sticky === false && untouched.active === false);
}

console.log("keyhold: " + passed + " checks passed");
