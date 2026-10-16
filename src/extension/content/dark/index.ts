// The dark-mode controller: the one object the leader actions talk to.
//// It owns the whole life of one page's theme — the early paint before anything
// is known, the decision, the sheet, the resample gate, and the four writes a
// user can make from the keyboard. The arithmetic is elsewhere (color/detect/theme)
// and the DOM shell is elsewhere (apply.ts); this file is glue and policy, which
// is why it is the file that reads like prose.
//
// POLICY, stated once:
//
//   mode `auto`   darken the page UNLESS it is already dark. This is the
//                 default, and it is what "smart" means here: on the pages that
//                 already look right, the correct action is none.
//   mode `dark`   darken regardless — the user asked, so the detection is not
//                 consulted. This is what `;Y d` writes, because a user who
//                 toggles a page is overriding an automatic decision rather
//                 than adding a vote to it.
//   mode `light`  the mirror image, for a user who prefers light pages.
//   mode `off`    nothing at all.
//
// A site rule (config.dark.sites) may pin any of those four per host, and may
// pin the engine, which is the escape hatch for a page the dynamic engine reads
// badly. Site rules are ordinary config, which is why they are editable in the
// settings page as well as from the keyboard.

import {
  hostAndPath,
  matchRules,
  parseFixList,
  type DarkRule,
} from "../../../shared/dark-rules";
import type { Config, SiteRule } from "../../../shared/types";
import { createDarkApplier, createResampleGate } from "./apply";
import { analyze, chooseEngine, shouldApply, type Analysis, type PageSample } from "./detect";
import { buildTheme, composeSheet, entriesFor, fallbackSheet, siteRulesFor, type Theme } from "./theme";

export interface DarkState {
  on: boolean;
  /** The mode in force: auto | dark | light | off. */
  mode: string;
  engine: string;
  /** Why the last decision came out the way it did. Never empty. */
  reason: string;
  host: string;
  /** The rule that decided this page, when one did. */
  site: SiteRule | null;
  pageDark: boolean;
  coverage: number;
  corpusBlocks: number;
  corpusErrors: number;
}

export interface DarkController {
  /** Paint the canvas NOW, before anything is known. See the note below. */
  early(): void;
  /** Re-decide and re-apply from the current config. Idempotent. */
  update(config: Config): void;
  /** `;Y d` — dark on/off for this site, writing a site rule. */
  toggleSite(): void;
  /** `;Y g` — cycle the global default. */
  cycleGlobal(): void;
  /** `;Y e` — cycle the engine for this site. */
  toggleEngine(): void;
  /** `;Y x` — drop this site's rules. */
  resetSite(): void;
  state(): DarkState;
}

export interface DarkDeps {
  doc: Document;
  win: Window;
  url(): string;
  getConfig(): Config;
  setConfig(next: Config): void;
  toast(msg: string): void;
}

type Mode = "auto" | "dark" | "light" | "off";
type EnginePref = "auto" | "dynamic" | "filter";

const MODE_CYCLE: Mode[] = ["auto", "dark", "light", "off"];
const ENGINE_CYCLE: EnginePref[] = ["auto", "dynamic", "filter"];

export function createDarkMode(deps: DarkDeps): DarkController {
  const applier = createDarkApplier(deps.doc, deps.win);
  const gate = createResampleGate(() => Date.now());
  let observer: MutationObserver | null = null;
  let corpusText = "\u0000";
  let corpus: DarkRule[] = [];
  let corpusErrors = 0;
  let state: DarkState = {
    on: false,
    mode: "auto",
    engine: "auto",
    reason: "not decided yet",
    host: hostAndPath(deps.url()).host,
    site: null,
    pageDark: false,
    coverage: 0,
    corpusBlocks: 0,
    corpusErrors: 0,
  };
  let earlySheet = false;

  function rules(): DarkRule[] {
    const text = deps.getConfig().dark?.fixes ?? "";
    if (text !== corpusText) {
      const parsed = parseFixList(text);
      corpusText = text;
      corpus = parsed.rules;
      corpusErrors = parsed.errors.length;
    }
    return corpus;
  }

  function siteFor(): SiteRule | null {
    const host = hostAndPath(deps.url()).host;
    const hits = siteRulesFor(deps.getConfig().dark?.sites || [], deps.url());
    const last = hits.length ? hits[hits.length - 1]! : null;
    state.host = host;
    return last;
  }

  /** The live theme, or null when the page should be left alone. */
  function decide(config: Config, analysis: Analysis): { theme: Theme | null; direction: Mode; mode: Mode; engine: EnginePref; reason: string } {
    const mode: Mode = state.site?.mode ?? config.dark.mode;
    const enginePref: EnginePref = state.site?.engine ?? config.dark.engine;
    if (mode === "off") return { theme: null, direction: mode, mode, engine: enginePref, reason: "turned off" };
    const direction = mode === "light" ? "lighten" : "darken";
    // `auto` is where the already-dark check applies; an explicit `dark`/`light`
    // is the user overriding detection, so it is not consulted.
    const skip = mode === "auto";
    const decision = shouldApply(direction, analysis, skip);
    if (!decision.on) return { theme: null, direction: mode, mode, engine: enginePref, reason: decision.reason };
    const engine = chooseEngine(enginePref, analysis);
    const theme = buildTheme(config.dark, direction, engine, analysis);
    return { theme, direction: mode, mode, engine: enginePref, reason: decision.reason + " · " + engine + " engine" };
  }

  function mirror(): void {
    try {
      const root = deps.doc.documentElement;
      if (!root) return;
      root.setAttribute("data-lf-dark", state.on ? "on" : "off");
      root.setAttribute("data-lf-dark-mode", state.mode);
      root.setAttribute("data-lf-dark-engine", state.engine);
      root.setAttribute("data-lf-dark-reason", state.reason);
    } catch {
      /* the document may be going away */
    }
  }

  function ensureObserver(): void {
    if (observer) return;
    try {
      observer = new MutationObserver(() => {
        if (!gate()) return;
        if (state.on) void apply(deps.getConfig());
      });
      observer.observe(deps.doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    } catch {
      observer = null;
    }
  }

  async function apply(config: Config): Promise<void> {
    const url = deps.url();
    state.site = siteFor();
    // THE PENDING PAINT IS NOT PART OF THE MEASUREMENT, and this is the line that
    // decides whether the feature works at all on a machine whose OS is dark.
    //
    // `early()` paints the OS's guess at document_start so there is no white
    // flash, and the fallback sheet paints `html,body` — which is exactly where
    // the sampler reads the CANVAS from. Measuring with it installed therefore
    // reads our own paint back as the page's: a white page measures as dark, the
    // decision comes out "the page is already dark", and the feature stands down
    // on every light page for a user with a dark OS. (Measured in the e2e theme
    // suite: `data-lf-dark-reason` read "the page is already dark" on a white
    // fixture whose `prefers-color-scheme` was dark.)
    //
    // So the placeholder is removed first and reinstated only if the decision is
    // to paint. The cost is the very flash the placeholder exists to prevent, for
    // as long as one measurement takes — and only on that dark-OS machine, where
    // the alternative is a feature that does nothing.
    if (earlySheet) applier.clear();
    const samples: PageSample[] = await applier.sample();
    const analysis = analyze(samples);
    const decision = decide(config, analysis);
    const rulesForPage = matchRules(rules(), url);
    state.coverage = analysis.coverage;
    state.pageDark = analysis.pageDark;
    state.corpusBlocks = corpus.length;
    state.corpusErrors = corpusErrors;
    state.mode = decision.mode;
    state.engine = decision.theme ? decision.theme.engine : decision.engine;
    state.reason = decision.reason;
    if (earlySheet) {
      // The real decision has landed; the placeholder paint is no longer needed
      // and must never outlive the sheet that replaces it.
      try {
        deps.doc.documentElement?.removeAttribute("data-lf-dark-pending");
      } catch {
        /* ignore */
      }
      earlySheet = false;
    }
    if (!decision.theme) {
      applier.clear();
      state.on = false;
      mirror();
      return;
    }
    const theme = decision.theme;
    const entries = theme.engine === "dynamic" ? entriesFor(samples, theme) : [];
    applier.setSheet(composeSheet({ theme, entries, rules: rulesForPage, userCss: config.dark.userCss || "" }));
    applier.setScheme(theme.direction === "darken" ? "dark" : "light");
    state.on = true;
    mirror();
    ensureObserver();
  }

  function write(next: Config): void {
    deps.setConfig(next);
    // Apply the local copy immediately so the toast and the sheet agree with
    // what the user just pressed; the storage broadcast will confirm it.
    void apply(next);
  }

  function upsertSite(host: string, patch: Partial<SiteRule>): Config {
    const config = deps.getConfig();
    const sites = (config.dark.sites || []).slice();
    const at = sites.findIndex((r) => r.match === host);
    const next: SiteRule = at >= 0 ? { ...sites[at]!, ...patch } : { match: host, ...patch };
    // An entry with nothing left to say is removed rather than kept as noise:
    // an empty rule reads like a setting and behaves like nothing.
    const meaningful = next.mode !== undefined || next.engine !== undefined || !!next.css;
    if (at >= 0) {
      if (meaningful) sites[at] = next;
      else sites.splice(at, 1);
    } else if (meaningful) {
      sites.push(next);
    }
    return { ...config, dark: { ...config.dark, sites } };
  }

  return {
    early(): void {
      // THE WHITE FLASH. Between document_start and the moment the config
      // arrives there is nothing to decide from except the operating system's
      // preference — the one fact available synchronously — so it is used as a
      // hint and nothing more. A user with a dark OS who has turned the feature
      // OFF will see this paint for a few milliseconds before it is removed;
      // the alternative (everyone else seeing a white flash on every page they
      // open) is worse, and this is the trade, stated.
      let prefersDark = false;
      try {
        prefersDark = !!deps.win.matchMedia && deps.win.matchMedia("(prefers-color-scheme: dark)").matches;
      } catch {
        prefersDark = false;
      }
      if (!prefersDark) return;
      const config = deps.getConfig();
      if (config.dark.mode === "off") return;
      const theme = buildTheme(config.dark, "darken", "dynamic", {
        canvas: { r: 255, g: 255, b: 255, a: 1 },
        text: { r: 0, g: 0, b: 0, a: 1 },
        canvasKey: "",
        textKey: "",
        pageDark: false,
        coverage: 0,
        sampled: false,
        distinct: 0,
      });
      try {
        deps.doc.documentElement?.setAttribute("data-lf-dark-pending", "1");
      } catch {
        /* ignore */
      }
      applier.setSheet(fallbackSheet(theme));
      earlySheet = true;
      state.reason = "waiting for the config (OS prefers dark)";
      mirror();
    },

    update(config: Config): void {
      void apply(config);
    },

    toggleSite(): void {
      const host = hostAndPath(deps.url()).host;
      if (!host) {
        deps.toast("dark mode: this page has no host");
        return;
      }
      const on = state.on;
      const next = upsertSite(host, { mode: on ? "off" : "dark" });
      deps.toast("dark mode: " + (on ? "off" : "on") + " for " + host);
      write(next);
    },

    cycleGlobal(): void {
      const config = deps.getConfig();
      const at = MODE_CYCLE.indexOf(config.dark.mode);
      const mode = MODE_CYCLE[(at + 1) % MODE_CYCLE.length]!;
      deps.toast("dark mode default: " + mode);
      write({ ...config, dark: { ...config.dark, mode } });
    },

    toggleEngine(): void {
      const host = hostAndPath(deps.url()).host;
      const config = deps.getConfig();
      const site = (config.dark.sites || []).find((r) => r.match === host);
      const current: EnginePref = site?.engine ?? config.dark.engine;
      const at = ENGINE_CYCLE.indexOf(current);
      const engine = ENGINE_CYCLE[(at + 1) % ENGINE_CYCLE.length]!;
      deps.toast("dark engine: " + engine + (host ? " for " + host : ""));
      write(upsertSite(host, { engine }));
    },

    resetSite(): void {
      const host = hostAndPath(deps.url()).host;
      const config = deps.getConfig();
      const sites = (config.dark.sites || []).filter((r) => r.match !== host);
      deps.toast(sites.length === (config.dark.sites || []).length ? "dark mode: no rules for " + host : "dark mode: rules for " + host + " cleared");
      write({ ...config, dark: { ...config.dark, sites } });
    },

    state: () => ({ ...state }),
  };
}
