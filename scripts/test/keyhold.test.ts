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
import {
  CONTENT_EXPECT_MS,
  expectContentIn,
  noteContentPresent,
  noteLocationChange,
  presenceTabFor,
  resetContentPresence,
} from "../../src/chrome/keystate.ts";
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
import { createFakeChromeEnv } from "../../src/chrome/env-fake.ts";

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
    // This is the sentence that is easy to get backwards,
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
});

describe("a freshly navigated page is expected to answer for itself", () => {
  // THE FIELD REPORT, in the user's words: "when the page navigate or load
  // there is a 1s or so delay that I can't run an action cause the leader gets
  // cleared out or the action gets absorbed so I have to do it twice or wait a
  // sec until lazyfox is warm on that page".
  //
  // Presence is PUSHED by the page's own script, so between a navigation and
  // that report landing, the helper holds NO record for the new document — and
  // it used to claim the keys. Both realms then answered the same keystroke:
  // `;` armed the CHROME leader (painting the helper's own which-key over the
  // page), the page's own leader armed too, the sub-key ran a chrome-side
  // binding that had no page to act on — "the action gets absorbed" — and when
  // the page's report finally arrived the helper stood its overlay down, which
  // is "the leader gets cleared out".
  //
  // The rule now: a tab whose DOCUMENT was just replaced is expected to answer
  // for itself, so the helper declines until either the page says it is there
  // (the ordinary case, one message round trip after document_start) or the
  // window closes (a page that never reports: a PDF viewer, an error page).
  //
  // Asserted HERE and not end-to-end because the window is a decision about
  // ownership plus a clock, and both are readable directly.
  /** A web tab mid-navigation, with the keyboard where a link leaves it. */
  function navigated(page = WEB) {
    const fm: any = { activeWindow: null, focusedElement: null };
    const { leader, down, win } = setup(page, { env: { services: { focus: fm }, Ci: {} } });
    fm.activeWindow = win;
    // The keyboard is IN THE PAGE — the state a click on a link leaves behind,
    // and the state in which the page's own listener is the one answering.
    fm.focusedElement = win.gBrowser.selectedBrowser;
    // A real navigation: no SAME_DOCUMENT flag.
    noteLocationChange(win, win.gBrowser.selectedBrowser, 0);
    return { leader, down, win, fm };
  }

  test("the leader key is declined, not claimed, and no chrome leader arms", () => {
    const { leader, down } = navigated();
    assert.equal(
      down.chromeKeyDown(keydown(";")),
      false,
      "the page's own listener is the one that must answer its leader key",
    );
    assert.equal(leader.active, false, "and a chrome-realm leader must not be armed on a web page");
  });

  test("an ordinary key is not eaten either", () => {
    // The window is about the WHOLE keyboard, not only the leader key: every
    // key pressed in it belongs to the page that is loading.
    const { down } = navigated();
    assert.equal(down.chromeKeyDown(keydown("j")), false);
    assert.equal(down.chromeKeyDown(keydown("d")), false);
  });

  test("the window is BOUNDED: a page that never reports is the helper's again", () => {
    const { leader, down, win } = navigated();
    // Re-arm the expectation as if it had been opened longer ago than the
    // window allows — which is every page with no content script to arrive.
    expectContentIn(win, win.gBrowser.selectedBrowser, Date.now() - (CONTENT_EXPECT_MS + 1));
    assert.equal(down.chromeKeyDown(keydown(";")), true, "the helper answers the leader key again");
    assert.equal(leader.active, true);
  });

  test("the page reporting in ends the window, leaving the ordinary answer", () => {
    const { leader, down, win } = navigated();
    report(win, true, WEB);
    assert.equal(down.chromeKeyDown(keydown(";")), false);
    assert.equal(leader.active, false, "the site's own leader is still the site's");
  });
});

describe("a page that cannot see the keyboard gets it back", () => {
  // THE FIELD REPORT in its own words: "it stops responding until I move the
  // mouse over the window and click on a spot on the page". The page is alive
  // and its content script owns its keys — and the KEYBOARD is somewhere else,
  // so the page's listener never runs and the key the helper declines because
  // "the page owns it" is answered by the browser's own UI instead. The click is
  // the repair the user discovers, and it is the one repair a keyboard-first
  // browser cannot ask for.
  //
  // Asserted HERE rather than end-to-end because the condition is a fact about
  // the FOCUS MANAGER, which the e2e layer can only reach through the states a
  // real window happens to be in; here it can be stated directly. The e2e case
  // (content/focus, "a page whose keyboard is in the browser's own UI") covers
  // the same repair through Ctrl+L and a real key.
  /** A chrome field on screen: the toolbar revealed, its box measurable. */
  function visibleChromeField(win: any, value = ""): any {
    return {
      tagName: "input",
      value,
      ownerDocument: win.document,
      getBoundingClientRect: () => ({ width: 320, height: 28 }),
    };
  }

  function lostKeyboard(page = WEB) {
    const fm: any = { activeWindow: null, focusedElement: null };
    const { leader, down, win } = setup(page, { env: { services: { focus: fm }, Ci: {} } });
    // The window IS active (otherwise the keys would not be arriving at all) and
    // the keyboard is on a chrome element: the URL bar after Ctrl+L, or the
    // toolbar after a hover.
    fm.activeWindow = win;
    // A field the user can SEE, because the veto is about a caret the user is
    // writing at: `Ctrl+L` REVEALS the toolbar (Lazyfox renders it as a hover
    // overlay, src/static/chrome/userChrome.css), and only then can a human
    // deliberately type into it. The hidden twin of this state is what the
    // reported freeze was, and chrome/chromefield.ts is where the difference is
    // decided — a zero-box field cannot veto.
    fm.focusedElement = visibleChromeField(win);
    const browser = win.gBrowser.selectedBrowser;
    const focused: string[] = [];
    browser.focus = () => focused.push("browser");
    // The page's content script has arrived: `chromeOwnsKeys` is false, which is
    // the gate this branch sits behind.
    report(win, true, page);
    return { leader, down, win, fm, browser, focused };
  }

  test("the leader key is consumed and the page is handed the keyboard", () => {
    const { leader, down, focused } = lostKeyboard();
    assert.equal(down.chromeKeyDown(keydown(";")), true, "the leader key must not be spent in the URL bar");
    // At least once, not exactly once: the escalation in focusSelectedContent is
    // entitled to try again when the focus manager has not taken the request yet
    // (and its own test pins that). What THIS branch must do is ask.
    assert.ok(focused.length >= 1, "the selected browser was given the keyboard back");
    // And the HELPER must not arm here: on a web page the leader belongs to the
    // content script, and a helper-owned leader would answer the sub-key while
    // the page's own engine stayed dark — the double-owner bug, in reverse.
    assert.equal(leader.active, false, "the page's leader is still the page's");
  });

  test("a page that already has the keyboard is left alone", () => {
    const { down, focused, fm, browser } = lostKeyboard();
    fm.focusedElement = browser; // the browser element IS what a remote page reports
    assert.equal(down.chromeKeyDown(keydown(";")), false, "the page owns the key, as it always did");
    assert.deepEqual(focused, [], "and nothing was refocused");
  });

  test("a chrome field the user is writing in is theirs", () => {
    // The veto for every browser-UI field EXCEPT the URL bar: its value is text
    // the user wrote (the find bar's box holds only what was typed into it), so
    // text means the caret is theirs and no repair may take it.
    //
    // Asserted with a PLAIN key, which is what the veto protects: the LEADER KEY
    // is deliberately outside it (a `;` from a user who wants Lazyfox moves the
    // keyboard back — the decision recorded in keysdispatch.givePageKeyboardBack
    // and pinned in "the rescue, when the browser's own address bar holds the
    // keyboard" below).
    const fm: any = { activeWindow: null, focusedElement: null };
    const { down, win } = setup(WEB, {
      env: { services: { focus: fm }, Ci: {} },
      typing: {
        focusedIsTyping: () => true,
        focusedTypingValue: () => "text the user is writing",
        focusedTypingTarget: () => visibleChromeField(win, "text the user is writing"),
      },
    });
    const b = win.gBrowser.selectedBrowser;
    const calls: string[] = [];
    b.focus = () => calls.push("browser");
    fm.activeWindow = win;
    fm.focusedElement = visibleChromeField(win, "text the user is writing");
    report(win, true, WEB);
    assert.equal(down.chromeKeyDown(keydown("d")), false, "the field's own text wins");
    assert.deepEqual(calls, [], "and the caret was not taken from it");
  });

  /**
   * A page whose keyboard sits in the URL BAR, with the URL bar's own flags.
   *
   * The state is described by the flags Firefox sets, not by the text in the
   * field, because that is the distinction the product has to make — and this
   * helper exists so a test can state the two states that differ ONLY in them.
   */
  function urlbar(
    opts: { valueIsTyped?: boolean; usertyping?: string | null; visible?: boolean } = {}
  ) {
    const fm: any = { activeWindow: null, focusedElement: null };
    let input: any = null;
    const { leader, down, win } = setup(WEB, {
      env: { services: { focus: fm }, Ci: {} },
      typing: {
        focusedIsTyping: () => true,
        // The measured value on the state this repair is for: the PAGE's address,
        // put there by navigation — non-empty, and not typed by anybody.
        focusedTypingValue: () => "http://127.0.0.1:50636/hello",
        focusedTypingTarget: () => input,
      },
    });
    const ub: any = {
      valueIsTyped: !!opts.valueIsTyped,
      getAttribute: (n: string) => (n === "usertyping" ? opts.usertyping ?? null : null),
    };
    // `visible` defaults to TRUE: an address being typed is typed into a toolbar
    // the user revealed (a hover at the top strip, or Ctrl+L). The hidden state
    // is the reported freeze and is stated explicitly by the cases below.
    input = {
      tagName: "input",
      ownerDocument: win.document,
      getAttribute: () => null,
      getBoundingClientRect: () =>
        opts.visible === false ? { width: 0, height: 0 } : { width: 320, height: 28 },
    };
    ub.inputField = input;
    win.gURLBar = ub;
    const focused: string[] = [];
    const b = win.gBrowser.selectedBrowser;
    b.focus = () => focused.push("browser");
    fm.activeWindow = win;
    fm.focusedElement = input;
    return { leader, down, win, fm, focused };
  }

  test("an address the URL bar is merely SHOWING does not veto the rescue", () => {
    // MEASURED end to end, and the bug this test is the floor under: the first
    // version of the veto asked whether the chrome field held text, and the URL
    // bar holds the page's own address in exactly the state the rescue exists
    // for — so the rescue declined every time and the keyboard never left the
    // URL bar. The flags below are the ones the running browser reported there:
    // `valueIsTyped: false`, no `usertyping` attribute.
    const { down, win, focused } = urlbar({ valueIsTyped: false, usertyping: null });
    report(win, true, WEB);
    assert.equal(down.chromeKeyDown(keydown(";")), true, "the leader key is consumed with the repair");
    assert.ok(focused.length >= 1, "and the page was given the keyboard back");
  });

  test("a URL the user is typing is theirs", () => {
    // The other side of the same measurement: once Firefox says the user edited
    // the value, the field is a composition and the caret wins over the freeze.
    // A plain key is what the veto protects (`;` is the deliberate exception).
    const { down, win, focused } = urlbar({ valueIsTyped: true });
    report(win, true, WEB);
    assert.equal(down.chromeKeyDown(keydown("d")), false, "the URL bar keeps the key it was typed into");
    assert.deepEqual(focused, [], "and the caret was not taken from it");
  });

  test("the URL bar's own usertyping attribute vetoes too", () => {
    // Firefox sets `usertyping` while the user types and clears it on blur; a
    // build that reports the flag only there must still veto, or the veto would
    // depend on which of the two signals a platform happens to expose.
    const { down, win, focused } = urlbar({ valueIsTyped: false, usertyping: "true" });
    report(win, true, WEB);
    assert.equal(down.chromeKeyDown(keydown("d")), false);
    assert.deepEqual(focused, []);
  });

  test("the SAME flags on a HIDDEN bar do not veto — this is the reported freeze", () => {
    // The user's state, exactly: Lazyfox hides the URL bar, Firefox parks the
    // keyboard in it, and a stray keystroke from a frozen page set the flags the
    // two cases above are about. Before chrome/chromefield.ts, that one stray
    // character vetoed EVERY rescue for the life of the window, invisibly, and
    // the only repair left was the click the user complained about.
    const { down, win, focused } = urlbar({ valueIsTyped: true, visible: false });
    report(win, true, WEB);
    assert.equal(down.chromeKeyDown(keydown(";")), true, "the leader key is honoured anyway");
    assert.ok(focused.length >= 1, "and the page is given the keyboard back");
  });

  /**
   * The state the field report describes in its own words: the HELPER answers
   * this page's keys (`;` arms, `;r`/`;s`/`;o`/`;d` run) while the KEYBOARD sits
   * in the browser's own UI, so the page's content script never sees a key and
   * everything that lives in the page — j/k/d/u, hints, find — is dead until the
   * page is clicked or reloaded.
   *
   * No presence is reported for this page, which is what makes the helper the
   * owner (see keystate.chromeOwnsKeys).
   */
  function helperOwnsPage(spec = WEB, opts: { typing?: boolean } = {}) {
    const fm: any = { activeWindow: null, focusedElement: null };
    let input: any = null;
    const { leader, down, win } = setup(spec, {
      env: { services: { focus: fm }, Ci: {} },
      typing: {
        // Where the caret is, and it changes the branch a key takes (the typing
        // guard runs first): in the URL bar by default, or nowhere — the two
        // states `;` has to survive on a page only the helper can answer.
        focusedIsTyping: () => opts.typing !== false,
        focusedTypingValue: () => "http://127.0.0.1:50636/hello",
        focusedTypingTarget: () => input,
      },
    });
    const b = win.gBrowser.selectedBrowser;
    const focused: string[] = [];
    b.focus = () => focused.push("browser");
    input = { tagName: "input", ownerDocument: win.document, getAttribute: () => null };
    fm.activeWindow = win;
    fm.focusedElement = input;
    win.gURLBar = { inputField: input, valueIsTyped: false, getAttribute: () => null };
    return { leader, down, win, fm, focused };
  }

  test("a page the HELPER answers still gets its keyboard back", () => {
    // The half that was missing. Without it, `;` here is answered by the typing
    // guard (the URL bar is a typing target holding the page's address) and the
    // user gets the field report: the leader key does something, the page does
    // nothing, and only a click or a reload repairs it.
    //
    // AND THE LEADER ARMS WITH THE REPAIR on this class — helper-owned means no
    // content script is present or expected, so no one else will ever answer the
    // next key. The repair used to consume `;` without arming (the old
    // "no helper leader was armed" assertion): one find — whose native find bar
    // parks the keyboard in the browser chrome — and every later leader press
    // on a neterror or uninjectable page was spent on nothing, forever. The
    // arming is pinned in keysdispatch as branch `leader-rescue-arm`.
    const { leader, down, focused } = helperOwnsPage();
    assert.equal(down.chromeKeyDown(keydown(";")), true, "the leader key is spent on the repair");
    assert.ok(focused.length >= 1, "and the page was given the keyboard back");
    assert.equal(leader.active, true, "the helper leader armed: nobody else can answer the next key here");
  });

  test("but NOT on a document no content script can own: the leader key arms Lazyfox", () => {
    // THE SAME STATE, ON A DOCUMENT WITH NO PAGE ENGINE BEHIND IT — and the
    // difference is the whole bug. `moz-extension://…/diagnostics.html` (and every
    // `about:` document) has no content script and never will, so "give the page
    // its keyboard back" moves the keyboard into a document that cannot answer a
    // key, while the LEADER KEY — spent on that repair — never reaches the
    // leader-arm branch. The chord is dead on its first press; the second press of
    // `;` works, which is what makes it read as "it works if I try again".
    //
    // Measured by the long session suite, step 23: `;T` opened the diagnostics
    // page, `;x` did nothing (`x` is not a binding on its own), and the helper's
    // own ring recorded `;` as `web-page-leader-rescue-split` on a tab where
    // `chromeOwnsKeys` was true and no content script existed.
    const { leader, down, focused } = helperOwnsPage("moz-extension://abc/diagnostics.html");
    assert.equal(
      down.chromeKeyDown(keydown(";")),
      true,
      "the leader key is consumed — as the leader key, not as a repair",
    );
    assert.equal(leader.active, true, "the helper's own leader armed");
    assert.equal(focused.length, 0, "and nothing was sent looking for a page engine that does not exist");
  });

  test("`about:` is the same class: the leader arms rather than repairing", () => {
    // The class, not the one URL: an about: page is chrome-owned for exactly the
    // same reason, and it is the case the helper sees most often (`about:blank`
    // on a fresh tab, `about:newtab`, the error pages).
    const { leader, down, focused } = helperOwnsPage("about:blank");
    assert.equal(down.chromeKeyDown(keydown(";")), true);
    assert.equal(leader.active, true);
    assert.equal(focused.length, 0);
  });

  test("and the branch it took is named, so a field report can be answered", () => {
    // TWO BRANCHES, ONE OUTCOME, and both are pinned because the field report
    // is read from this ring: `typing-arm` when Firefox parked the caret in the
    // URL bar (the typing guard's page-class exception is what arms it — before
    // that exception named this page class, this state spent `;` as a character),
    // and `leader-arm` when the caret is nowhere at all. Neither is a repair.
    //
    // A THIRD branch exists for the repair on a helper-owned WEB document:
    // `leader-rescue-arm` (the focus repair fired AND the leader armed), which
    // is what separates "one find and the leader never came back" from this
    // contract. It belongs in this pin because the ring is the only place a
    // field report can say it.
    const previous = (globalThis as any).__DEV__;
    (globalThis as any).__DEV__ = true;
    try {
      const rescue = helperOwnsPage(); // WEB spec: content-ownable, helper-owned
      rescue.down.chromeKeyDown(keydown(";"));
      assert.equal(rescue.down.dispatchTrace().slice(-1)[0].br, "leader-rescue-arm");
      assert.equal(rescue.leader.active, true);
      const inUrlBar = helperOwnsPage("moz-extension://abc/diagnostics.html");
      inUrlBar.down.chromeKeyDown(keydown(";"));
      assert.equal(inUrlBar.down.dispatchTrace().slice(-1)[0].br, "typing-arm");
      assert.equal(inUrlBar.leader.active, true, "a URL bar holding text cannot spend the leader key here");

      const nowhere = helperOwnsPage("moz-extension://abc/diagnostics.html", { typing: false });
      nowhere.down.chromeKeyDown(keydown(";"));
      assert.equal(nowhere.down.dispatchTrace().slice(-1)[0].br, "leader-arm");
      assert.equal(nowhere.leader.active, true);
    } finally {
      (globalThis as any).__DEV__ = previous;
    }
  });

  test("...but a letter key is never taken from the browser's own UI", () => {
    // The reason the repair is leader-key-only on this side: the URL bar is where
    // a user types an address, and `valueIsTyped` cannot tell a half-typed URL
    // from the page's own address until they have actually typed.
    const { down, focused } = helperOwnsPage();
    assert.equal(down.chromeKeyDown(keydown("x")), false, "the URL bar keeps the letter");
    assert.deepEqual(focused, [], "and the caret was not taken from it");
  });

  test("a STALE 'another window is active' does not refuse the repair — a key is proof", () => {
    // This case used to assert the opposite, and the change is the point of the
    // strict rule (see focusIsInSelectedContent): the focus manager's "this window
    // is not the active one" is believed by the TRIGGERS, because a tab select or
    // a load can genuinely happen in a window the user is not in — and it is WRONG
    // at a key, because this dispatcher is only running at all if a keydown was
    // delivered to THIS window's listener, which cannot happen while the user's
    // keyboard is in another window. Believing it is the reported freeze in its
    // purest form: the helper declines the key because "the page owns it" and the
    // page sees nothing, because its document is not focused.
    //
    // The repair cannot do harm in this state either: `focusSelectedContent`
    // escalates through the focus manager ONLY when the manager names this window
    // as the active one (its own test pins that), so a genuinely inactive window
    // gets its browser element focused and the OS keeps the other window.
    const { down, focused, fm } = lostKeyboard();
    fm.activeWindow = null;
    fm.focusedElement = null;
    assert.equal(down.chromeKeyDown(keydown(";")), true, "the leader key is spent on the repair");
    assert.ok(focused.length >= 1, "the page was given the keyboard rather than left to a click");
  });
});

describe("the hold must not outlive the window's attention", () => {
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

// THE VETO, AND THE LEADER KEY THAT BEATS IT.
//
// The rescue that gives a page its keyboard back is vetoed while the user is
// composing in a chrome field — correct in principle, and the trap the user
// reported in practice: Lazyfox renders the URL bar with `display:none`, Firefox
// parks the keyboard in it, and one stray character typed into the invisible
// field sets `valueIsTyped`. From that moment every rescue was vetoed, on every
// key, for the life of the window.
//
// Two rules close it, and they are asserted here at the level the product
// decides them — the real dispatcher, over a real presence record:
//
//   * a field the user cannot SEE cannot veto (chrome/chromefield.ts), and
//   * the LEADER KEY is never vetoed at all: it is the key a Lazyfox user
//     presses to say "Lazyfox, now", and it costs nothing to honour it — the
//     typed text stays in the field, and `;o` is the product's way to enter an
//     address.
describe("the rescue, when the browser's own address bar holds the keyboard", () => {
  /**
   * The reported state: a live web page whose keys the page owns, the keyboard
   * parked in the browser's URL bar, and that bar either hidden (Lazyfox's
   * normal chrome) or revealed by hovering the top strip.
   */
  function setupAddressBar(opts: { visible: boolean; text?: string }) {
    resetContentPresence();
    const env = createFakeChromeEnv({ tabs: [{ url: WEB, active: true }] });
    const win = env.window as any;
    const browser: any = win.gBrowser.selectedBrowser;
    const input: any = {
      tagName: "INPUT",
      value: opts.text ?? "",
      ownerDocument: win.document,
      getBoundingClientRect: () => ({ width: opts.visible ? 320 : 0, height: opts.visible ? 28 : 0 }),
    };
    // `valueIsTyped` is the URL bar's own "the user edited this" flag: true in
    // every case here, because that single flag is what used to make the state
    // permanent.
    win.gURLBar = { inputField: input, ownerDocument: win.document, valueIsTyped: true };
    // The page's script reported in, so the keys are ITS business.
    report(win, true, WEB);
    const fm: any = {
      activeWindow: win,
      focusedElement: input,
      setFocus(el: any) {
        fm.focusedElement = el;
      },
    };
    const leader = fakeLeader();
    const down = createChromeKeyDown({
      win,
      env: { services: { focus: fm } },
      leader: () => leader,
      popup: { isOpen: () => false, handleKey: () => false, close() {}, resizeOnKey: () => false },
      typing: {
        focusedIsTyping: () => true,
        focusedTypingValue: () => String(input.value),
        focusedTypingTarget: () => input,
        reset() {},
      },
      keyGuard: { shouldIgnore: () => false },
      leaderKey: () => ";",
      handleHotkeyCombo: () => false,
      switchSessionByMarker: () => {},
      handleScrollKeys: () => false,
      runWebHints: () => {},
      cancelLeaderHold: () => {},
    } as any) as any;
    return { down, win, browser, input };
  }

  test("`;` gives the page its keyboard back even with typed text in the HIDDEN address bar", () => {
    const { down, browser } = setupAddressBar({ visible: false, text: "gg d" });
    assert.equal(
      down.chromeKeyDown(keydown(";")),
      true,
      "the leader key is consumed as part of the repair — it must never be spent as a character in a field the user cannot see",
    );
    // `>= 1`: focusSelectedContent focuses the browser element and then
    // escalates through the focus manager, which touches it again (see its
    // note on why one element focus is not always enough).
    assert.ok(browser.focusCount >= 1, "the page got its keyboard back");
  });

  test("the branch that did it is named, so a field report can be answered", () => {
    const previous = (globalThis as any).__DEV__;
    (globalThis as any).__DEV__ = true;
    try {
      const { down } = setupAddressBar({ visible: false, text: "gg d" });
      down.chromeKeyDown(keydown(";"));
      assert.equal(down.dispatchTrace().slice(-1)[0].br, "web-page-leader-rescue");
    } finally {
      (globalThis as any).__DEV__ = previous;
    }
  });

  test("a VISIBLE address bar being typed in is never robbed by a plain key", () => {
    const { down, browser } = setupAddressBar({ visible: true, text: "exam" });
    assert.equal(down.chromeKeyDown(keydown("d")), false, "the key is not ours");
    assert.equal(browser.focusCount, 0, "the caret stays in the field the user is typing into");
  });

  test("but the LEADER KEY still wins — that is the user's decision, not a side effect", () => {
    const { down, browser } = setupAddressBar({ visible: true, text: "exam" });
    assert.equal(down.chromeKeyDown(keydown(";")), true);
    assert.ok(browser.focusCount >= 1, "the leader key is honoured even mid-address");
  });

  test("a plain key REPAIRS when the address bar is hidden — the state that had no way out", () => {
    const { down, browser } = setupAddressBar({ visible: false, text: "gg d" });
    assert.equal(down.chromeKeyDown(keydown("d")), false, "the key itself is declined; it is the repair");
    assert.ok(browser.focusCount >= 1, "and the page has the keyboard for the next one");
  });
});

// A KEY IS PROOF THE KEYBOARD IS IN THIS WINDOW.
//
// `selectedContentHasKeyboard` answers YES for a window the focus manager does
// not name as the active one, and that safeguard is right for the TRIGGERS — a
// tab select or a load finishing can happen in a window the user is not in, and
// pulling focus there would be an intrusion. At a KEY it is the freeze in its
// purest form: the keydown was delivered to THIS
// window's listener, so the user's keyboard is here and the manager's answer is
// stale — while believing it means the helper declines the key because "the page
// owns it" and the page sees nothing, because its document is not focused. The
// user's only repair is a click, which is also what makes the manager agree.
//
// The unit case is the only honest way to pin it: a stale focus manager is not a
// state the e2e harness can produce (it cannot make Firefox's focus manager name
// another window and still deliver a key to this one), so the rule is asserted
// where it is decided and the e2e covers the states it can reach.
describe("a stale focus manager does not refuse the repair at a key", () => {
  test("nothing is focused and another window is named active: the page gets the keyboard", () => {
    resetContentPresence();
    const env = createFakeChromeEnv({ tabs: [{ url: WEB, active: true }] });
    const win = env.window as any;
    const browser: any = win.gBrowser.selectedBrowser;
    const otherWindow = { not: "this window" };
    const fm: any = { activeWindow: otherWindow, focusedElement: null, setFocus() {} };
    report(win, true, WEB);
    const leader = fakeLeader();
    const down = createChromeKeyDown({
      win,
      env: { services: { focus: fm } },
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
    } as any) as any;

    assert.equal(down.chromeKeyDown(keydown(";")), true, "the leader key is consumed as part of the repair");
    assert.ok(browser.focusCount >= 1, "the page was given the keyboard rather than left to a click");

    // AND THE OTHER DIRECTION IS UNTOUCHED: when the page really does hold the
    // keyboard (a remote tab reports the browser element itself), nothing moves.
    fm.focusedElement = browser;
    const focusedBefore = browser.focusCount;
    assert.equal(down.chromeKeyDown(keydown(";")), false, "the page owns the key, as it always did");
    assert.equal(browser.focusCount, focusedBefore, "and nothing was refocused");
  });
});

describe("a developer surface is never claimed (K4)", () => {
  const TOOLBOX = "about:devtools-toolbox?type=tab&id=3";

  test("not the key, and not the repair either", () => {
    // THE ORDER IS THE FIX, and this test is about the order rather than about
    // the URL class (scripts/test/privileged.test.ts pins the class). A devtools
    // document is not content-ownable, so the OLD rule called it chrome-owned and
    // the helper answered `j` and `;` there; the ownership latch alone is not
    // enough either, because `chromeOwnsKeys === false` routes the key into the
    // WEB PAGE rescue — which would move the keyboard into the developer's
    // console and spend the leader key doing it. So the dispatcher refuses first:
    // "not ours" and "not touched" have to be the same answer.
    const fm: any = { activeWindow: null, focusedElement: null };
    const { leader, down, win } = setup(TOOLBOX, {
      env: { services: { focus: fm }, Ci: {} },
    });
    const browser = win.gBrowser.selectedBrowser;
    const focused: string[] = [];
    browser.focus = () => focused.push("browser");
    assert.equal(down.chromeKeyDown(keydown("j")), false, "the scroll key stays with devtools");
    assert.equal(down.chromeKeyDown(keydown("d")), false, "and so does a half-page scroll");
    assert.equal(down.chromeKeyDown(keydown(";")), false, "and so does the leader key");
    assert.equal(leader.active, false, "no Lazyfox leader was armed over a developer surface");
    assert.deepEqual(focused, [], "and nothing tried to move the keyboard");
  });

  test("the refusal is named, so the field report can be answered", () => {
    const previous = (globalThis as any).__DEV__;
    (globalThis as any).__DEV__ = true;
    try {
      const { down } = setup(TOOLBOX, { env: { services: { focus: {} }, Ci: {} } });
      down.chromeKeyDown(keydown(";"));
      assert.equal(down.dispatchTrace().slice(-1)[0].br, "devtools-surface");
    } finally {
      (globalThis as any).__DEV__ = previous;
    }
  });

  test("about:debugging is the same class, and about:blank is not", () => {
    // The class travels (the harness can open about:debugging without a debugger
    // connection), and the OTHER edge is pinned in the same test because it is the
    // one a wider rule would break: `about:blank` and its family are exactly the
    // pages whose keys Lazyfox exists to answer.
    const debugging = setup("about:debugging#/runtime/this-firefox", {
      env: { services: { focus: {} }, Ci: {} },
    });
    assert.equal(debugging.down.chromeKeyDown(keydown(";")), false);
    assert.equal(debugging.leader.active, false);

    const blank = setup("about:blank", { env: { services: { focus: {} }, Ci: {} } });
    assert.equal(blank.down.chromeKeyDown(keydown(";")), true, "about:blank is Lazyfox's page");
    assert.equal(blank.leader.active, true);
  });
});
