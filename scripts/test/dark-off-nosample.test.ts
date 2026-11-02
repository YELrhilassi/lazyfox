// A PAGE NOBODY ASKED US TO RECOLOUR IS NOT MEASURED.
//
// The report this file exists for: "I go to apps like web.whatsapp.com and it
// freezes after it loads, and Firefox complains about lazyfox". The sampler walks
// the document and reads a computed style per element. `off` is the default and
// every load asked for a pass (boot, the stored config, DOMContentLoaded), so a
// page the user never asked us to touch was walked three times to build a theme
// the mode had already refused. These tests COUNT the reads instead of trusting
// the comment: the off case must not enumerate or measure anything, and the
// control proves the counting instrument would have caught the regression.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDarkMode } from "../../src/extension/content/dark/index.ts";
import { mergeConfig } from "../../src/shared/config.ts";
import type { Config } from "../../src/shared/types.ts";

interface Counts {
  /** `getPropertyValue` calls — one computed style actually read. */
  elementStyles: number;
  /** `querySelectorAll("*")` calls — the document being enumerated. */
  allQueries: number;
}

function fakeWorld(counts: Counts) {
  const computed = (): any => ({
    colorScheme: "",
    getPropertyValue: (name: string): string => {
      counts.elementStyles++;
      switch (name) {
        case "display":
          return "block";
        case "visibility":
          return "visible";
        case "background-color":
          return "rgb(255, 255, 255)";
        case "color":
          return "rgb(17, 17, 17)";
        case "background-image":
          return "none";
        case "background-size":
          return "auto";
        default:
          return name.slice(-6) === "-width" ? "0" : "";
      }
    },
  });

  const el = (tag: string): any => ({
    tagName: tag,
    id: "",
    isConnected: true,
    classList: [],
    children: [],
    textContent: "",
    style: { getPropertyValue: () => "", setProperty: () => {}, removeProperty: () => {} },
    getAttribute: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    appendChild: () => {},
  });

  // The document the controller sees: a real-looking page of four elements, with
  // an instrument on the two reads the sampler exists to spend.
  const nodes = [el("HTML"), el("BODY"), el("DIV"), el("P")];
  const doc: any = {
    documentElement: nodes[0],
    body: nodes[1],
    head: null,
    readyState: "complete",
    querySelectorAll: (sel: string): any[] => {
      if (sel === "*") counts.allQueries++;
      return sel === "*" ? nodes : [];
    },
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tag: string) => el(tag.toUpperCase()),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const win: any = {
    getComputedStyle: () => computed(),
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    performance: { now: () => Date.now() },
    innerWidth: 1280,
    innerHeight: 800,
  };
  return { doc, win };
}

function controller(counts: Counts, config: Config) {
  const { doc, win } = fakeWorld(counts);
  return createDarkMode({
    doc,
    win,
    url: () => "https://web.whatsapp.com/",
    getConfig: () => config,
    setConfig: () => {},
    toast: () => {},
  });
}

/** `apply` is async (the sampler yields); two turns is past the first pass. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("dark mode standing down on a page nobody asked us to recolour", () => {
  test("`off` never enumerates or measures the document", async () => {
    const counts: Counts = { elementStyles: 0, allQueries: 0 };
    const config = mergeConfig(undefined);
    assert.equal(config.dark.mode, "off", "premise: off is the shipped default");
    const dark = controller(counts, config);

    dark.update(config);
    await settle();

    assert.equal(counts.allQueries, 0, "the document was enumerated for a theme nobody asked for");
    assert.equal(counts.elementStyles, 0, "an element's computed style was read for a theme nobody asked for");
    assert.equal(dark.state().on, false);
    assert.equal(dark.state().mode, "off");
    assert.equal(dark.state().reason, "turned off");
  });

  test("a site rule that says off is the same stand-down", async () => {
    const counts: Counts = { elementStyles: 0, allQueries: 0 };
    const base = mergeConfig(undefined);
    // The site rule wins over the global mode: `dark` globally, off HERE.
    const config = mergeConfig({
      dark: { ...base.dark, mode: "dark", sites: [{ match: "web.whatsapp.com", mode: "off" }] },
    });
    const dark = controller(counts, config);

    dark.update(config);
    await settle();

    assert.equal(counts.allQueries, 0, "a site turned off is still not measured");
    assert.equal(counts.elementStyles, 0, "a site turned off still pays no style reads");
    assert.equal(dark.state().on, false);
    assert.equal(dark.state().mode, "off");
  });

  test("control: dark on DOES measure the page, so the counters above bite", async () => {
    const counts: Counts = { elementStyles: 0, allQueries: 0 };
    const base = mergeConfig(undefined);
    const config = mergeConfig({ dark: { ...base.dark, mode: "dark" } });
    const dark = controller(counts, config);

    dark.update(config);
    await settle();

    assert.ok(counts.allQueries > 0, "the page is enumerated when a theme is wanted");
    assert.ok(counts.elementStyles > 0, "elements are measured when a theme is wanted");
  });
});
