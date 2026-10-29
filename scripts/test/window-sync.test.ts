// The keyboard rule's TRIGGERS, driven in Node.
//
// WHY THIS FILE EXISTS. `src/chrome/keyboardfocus.ts` decides WHERE the
// keyboard belongs, and it is pure and tested (`keyboard-focus.test.ts`). What
// it cannot test is WHEN it is asked: that is chrome/winsync.ts, and every one
// of its triggers is an EVENT — a tab selected, a document replaced, a
// document finished loading, the window finished booting. Those events cannot
// be replayed by hand in a browser, and missing ONE of them is exactly the
// reported freeze: `;n` opened the home tab, the tab was in front, and no key
// reached it until the user clicked the page, because the only trigger that
// could have fired ran while the tab's document did not exist yet.
//
// So the rules this file pins are the ones that decide whether an event is a
// trigger at all:
//
//   * a TOP-LEVEL load stop fires it; a subdocument's does not (a frame
//     finishing is not a change of who the keyboard belongs to);
//   * only the SELECTED tab's load fires it (a background tab must not take
//     the keyboard away from the page the user is looking at);
//   * a TabSelect fires it;
//   * a window whose document is already loaded fires it once at boot (the
//     first tab of a session has no tab-select to announce it).
//
// Run: node --test --experimental-strip-types --import ./scripts/test/_loader.mjs
//      scripts/test/window-sync.test.ts   (part of `npm run test:unit`)

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { installWinSync } from "../../src/chrome/winsync.ts";
import { createFakeChromeEnv } from "../../src/chrome/env-fake.ts";

/**
 * The smallest deps object installWinSync accepts, with the keyboard recorded.
 *
 * `readyState` is the chrome document's own state at install time — the fact
 * the boot rule branches on (a window whose document is complete applies the
 * rule now; one still loading waits for its `load` event).
 */
function harness(opts: { readyState?: string; autoRunTimers?: boolean } = {}) {
  const env = createFakeChromeEnv({
    tabs: [
      { url: "http://example.com/a", active: true },
      { url: "http://example.com/b" },
    ],
    autoRunTimers: opts.autoRunTimers,
  });
  if (opts.readyState) (env.document as any).readyState = opts.readyState;
  const calls: string[] = [];
  installWinSync({
    env,
    channel: {
      startRelay: () => true,
      poll: () => {},
      requestSessionState: () => Promise.resolve(),
      handleLfc: () => {},
    },
    alive: { announce: () => {} },
    split: { rememberSplit: () => {} },
    status: {
      update: () => {},
      compute: () => {},
      pollDownloads: () => Promise.resolve(),
      setActiveStealth: () => {},
      getStealthFlags: () => [],
      isStealthTab: () => false,
    },
    leader: () => null,
    keyboard: {
      giveKeyboardToSelectedPage: () => {
        calls.push("give");
        return "content";
      },
    },
  });
  const selected = env.window.gBrowser.selectedBrowser;
  const other = env.window.gBrowser.tabs[1].linkedBrowser;
  return { env, calls, selected, other };
}

/** One `onStateChange` call, with the state flags the caller asks for. */
function stop(env: any, browser: any, flags: number) {
  const listener = env.progressListeners[0];
  assert.ok(listener, "the helper must register a tab progress listener to see documents load");
  assert.equal(typeof listener.onStateChange, "function", "it must handle load state changes");
  listener.onStateChange(browser, {}, {}, flags);
}

const STOP = 0x10;
const IS_WINDOW = 0x80000;
const IS_DOCUMENT = 0x20000;
const START = 0x1;

describe("the keyboard rule's triggers", () => {
  test("a top-level document finishing loading in the SELECTED tab gives it the keyboard", () => {
    // The trigger the reported freeze was missing. `;n` opens the home tab;
    // the tab select and the location change both run against a document that
    // is about to be replaced, so the document that finally arrives finds
    // nobody has the keyboard at all.
    const h = harness();
    h.calls.length = 0;
    stop(h.env, h.selected, STOP | IS_WINDOW);
    assert.deepEqual(h.calls, ["give"], "a load stop in the selected tab is the moment the rule runs");
  });

  test("a BACKGROUND tab finishing loading does not take the keyboard from the page", () => {
    // The other direction, and the reason the tab is checked at all: a page the
    // user is not looking at loading in the background must never move the
    // keyboard out of the page on screen.
    const h = harness();
    h.calls.length = 0;
    stop(h.env, h.other, STOP | IS_WINDOW);
    assert.deepEqual(h.calls, [], "only the selected tab's document may be given the keyboard");
  });

  test("a SUBDOCUMENT finishing loading is not a change of who has the keyboard", () => {
    // A frame is a different document and a real load stop — but the user's
    // keyboard has not moved anywhere, and acting on it would pull focus out of
    // whatever the user is doing (an embedded app's field, for one).
    const h = harness();
    h.calls.length = 0;
    stop(h.env, h.selected, STOP | IS_DOCUMENT);
    assert.deepEqual(h.calls, [], "a frame's load stop is not a keyboard event");
  });

  test("only a STOP is a trigger, never a start or a redirect", () => {
    const h = harness();
    h.calls.length = 0;
    stop(h.env, h.selected, START | IS_WINDOW);
    stop(h.env, h.selected, 0x08000000 | IS_WINDOW); // STATE_REDIRECTING
    assert.deepEqual(h.calls, [], "the rule runs when the document is DONE, not when it begins");
  });

  test("selecting a tab gives its page the keyboard", () => {
    const h = harness();
    h.calls.length = 0;
    h.env.dispatchTabSelect();
    assert.deepEqual(h.calls, ["give"], "TabSelect is the oldest of the triggers");
  });

  test("a window that is already up gives its first page the keyboard once", () => {
    // The first document of a session has no tab-select and no location change
    // to announce it: the window opens with its first tab already selected. The
    // boot trigger is what a real user's first keystroke depends on, and it has
    // to be ONE call (a rule applied twice is a page focused twice, which on a
    // page whose own focus handler scrolls is not free).
    const h = harness({ readyState: "complete", autoRunTimers: true });
    assert.deepEqual(h.calls, ["give"], "boot applies the rule once");
    h.env.dispatchWindow("load");
    assert.deepEqual(h.calls, ["give"], "and a later load event does not apply it again");
  });

  test("a window still loading defers the boot rule to its load event", () => {
    // The other half of the same rule: the helper can be installed before the
    // chrome document is complete (the loader injects it during window init),
    // and a rule run then would be aimed at a window whose own selected tab is
    // not there yet.
    const h = harness({ autoRunTimers: true });
    assert.deepEqual(h.calls, [], "nothing runs while the window is still loading");
    h.env.dispatchWindow("load");
    assert.deepEqual(h.calls, ["give"], "the window's own load is the moment");
  });
});
