// shared/dom.ts — which element a keystroke really happened in.
//
// The bug this pins: typing detection read `e.target`, and for a keystroke
// inside a CLOSED shadow root (YouTube's search box, Reddit's input, most
// component libraries) the event is retargeted to the HOST custom element.
// The host is not a typing target, so Lazyfox decided nobody was typing and
// ran a binding — measured, `;x` typed into such a field CLOSED A TAB.
//
// The fix is not `composedPath()`. Measured in Firefox 158 against a real
// closed-root field, the composed path is `[host, body, html, document,
// window]` — Gecko keeps the shadow tree out of it, so `path[0]` is the host
// as well. The only view that reaches inside is the one Firefox gives
// extensions: `element.openOrClosedShadowRoot` (and `browser.dom.` for other
// hosts). These tests pin that door, and pin what happens without it, so the
// fallback order cannot silently regress into "closed roots are invisible".

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deepTypingFocus, isTypingEvent, isTypingTarget, typingTargetOf } from "../../src/shared/dom.ts";

// Enough of an Element for the predicate: tagName, the attribute probes, and
// the two shadow-root doors.
type FakeEl = {
  tagName: string;
  isContentEditable?: boolean;
  getAttribute?: (n: string) => string | null;
  closest?: (sel: string) => unknown;
  shadowRoot?: unknown;
  openOrClosedShadowRoot?: unknown;
};

const el = (tag: string, extra: FakeEl = {}): FakeEl => ({
  tagName: tag,
  isContentEditable: false,
  getAttribute: () => null,
  closest: () => null,
  ...extra,
});

const input = el("INPUT");
const textarea = el("TEXTAREA");
const host = el("CLOSED-FIELD");

// A closed root: `shadowRoot` is null (the page's view) while the extension
// door hands over the real root.
const closedRoot = { mode: "closed", activeElement: input };
host.shadowRoot = null;
host.openOrClosedShadowRoot = closedRoot;

// The event a window-level capture listener sees for a keystroke inside that
// closed root: retargeted host, and a composed path that does NOT contain the
// field.
const keydownInClosedRoot = () =>
  ({
    key: "x",
    target: host,
    composedPath: () => [host, el("BODY"), el("HTML"), { nodeName: "#document" }],
  }) as unknown as Event;

describe("a keystroke inside a closed shadow root reads as typing", () => {
  test("the extension's shadow-root door resolves the host to the field", () => {
    assert.equal(deepTypingFocus(host as unknown as Element), input);
  });

  test("isTypingEvent says the user is typing", () => {
    assert.equal(isTypingEvent(keydownInClosedRoot()), true);
  });

  test("the resolved element is the FIELD, not the host", () => {
    // Returning the host would keep every caller that inspects the element
    // (focus, scroll-into-view, the popup's own field handling) pointed at a
    // node with nothing to type into.
    assert.equal(typingTargetOf(keydownInClosedRoot()), input);
  });

  test("a textarea behind the same host counts too", () => {
    closedRoot.activeElement = textarea;
    try {
      assert.equal(isTypingEvent(keydownInClosedRoot()), true);
    } finally {
      closedRoot.activeElement = input;
    }
  });

  test("a host with nothing focused inside it is not typing", () => {
    // The door must not turn EVERY custom element into a text field, or the
    // leader would stop working anywhere a component library is on the page.
    closedRoot.activeElement = el("DIV");
    try {
      assert.equal(isTypingEvent(keydownInClosedRoot()), false);
    } finally {
      closedRoot.activeElement = input;
    }
  });
});

describe("without the extension door, a closed root stays invisible", () => {
  // Documented, not wished away: in a page context (and in any browser that
  // does not implement the door) there is nothing to see inside a closed
  // root. This test exists so that assumption is a pinned fact rather than a
  // comment somebody re-derives.
  const bare = el("CLOSED-FIELD");

  test("the host does not read as typing", () => {
    assert.equal(isTypingTarget(bare as unknown as Element), false);
    assert.equal(
      deepTypingFocus(bare as unknown as Element),
      bare,
      "nothing to walk into"
    );
  });
});

describe("browser.dom is used when the element property is absent", () => {
  test("the API path opens the root", () => {
    const g = globalThis as unknown as {
      browser?: unknown;
    };
    const had = Object.prototype.hasOwnProperty.call(g, "browser");
    const before = g.browser;
    const hostNoProp = el("CLOSED-FIELD");
    hostNoProp.openOrClosedShadowRoot = undefined;
    g.browser = {
      dom: {
        openOrClosedShadowRoot: (e: unknown) => (e === hostNoProp ? closedRoot : null),
      },
    };
    try {
      assert.equal(deepTypingFocus(hostNoProp as unknown as Element), input);
    } finally {
      if (had) g.browser = before;
      else delete g.browser;
    }
  });

  test("a throwing door is survivable", () => {
    const g = globalThis as unknown as { browser?: unknown };
    const had = Object.prototype.hasOwnProperty.call(g, "browser");
    const before = g.browser;
    g.browser = {
      dom: {
        openOrClosedShadowRoot: () => {
          throw new Error("not allowed here");
        },
      },
    };
    try {
      const plain = el("INPUT");
      assert.equal(deepTypingFocus(plain as unknown as Element), plain);
    } finally {
      if (had) g.browser = before;
      else delete g.browser;
    }
  });
});

describe("the ordinary cases are unchanged", () => {
  test("a plain input", () => {
    const target = el("INPUT");
    assert.equal(
      isTypingEvent({ key: "a", target, composedPath: () => [target] } as unknown as Event),
      true
    );
  });

  test("a plain div is not typing", () => {
    const target = el("DIV");
    assert.equal(
      isTypingEvent({ key: "a", target, composedPath: () => [target] } as unknown as Event),
      false
    );
  });

  test("a contenteditable div is typing", () => {
    const target = el("DIV", { isContentEditable: true });
    assert.equal(
      isTypingEvent({ key: "a", target, composedPath: () => [target] } as unknown as Event),
      true
    );
  });

  test("an OPEN root resolves through composedPath", () => {
    const openHost = el("MY-INPUT");
    openHost.shadowRoot = { mode: "open", activeElement: input };
    const wrapped = el("SPAN");
    assert.equal(
      typingTargetOf(
        {
          key: "a",
          target: openHost,
          composedPath: () => [wrapped, openHost],
        } as unknown as Event
      ),
      input,
      "the field inside the open root is the answer, not the wrapper"
    );
  });
});