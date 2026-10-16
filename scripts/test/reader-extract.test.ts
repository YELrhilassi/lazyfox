// Reader mode's extraction, driven without a browser.
//
// This is the file that makes the DOM shell thin enough to trust. The scorer,
// the penalty tables and the block collector are all pure, so a page-shaped tree
// is enough to ask the only questions that matter: does it pick the article
// rather than the sidebar, does it refuse when there is no article, and does it
// leave out what the page marked as chrome.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanTitle,
  countWords,
  extractArticle,
  scoreTree,
  MIN_SCORE,
  type Node as Facade,
} from "../../src/extension/content/reader/extract.ts";

/**
 * A façade node whose text and link lengths are derived exactly the way the DOM
 * shell derives them: `own` plus the children's totals, computed on the way up.
 */
function node(tag: string, over: Partial<Facade> = {}): Facade {
  const n: Facade = { tag, text: 0, linkText: 0, depth: over.depth ?? 1, children: [], ...over };
  if (over.text === undefined) {
    n.text = (n.own || "").length + n.children.reduce((sum, c) => sum + c.text, 0);
  }
  if (over.linkText === undefined) {
    n.linkText = n.tag === "a" ? n.text : n.children.reduce((sum, c) => sum + c.linkText, 0);
  }
  return n;
}

function para(chars: number, extra = ""): Facade {
  return node("p", { own: "word ".repeat(Math.floor(chars / 5)).trim() + extra });
}

function links(count: number, chars: number, extra = "link"): Facade[] {
  return Array.from({ length: count }, () => node("a", { own: (extra + " ").repeat(Math.ceil(chars / (extra.length + 1))).trim() }));
}

function articleWith(paragraphs: number, chars: number): Facade {
  return node("article", {
    classes: ["content"],
    children: [node("h1", { own: "The Real Title" }), ...Array.from({ length: paragraphs }, () => para(chars))],
  });
}

describe("picking the article", () => {
  test("the prose container beats the navigation and the sidebar", () => {
    const root = node("div", {
      children: [
        node("nav", { children: links(24, 40, "nav link") }),
        node("aside", { classes: ["sidebar"], children: links(30, 40, "sidebar link") }),
        articleWith(6, 320),
      ],
    });
    const art = extractArticle(root, "The Real Title | Some Site");
    assert.ok(art, "an article must be found");
    assert.equal(art.title, "The Real Title");
    assert.equal(art.blocks.filter((b) => b.kind === "p").length, 6);
    assert.ok(art.words > 300, `expected a real article, got ${art.words} words`);
    const text = art.blocks.map((b) => b.text || "").join(" ");
    assert.ok(text.indexOf("nav link") < 0, "the navigation must not be in the article");
    assert.ok(text.indexOf("sidebar link") < 0, "nor the sidebar");
  });

  test("a link farm loses to prose of the same size", () => {
    // Link density is the one signal that separates a menu from a paragraph, and
    // this is that signal with everything else held equal.
    const root = node("div", {
      children: [
        node("div", { classes: ["comments"], children: links(8, 300, "click here") }),
        node("div", { classes: ["content"], children: [para(600), para(600), para(600)] }),
      ],
    });
    const art = extractArticle(root, "");
    assert.ok(art);
    const text = art.blocks.map((b) => b.text || "").join(" ");
    assert.ok(text.indexOf("click here") < 0);
    assert.equal(art.blocks.filter((b) => b.kind === "p").length, 3);
  });

  test("a page made only of chrome and links has no article, and says so", () => {
    const root = node("div", { children: [node("nav", { children: links(40, 60, "menu entry") })] });
    assert.equal(extractArticle(root, "Site"), null);
  });

  test("a thin page is refused rather than rendered", () => {
    // The failure mode worth avoiding is not "no reader mode": it is a reader
    // mode that opens on a page with almost nothing in it and looks broken.
    const root = node("div", { children: [node("p", { own: "Short note about something." })] });
    assert.equal(extractArticle(root, "Note"), null);
    assert.ok(MIN_SCORE > 0);
  });

  test("a heading with no prose under it is not an article", () => {
    const root = node("div", { children: [node("h1", { own: "A title" }), node("ul", { children: [node("li", { own: "one" })] })] });
    assert.equal(extractArticle(root, ""), null);
  });

  test("the best node is the one with prose in it, even when a wrapper holds more", () => {
    // Wrappers inherit half of their children's evidence, so a generic `div`
    // around a good article cannot outscore the article itself — otherwise every
    // extraction would return the whole page.
    const article = articleWith(5, 400);
    const root = node("div", { children: [article] });
    const { best } = scoreTree(root);
    assert.equal(best, article);
  });

  test("hidden subtrees are not candidates", () => {
    const root = node("div", {
      children: [node("div", { hidden: true, children: [para(5000)] }), articleWith(3, 300)],
    });
    const art = extractArticle(root, "");
    assert.ok(art);
    assert.ok(art.blocks.length > 0);
    const { scores } = scoreTree(root);
    assert.equal(scores.get(root.children[0]!), -Infinity, "a hidden node scores nothing at all");
  });
});

describe("the blocks", () => {
  const root = node("div", {
    children: [
      node("article", {
        classes: ["post"],
        children: [
          node("h1", { own: "Title" }),
          node("h2", { own: "A section" }),
          para(300),
          node("blockquote", { own: "Quoted words that are long enough to keep." }),
          node("pre", { own: "const a = 1;\nconst b = 2;" }),
          node("figure", { children: [node("img", { src: "https://x.test/a.png", alt: "A picture", own: "" })] }),
          node("ul", { children: [node("li", { own: "First item" }), node("li", { own: "Second item" }), node("li", { own: "" })] }),
          node("ol", { children: [node("li", { own: "Step one" })] }),
          node("hr", {}),
          para(300),
          para(300),
        ],
      }),
    ],
  });

  test("headings keep their level, and prose keeps its order", () => {
    const art = extractArticle(root, "")!;
    const kinds = art.blocks.map((b) => b.kind);
    assert.deepEqual(kinds.slice(0, 5), ["h", "h", "p", "quote", "pre"]);
    assert.equal(art.blocks[1]!.level, 2);
  });

  test("the page's own title is preferred to the document's", () => {
    assert.equal(extractArticle(root, "Something | Site")!.title, "Title");
  });

  test("lists, quotes, code and images are carried over", () => {
    const art = extractArticle(root, "")!;
    const list = art.blocks.find((b) => b.kind === "ul");
    assert.deepEqual(list?.items, ["First item", "Second item"], "an empty item is dropped");
    const ol = art.blocks.find((b) => b.kind === "ol");
    assert.deepEqual(ol?.items, ["Step one"]);
    assert.ok(art.blocks.some((b) => b.kind === "quote"));
    assert.ok(art.blocks.some((b) => b.kind === "pre"));
    assert.ok(art.blocks.some((b) => b.kind === "img" && b.src === "https://x.test/a.png"));
    assert.ok(art.blocks.some((b) => b.kind === "rule"));
  });

  test("images can be left behind", () => {
    const art = extractArticle(root, "", false)!;
    assert.ok(!art.blocks.some((b) => b.kind === "img"));
    assert.ok(art.blocks.some((b) => b.kind === "p"), "and the text is unaffected");
  });

  test("chrome inside the article is dropped by its class", () => {
    const withChrome = node("div", {
      children: [
        node("article", {
          classes: ["content"],
          children: [para(400), node("div", { classes: ["share-buttons"], children: [para(400)] }), para(400)],
        }),
      ],
    });
    const art = extractArticle(withChrome, "")!;
    assert.equal(art.blocks.filter((b) => b.kind === "p").length, 2);
  });

  test("a byline is found when the page names one, and never invented", () => {
    const withByline = node("div", {
      children: [
        node("article", {
          classes: ["content"],
          children: [node("div", { classes: ["byline"], own: "By Jane Doe" }), para(400), para(400)],
        }),
      ],
    });
    assert.equal(extractArticle(withByline, "")!.byline, "By Jane Doe");
    assert.equal(extractArticle(root, "")!.byline, "");
  });

  test("the block list is capped", () => {
    // A pathological page must not be able to build an unbounded tree: the cap
    // is the difference between a slow render and a frozen tab.
    const huge = node("div", {
      children: [node("article", { classes: ["content"], children: Array.from({ length: 700 }, () => para(120)) })],
    });
    const art = extractArticle(huge, "")!;
    assert.ok(art.blocks.length <= 600, `expected at most 600 blocks, got ${art.blocks.length}`);
    assert.ok(art.blocks.length >= 500, "and it should still collect a lot of them");
  });
});

describe("titles and counts", () => {
  test("a site suffix is stripped when the title is long enough to have one", () => {
    assert.equal(cleanTitle("A Real Article Title | Example News"), "A Real Article Title");
    assert.equal(cleanTitle("A Real Article Title – Example"), "A Real Article Title");
    assert.equal(cleanTitle("A Real Article Title · Site"), "A Real Article Title");
  });

  test("a separator early in a short title is part of the title", () => {
    // "Home - Site" is a page name, not an article: cutting at position 5 would
    // leave "Home", which is a heading for something that is not this page.
    assert.equal(cleanTitle("Home - Site"), "Home - Site");
    assert.equal(cleanTitle("Notes"), "Notes");
    assert.equal(cleanTitle(""), "");
  });

  test("word counting follows the blocks", () => {
    assert.equal(countWords([{ kind: "p", text: "one two three" }, { kind: "ul", items: ["four five"] }]), 5);
    assert.equal(countWords([]), 0);
  });
});
