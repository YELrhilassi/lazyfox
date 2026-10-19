// What the dark engine decides, and the CSS it writes.
//
// The two halves that a browser cannot be asked about cheaply are both here:
// "would a page that looks like THIS be themed?" is a pure question about
// samples, and "what does the sheet look like?" is a pure question about strings.
// The e2e suite covers the remaining half — that a real page really is painted —
// and it is a much smaller surface because of this file.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  analyze,
  chooseEngine,
  declaresDarkSupport,
  nativeDarkVerdict,
  shouldApply,
  type PageSample,
} from "../../src/extension/content/dark/detect.ts";
import { createResampleGate, touchesOnlyOwnStyle } from "../../src/extension/content/dark/apply.ts";
import {
  buildTheme,
  composeSheet,
  entriesFor,
  fallbackSheet,
  OUR_HOSTS,
  preImage,
} from "../../src/extension/content/dark/theme.ts";
import { parseFixList } from "../../src/shared/dark-rules.ts";
import { DARK_DEFAULTS } from "../../src/shared/config.ts";
import { contrastRatio, relativeLuminance, parseColor } from "../../src/extension/content/dark/color.ts";

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

  test("the engine does not flip while coverage hovers around the threshold", () => {
    // THE FLICKER. Coverage is re-measured on every pass, and the two engines paint
    // the page in opposite ways, so a page whose coverage drifts across one
    // threshold was remapped on one pass and inverted on the next — a whole-page
    // flash each time, on any page with a lazy panel or an ad slot. The band is
    // what makes a switch a decision instead of a coin toss.
    const at = (coverage: number) => ({ ...analyze(LIGHT_PAGE), coverage, sampled: true });
    assert.equal(chooseEngine("auto", at(1), "dynamic"), "dynamic");
    assert.equal(chooseEngine("auto", at(0.45), "dynamic"), "dynamic", "still well understood");
    assert.equal(chooseEngine("auto", at(0.45), "filter"), "filter", "not yet clearly understood");
    assert.equal(chooseEngine("auto", at(0.55), "filter"), "filter", "the band is sticky both ways");
    assert.equal(chooseEngine("auto", at(0.1), "dynamic"), "filter", "a decisive loss switches");
    assert.equal(chooseEngine("auto", at(0.9), "filter"), "dynamic", "a decisive gain switches");
    // No previous engine is the cold decision, unchanged.
    assert.equal(chooseEngine("auto", at(0.5)), "dynamic");
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

/* ---------- the site's own dark theme ---------- */

// THE REPORT: "it should detect if the website is already in dark, it should be
// smart to use website native dark mode if available". The already-dark half was
// measured from pixels (and tested above). This is the other half: a page that
// ships a dark theme and is rendering LIGHT because the OS is light. Asking that
// page for its own theme is better than recolouring its light one, and
// `color-scheme` is the declaration that makes the ask real.
describe("asking the site for its own dark theme", () => {
  test("a declaration of dark support is recognised, in both spellings", () => {
    assert.equal(declaresDarkSupport("light dark"), true);
    assert.equal(declaresDarkSupport("dark"), true);
    assert.equal(declaresDarkSupport("only dark"), true);
    assert.equal(declaresDarkSupport("LIGHT DARK"), true);
    // A meta tag instead of CSS: same fact, other place.
    assert.equal(declaresDarkSupport("light", "dark"), true);
    assert.equal(declaresDarkSupport("light", "light dark"), true);
  });

  test("a page that says nothing about the scheme is not asked", () => {
    // The default `color-scheme` is `normal`, which means "no preference": a
    // page that never declared anything must be remapped, not interrogated.
    assert.equal(declaresDarkSupport("normal"), false);
    assert.equal(declaresDarkSupport(""), false);
    assert.equal(declaresDarkSupport(null), false);
    assert.equal(declaresDarkSupport(undefined), false);
    assert.equal(declaresDarkSupport("light"), false);
  });

  test("the ask is the ONLY thing that turns a declaration into a verdict", () => {
    const light = analyze(LIGHT_PAGE);
    const dark = analyze(DARK_PAGE);
    // Declared, not yet asked: still our job.
    const before = nativeDarkVerdict(true, false, light);
    assert.equal(before.native, false);
    assert.match(before.reason, /asking/);
    // Asked and the page went dark: it is the site's theme, so nothing of ours.
    const after = nativeDarkVerdict(true, true, dark);
    assert.equal(after.native, true);
    assert.match(after.reason, /color-scheme/);
    // Asked and it stayed light: a declaration it does not honour, so we remap.
    const stubborn = nativeDarkVerdict(true, true, light);
    assert.equal(stubborn.native, false);
    assert.match(stubborn.reason, /still renders light/);
    // No declaration at all: never asked, never taken.
    assert.equal(nativeDarkVerdict(false, false, light).native, false);
  });
});

/* ---------- the resample gate is a rate limit, not a lifetime cap ---------- */

// THE OTHER HALF OF THE REPORT: "it breaks when I switch state and ... doesn't
// render dark elements properly". A state switch is a mutation burst that lands
// long after the first one, so a gate that stops answering forever freezes the
// page's mapping at whatever it looked like on load.
describe("how often a page may be re-measured", () => {
  test("a burst is cheap, and a quiet page is never re-measured", () => {
    let now = 0;
    const gate = createResampleGate(() => now);
    assert.equal(gate(), true, "the first pass is immediate");
    assert.equal(gate(), false, "and the second, in the same instant, is not");
    now += 400;
    assert.equal(gate(), true);
  });

  test("after the burst the page still earns a pass, slowly", () => {
    let now = 0;
    const gate = createResampleGate(() => now);
    for (let i = 0; i < 40; i++) {
      now += 400;
      gate();
    }
    // Past MAX_RESAMPLES: the calm-down interval no longer earns a pass...
    now += 401;
    assert.equal(gate(), false, "the burst allowance is a rate, not a queue");
    // ...but a state switch ten seconds later does, which is the whole point.
    now += 2500;
    assert.equal(gate(), true, "a late change is measured, not ignored");
  });

  test("a new page state starts over", () => {
    let now = 0;
    const gate = createResampleGate(() => now);
    for (let i = 0; i < 40; i++) {
      now += 400;
      gate();
    }
    gate.reset();
    assert.equal(gate(), true, "a same-document navigation is a fresh page");
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

  test("an empty box keeps its backdrop, because the image is the design", () => {
    // The cell above CARRIES CONTENT (its label), so its surface is painted. An
    // element with nothing inside it is a transparent logo drawn on a backdrop
    // the site chose: painting that dark would erase a dark mark, which is the
    // opposite of an improvement.
    const [logo] = entriesFor(
      [sample({ selector: ".logo", hasBgImage: true, hasContent: false, bg: "rgb(255, 255, 255)", area: 3000 })],
      theme
    );
    assert.equal(logo!.bg, undefined);
  });

  test("a placeholder under a COVERED photo is a surface like any other", () => {
    // Measured on merriam-webster.com: `div.lazyload-container` is `#d7d5d5` plus
    // an `image-set()` photo at `background-size: cover` — a light grey box on a
    // dark page while the image loads, and a box the image hides completely once it
    // arrives. An uncovered `url()` of the same colour keeps its backdrop (the
    // empty-box case above), because there the colour is what the user sees.
    const [box] = entriesFor(
      [sample({ selector: ".lazyload-container", hasBgImage: true, hasContent: false, bgCovers: true, bg: "rgb(215, 213, 213)", area: 64_000 })],
      theme
    );
    assert.ok(box!.bg, "the placeholder is painted");
    assert.ok(relativeLuminance(parseColor(box!.bg!)!) < 0.2, `and it is dark, got ${box!.bg}`);
  });

  test("a transparent background is not a colour", () => {
    // Painting one would put a dark rectangle under content the page left
    // see-through on purpose.
    const [entry] = entriesFor([sample({ bg: "rgba(0, 0, 0, 0)", area: 1000 })], theme);
    assert.equal(entry!.bg, undefined);
    assert.ok(entry!.fg);
  });

  test("a transparent layer is not painted opaque over what it reveals", () => {
    // THE REPORT: "the grid is completely hidden by some sort of gray overlay".
    // The sampler resolves a transparent element's colour against its ancestors
    // so the PAGE can be read; painting that resolved colour back turns the
    // transparent layer into an opaque sheet over whatever it used to reveal.
    const [e] = entriesFor(
      [
        sample({
          selector: ".grid-layer",
          area: 40_000,
          ownBg: "rgba(0, 0, 0, 0)",
          bg: "rgb(255, 255, 255)",
          fg: "rgb(17, 17, 17)",
        }),
      ],
      theme
    );
    assert.equal(e!.bg, undefined, "a layer that painted nothing must keep painting nothing");
    assert.ok(e!.fg, "its text is still mapped");
    // And the text is measured against the surface it shows through, not against
    // a colour the element never had.
    assert.ok(
      contrastRatio(parseColor(e!.fg!)!, parseColor(theme.background)!) >= 4.5,
      "text on the revealed surface is readable: " + e!.fg
    );
  });

  test("an invisible layer with no text produces no rule at all", () => {
    const entries = entriesFor(
      [sample({ selector: ".veil", area: 5000, ownBg: "rgba(0, 0, 0, 0)", bg: "rgb(255, 255, 255)", fg: "rgba(0, 0, 0, 0)" })],
      theme
    );
    assert.deepEqual(entries, []);
  });

  test("a translucent WHITE surface is mapped and keeps its alpha", () => {
    // The frosted sticky header: `rgba(255,255,255,.85)` over a page that is now
    // dark renders as a near-white bar across the top of the page — the most
    // visible artifact a dark theme can produce. Mapping the RGB and keeping the
    // alpha turns it into a translucent dark bar.
    const [entry] = entriesFor(
      [sample({ selector: ".frosted", bg: "rgba(255, 255, 255, 0.85)", fg: "rgb(17, 17, 17)", area: 1000 })],
      theme
    );
    assert.equal(entry!.bg, "rgba(22, 22, 30, 0.85)", "the panel becomes the canvas at the same alpha");
  });

  // THE REPORT: "the colour that it picks ... is awful to look at". These are the
  // surfaces a real site is made of, and the property each one has to keep.
  test("a dark header keeps its weight, and its white text stays white", () => {
    // A navy hero with white text is a SURFACE far from the canvas. Mapping it by
    // position turned it pale (far from the canvas reads as text-like) and left
    // its white text white: a light bar with invisible text on a dark page.
    const [e] = entriesFor(
      [sample({ selector: "header", bg: "rgb(11, 26, 51)", fg: "rgb(255, 255, 255)", area: 40_000 })],
      theme
    );
    const bg = parseColor(e!.bg!)!;
    const fg = parseColor(e!.fg!)!;
    assert.ok(relativeLuminance(bg) < 0.25, "the header is still dark: " + e!.bg);
    assert.ok(relativeLuminance(bg) > relativeLuminance(theme.poles.bg), "and still a panel: " + e!.bg);
    assert.ok(relativeLuminance(fg) > 0.9, "white text was not inverted: " + e!.fg);
    assert.ok(contrastRatio(fg, bg) >= 4.5, "the pair reads: " + e!.fg + " on " + e!.bg);
  });

  test("text on a coloured badge is lifted until it reads", () => {
    // Black text on a yellow badge: both ends moved to the dark side under the
    // positional model, and the label vanished. The surface mapping keeps the
    // badge a badge; `ensureContrast` is what keeps the label a label.
    const [e] = entriesFor(
      [sample({ selector: ".badge", bg: "rgb(255, 235, 59)", fg: "rgb(17, 17, 17)", area: 1200 })],
      theme
    );
    assert.ok(contrastRatio(parseColor(e!.fg!)!, parseColor(e!.bg!)!) >= 4.5, e!.fg + " on " + e!.bg);
  });

  test("a light panel is a panel, not the canvas again", () => {
    const [e] = entriesFor([sample({ selector: ".card", bg: "rgb(242, 244, 248)", area: 5000 })], theme);
    assert.notEqual(e!.bg, theme.background, "a page's cards must remain visible");
  });

  test("a border on a panel stays visible", () => {
    const [e] = entriesFor(
      [sample({ selector: ".card", bg: "rgb(247, 248, 250)", fg: "rgb(27, 31, 36)", border: "rgb(207, 214, 224)", area: 5000 })],
      theme
    );
    assert.ok(e!.border, "a hairline is mapped");
    assert.ok(
      contrastRatio(parseColor(e!.border!)!, parseColor(e!.bg!)!) >= 1.3,
      "the rule is still a rule: " + e!.border + " on " + e!.bg
    );
  });

  test("a translucent white border is a grey ring, and it is mapped like a surface", () => {
    // MEASURED on merriam-webster.com: a hero card is ringed by
    // `border: 4px solid rgba(255,255,255,.5)` on three sides. Reading only the
    // TOP side (and only an OPAQUE one) left all three of those edges as they
    // were — a half-white 4px ring on a dark card, which reads as exactly the
    // "gray overlay on some elements" in the report.
    const [e] = entriesFor(
      [
        sample({
          selector: ".hero",
          bg: "rgb(255, 255, 255)",
          fg: "rgb(17, 17, 17)",
          area: 16_000,
          borders: [
            { side: "right", color: "rgba(255, 255, 255, 0.5)" },
            { side: "bottom", color: "rgba(255, 255, 255, 0.5)" },
            { side: "left", color: "rgba(255, 255, 255, 0.5)" },
          ],
        }),
      ],
      theme
    );
    // Three sides that AGREE are one declaration: `border-color` is the page's
    // own shape, and a side with no width paints nothing whatever colour it is
    // given. (Sides that disagree go to `borders` — the next case.)
    assert.ok(e!.border, "the ring is mapped: " + JSON.stringify(e));
    const c = parseColor(e!.border!)!;
    assert.ok(relativeLuminance(c) < 0.3, "the ring is no longer light: " + e!.border);
    // The ALPHA is kept, like a translucent surface's: the page's own softness is
    // the design, and what it must stop being is white.
    assert.ok(c.a > 0.4 && c.a < 0.999, "the ring lost its alpha: " + e!.border);
  });

  test("a border on one side only is painted on that side, and nowhere else", () => {
    // A row separator is `border-bottom: 1px solid #e5e7eb`. Its TOP width is 0,
    // so a top-only read found no border at all and left a light hairline in a
    // dark page; writing `border-color` would be the opposite mistake and would
    // give the three unpainted sides a colour too.
    const [e] = entriesFor(
      [
        sample({
          selector: ".row",
          bg: "rgb(255, 255, 255)",
          fg: "rgb(17, 17, 17)",
          area: 5000,
          borders: [{ side: "bottom", color: "rgb(227, 230, 232)" }],
        }),
      ],
      theme
    );
    assert.ok(e!.border, "the separator is mapped at all: " + JSON.stringify(e));
    assert.ok(!e!.borders, "one side is not a per-side rule: " + JSON.stringify(e));
    const css = composeSheet({ theme, entries: [e!], rules: [], userCss: "" });
    assert.match(css, /border-color:rgb\(\d+, \d+, \d+\)/, "the colour is written: " + css);
    const c = parseColor(/border-color:(rgb\([^)]*\))/.exec(css)![1]!)!;
    assert.ok(relativeLuminance(c) < 0.25, "a hairline on a dark page is a hairline, not a highlight: " + css);
  });

  test("two different border colours keep their own, so an accent stays an accent", () => {
    // `border-top: 1px solid #eee; border-left: 4px solid #e11d48` is a card with
    // an accent rule. One `border-color` from the top side repaints the accent in
    // the neutral colour — a small thing that is very visible on a red rule.
    const [e] = entriesFor(
      [
        sample({
          selector: ".card",
          bg: "rgb(255, 255, 255)",
          fg: "rgb(17, 17, 17)",
          area: 5000,
          borders: [
            { side: "top", color: "rgb(238, 238, 238)" },
            { side: "left", color: "rgb(225, 29, 72)" },
          ],
        }),
      ],
      theme
    );
    assert.ok(!e!.border, "no shorthand when the sides disagree");
    const top = parseColor(e!.borders!.find((b) => b.side === "top")!.color)!;
    const left = parseColor(e!.borders!.find((b) => b.side === "left")!.color)!;
    assert.ok(left.r - left.g > 25, "the accent is still red: " + JSON.stringify(e!.borders));
    assert.ok(Math.abs(top.r - top.g) < 20, "and the neutral rule is still neutral");
  });

  test("a gradient's stop colours go through the same mapping", () => {
    // A pale gradient used to be left alone (only `url(` counted as a background
    // image), so it washed white over the mapped colour.
    const [e] = entriesFor(
      [
        sample({
          selector: ".hero",
          bg: "rgb(255, 255, 255)",
          bgImage: "linear-gradient(rgb(255, 255, 255) 0%, rgb(238, 238, 238) 100%)",
          area: 40_000,
        }),
      ],
      theme
    );
    assert.ok(e!.image, "the gradient was mapped");
    const stops = e!.image!.match(/rgba?\([^)]*\)/g) || [];
    assert.equal(stops.length, 2, "both stops survived: " + e!.image);
    for (const stop of stops) {
      assert.ok(relativeLuminance(parseColor(stop)!) < 0.2, "stop left light: " + stop);
    }
    assert.match(e!.image!, /linear-gradient/, "the shape of the gradient did not change");
  });

  test("a gradient that carries a url() is a photograph, and is left alone", () => {
    const [e] = entriesFor(
      [sample({ selector: ".hero", bg: "rgb(255, 255, 255)", hasBgImage: true, bgImage: "url(x.png)", area: 40_000 })],
      theme
    );
    assert.equal(e!.image, undefined);
    assert.equal(e!.bg, undefined, "and its colour is not ours either");
  });

  test("a translucent DARK veil is left alone", () => {
    // A modal scrim is dark on purpose. Inverting it would wash the page under it
    // light, which is the same artifact in the other direction.
    const [entry] = entriesFor(
      [sample({ selector: ".scrim", bg: "rgba(0, 0, 0, 0.5)", fg: "rgb(255, 255, 255)", area: 1000 })],
      theme
    );
    assert.equal(entry!.bg, undefined);
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

  test("a shared class whose members disagree is split, so no panel stays white", () => {
    // THE REPORT: 556 of 827 text elements unreadable on merriam-webster.com.
    // A heading's class is shared with a transparent wrapper; the wrapper used
    // to veto the group's background, so the white panel was never painted while
    // the text on it was mapped to near-white. One rule per element is the fix.
    const entries = entriesFor(
      [
        sample({
          selector: ".card",
          solo: "div.card:nth-of-type(1)",
          ownBg: "rgb(255, 255, 255)",
          bg: "rgb(255, 255, 255)",
          fg: "rgb(33, 37, 41)",
          area: 5000,
        }),
        sample({
          selector: ".card",
          solo: "div.card:nth-of-type(2)",
          ownBg: "rgba(0, 0, 0, 0)",
          bg: "rgb(255, 255, 255)",
          fg: "rgb(244, 244, 244)",
          area: 1200,
        }),
      ],
      theme
    );
    assert.deepEqual(entries.map((e) => e.selector), ["div.card:nth-of-type(1)", "div.card:nth-of-type(2)"]);
    assert.equal(entries[0]!.bg, theme.background, "the opaque panel is painted");
    assert.equal(entries[1]!.bg, undefined, "the transparent one still paints nothing");
    // The white text of the transparent member is measured against the surface
    // that will actually render (our canvas), so it stays readable.
    assert.ok(
      contrastRatio(parseColor(entries[1]!.fg!)!, parseColor(theme.background)!) >= 4.5,
      "text on the revealed canvas is readable: " + entries[1]!.fg
    );
  });

  test("a disagreeing member with no address of its own is left alone, not painted with its siblings", () => {
    const entries = entriesFor(
      [
        sample({ selector: ".card", solo: "#only", ownBg: "rgb(255, 255, 255)", bg: "rgb(255, 255, 255)", area: 5000 }),
        sample({ selector: ".card", ownBg: "rgba(0, 0, 0, 0)", bg: "rgb(255, 255, 255)", fg: "rgb(244, 244, 244)", area: 1200 }),
      ],
      theme
    );
    assert.deepEqual(entries.map((e) => e.selector), ["#only"]);
  });

  test("a translucent white sheet over the whole screen is darkened, not left as a gray blanket", () => {
    // MEASURED, on nytimes.com/puzzles/sudoku: the game sits under
    // `#modalWrapper-overlay` — `position:absolute;z-index:101;
    // background:rgba(255,255,255,.376);opacity:.86` over a million square
    // pixels. Invisible on the site's own white page; a grey blanket over the
    // board once the page is dark. That is the report "the grid is completely
    // hidden by some sort of gray overlay", so a large translucent WHITE surface
    // is painted like any other light surface, with its alpha kept.
    const [sheet] = entriesFor(
      [sample({ selector: ".overlay", ownBg: "rgba(255, 255, 255, 0.376)", bg: "rgb(255, 255, 255)", fg: "rgb(238, 240, 252)", area: 994_969 })],
      theme
    );
    assert.equal(sheet!.bg, "rgba(22, 22, 30, 0.376)", "the white sheet became a dark one");
  });

  test("a frosted header keeps its alpha", () => {
    const [e] = entriesFor(
      [sample({ selector: ".hdr", ownBg: "rgba(255, 255, 255, 0.85)", bg: "rgb(255, 255, 255)", fg: "rgb(17, 17, 17)", area: 800_000 })],
      theme
    );
    assert.equal(e!.bg, "rgba(22, 22, 30, 0.85)");
  });

  test("a gradient over a transparent background-colour is still a surface", () => {
    const [e] = entriesFor(
      [
        sample({
          selector: ".hero",
          ownBg: "rgba(0, 0, 0, 0)",
          bg: "rgb(255, 255, 255)",
          bgImage: "linear-gradient(rgb(255, 255, 255) 0%, rgb(238, 238, 238) 100%)",
          area: 40_000,
        }),
      ],
      theme
    );
    assert.ok(e!.image, "the wash was mapped");
  });
});

describe("the sheet", () => {
  const theme = buildTheme(DARK_DEFAULTS, "darken", "dynamic", analyze(LIGHT_PAGE));

  test("dynamic: the poles are defined, including upstream's variable names", () => {
    const css = composeSheet({ theme, entries: [], rules: [], userCss: "" });
    // The page's own scheme is NOT touched (see the scheme test below), so the
    // root block starts at the variables.
    assert.ok(!/:root\{[^}]*color-scheme/.test(css), "no color-scheme of ours: " + css.slice(0, 160));
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

  test("an entry's mapped gradient is emitted as background-image", () => {
    const entries = entriesFor(
      [sample({ selector: ".hero", bg: "rgb(255,255,255)", bgImage: "linear-gradient(rgb(255, 255, 255), rgb(238, 238, 238))", area: 5000 })],
      theme
    );
    const css = composeSheet({ theme, entries, rules: [], userCss: "" });
    assert.match(css, /\.hero\{background-color:[^}]*background-image:linear-gradient\(rgb\(/);
  });

  test("a light surface UNDER a background image is still a surface", () => {
    // MEASURED on en.wikipedia.org/wiki/Firefox: a sortable table header is
    // `background: #eaecf0 url(<sort arrow>)`. Skipping the colour because the
    // value contains a `url(` left the cell light while its text was mapped to
    // near-white — ten unreadable header cells, and the report "issues with
    // content". The image paints above the colour, so the colour is ours.
    const entries = entriesFor(
      [
        sample({
          selector: "th.headerSort",
          bg: "rgb(234, 236, 240)",
          ownBg: "rgb(234, 236, 240)",
          fg: "rgb(32, 33, 34)",
          hasBgImage: true,
          hasContent: true,
          area: 4900,
        }),
      ],
      theme
    );
    const css = composeSheet({ theme, entries, rules: [], userCss: "" });
    const rule = /th\.headerSort\{([^}]*)\}/.exec(css);
    assert.ok(rule, "the header cell has a rule: " + css);
    assert.match(rule[1]!, /background-color:rgb\(\d+, \d+, \d+\)/);
    const bg = /background-color:(rgb\([^)]*\))/.exec(rule[1]!)![1]!;
    assert.ok(relativeLuminance(parseColor(bg)!) < 0.2, `the cell was left light: ${bg}`);
    // …and its text still reads on the colour it will actually sit on.
    const fgText = /(?:^|;)color:(rgb\([^)]*\))/.exec(rule[1]!)![1]!;
    assert.ok(contrastRatio(parseColor(fgText)!, parseColor(bg)!) >= 4.5, `text ${fgText} on ${bg}`);
  });

  test("a pseudo-element layer is painted as a surface, and never as text", () => {
    // `::before{content:"";inset:0;background:rgba(255,255,255,.7)}` is how a site
    // draws a veil, and a veil is not an element: it was never sampled, so it
    // stayed white over the mapped surface — "some gray overlay on some elements".
    const entries = entriesFor(
      [
        sample({
          selector: ".card::before",
          solo: "#a > div:nth-of-type(2)::before",
          tag: "DIV::before",
          bg: "rgba(255, 255, 255, 0.7)",
          ownBg: "rgba(255, 255, 255, 0.7)",
          fg: "",
          area: 40_000,
          pseudo: "::before",
        }),
      ],
      theme
    );
    const css = composeSheet({ theme, entries, rules: [], userCss: "" });
    const rule = /\.card::before\{([^}]*)\}/.exec(css);
    assert.ok(rule, "the layer has a rule: " + css);
    assert.match(rule[1]!, /background-color:rgba\(22, 22, 30, 0\.7\)/);
    assert.ok(!/(?:^|;)color:/.test(rule[1]!), "a layer has no text of its own: " + rule[1]);
    assert.ok(rule[1]!.indexOf("border") < 0, "and no border of its own: " + rule[1]);
  });

  test("a layer does not vote on the page's canvas", () => {
    // The veil covers its element, so its area is the element's — a full-page
    // `::before` would otherwise outvote the page's own colour and hand the
    // canvas to a translucent sheet.
    const a = analyze([
      sample({ selector: "body", area: 500_000, bg: "rgb(255, 255, 255)" }),
      sample({
        selector: "body::before",
        area: 500_000,
        bg: "rgb(0, 0, 0)",
        ownBg: "rgba(0, 0, 0, 0.6)",
        pseudo: "::before",
        fg: "",
      }),
    ]);
    assert.equal(a.pageDark, false, "the white page is still the page");
    assert.equal(a.coverage, 1);
  });

  test("a scheme is written only when the caller says the page has none of its own", () => {
    // Native scrollbars and form controls come from `color-scheme`. It is safe
    // ONLY on a page with no dark support: there `light-dark()` has nothing to
    // flip, so the mapping cannot be invalidated by its own declaration.
    const without = composeSheet({ theme, entries: [], rules: [], userCss: "" });
    assert.ok(!/color-scheme/.test(without), "no scheme by default: " + without.slice(0, 160));
    const withScheme = composeSheet({ theme, entries: [], rules: [], userCss: "", scheme: "dark" });
    // The `;` matters: it is the separator between the last variable and this
    // declaration, and without it the browser drops the whole declaration.
    assert.match(withScheme, /;color-scheme:dark !important\}/);
    const lightPage = buildTheme(DARK_DEFAULTS, "lighten", "dynamic", analyze(DARK_PAGE));
    assert.match(
      composeSheet({ theme: lightPage, entries: [], rules: [], userCss: "", scheme: "light" }),
      /;color-scheme:light !important\}/
    );
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

  test("filter: the root is filtered and the canvas is painted with its PRE-IMAGE", () => {
    // THE ARTIFACT. `filter` applies to the element's own background too, so
    // declaring the theme's dark canvas inside the filtered root rendered it
    // LIGHT: the engine painted the page's background upside down. The declared
    // value is therefore the channel complement of #16161e (233, 233, 225), which
    // the inversion lands exactly on. The page guarantee (`html,body`) declares
    // no text colour: the page's own text inverted is already the right text
    // colour, and a colour there would be inverted on top of the page's.
    const filtered = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    const css = composeSheet({ theme: filtered, entries: [], rules: [], userCss: "" });
    assert.match(css, /html\{filter:invert\(1\) hue-rotate\(180deg\) !important;\}/);
    // Exactly one declaration: the canvas, and nothing else.
    assert.match(css, /html,body\{background-color:rgb\(233, 233, 225\) !important\}/);
    assert.ok(!/html,body\{[^}]*(;|\{)color:/.test(css), "no text colour under the inversion");
    assert.deepEqual(preImage(parseColor("rgb(22, 22, 30)")!), { r: 233, g: 233, b: 225, a: 1 });
    // And the anchor rule that guarantees a canvas uses the same value — the
    // TEXT colour too, because a colour declared inside the filtered root is
    // inverted as well: handed the theme's light text it would render dark.
    assert.match(css, /html\[data-lf-scheme\]\{background-color:rgb\(233, 233, 225\) !important/);
    assert.match(
      css,
      /html\[data-lf-scheme\]\{[^}]*color:rgb\(63, 53, 10\) !important/,
      "the declared text colour is the pre-image of the theme's: " + css.slice(0, 400)
    );
  });

  test("NEITHER engine forces the page's scheme, so light-dark() is not flipped under the mapping", () => {
    // The palette engine reads the page's computed colours and writes a mapping
    // for them. Installing `color-scheme: dark` next to that mapping changes the
    // colours AFTER they were read: every `light-dark()` value and every
    // scheme-aware UA style on the site flips to its dark variant, and the
    // mapping repaints values it never saw. On a site that ships both schemes
    // that is the reported "dark elements not rendered properly". The scheme the
    // page was measured in is the scheme it keeps.
    const filtered = buildTheme(DARK_DEFAULTS, "darken", "filter", analyze(LIGHT_PAGE));
    const filterCss = composeSheet({ theme: filtered, entries: [], rules: [], userCss: "" });
    assert.ok(!/:root\{[^}]*color-scheme/.test(filterCss), "no color-scheme in filter mode: " + filterCss.slice(0, 200));
    const dynamic = buildTheme(DARK_DEFAULTS, "darken", "dynamic", analyze(LIGHT_PAGE));
    const dynamicCss = composeSheet({ theme: dynamic, entries: [], rules: [], userCss: "" });
    assert.ok(!/:root\{[^}]*color-scheme/.test(dynamicCss), "no color-scheme in the palette engine: " + dynamicCss.slice(0, 200));
    // Both directions, both engines.
    for (const engine of ["dynamic", "filter"] as const) {
      for (const direction of ["darken", "lighten"] as const) {
        const t = buildTheme(DARK_DEFAULTS, direction, engine, analyze(LIGHT_PAGE));
        assert.ok(!/:root\{[^}]*color-scheme/.test(composeSheet({ theme: t, entries: [], rules: [], userCss: "" })));
      }
    }
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
    assert.match(css, /\.photo\{background-image:none !important;background-color:rgb\(233, 233, 225\) !important\}/);
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

  test("the fallback paint is gated on the pending marker, and covers the body too", () => {
    // A page almost always paints its own body, which covers <html> completely: a
    // placeholder that only painted the root bought nothing on the pages it
    // existed for, and the white body showed through until the real sheet landed.
    const css = fallbackSheet(theme);
    assert.match(css, /html\[data-lf-dark-pending\],html\[data-lf-dark-pending\] body\{background-color:/);
    assert.match(css, /body\{background-color:rgb\(22, 22, 30\) !important;color:rgb\(192, 202, 245\) !important\}/);
  });
});

/* ---------- the observer's feedback loop ---------- */

describe("telling our own writes from the page's", () => {
  const style = { id: "lazyfox-dark" };
  const pageNode = { id: "panel" };

  test("a batch that only touches the sheet is ours", () => {
    // `textContent = css` on the <style> is a childList mutation in the subtree
    // the observer watches, and appending the <style> is another. Reading either
    // as page activity made every write buy the next measurement — the loop that
    // flickered the page.
    assert.equal(touchesOnlyOwnStyle([{ target: style }], style), true);
    assert.equal(
      touchesOnlyOwnStyle([{ target: { id: "head" }, addedNodes: [style] }], style),
      true
    );
    assert.equal(
      touchesOnlyOwnStyle([{ target: { id: "head" }, removedNodes: [style] }], style),
      true
    );
  });

  test("a batch with any page mutation is the page's", () => {
    assert.equal(touchesOnlyOwnStyle([{ target: pageNode }], style), false);
    assert.equal(
      touchesOnlyOwnStyle([{ target: style }, { target: { id: "head" }, addedNodes: [pageNode] }], style),
      false,
      "one page node is enough"
    );
  });

  test("no sheet, no batch: nothing is ours", () => {
    assert.equal(touchesOnlyOwnStyle([], style), false);
    assert.equal(touchesOnlyOwnStyle([{ target: style }], null), false);
  });
});
