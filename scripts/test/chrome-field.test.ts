// The veto only protects a field the user can SEE.
//
// The report this file is about, in the user's words: Lazyfox "freezes" until
// they click the page — with the toolbar hidden, so they "never see the URL
// bar". Lazyfox's own chrome CSS renders the URL bar with `display:none`, and
// Firefox still parks the keyboard in it on a fresh tab; one stray character
// typed there sets the URL bar's `valueIsTyped` flag, and from that moment the
// rescue that gives the page its keyboard back was vetoed on EVERY key for the
// life of the window, with nothing on screen to explain it. The user's repair was
// the only one left: a click.
//
// So there are two questions, and they are asserted separately on purpose:
//
//   1. `chromeElementOnScreen` — is this element of the browser's own UI on
//      screen? (`display:none`, a collapsed ancestor, a zero box, or no
//      measurement at all: all "no".)
//   2. `chromeFieldHoldsUserText` — given a field and the text in it, is the
//      USER composing there? The URL bar's own `valueIsTyped`/`usertyping` flags
//      answer for the URL bar, the value answers for every other field, and
//      BOTH are now subject to (1).
//
// Run: node --test --experimental-strip-types --import ./scripts/test/_loader.mjs
//      scripts/test/chrome-field.test.ts   (part of `npm run test:unit`)

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chromeElementOnScreen } from "../../src/chrome/chromefield.ts";
import { chromeFieldHoldsUserText } from "../../src/chrome/commandcenterfocus.ts";
import { createFakeChromeEnv } from "../../src/chrome/env-fake.ts";

const PAGE = "https://example.com/";

/**
 * A chrome field: a box of the given size, and 0x0 when no size is given.
 *
 * The zero box is the DEFAULT on purpose — it is what the hidden URL bar looks
 * like (Lazyfox's `#nav-bar { display: none }`), so a case that forgets to give
 * a field a size is the hidden case rather than a field that accidentally
 * answers "visible". `ownerDocument` is set by the caller, the way the real
 * element's is.
 */
function field(opts: { tag?: string; value?: string; w?: number; h?: number; check?: unknown } = {}): any {
  const el: any = {
    tagName: String(opts.tag || "input").toUpperCase(),
    value: opts.value ?? "",
    ownerDocument: null,
    getBoundingClientRect: () => ({ width: opts.w ?? 0, height: opts.h ?? 0 }),
  };
  if ("check" in opts) {
    el.checkVisibility = typeof opts.check === "function" ? opts.check : () => opts.check === true;
  }
  return el as any;
}

describe("chromeElementOnScreen — the browser's own answer to 'is it there'", () => {
  test("no element is not on screen", () => {
    assert.equal(chromeElementOnScreen(null), false);
    assert.equal(chromeElementOnScreen(undefined), false);
  });

  test("checkVisibility answers when it exists", () => {
    assert.equal(chromeElementOnScreen(field({ check: true })), true);
    assert.equal(chromeElementOnScreen(field({ check: false })), false);
  });

  test("a measurable box is the fallback, and a zero box is the hidden URL bar", () => {
    assert.equal(chromeElementOnScreen(field({ w: 320, h: 28 })), true);
    assert.equal(chromeElementOnScreen(field({ w: 320, h: 0 })), true, "one axis is enough to be rendered");
    assert.equal(chromeElementOnScreen(field({ w: 0, h: 0 })), false);
  });

  test("checkVisibility throwing does not lose the geometry answer", () => {
    const el = field({ w: 200, h: 30 });
    el.checkVisibility = () => {
      throw new Error("not implemented for this element");
    };
    assert.equal(chromeElementOnScreen(el), true);
  });

  test("a rect list is the last resort", () => {
    const el: any = { getClientRects: () => [{ width: 10, height: 10 }] };
    assert.equal(chromeElementOnScreen(el), true);
    assert.equal(chromeElementOnScreen({ getClientRects: () => [] }), false);
  });

  test("an element whose size cannot be read is NOT evidence the user is typing there", () => {
    // The direction of the unknown, and it is deliberate: answering "on screen"
    // here is the freeze (a veto nothing can clear), answering "not on screen"
    // costs an address half typed into a field the user cannot see anyway.
    assert.equal(chromeElementOnScreen({}), false);
    const throwing: any = {
      get checkVisibility() {
        throw new Error("no");
      },
      getBoundingClientRect() {
        throw new Error("no");
      },
      getClientRects() {
        throw new Error("no");
      },
    };
    assert.equal(chromeElementOnScreen(throwing), false);
  });
});

/**
 * A fake chrome window whose URL bar is `input`.
 *
 * The element's GEOMETRY is what says whether the toolbar is rendered (the real
 * rule reads it, see chromefield.ts), so each test states it: no rect at all, or
 * a zero one, is the hidden toolbar Lazyfox's CSS creates.
 */
function windowWithUrlBar(input: any) {
  const env = createFakeChromeEnv({ tabs: [{ url: PAGE, active: true }], ids: { "urlbar-input": input } });
  const ub: any = { inputField: input, ownerDocument: env.document };
  (env.window as any).gURLBar = ub;
  input.ownerDocument = env.document;
  return { env, ub, win: env.window as any };
}

describe("chromeFieldHoldsUserText — a hidden field cannot hold an intent", () => {
  test("the reported state: the hidden URL bar reports valueIsTyped, and it is NOT the user's", () => {
    const input = field({ value: "gg d" });
    const { win, ub } = windowWithUrlBar(input);
    ub.valueIsTyped = true;
    assert.equal(input.getBoundingClientRect().width, 0, "the fake models the hidden toolbar");
    assert.equal(
      chromeFieldHoldsUserText(win, input, "gg d"),
      false,
      "a field the user cannot see must not veto the rescue — that veto is the freeze",
    );
  });

  test("the same field with the toolbar revealed IS the user's", () => {
    const input = field({ value: "exa" });
    input.getBoundingClientRect = () => ({ width: 320, height: 28 });
    const { win, ub } = windowWithUrlBar(input);
    ub.valueIsTyped = true;
    assert.equal(chromeFieldHoldsUserText(win, input, "exa"), true);
  });

  test("usertyping on the input and on the urlbar element answer the same way", () => {
    const input = field({ value: "" });
    input.getBoundingClientRect = () => ({ width: 320, height: 28 });
    const { win, ub } = windowWithUrlBar(input);
    input.getAttribute = (k: string) => (k === "usertyping" ? "true" : null);
    assert.equal(chromeFieldHoldsUserText(win, input, ""), true);
    input.getAttribute = () => null;
    // The host element has the same box when the toolbar is rendered; the rule
    // measures whichever element the focus actually landed on.
    ub.getBoundingClientRect = () => ({ width: 320, height: 28 });
    ub.getAttribute = (k: string) => (k === "usertyping" ? "true" : null);
    assert.equal(chromeFieldHoldsUserText(win, ub, ""), true, "the host element is the same question");
  });

  test("a hidden URL bar that reports usertyping is still not the user's", () => {
    const input = field({ value: "gg d" });
    input.getAttribute = (k: string) => (k === "usertyping" ? "true" : null);
    const { win } = windowWithUrlBar(input);
    assert.equal(chromeFieldHoldsUserText(win, input, "gg d"), false);
  });

  test("another chrome field keeps the simple rule, on screen or not", () => {
    const visible = field({ tag: "input", value: "needle" });
    visible.getBoundingClientRect = () => ({ width: 200, height: 24 });
    const hidden = field({ tag: "input", value: "needle" });
    const { env, win } = windowWithUrlBar(field({}));
    visible.ownerDocument = env.document;
    hidden.ownerDocument = env.document;
    assert.equal(chromeFieldHoldsUserText(win, visible, "needle"), true, "the find bar's text is the user's");
    assert.equal(chromeFieldHoldsUserText(win, hidden, "needle"), false, "a hidden box is not a caret");
    assert.equal(chromeFieldHoldsUserText(win, visible, ""), false, "an empty field holds nothing to protect");
  });

  test("a field in a PAGE is never the browser's UI, whatever it says", () => {
    const pageField = field({ tag: "input", value: "typed in the page" });
    pageField.getBoundingClientRect = () => ({ width: 200, height: 24 });
    const { win } = windowWithUrlBar(field({}));
    // ownerDocument is left null: not the chrome document.
    assert.equal(chromeFieldHoldsUserText(win, pageField, "typed in the page"), false);
  });
});
