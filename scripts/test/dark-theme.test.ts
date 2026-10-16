// What the dark engine decides, and the CSS it writes.
//
// The two halves that a browser cannot be asked about cheaply are both here:
// "would a page that looks like THIS be themed?" is a pure question about
// samples, and "what does the sheet look like?" is a pure question about strings.
// The e2e suite covers the remaining half — that a real page really is painted —
// and it is a much smaller surface because of this file.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { analyze, chooseEngine, shouldApply, type PageSample } from "../../src/extension/content/dark/detect.ts";
import { buildTheme, composeSheet, entriesFor, fallbackSheet, OUR_HOSTS } from "../../src/extension/content/dark/theme.ts";
import { parseFixList } from "../../src/shared/dark-rules.ts";
import { DARK_DEFAULTS } from "../../src/shared/config.ts";
import { relativeLuminance, parseColor } from "../../src/extension/content/dark/color.ts";

function sample(over: Partial<PageSample> & { area: number }): PageSample {
  return {
    selector: ".x",
    tag: "DIV",
    bg: "rgb(255, 255, 255)",
    fg: "rgb(17, 17, 17)",
    hasBgImage: false,
    media: false,
    ...over,
  };
}

const LIGHT_PAGE = [
  sample({ selector: "body", tag: "BODY", bg: "rgb(255, 255, 255)", fg: "rgb(17, 17, 17)", area: 500_000 }),
  sample({ selector: ".card", bg: "rgb(245, 245, 245)", fg: "rgb(51, 51, 51)", area: 100_000 }),
];

const DARK_PAGE = [
  sample({ selector: "body", tag: "BODY", bg: "rgb(24, 24, 27)", fg: "rgb(228, 228, 231)", area: 600_000 }),
];

describe("reading a page from its samples", () => {
  test("the canvas is the surface with the most area, and the text sits on it", () => {
    const a = analyze(LIGHT_PAGE);
    assert.equal(a.canvasKey, analyze([sample({ area: 500_000 })])!.canvasKey);
    assert.deepEqual(a.text, parseColor("rgb(17, 17, 17)"));
    assert.equal(a.pageDark, false);
    assert.equal(a.sampled, true);
  });

  test("an already-dark page is recognised as dark", () => {
    const a = analyze(DARK_PAGE);
    assert.equal(a.pageDark, true);
    assert.ok(relativeLuminance(a.canvas) < 0.4);
  });

  test("text is only taken from elements that CONTRAST with the canvas", () => {
    // A big pale panel whose own border colour is close to the canvas must not be
    // mistaken for the page's text: the theme's text pole would then be a panel
    // colour, and every heading on the page would be mapped to near-canvas.
    const a = analyze([
      sample({ selector: "body", area: 500_000, fg: "rgb(250, 250, 250)" }),
      sample({ selector: ".panel", bg: "rgb(240, 240, 240)", fg: "rgb(20, 20, 20)", area: 400_000 }),
    ]);
    assert.deepEqual(a.text, parseColor("rgb(20, 20, 20)"));
  });

  test("a page of background images cannot be mapped, and says so", () => {
    // Coverage is the engine's confidence. A background image is a surface the
    // engine will not touch, so it must not count as understood — otherwise the
    // page gets a remap that leaves half of it light.
    const a = analyze([
      sample({ selector: ".hero", area: 400_000, hasBgImage: true }),
      sample({ selector: ".banner", area: 400_000, hasBgImage: true }),
      sample({ selector: ".card", area: 100_000 }),
    ]);
    assert.ok(a.coverage < 0.2, `coverage was ${a.coverage}`);
    assert.equal(chooseEngine("auto", a), "filter");
  });

  test("a flat page is understood, and gets the palette engine", () => {
    const a = analyze(LIGHT_PAGE);
    assert.equal(a.coverage, 1);
    assert.equal(chooseEngine("auto", a), "dynamic");
  });

  test("media is not a surface, and is not sampled as one", () => {
    const a = analyze([
      sample({ selector: "body", area: 500_000 }),
      sample({ selector: "img", tag: "IMG", media: true, bg: "rgb(10, 10, 10)", area: 900_000 }),
    ]);
    assert.deepEqual(a.canvas, parseColor("rgb(255, 255, 255)"));
    assert.equal(a.coverage, 1);
  });

  test("nothing usable falls back to a light page rather than no decision", () => {
    const a = analyze([]);
    assert.equal(a.sampled, false);
    assert.equal(a.pageDark, false);
    assert.equal(chooseEngine("auto", a), "filter", "a page we cannot read is inverted, not half-mapped");
  });

  test("a forced engine is not second-guessed", () => {
    const flat = analyze(LIGHT_PAGE);
    const messy = analyze([sample({ area: 1000, hasBgImage: true })]);
    assert.equal(chooseEngine("filter", flat), "filter");
    assert.equal(chooseEngine("dynamic", messy), "dynamic");
  });
});

describe("whether to apply at all", () => {
  const light = analyze(LIGHT_PAGE);
  const dark = analyze(DARK_PAGE);

  test("auto leaves a dark page alone — the whole point of the feature", () => {
    const d = shouldApply("darken", dark, true);
    assert.equal(d.on, false);
    assert.match(d.reason, /already dark/);
  });

  test("auto themes a light page", () => {
    assert.equal(shouldApply("darken", light, true).on, true);
  });

  test("an explicit choice does not consult the detection", () => {
    // `;Y d` on a page the detector thinks is dark must still do something: the
    // user pressed a key, and a key that answers "no" is a broken key.
    assert.equal(shouldApply("darken", dark, false).on, true);
    assert.equal(shouldApply("lighten", light, false).on, true);
  });

  test("light mode is the mirror image", () => {
    assert.equal(shouldApply("lighten", dark, true).on, true);
    const onLight = shouldApply("lighten", light, true);
    assert.equal(onLight.on, false);
    assert.match(onLight.reason, /already light/);
  });

  test("every reason is a phrase, never empty", () => {
    for (const [dir, a, skip] of [
      ["darken", light, true],
      ["darken", dark, true],
      ["lighten", light, true],
      ["lighten", dark, true],
      ["darken", light, false],
    ] as const) {
      assert.ok(shouldApply(dir, a, skip).reason.length > 3);
    }
  });
});

describe("the theme", () => {
  const paper = analyze(LIGHT_PAGE);

  test("darken paints the configured corners", () => {
    const t = buildTheme(DARK_DEFAULTS, "darken", "dynamic", paper);
    assert.equal(t.background, "rgb(22, 22, 30)");
    assert.equal(t.foreground, "rgb(192, 202, 245)");
    assert.equal(t.accent, "rgb(122, 162, 247)");
    assert.equal(t.direction, "darken");
  });

  test("light mode swaps the two poles rather than inventing a palette", () => {
    const t = buildTheme(DARK_DEFAULTS, "lighten", "dynamic", analyze(DARK_PAGE));
    assert.equal(t.background, "rgb(192, 202, 245)");
    assert.equal(t.foreground, "rgb(22, 22, 30)");
  });

  test("the anchors come from the page, not from the settings", () => {
    const dark = buildTheme(DARK_DEFAULTS, "darken", "dynamic", analyze(DARK_PAGE));
    const light = buildTheme(DARK_DEFAULTS, "darken", "dynamic", paper);
    assert.ok(dark.anchors.srcBg < light.anchors.srcBg, "the dark page's canvas is darker on the way in");
    assert.equal(dark.anchors.dstBg, light.anchors.dstBg, "and both arrive at the same canvas");
  });
});

describe("the mapping entries", () => {
  const paper = analyze(LIGHT_PAGE);
  const theme = buildTheme(DARK_DEFAULTS, "darken", "dynamic", paper);

  test("a white panel becomes the canvas and its black text the theme's text", () => {
    const [entry] = entriesFor([sample({ selector: ".panel", bg: "rgb(255, 255, 255)", fg: "rgb(0, 0, 0)", area: 1000 })], theme);
    assert.equal(entry!.selector, ".panel");
    assert.equal(entry!.bg, theme.background);
    assert.equal(entry!.fg, theme.foreground);
  });

  test("media and background-image elements are left alone", () => {
    const entries = entriesFor(
      [
        sample({ selector: "img", tag: "IMG", media: true, area: 5000 }),
        sample({ selector: ".hero", hasBgImage: true, bg: "rgb(255, 255, 255)", fg: "rgb(0, 0, 0)", area: 5000 }),
        sample({ selector: ".plain", area: 5000 }),
      ],
      theme
    );
    assert.deepEqual(entries.map((e) => e.selector), [".hero", ".plain"], "the img is skipped entirely");
    assert.equal(entries[0]!.bg, undefined, "a background image's colour is not ours to move");
    assert.ok(entries[0]!.fg, "…but its text is");
    assert.ok(entries[1]!.bg);
  });

  test("a transparent background is not a colour", () => {
    // Painting one would put a dark rectangle under content the page left
    // see-through on purpose.
    const [entry] = entriesFor([sample({ bg: "rgba(0, 0, 0, 0)", area: 1000 })], theme);
    assert.equal(entry!.bg, undefined);
    assert.ok(entry!.fg);
  });

  test("an element with nothing to say produces no entry", () => {
    assert.deepEqual(entriesFor([sample({ bg: "rgba(0,0,0,0)", fg: "rgba(0,0,0,0)", area: 1000 })], theme), []);
  });

  test("IGNORE INLINE STYLE is honoured through the caller's predicate", () => {
    const entries = entriesFor(
      [sample({ selector: ".keep", area: 1000 }), sample({ selector: ".other", area: 1000 })],
      theme,
      (s) => s.selector === ".keep"
    );
    assert.deepEqual(entries.map((e) => e.selector), [".other"]);
  });

  test("identical rules collapse", () => {
    const entries = entriesFor(
      [sample({ selector: ".a", area: 1000 }), sample({ selector: ".a", area: 2000 })],
      theme
    );
    assert.equal(entries.length, 1);
  });
});

describe("the sheet", () => {
  const theme = buildTheme(DARK_DEFAULTS, "darken", "dynamic", analyze(LIGHT_PAGE));

  test("dynamic: the poles are defined, including upstream's variable names", () => {
    const css = composeSheet({ theme, entries: [], rules: [], userCss: "" });
    assert.match(css, /:root\{color-scheme:dark !important/);
    assert.match(css, /--darkreader-neutral-background:rgb\(22, 22, 30\)/);
    assert.match(css, /--darkreader-neutral-text:rgb\(192, 202, 245\)/);
    assert.match(css, /html\[data-lf-scheme\]\{background-color:rgb\(22, 22, 30\) !important/);
  });

  test("dynamic: the page guarantee and an unstyled link colour", () => {
    const css = composeSheet({ theme, entries: [], rules: [], userCss: "" });
    assert.match(css, /html,body\{background-color:rgb\(22, 22, 30\) !important;color:rgb\(192, 202, 245\) !important\}/);
    assert.match(css, /a:link:not\(\[class\]\):not\(\[id\]\)\{color:rgb\(122, 162, 247\) !important\}/);
  });

  test("dynamic: one rule per entry, and media is never in one", () => {
    const entries = entriesFor([sample({ selector: ".card", area: 1000 })], theme);
    const css = composeSheet({ theme, entries, rules: [], userCss: "" });
    assert.match(css, /\.card\{background-color:rgb\(22, 22, 30\) !important;color:rgb\(192, 202, 245\) !important\}/);
    assert.ok(css.indexOf("img{") < 0, "no blanket media rule in the palette engine");
  });

  test("the corpus is expanded with this theme's poles", () => {
    const { rules } = parseFixList("example.com\nCSS\n.thing { background: ${white} !important; }");
    const css = composeSheet({ theme, entries: [], rules, userCss: "" });
    assert.match(css, /\.thing \{ background: rgb\(192, 202, 245\) !important; \}/);
  });

  test("the user's CSS is the last word", () => {
    const { rules } = parseFixList("example.com\nCSS\n.thing { color: red; }");
    const css = composeSheet({ theme, entries: [], rules, userCss: ".thing { color: blue; }" });
    assert.ok(css.indexOf(".thing { color: blue; }") > css.indexOf(".thing { color: red; }"));
  });

  test("dynamic: INVERT marks an element to invert, since nothing else inverts", () => {
    const { rules } = parseFixList("example.com\nINVERT\nimg.logo-dark");
    const css = composeSheet({ theme, entries: [], rules, userCss: "" });
    assert.match(css, /img\.logo-dark\{filter:invert\(1\) hue-rotate\(180deg\) !important\}/);
  });

  test("filter: the root is filtered and the canvas painted", () => {
    const filtered = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    const css = composeSheet({ theme: filtered, entries: [], rules: [], userCss: "" });
    assert.match(css, /html\{filter:invert\(1\) hue-rotate\(180deg\) !important;\}/);
    assert.match(css, /html,body\{background-color:rgb\(22, 22, 30\) !important\}/);
  });

  test("filter: media is counter-inverted, and our own surfaces with it", () => {
    // Without the second half the which-key overlay, the popups, the hint layer
    // and the caret come back as negatives of themselves the moment this engine
    // runs — and the user's first keypress is also their first bug report.
    const filtered = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    const css = composeSheet({ theme: filtered, entries: [], rules: [], userCss: "" });
    assert.match(css, /img,video,canvas,iframe,object,embed,picture,svg,\*\[style\*="background-image"\]\{filter:invert\(1\)/);
    for (const host of OUR_HOSTS) assert.ok(css.includes(host), `${host} must be counter-inverted`);
  });

  test("filter: NO INVERT excludes selectors from the counter-inversion", () => {
    // The exclusion is applied per media selector rather than wrapping the whole
    // list, because `:not()` has to see the counter-inversion selectors
    // individually — a single `:not()` around `img,video,…` would be a selector
    // list inside `:not()`, which is not what `asIs` produces and not what the
    // cascade would mean. One selector therefore lands as `:not(#player *)`.
    const { rules } = parseFixList("example.com\nNO INVERT\n#player *");
    const filtered = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    const css = composeSheet({ theme: filtered, entries: [], rules, userCss: "" });
    assert.match(css, /img:not\(#player \*\)/);
    assert.match(css, /svg:not\(#player \*\)/);
    const two = parseFixList("example.com\nNO INVERT\n#player *\n.no-invert");
    const css2 = composeSheet({ theme: filtered, entries: [], rules: two.rules, userCss: "" });
    assert.match(css2, /img:not\(:is\(#player \*, \.no-invert\)\)/, "several exclusions become one :is() argument");
  });

  test("filter: REMOVE BG drops the image and paints the canvas", () => {
    const { rules } = parseFixList("example.com\nREMOVE BG\n.photo");
    const filtered = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    const css = composeSheet({ theme: filtered, entries: [], rules, userCss: "" });
    assert.match(css, /\.photo\{background-image:none !important;background-color:rgb\(22, 22, 30\) !important\}/);
  });

  test("filter: the adjustments only appear when they are not the identity", () => {
    const plain = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    assert.ok(composeSheet({ theme: plain, entries: [], rules: [], userCss: "" }).indexOf("brightness") < 0);
    const tuned = buildTheme(
      { ...DARK_DEFAULTS, brightness: 110, contrast: 90, sepia: 20, grayscale: 10 },
      "darken",
      "filter",
      analyze(LIGHT_PAGE)
    );
    const css = composeSheet({ theme: tuned, entries: [], rules: [], userCss: "" });
    assert.match(css, /brightness\(1\.1\)/);
    assert.match(css, /contrast\(0\.9\)/);
    assert.match(css, /sepia\(0\.2\)/);
    assert.match(css, /grayscale\(0\.1\)/);
  });

  test("the filter engine ignores the palette entries it is given", () => {
    const filtered = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    const entries = entriesFor([sample({ selector: ".card", area: 1000 })], filtered);
    const css = composeSheet({ theme: filtered, entries, rules: [], userCss: "" });
    assert.ok(css.indexOf(".card{background-color") < 0, "an inversion needs no per-element rules");
  });

  test("the fallback paint is gated on the pending marker", () => {
    assert.match(fallbackSheet(theme), /html\[data-lf-dark-pending\]\{background-color:/);
  });
});
