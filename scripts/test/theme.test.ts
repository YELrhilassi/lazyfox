// The UI palette: five presets, the user's overrides, and the tokens every
// surface reads.
//
// What this pins is the part that is easy to get subtly wrong and impossible to
// notice by eye: an accent whose ink is unreadable, a preset that claims to be
// light while its ground is dark, a background override that leaves borders
// invisible against the new ground, or a token block that forgets one name and
// quietly paints that surface in its fallback for every preset.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { mergeConfig } from "../../src/shared/config.ts";
import {
  DEFAULT_UI_PRESET,
  UI_PRESETS,
  UI_THEME_DEFAULTS,
  isHexColor,
  logoFile,
  luminance,
  presetById,
  resolvePalette,
  uiCss,
  uiVars,
} from "../../src/shared/theme.ts";

/** WCAG contrast of ink against a fill, computed from the module's own luminance. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the shipped presets", () => {
  test("there are five, with unique ids, and the default is one of them", () => {
    assert.equal(UI_PRESETS.length, 5);
    assert.equal(new Set(UI_PRESETS.map((p) => p.id)).size, 5);
    assert.ok(UI_PRESETS.some((p) => p.id === DEFAULT_UI_PRESET));
  });

  test("exactly one is a light palette, and it is the daylight option", () => {
    const light = UI_PRESETS.filter((p) => p.palette.light);
    assert.equal(light.length, 1);
    assert.equal(light[0]!.id, "solarized");
  });

  test("every preset's ink and accent are readable on every ground it paints", () => {
    for (const preset of UI_PRESETS) {
      const p = resolvePalette({ preset: preset.id });
      // Measured against the PANEL, the worst ground the UI puts text on:
      // a popup row sits on --lf-panel, which is lighter than the page on a
      // dark preset and darker on a light one. Body ink clears 8:1 there, the
      // secondary tier 5.5:1 and the tertiary tier 4.2:1 — enough separation
      // that the three tiers still read as three tiers.
      for (const [name, ink, min] of [
        ["foreground", p.fg, 8.5],
        ["secondary", p.sub, 6.5],
        ["tertiary", p.dim, 4.8],
      ] as const) {
        assert.ok(
          contrast(ink, p.panel) >= min,
          `${preset.id}: ${name} ${ink} on panel ${p.panel} = ${contrast(ink, p.panel).toFixed(1)}:1`
        );
      }
      // The accent is both a FILL (with onAccent drawn on it) and a colour used
      // for keys and links, so both jobs are checked.
      assert.ok(
        contrast(p.accent, p.bg) >= 4.6,
        `${preset.id}: accent ${p.accent} on ${p.bg} = ${contrast(p.accent, p.bg).toFixed(1)}:1`
      );
      assert.ok(
        contrast(p.onAccent, p.accent) >= 4.5,
        `${preset.id}: ink ${p.onAccent} on accent ${p.accent} = ${contrast(p.onAccent, p.accent).toFixed(1)}:1`
      );
      // Every semantic fill carries its own ink, and every pair must pass: a
      // FIND badge is cyan on one preset and red on another, and neither may
      // inherit the accent's answer.
      for (const [name, fill, ink] of [
        ["green", p.green, p.onGreen],
        ["red", p.red, p.onRed],
        ["yellow", p.yellow, p.onYellow],
        ["purple", p.purple, p.onPurple],
        ["cyan", p.cyan, p.onCyan],
      ] as const) {
        assert.ok(
          contrast(ink, fill) >= 4.5,
          `${preset.id}: ink ${ink} on ${name} ${fill} = ${contrast(ink, fill).toFixed(1)}:1`
        );
      }
      assert.ok(isHexColor(p.bg) && isHexColor(p.accent), preset.id + ": hex colours");
    }
  });

  test("the active row is a brighter, coloured step — never the hover tone", () => {
    // The bug this pins: hover and selection shared `raise`, so a pointer that
    // rested on an unrelated row made it look exactly like the selected one and
    // the active item was the hardest thing in the list to find. The selection
    // is now a step toward the accent, visibly apart from hover, and body ink
    // still reads on it (selected rows print both title and subtitle).
    for (const preset of UI_PRESETS) {
      const p = resolvePalette({ preset: preset.id });
      assert.notEqual(p.sel, p.raise, preset.id + ": selection must differ from hover");
      assert.ok(
        contrast(p.sel, p.raise) >= 1.15,
        `${preset.id}: selection ${p.sel} on hover ${p.raise} = ${contrast(p.sel, p.raise).toFixed(2)}:1`
      );
      assert.ok(
        contrast(p.fg, p.sel) >= 5.2,
        `${preset.id}: ink ${p.fg} on selection ${p.sel} = ${contrast(p.fg, p.sel).toFixed(2)}:1`
      );
      // A custom ground re-derives the surfaces; the selection must follow.
      const custom = resolvePalette({ preset: preset.id, background: "#101820" });
      assert.ok(contrast(custom.fg, custom.sel) >= 5.2, preset.id + ": custom-ground selection ink");
    }
  });

  test("a session chip separates from the bar it is drawn on", () => {
    // The light-theme complaint this pins: `raise` is 1.09:1 from the bar on
    // Solarized and on Rosé Pine, so the chips were shapes you could not see
    // until one of them turned blue. The chip token is measured against the bar
    // for exactly this reason, and the ink on it has to survive the change.
    for (const preset of UI_PRESETS) {
      const p = resolvePalette({ preset: preset.id });
      assert.ok(
        contrast(p.chip, p.bg2) >= 1.29,
        `${preset.id}: chip ${p.chip} on bar ${p.bg2} = ${contrast(p.chip, p.bg2).toFixed(2)}:1`
      );
      assert.ok(
        contrast(p.sub, p.chip) >= 4.6,
        `${preset.id}: secondary ink ${p.sub} on chip ${p.chip} = ${contrast(p.sub, p.chip).toFixed(2)}:1`
      );
    }
  });
});

describe("resolving the user's theme", () => {
  test("no theme means the default preset, with nothing overridden", () => {
    const p = resolvePalette();
    assert.equal(p.bg, presetById(DEFAULT_UI_PRESET).palette.bg);
    assert.equal(p.accent, presetById(DEFAULT_UI_PRESET).palette.accent);
  });

  test("an unknown preset falls back to the default instead of throwing", () => {
    const p = resolvePalette({ preset: "not-a-theme" });
    assert.equal(p.bg, presetById(DEFAULT_UI_PRESET).palette.bg);
  });

  test("an accent override replaces the accent and recomputes its ink", () => {
    const p = resolvePalette({ preset: "tokyonight", accent: "#f9e2af" });
    assert.equal(p.accent, "#f9e2af");
    // A pale yellow needs dark ink; the preset's blue took dark ink too, so this
    // also proves the computation runs rather than the value being copied.
    assert.equal(p.onAccent, "#101014");
    // A deep blue cannot be read as TEXT on a dark ground, so the override is
    // fitted lighter before its ink is chosen — a user cannot pick an accent
    // that makes every key cap and link vanish.
    const dark = resolvePalette({ preset: "tokyonight", accent: "#1a237e" });
    assert.notEqual(dark.accent, "#1a237e");
    assert.ok(contrast(dark.accent, dark.bg) >= 4.6);
    // On a light preset the accent is dark enough to need white ink.
    assert.equal(resolvePalette({ preset: "solarized" }).onAccent, "#ffffff");
  });

  test("a background override re-derives the surfaces around it", () => {
    const base = resolvePalette({ preset: "gruvbox" });
    const custom = resolvePalette({ preset: "gruvbox", background: "#101820" });
    assert.equal(custom.bg, "#101820");
    assert.notEqual(custom.bg2, base.bg2);
    assert.notEqual(custom.panel, base.panel);
    // The ground moved, so it must still be described as dark.
    assert.equal(custom.light, false);
    // Ink follows the ground, not the preset. Gruvbox's cream is fine here, so
    // it survives; the point is that it was measured, not copied.
    assert.ok(contrast(custom.fg, custom.panel) >= 8.5);
  });

  test("a light custom ground turns the surface decisions light", () => {
    const p = resolvePalette({ preset: "tokyonight", background: "#fafafa" });
    assert.equal(p.light, true);
    assert.match(p.tint, /rgba\(0,0,0/);
    // The veil is derived from the new ground rather than from a hard-coded
    // paper colour.
    assert.match(p.backdrop, /^rgba\(/);
  });

  test("a dark preset on a light custom ground gets dark, readable ink", () => {
    // The bug this pins: Tokyo Night's pale ink stayed on a #fafafa ground, so
    // every row and every label was white-on-white.
    const p = resolvePalette({ preset: "tokyonight", background: "#fafafa" });
    assert.ok(contrast(p.fg, p.bg) >= 8.5, `fg ${p.fg} on ${p.bg} = ${contrast(p.fg, p.bg).toFixed(1)}`);
    assert.ok(contrast(p.sub, p.bg) >= 6.5, `sub ${p.sub} on ${p.bg}`);
    assert.ok(contrast(p.dim, p.bg) >= 4.8, `dim ${p.dim} on ${p.bg}`);
    // And the accent's ink followed: a pale accent on paper needs dark text.
    assert.ok(contrast(p.onAccent, p.accent) >= 4.5);
  });

  test("the logo flips to the dark wordmark on a light palette", () => {
    assert.match(logoFile(resolvePalette({ preset: "tokyonight" })), /^lazyfox-logo\.svg$/);
    assert.match(logoFile(resolvePalette({ preset: "solarized" })), /^lazyfox-logo-light\.svg$/);
    assert.match(logoFile(resolvePalette({ preset: "tokyonight", background: "#fafafa" })), /light/);
  });

  test("an invalid colour is ignored rather than emitted as broken CSS", () => {
    const p = resolvePalette({ preset: "tokyonight", accent: "rebeccapurple", background: "#12" });
    assert.equal(p.accent, presetById("tokyonight").palette.accent);
    assert.equal(p.bg, presetById("tokyonight").palette.bg);
  });

  test("merging a stored partial does not erase the other theme fields", () => {
    const merged = mergeConfig({ theme: { preset: "rosepine", accent: "", background: "" } });
    assert.equal(merged.theme.preset, "rosepine");
    assert.equal(merged.theme.accent, UI_THEME_DEFAULTS.accent);
    assert.equal(merged.theme.background, UI_THEME_DEFAULTS.background);
  });
});

describe("the emitted tokens", () => {
  test("every role is emitted, exactly once", () => {
    const p = resolvePalette({ preset: "catppuccin" });
    const vars = uiVars(p);
    const names = [...vars.matchAll(/--lf-([a-z0-9-]+):/g)].map((m) => m[1]);
    assert.equal(names.length, new Set(names).size, "no duplicate token");
    for (const required of [
      "bg", "bg2", "panel", "fg", "sub", "dim", "border", "border2",
      "raise", "sel", "chip", "accent", "green", "red", "yellow", "purple", "cyan",
      "on-accent", "on-green", "on-red", "on-yellow", "on-purple", "on-cyan",
      "tint", "backdrop", "shadow",
      // A type token, not a colour: the bar and its settings preview must pick
      // the same face, and both read it from this block.
      "bar-font",
    ]) {
      assert.ok(names.includes(required), "missing token --lf-" + required);
    }
  });

  test("a stylesheet is prefixed for BOTH hosts, as separate rules", () => {
    const css = uiCss(".x{color:var(--lf-fg)}");
    // Separate rules on purpose: a selector list mixing :host and :root is
    // dropped wholesale in the plain-DOM chrome context.
    assert.ok(css.startsWith(":root{"));
    assert.ok(css.includes("\n:host{"));
    assert.ok(css.endsWith(".x{color:var(--lf-fg)}"));
  });

  test("a light palette sets the light attribute value the pages read", () => {
    const p = resolvePalette({ preset: "solarized" });
    assert.equal(p.light, true);
  });
});
