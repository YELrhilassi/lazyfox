// The chrome helper draws hint labels on pages where no content script runs
// (about:, error pages, PDFs), and it draws them INTO the page's own DOM with
// inline styles, because a chrome-owned page has no shadow host to hide a
// stylesheet in. That made it the second implementation of "what a hint label
// looks like", and the two drifted: the content labels were a solid teal pill
// while these were a bordered dark chip with blue text, so `;f` looked like two
// different features depending on the page.
//
// The rule now lives in shared/hintlabel.ts and this is the test that says the
// chrome host actually reads it. It drives the REAL createChromePageHints over a
// fake page — the same shape the harness uses elsewhere — and reads the style
// attribute off the labels the engine appended, which is the only thing a user
// sees from this host.
//
// What this does NOT prove: that the labels land in the right PLACE (that is the
// page's own geometry, exercised by the browser suite) or that they look good.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createChromePageHints } from "../../src/chrome/pagehints.ts";
import { HINT_LABEL, hintLabelInlineStyle } from "../../src/shared/hintlabel.ts";

interface FakeLabel {
  tag: string;
  textContent: string;
  attrs: Record<string, string>;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

function makeLabel(tag: string): FakeLabel {
  const el: FakeLabel = {
    tag,
    textContent: "",
    attrs: {},
    removed: false,
    setAttribute(name: string, value: string) {
      el.attrs[name] = value;
    },
    remove() {
      el.removed = true;
    },
  };
  return el;
}

/** A page with `n` visible links, and the document that records what was drawn. */
interface FakeLink {
  href: string;
  getAttribute(): string;
  getBoundingClientRect(): {
    top: number;
    left: number;
    width: number;
    height: number;
    bottom: number;
    right: number;
  };
}

function fakePage(n: number) {
  const links: FakeLink[] = [];
  for (let i = 0; i < n; i++) {
    links.push({
      href: "/target" + i,
      getAttribute: () => "/target" + i,
      getBoundingClientRect: () => ({
        top: 10 + i * 20,
        left: 5,
        width: 120,
        height: 18,
        bottom: 28 + i * 20,
        right: 125,
      }),
    });
  }
  const labels: FakeLabel[] = [];
  const doc = {
    baseURI: "https://example.test/",
    documentElement: { appendChild: () => {} },
    body: {
      appendChild: (el: FakeLabel) => {
        labels.push(el);
      },
    },
    createElement: (tag: string) => makeLabel(tag),
    querySelectorAll: (sel: string) => (sel === "a[href]" || sel === "iframe, frame" ? links : []),
  };
  const cw = { document: doc, innerHeight: 800, innerWidth: 1000, URL };
  const win = { gBrowser: { selectedBrowser: { contentWindow: cw } } };
  // The engine only touches `env` when it OPENS a link, which is not this test's
  // subject; the cast keeps the fake honest about that.
  return { win, labels };
}

function fakeLeader() {
  const armed: string[] = [];
  return {
    armed,
    armPending: (_fn: unknown, opts: { expect?: unknown }) => {
      armed.push(JSON.stringify(opts && opts.expect));
    },
  };
}

describe("chrome-side hint labels", () => {
  test("are drawn with the shared label tokens, not a private style", () => {
    const { win, labels } = fakePage(2);
    const leader = fakeLeader();
    const engine = createChromePageHints({} as never, win as never, () => leader as never);
    engine.show();
    try {
      assert.equal(labels.length, 2, "one label per link");
      for (const label of labels) {
        const style = label.attrs.style || "";
        assert.ok(style.includes("background:" + HINT_LABEL.fill), "the shared fill: " + style);
        assert.ok(style.includes("color:" + HINT_LABEL.text), "the shared text colour: " + style);
        assert.ok(style.includes("font:" + HINT_LABEL.font), "the shared font: " + style);
        assert.ok(
          style.includes("border-radius:" + HINT_LABEL.radius),
          "the shared radius: " + style,
        );
        // The drift, pinned by name: a border and its own font size are what made
        // these labels a different-looking feature.
        assert.ok(!style.includes("border:1px"), "no border of its own: " + style);
        assert.ok(!style.includes("11px"), "no private font size: " + style);
        assert.ok(!style.includes("min-width"), "no private box model: " + style);
      }
      // The position IS this host's business, and it must still be there: the
      // engine nudges each label 2px inside its link so it does not sit on the
      // border, which is why the link's own 10/5 becomes 12/7.
      assert.match(
        labels[0]!.attrs.style!,
        /top:12px;left:7px$/,
        "the label is placed on its link: " + labels[0]!.attrs.style,
      );
      // And it counted the links it could reach.
      assert.equal(labelCount(leader.armed, 2), true, "the one-shot capture was armed for two links");
    } finally {
      engine.clear(); // also stops the 8s cleanup timer, so the test can end
    }
  });

  test("the inline builder is the one place the values are spelled out", () => {
    // A second hand-written style string would defeat the point of the shared
    // module even if this host happened to be right today, so the builder's own
    // output is checked against the tokens too.
    const style = hintLabelInlineStyle("top:1px;left:2px");
    assert.ok(style.includes(HINT_LABEL.fill));
    assert.ok(style.includes(HINT_LABEL.padding));
    assert.ok(style.includes(HINT_LABEL.letterSpacing));
    assert.ok(style.endsWith("top:1px;left:2px"), "the caller's extra is last: " + style);
    assert.equal(
      hintLabelInlineStyle("").includes("pointer-events:none"),
      true,
      "a label never eats a click",
    );
  });
});

/** The capture was armed with a two-digit expectation for two links. */
function labelCount(armed: string[], expected: number): boolean {
  if (armed.length !== 1) return false;
  return armed[0]!.includes(String(expected));
}
