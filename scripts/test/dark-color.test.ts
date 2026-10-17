// The colour maths behind the dark engine.
//
// Everything a user notices about the feature — a photograph that kept its
// colours, a grey that stayed a grey, a page that did NOT get themed because it
// was already dark — comes out of these functions, and none of them need a
// browser to check. That is why they are the ones with tests: the sampling and
// the stylesheet are the parts that can only be verified in a real page, and
// they are the parts that should therefore be thin.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  colorKey,
  contrastRatio,
  ensureContrast,
  formatColor,
  hslToRgb,
  MIN_TEXT_CONTRAST,
  mapColor,
  mapInk,
  mapLightness,
  mapSurface,
  nearColor,
  parseColor,
  relativeLuminance,
  rgbToHsl,
  withLuminance,
} from "../../src/extension/content/dark/color.ts";

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe("parsing a CSS colour", () => {
  test("hex, in both lengths and with alpha", () => {
    assert.deepEqual(parseColor("#ffffff"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor("#0af"), { r: 0, g: 170, b: 255, a: 1 });
    const short = parseColor("#0af8")!;
    assert.equal(short.a, 136 / 255);
    const long = parseColor("#00000080")!;
    assert.ok(near(long.a, 128 / 255));
  });

  test("rgb and rgba in both syntaxes", () => {
    assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
    assert.deepEqual(parseColor("rgb(1 2 3)"), { r: 1, g: 2, b: 3, a: 1 });
    const half = parseColor("rgb(1 2 3 / 50%)")!;
    assert.equal(half.a, 0.5);
    const legacy = parseColor("rgba(10, 20, 30, 0.25)")!;
    assert.equal(legacy.a, 0.25);
  });

  test("hsl", () => {
    const red = parseColor("hsl(0, 100%, 50%)")!;
    assert.ok(near(red.r, 255, 1) && near(red.g, 0, 1) && near(red.b, 0, 1));
  });

  test("named colours a computed style would never produce, but a test will", () => {
    assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(parseColor("White"), { r: 255, g: 255, b: 255, a: 1 });
  });

  test("anything unparseable is null, not a guess", () => {
    // The caller's contract: an unparseable value means "leave this element
    // alone". Guessing a colour for it is how a theme paints something the page
    // never asked for.
    for (const bad of ["", "not a color", "rgb(1,2)", "#12", "rgb(1,2,3,4,5)"]) {
      assert.equal(parseColor(bad), null, bad);
    }
  });

  test("round-tripping a colour through the formatter keeps it", () => {
    for (const css of ["#ffffff", "#16161e", "#7aa2f7", "rgb(1, 2, 3)"]) {
      const parsed = parseColor(css)!;
      const again = parseColor(formatColor(parsed))!;
      assert.deepEqual(again, parsed, css);
    }
  });
});

describe("formatting", () => {
  test("opaque colours are rgb(), transparent ones carry the alpha", () => {
    assert.equal(formatColor({ r: 1, g: 2, b: 3, a: 1 }), "rgb(1, 2, 3)");
    assert.equal(formatColor({ r: 1, g: 2, b: 3, a: 0.5 }), "rgba(1, 2, 3, 0.5)");
    assert.equal(formatColor({ r: 1.4, g: 2.6, b: 3, a: 1 }), "rgb(1, 3, 3)");
  });
});

describe("HSL round trip", () => {
  test("letters keep their hue", () => {
    for (const [css, hue] of [["#ff0000", 0], ["#00ff00", 120], ["#0000ff", 240]] as const) {
      const hsl = rgbToHsl(parseColor(css)!);
      assert.ok(near(hsl.h, hue, 0.001), `${css} → ${hsl.h}`);
      const back = hslToRgb(hsl);
      const original = parseColor(css)!;
      assert.ok(near(back.r, original.r, 0.001) && near(back.g, original.g, 0.001) && near(back.b, original.b, 0.001));
    }
  });

  test("grey has no hue and no saturation", () => {
    const hsl = rgbToHsl(parseColor("#808080")!);
    assert.equal(hsl.s, 0);
    assert.ok(near(hsl.l, 0.502, 0.002));
  });
});

describe("luminance and contrast", () => {
  test("the ends of the scale", () => {
    assert.equal(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }), 1);
    assert.equal(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 }), 0);
  });

  test("white on black is the maximum ratio", () => {
    assert.ok(near(contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }), 21, 1e-9));
  });

  test("a colour against itself is 1", () => {
    const c = { r: 20, g: 30, b: 40, a: 1 };
    assert.equal(contrastRatio(c, c), 1);
  });
});

describe("the lightness mapping", () => {
  const anchors = { srcBg: 1, srcFg: 0, dstBg: 0.08, dstFg: 0.62 };

  test("the sources' two poles land exactly on the theme's two poles", () => {
    // This is the property that makes the whole engine predictable: whatever the
    // page's canvas is, it BECOMES the theme's canvas, not something near it.
    assert.ok(near(mapLightness(1, anchors), 0.08));
    assert.ok(near(mapLightness(0, anchors), 0.62));
  });

  test("the middle of the range moves monotonically", () => {
    let last = mapLightness(0, anchors);
    for (let l = 0.1; l <= 1.0001; l += 0.1) {
      const mapped = mapLightness(l, anchors);
      assert.ok(mapped <= last + 1e-12, `l=${l} went up (${mapped} > ${last})`);
      last = mapped;
    }
  });

  test("values outside the anchors are clamped, not extrapolated", () => {
    // Extrapolation past pure black or white is not a colour, and it is how a
    // near-white panel would land at a negative lightness.
    for (const l of [-0.5, -0.0001, 1.0001, 2]) {
      const mapped = mapLightness(l, anchors);
      assert.ok(mapped >= 0 && mapped <= 1, `l=${l} → ${mapped}`);
    }
  });

  test("a degenerate page (canvas and text the same lightness) does not divide by zero", () => {
    const flat = mapLightness(0.5, { srcBg: 0.5, srcFg: 0.5, dstBg: 0.08, dstFg: 0.62 });
    assert.ok(Number.isFinite(flat));
    assert.equal(flat, 0.08);
  });
});

describe("mapping a colour", () => {
  test("hue and saturation survive, lightness moves", () => {
    const brand = parseColor("#1f6feb")!;
    const mapped = mapColor(brand, { srcBg: 1, srcFg: 0, dstBg: 0.08, dstFg: 0.62 });
    const before = rgbToHsl(brand);
    const after = rgbToHsl(mapped);
    assert.ok(near(after.h, before.h, 0.5), `hue moved from ${before.h} to ${after.h}`);
    assert.ok(near(after.s, before.s, 0.005), `saturation moved from ${before.s} to ${after.s}`);
    assert.ok(after.l < before.l, "and a light-ish blue got darker");
  });

  test("alpha is carried through untouched", () => {
    const mapped = mapColor({ r: 255, g: 255, b: 255, a: 0.4 }, { srcBg: 1, srcFg: 0, dstBg: 0.08, dstFg: 0.62 });
    assert.equal(mapped.a, 0.4);
  });

  test("white becomes the theme's canvas and black its text", () => {
    const anchors = { srcBg: 1, srcFg: 0, dstBg: 0.08, dstFg: 0.62 };
    assert.ok(near(rgbToHsl(mapColor({ r: 255, g: 255, b: 255, a: 1 }, anchors)).l, 0.08, 1e-6));
    assert.ok(near(rgbToHsl(mapColor({ r: 0, g: 0, b: 0, a: 1 }, anchors)).l, 0.62, 1e-6));
  });
});

/* ---------- surfaces and inks: the model a real page is painted with ---------- */

// THE REPORT behind these tests: "the colour that it picks is awful to look at".
// The positional mapping (tested above) puts a colour at the same position
// between text and canvas that it had on the light page — which means a DARK
// HEADER comes back as a PALE BAR, and a badge comes back as a glowing one.
// A surface and an ink are different questions; these are the answers.
describe("mapping a surface", () => {
  const lightPage = { canvas: parseColor("#ffffff")!, ink: parseColor("#111111")! };
  const darkTheme = { canvas: parseColor("#16161e")!, ink: parseColor("#c0caf5")! };
  const lum = (c: string) => relativeLuminance(parseColor(c)!);

  test("the page's canvas lands EXACTLY on the theme's canvas", () => {
    const mapped = mapSurface(parseColor("#ffffff")!, lightPage, darkTheme);
    assert.equal(formatColor(mapped), formatColor(darkTheme.canvas));
    // And a surface a rounding error away from it does too, or a white page
    // would come back as a wash of near-misses.
    assert.equal(formatColor(mapSurface(parseColor("#fefefe")!, lightPage, darkTheme)), formatColor(darkTheme.canvas));
  });

  test("a light panel becomes a slightly LIGHTER panel, not a second canvas", () => {
    const mapped = mapSurface(parseColor("#f2f4f8")!, lightPage, darkTheme);
    const d = relativeLuminance(mapped) - relativeLuminance(darkTheme.canvas);
    assert.ok(d > 0.01 && d < 0.08, `the panel sits ${d} above the canvas`);
  });

  test("a DARK header stays dark — the artifact this model exists for", () => {
    // #0b1a33 is a navy hero with white text on a white page. The old mapping
    // lightened it to near-white (it is "far from the canvas") and the header's
    // white text stayed white: a pale bar with invisible text in the middle of a
    // dark page.
    const mapped = mapSurface(parseColor("#0b1a33")!, lightPage, darkTheme);
    assert.ok(relativeLuminance(mapped) < 0.25, `the header came back at luminance ${relativeLuminance(mapped)}`);
    assert.ok(relativeLuminance(mapped) > relativeLuminance(darkTheme.canvas), "but it is still a visible panel");
    // White text on it must survive as white (see the ink tests).
    const ink = mapInk(parseColor("#ffffff")!, lightPage, darkTheme);
    assert.ok(relativeLuminance(ink) > 0.9, "white text stayed light");
    assert.ok(contrastRatio(ink, mapped) >= 4.5, "and reads on the panel it is on");
  });

  test("a saturated badge comes back deep, not neon", () => {
    // Preserving HSL lightness put #c62828 at luminance ~0.2 — a glowing red on a
    // dark page. Targeting luminance keeps its weight instead.
    const mapped = mapSurface(parseColor("#c62828")!, lightPage, darkTheme);
    assert.ok(relativeLuminance(mapped) < 0.2, `badge luminance ${relativeLuminance(mapped)}`);
    assert.ok(relativeLuminance(mapped) > lum("#16161e"), "still a surface, not the canvas");
    assert.ok(rgbToHsl(mapped).h < 10 || rgbToHsl(mapped).h > 350, "the hue survived");
  });

  test("a surface the size of the screen is quieter than a card", () => {
    // MEASURED on nytimes.com/puzzles/sudoku: the board is
    // `background:rgb(151,151,151)` over half a million px² (share 0.5). Lifted
    // like a card it became rgb(94,94,94) on a #16161e page — a glaring grey
    // square, the report "bunch of artifacts and harsh colors".
    const board = parseColor("#979797")!;
    const card = mapSurface(board, lightPage, darkTheme, 0.01);
    const backdrop = mapSurface(board, lightPage, darkTheme, 0.5);
    assert.ok(
      relativeLuminance(backdrop) < relativeLuminance(card) * 0.7,
      `the backdrop is quieter than the card: ${formatColor(backdrop)} vs ${formatColor(card)}`
    );
    assert.ok(
      relativeLuminance(backdrop) > relativeLuminance(darkTheme.canvas),
      "but it is still a surface, not the canvas"
    );
    // A small element is unaffected — the damping is about area, not colour.
    assert.equal(formatColor(mapSurface(board, lightPage, darkTheme, 0)), formatColor(card));
  });

  test("alpha is carried through untouched", () => {
    const frosted = parseColor("rgba(255,255,255,0.85)")!;
    assert.equal(mapSurface(frosted, lightPage, darkTheme).a, 0.85);
  });

  test("lightening a dark page mirrors the rule: panels go slightly darker", () => {
    const darkPage = { canvas: parseColor("#0f1115")!, ink: parseColor("#e6e6e6")! };
    const lightTheme = { canvas: parseColor("#c0caf5")!, ink: parseColor("#16161e")! };
    const mapped = mapSurface(parseColor("#202836")!, darkPage, lightTheme);
    assert.ok(relativeLuminance(mapped) < relativeLuminance(lightTheme.canvas), "a panel on a light page is darker");
    const canvas = mapSurface(parseColor("#0f1115")!, darkPage, lightTheme);
    assert.equal(formatColor(canvas), formatColor(lightTheme.canvas));
  });
});

describe("mapping an ink", () => {
  const lightPage = { canvas: parseColor("#ffffff")!, ink: parseColor("#111111")! };
  const darkTheme = { canvas: parseColor("#16161e")!, ink: parseColor("#c0caf5")! };

  test("the page's own text colour lands on the theme's ink", () => {
    assert.equal(formatColor(mapInk(parseColor("#111111")!, lightPage, darkTheme)), formatColor(darkTheme.ink));
  });

  test("a dark page's white text is not inverted into black text", () => {
    // On a dark page, white text on a dark header is ALREADY correct. The
    // positional model maps "far from the canvas" toward the other pole and
    // turns it black, which is black text on a black bar.
    const ink = mapInk(parseColor("#ffffff")!, lightPage, darkTheme);
    assert.ok(relativeLuminance(ink) > 0.9, `white text came back at ${formatColor(ink)}`);
  });

  test("hierarchy survives: muted text is dimmer than body text", () => {
    const body = mapInk(parseColor("#1b1f24")!, lightPage, darkTheme);
    const muted = mapInk(parseColor("#5b6472")!, lightPage, darkTheme);
    assert.ok(relativeLuminance(muted) < relativeLuminance(body), "muted must stay quieter");
    assert.ok(contrastRatio(muted, darkTheme.canvas) >= MIN_TEXT_CONTRAST, "and still readable");
  });

  test("a saturated ink keeps its hue", () => {
    const mapped = mapInk(parseColor("#1257c9")!, lightPage, darkTheme);
    const hue = rgbToHsl(mapped).h;
    assert.ok(hue > 200 && hue < 230, `blue link came back at hue ${hue}`);
  });
});

describe("guaranteeing contrast", () => {
  test("no text is left below the readable ratio", () => {
    // Black text mapped onto a dark badge is the classic disaster: both ends of
    // the pair moved to the dark side and the label vanished.
    const surface = parseColor("#2b2b2b")!;
    const out = ensureContrast(parseColor("#16161e")!, surface, MIN_TEXT_CONTRAST);
    assert.ok(contrastRatio(out, surface) >= MIN_TEXT_CONTRAST, formatColor(out));
  });

  test("on a light surface it darkens rather than lightens", () => {
    const surface = parseColor("#e8e8e8")!;
    const out = ensureContrast(parseColor("#dddddd")!, surface, MIN_TEXT_CONTRAST);
    assert.ok(contrastRatio(out, surface) >= MIN_TEXT_CONTRAST);
    assert.ok(relativeLuminance(out) < relativeLuminance(surface));
  });

  test("a colour that already reads is returned untouched", () => {
    const fg = parseColor("#c0caf5")!;
    assert.equal(ensureContrast(fg, parseColor("#16161e")!, MIN_TEXT_CONTRAST), fg);
  });

  test("withLuminance hits its target exactly, hue intact", () => {
    const out = withLuminance(parseColor("#c62828")!, 0.08);
    assert.ok(near(relativeLuminance(out), 0.08, 0.004), `got ${relativeLuminance(out)}`);
    assert.equal(rgbToHsl(out).h, rgbToHsl(parseColor("#c62828")!).h);
  });
});

// THE MODERN SYNTAXES. A computed colour is not always `rgb()`: Firefox hands
// back whatever the page wrote, and since 2024 that is usually `oklch()`,
// `oklab()` or `lab()`. Each of these was measured in the browser (the pixels
// are Firefox's own, via a 1x1 canvas) rather than copied from a spec table —
// the anchors below are the values a real rendering produced.
describe("the modern colour syntaxes", () => {
  const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
  const rgb = (s: string) => {
    const c = parseColor(s);
    assert.ok(c, `parsed nothing from ${s}`);
    return c!;
  };
  const same = (s: string, r: number, g: number, b: number, tol = 2) => {
    const c = rgb(s);
    assert.ok(
      near(c.r, r, tol) && near(c.g, g, tol) && near(c.b, b, tol),
      `${s} → ${formatColor(c)}, expected rgb(${r}, ${g}, ${b})`
    );
  };

  test("oklch and oklab land in sRGB", () => {
    same("oklch(1 0 0)", 255, 255, 255);
    same("oklch(0 0 0)", 0, 0, 0);
    same("oklab(0.5 0 0)", 99, 99, 99);
    const mid = rgb("oklch(0.5 0.1 200)");
    assert.ok(!near(mid.r, mid.b, 1), "a chromatic colour is not a grey: " + formatColor(mid));
  });

  test("lab and lch land in sRGB, D50 adaptation included", () => {
    // `lab(50% 0 0)` is the canonical mid grey, and it is the one value that
    // catches a missing D50→D65 adaptation (which lands at 124 instead of 119).
    same("lab(100% 0 0)", 255, 255, 255);
    same("lab(0% 0 0)", 0, 0, 0);
    same("lab(50% 0 0)", 119, 119, 119, 4);
    same("lab(50 0 0)", 119, 119, 119, 4);
    same("lch(50% 0 0)", 119, 119, 119, 4);
    const red = rgb("lch(29.2345% 44.2 27)");
    assert.ok(red.r > red.g && red.r > red.b, "the hue survived: " + formatColor(red));
  });

  test("the rest of the Color 4 syntaxes are read, not skipped", () => {
    same("hwb(0 0% 0%)", 255, 0, 0);
    same("color(srgb 1 0 0)", 255, 0, 0);
    same("color(srgb 0.5 0.5 0.5)", 128, 128, 128, 2);
    const p3 = rgb("color(display-p3 1 0 0)");
    assert.ok(p3.r > 250 && p3.g < 40 && p3.b < 40, "P3 red fits in sRGB: " + formatColor(p3));
    same("color-mix(in srgb, #ffffff 50%, #000000)", 128, 128, 128, 2);
    same("color-mix(in srgb, #ffffff 25%, #000000)", 64, 64, 64, 2);
    same("light-dark(white, black)", 255, 255, 255);
  });

  test("an alpha survives in every syntax", () => {
    assert.ok(near(rgb("oklab(1 0 0 / 0.1)").a, 0.1, 0.01));
    assert.ok(near(rgb("lab(50% 0 0 / 50%)").a, 0.5, 0.01));
    assert.ok(near(rgb("color-mix(in srgb, rgb(255 0 0 / 0.5) 100%, transparent)").a, 0.5, 0.02));
  });

  test("a syntax that is not a colour is still refused", () => {
    assert.equal(parseColor("lab(50% 0)"), null);
    assert.equal(parseColor("nonsense(1 2 3)"), null);
    assert.equal(parseColor("color(nonsense 1 0 0)"), null);
    assert.equal(parseColor("color(display-p3 1 0)"), null);
  });
});

describe("colour bucketing", () => {
  test("near-identical colours share a key, distant ones do not", () => {
    assert.equal(colorKey(parseColor("#ffffff")!), colorKey(parseColor("#fefefe")!));
    assert.notEqual(colorKey(parseColor("#ffffff")!), colorKey(parseColor("#000000")!));
  });

  test("nearColor's tolerance is in one place and is used the other way round", () => {
    assert.equal(nearColor(parseColor("#ffffff")!, parseColor("#f8f8f8")!), true);
    assert.equal(nearColor(parseColor("#ffffff")!, parseColor("#d8d8d8")!), false);
    assert.equal(nearColor(parseColor("#ffffff")!, parseColor("#d8d8d8")!, 60), true);
  });
});
