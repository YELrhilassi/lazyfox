// The keyboard follows the tab. One rule, two triggers, and the report it exists
// for: "Lazyfox stopped responding and I have to click the page before a key
// works".
//
// WHY THIS IS NOT A TEST OF A FOCUS HELPER. A keydown is delivered to the
// FOCUSED document and nowhere else, so when keyboard focus is parked in the
// browser's own UI — the tab strip, the hidden URL bar a fresh tab starts with —
// the page's content script never sees the key. Nothing about that state looks
// broken: the tab is selected, the page is painted, `document.activeElement` is
// even the BODY (a document with no focused element reports exactly that, which
// is why "the body is active" is not "the page has the keyboard"). The only
// repair a user finds is a click, and the tab actions that leave you there are
// the ones driven from the keyboard, where no click ever happens.
//
// The rule's EXCEPTIONS are asserted here as hard as its happy path, because
// each one is a state where pulling focus into the page would be a new bug: a
// live Lazyfox popup owns the keyboard by design, a relay/`#lfc=` carrier is
// removed a moment later, and a chrome text field holding TEXT belongs to the
// user (the same exception the key dispatcher already makes for an empty URL bar
// versus a typed one).
//
// Run: node --test --experimental-strip-types --import ./scripts/test/_loader.mjs
//      scripts/test/keyboard-focus.test.ts   (part of `npm run test:unit`)

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createKeyboardFocus,
  keyboardTargetFor,
  readKeyboardFacts,
  type KeyboardFacts,
} from "../../src/chrome/keyboardfocus.ts";
import { focusCCBody, focusSelectedContent } from "../../src/chrome/commandcenterfocus.ts";
import { createFakeChromeEnv } from "../../src/chrome/env-fake.ts";

const PAGE = "https://example.com/";
const CC = "moz-extension://abc/commandcenter.html";
const RELAY = "moz-extension://abc/relay.html";
const CARRIER = "moz-extension://abc/commandcenter.html#lfc=req.abc";

const noFacts: KeyboardFacts = {
  popupOpen: false,
  transientTab: false,
  commandCenter: false,
  chromeFieldHasText: false,
};

/**
 * A field in the browser's own UI, on screen or not.
 *
 * The size is part of the fact and not decoration: `chromeFieldHasText` now asks
 * whether the field is RENDERED before it vetoes the pull (see
 * chrome/chromefield.ts), because Lazyfox renders the URL bar with
 * `display:none` and a field nobody can see must not be able to hold the repair
 * off for ever. A zero box is what the hidden toolbar measures.
 */
function chromeField(opts: { tag?: string; value?: string; w?: number; h?: number } = {}): any {
  return {
    tagName: String(opts.tag || "INPUT").toUpperCase(),
    value: opts.value ?? "",
    getBoundingClientRect: () => ({ width: opts.w ?? 0, height: opts.h ?? 0 }),
  };
}

/** The fake window with one selected tab, plus the rule wired to it. */
function harness(
  url: string,
  opts: { popupOpen?: boolean; asCommandCenter?: boolean; activeElement?: any } = {}
) {
  const env = createFakeChromeEnv({ tabs: [{ url, active: true }] });
  if (opts.activeElement) env.document.activeElement = opts.activeElement;
  const browser = env.tabs[0].linkedBrowser;
  const calls = { commandCenter: 0 };
  const deps = {
    win: env.window,
    popupOpen: () => !!opts.popupOpen,
    // The real predicate is channel.isKnownRelayTab (an identity check); the URL
    // test covers the other half of the same product rule (primitives.realTabs).
    isRelayTab: () => false,
    commandCenter: () => !!opts.asCommandCenter,
    focusCommandCenter: () => {
      calls.commandCenter++;
    },
    // The REAL applier for an ordinary page, so the assertion below covers the
    // whole chain (rule -> focusSelectedContent -> the browser element) rather
    // than a spy that would pass with the rule wired to nothing.
    focusContent: () => focusSelectedContent(env.window),
  };
  const keyboard = createKeyboardFocus(deps);
  return { env, browser, calls, keyboard, deps };
}

describe("keyboardTargetFor — the rule, one line per state", () => {
  test("a plain page gets the keyboard", () => {
    assert.equal(keyboardTargetFor(noFacts), "content");
  });

  test("the command center gets it through its own helper", () => {
    assert.equal(keyboardTargetFor({ ...noFacts, commandCenter: true }), "command-center");
  });

  test("a live chrome popup keeps it", () => {
    assert.equal(keyboardTargetFor({ ...noFacts, popupOpen: true }), "none");
  });

  test("a relay or #lfc= carrier is left alone — it is removed a moment later", () => {
    assert.equal(keyboardTargetFor({ ...noFacts, transientTab: true }), "none");
  });

  test("a chrome text field holding text belongs to the user", () => {
    assert.equal(keyboardTargetFor({ ...noFacts, chromeFieldHasText: true }), "none");
  });

  test("a popup beats the command center, and a carrier beats everything", () => {
    // Order matters, not just membership: these combinations are reachable (a
    // popup opened ON the home page, a carrier whose URL names the command
    // center — every `#lfc=` carrier IS a command-center URL), and each must
    // resolve to the refusal rather than to the pull.
    assert.equal(keyboardTargetFor({ ...noFacts, popupOpen: true, commandCenter: true }), "none");
    assert.equal(keyboardTargetFor({ ...noFacts, transientTab: true, commandCenter: true }), "none");
    assert.equal(
      keyboardTargetFor({ ...noFacts, transientTab: true, popupOpen: true, commandCenter: true }),
      "none"
    );
  });
});

describe("readKeyboardFacts — the facts, read from the window", () => {
  test("a relay URL is recognised as one of Lazyfox's own carriers", () => {
    const h = harness(RELAY);
    assert.equal(readKeyboardFacts(h.deps).transientTab, true);
  });

  test("an #lfc= request carrier is too", () => {
    const h = harness(CARRIER);
    assert.equal(readKeyboardFacts(h.deps).transientTab, true);
  });

  test("a web page is not", () => {
    const h = harness(PAGE);
    assert.equal(readKeyboardFacts(h.deps).transientTab, false);
  });
});

describe("giveKeyboardToSelectedPage — what actually happens", () => {
  test("a web page's browser element is focused", () => {
    const h = harness(PAGE);
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "content");
    assert.equal(h.browser.focusCount, 1, "the selected tab's content was focused");
  });

  test("the command center goes through its own helper, not the browser element", () => {
    // The distinction is load-bearing: focusing a command center's <browser>
    // element hands the caret to its search box, which is INSERT mode — the
    // user's next `;` would be typed instead of run.
    const h = harness(CC, { asCommandCenter: true });
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "command-center");
    assert.equal(h.calls.commandCenter, 1);
    assert.equal(h.browser.focusCount, 0, "the browser element must not be focused for the home page");
  });

  test("nothing happens while a popup owns the keyboard", () => {
    const h = harness(PAGE, { popupOpen: true });
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "none");
    assert.equal(h.browser.focusCount, 0);
  });

  test("nothing happens on a relay tab", () => {
    const h = harness(RELAY);
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "none");
    assert.equal(h.browser.focusCount, 0);
  });

  test("nothing happens while the user's own text is in a VISIBLE chrome field", () => {
    // The toolbar revealed by hovering the top strip, the address bar clicked,
    // an address half typed: that is a user composing, and the first character
    // of their URL must not yank focus into the page.
    const h = harness(PAGE, {
      activeElement: chromeField({ value: "https://half typed", w: 320, h: 28 }),
    });
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "none");
    assert.equal(h.browser.focusCount, 0);
  });

  test("a HIDDEN chrome field holding stray text does not stop the pull — the reported freeze", () => {
    // THE REPORT, as a state: Lazyfox hides the URL bar outright, Firefox still
    // parks the keyboard in it on a fresh tab, and one stray keystroke sets its
    // `valueIsTyped` flag. Before this rule, that made every trigger in this
    // module refuse to move the keyboard — invisibly, for the life of the
    // window — and the only repair left was the click the user complained about.
    const h = harness(PAGE, {
      activeElement: chromeField({ value: "gg d", w: 0, h: 0 }),
    });
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "content");
    assert.equal(h.browser.focusCount, 1, "the page got its keyboard back");
  });

  test("an EMPTY chrome field is not the user's — the hidden URL bar is taken from it", () => {
    // This is the state a fresh tab starts in, and the rewrite behind the whole
    // rule: an empty URL bar holds no content to protect, and leaving the
    // keyboard there is the dead keyboard the user has to click out of. The
    // dispatcher's own rule is the same one (keysdispatch.ts: a field that holds
    // TEXT always wins; an empty one is where a sequence continues).
    const h = harness(PAGE, { activeElement: chromeField({ value: "", w: 320, h: 28 }) });
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "content");
    assert.equal(h.browser.focusCount, 1);
  });

  test("a chrome field that is not a text field at all does not stop the pull", () => {
    const h = harness(PAGE, { activeElement: chromeField({ tag: "TOOLBARBUTTON", w: 24, h: 24 }) });
    assert.equal(h.keyboard.giveKeyboardToSelectedPage(), "content");
    assert.equal(h.browser.focusCount, 1);
  });
});

describe("the command center's own focus helper", () => {
  test("an unreachable document — a cross-process tab — makes it focus the browser element", () => {
    // The measured failure: `;n` opened the home tab, the tab was in front, and
    // the page answered no keys until it was clicked. The page's own
    // `body.focus()` cannot claim a keyboard the tab does not have, and a page
    // in another process cannot be reached to try; the browser element is the
    // one handle the parent process has.
    const env = createFakeChromeEnv({ tabs: [{ url: CC, active: true }] });
    const browser = env.tabs[0].linkedBrowser;
    assert.equal(browser.contentWindow, null, "the fake models an out-of-process document");
    focusCCBody(env.window);
    assert.equal(browser.focusCount, 1);
  });

  test("one element focus is not always enough, and the escalation is measured", () => {
    // THE `;n` CASE, reproduced without a browser: the window is active, NOTHING
    // has the keyboard, and `selectedBrowser.focus()` alone does not put it
    // back — which is the state a user repairs with a click.
    const env = createFakeChromeEnv({ tabs: [{ url: PAGE, active: true }] });
    const browser = env.tabs[0].linkedBrowser;
    let focusedElement: any = null;
    const fm = {
      activeWindow: env.window,
      get focusedElement() {
        return focusedElement;
      },
      setFocus(el: any) {
        focusedElement = el;
      },
    };
    focusSelectedContent(env.window, fm);
    assert.equal(browser.focusCount >= 1, true, "the element focus was tried");
    assert.equal(focusedElement, browser, "the focus manager was asked as the last resort");
  });

  test("when the content already holds it, nothing escalates", () => {
    const env = createFakeChromeEnv({ tabs: [{ url: PAGE, active: true }] });
    const browser = env.tabs[0].linkedBrowser;
    const fm = {
      activeWindow: env.window,
      focusedElement: browser,
      setFocus() {
        throw new Error("the focus manager must not be asked when the content has the keyboard");
      },
    };
    focusSelectedContent(env.window, fm);
    assert.equal(browser.focusCount, 1, "exactly the element focus ran");
  });

  test("another window's keyboard is never taken", () => {
    const env = createFakeChromeEnv({ tabs: [{ url: PAGE, active: true }] });
    const fm = {
      activeWindow: { not: "this window" },
      focusedElement: null,
      setFocus() {
        throw new Error("a background window must not grab the focus manager");
      },
    };
    focusSelectedContent(env.window, fm);
  });

  test("focusSelectedContent is the same one handle, and never throws on a dead tab", () => {
    const env = createFakeChromeEnv({ tabs: [{ url: PAGE, active: true }] });
    const browser = env.tabs[0].linkedBrowser;
    focusSelectedContent(env.window);
    assert.equal(browser.focusCount, 1);
    // A torn-down window is not an exception to the rule, only a call with
    // nothing to focus: the next tab switch tries again.
    assert.doesNotThrow(() => focusSelectedContent({ document: env.document } as any));
  });
});
