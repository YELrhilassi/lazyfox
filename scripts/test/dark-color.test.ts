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
  formatColor,
  hslToRgb,
  mapColor,
  mapLightness,
  nearColor,
  parseColor,
  relativeLuminance,
  rgbToHsl,
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
