// Config: bootstrap and restore — part of the e2e fixture.
//
// Config is the one piece of shared state that outlives a test and fails
// // somewhere else entirely — the options group reading whichKey three
// // groups after a `;q`. restoreConfig diffs against a pristine snapshot and
// // writes the WHOLE config back through the background's own setConfig
// // handler, because the background caches config and would otherwise
// // re-save its copy over the top.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import { evalIn } from "../bidi.ts";
// The product's OWN schema and merge, imported rather than re-implemented.
//
// `setConfig` does not store what it is handed: the handler validates the
// payload per field (extension/store.ts#vConfig) and writes
// `mergeConfig(...)` over the defaults (extension/handlers/sync.ts). A harness
// that compares the stored config against the object it SENT is therefore
// comparing against a value the product never promised to keep — and it
// reported `config apps did not take` on every single test of a content run,
// because one app entry the harness held did not survive the product's
// per-app normalisation (`vQuickApp` keeps exactly id/name/url/enabled).
// Expected-vs-stored is only meaningful when the expectation goes through the
// same path, so it does — the same rule the tab-count predicate follows.
import { vConfig } from "../../../src/extension/store.ts";
import { mergeConfig } from "../../../src/shared/config.ts";

export function installConfig(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
  // Establish the prerequisites every subset needs: the command-center base
  // URL (ccUrl/ccBase) and the probe tab. Runs once at suite start; the
  // "new tab opens the command center" test then re-verifies the CC itself.
  ctx.bootstrap = async function bootstrap() {
    if (!ctx.ccUrl) {
      await ctx.openCC(ctx.tabA);
      const f = await ctx.ccFacts(ctx.tabA);
      ctx.ccUrl = f.url.replace(/[?#].*$/, "");
      ctx.ccBase = ctx.ccUrl;
    }
    if (!ctx.probe) {
      ctx.probe = await ctx.makeProbeTab();
    }
    // The pristine config is the run's definition of "untouched", so it has to
    // be read here — after the extension is installed and before any test has
    // had the chance to write. A fresh profile also means these are the
    // shipped defaults, which is what the options page should be showing.
    if (!ctx.pristineConfig) {
      const raw = await evalIn(
        ctx.probe,
        `browser.storage.local.get("config").then(r => JSON.stringify(r.config || {}))`,
      ).catch(() => null);
      if (raw) ctx.pristineConfig = JSON.parse(raw as string);
    }
  };

  /**
   * Put back any config key a test moved, and confirm it landed.
   *
   * Without this, the config is the one piece of SHARED state the harness never
   * restored, and it fails in the most confusing way available: the options
   * group's "options page loads and renders the form" reads `whichKey` and
   * fails because some test three groups earlier pressed `;q`. The test is
   * right and the leak is the bug, so the fix belongs HERE, not in the test
   * that noticed — and a per-group setup call would only fix this one key, and
   * only for the group that happened to trip over it.
   *
   * The write goes through the background's `setConfig` handler for the same
   * reason ctx.ensureWhichKey does: the background caches the config and
   * re-saves its in-memory copy, so writing browser.storage.local directly
   * would be silently undone. Whole object, whole write, then verify from
   * storage — the same shape as ensureWhichKey, with the diff generalised.
   */
  // What the product holds after being handed `partial`: its own validation,
  // then its own merge over the defaults. Pure, so it can be compared directly
  // against what storage reads back.
  const storedForm = (partial: any): any => mergeConfig(vConfig(partial) || {});

  // One line per RUN, not per test. A config note that repeats sixty times (see
  // the note above) buries every other repair in the report, and the first
  // occurrence already says everything the sixtieth would.
  const noteOnce = (msg: string): void => {
    ctx.configNotes = ctx.configNotes || new Set<string>();
    if (ctx.configNotes.has(msg)) return;
    ctx.configNotes.add(msg);
    ctx.repaired.push(msg);
  };

  // The keys of `a` whose value differs from `b`, comparing JSON so an array or
  // an object is compared by value rather than by identity.
  const differingKeys = (a: any, b: any): string[] =>
    Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  const show = (v: any): string => {
    const s = JSON.stringify(v);
    return s === undefined ? "undefined" : s.length > 120 ? s.slice(0, 117) + "..." : s;
  };

  ctx.restoreConfig = async function restoreConfig(): Promise<void> {
    if (!ctx.probe) ctx.probe = await ctx.makeProbeTab();
    const read = async () => {
      const raw = await evalIn(
        ctx.probe,
        `browser.storage.local.get("config").then(r => JSON.stringify(r.config || {}))`,
      ).catch(() => null);
      return raw ? JSON.parse(raw as string) : null;
    };
    // The FIRST reset() runs before any test, so by construction nothing has
    // leaked yet — but the product materialises its default config lazily, and
    // the snapshot taken at bootstrap can be missing every key. Adopting the
    // config as it stands here means every later comparison is between two
    // POPULATED configs. Without it the harness "restores" a half-empty config
    // before every test, the product refills it, and the diff is non-empty
    // forever: measured at 67 needless whole-config writes across one run.
    if (!ctx.configSettled) {
      ctx.configSettled = true;
      const settled = await read();
      if (settled) ctx.pristineConfig = settled;
      return;
    }
    const pristine = ctx.pristineConfig;
    if (!pristine) return;
    const now = await read();
    if (!now) return;
    // Compare against the form the product would STORE for this baseline, not
    // against the baseline itself: a field the product normalises on the way in
    // (apps, whose entries are narrowed to id/name/url/enabled) is not drift.
    const expected = storedForm(pristine);
    const drifted = differingKeys(expected, now);
    const added = Object.keys(now).filter((k) => !(k in expected));
    if (!drifted.length && !added.length) return;
    const keys = drifted.concat(added.map((k) => k + " (added)"));
    const applied = await evalIn(
      ctx.probe,
      `(async () => {
         const res = await browser.runtime.sendMessage({ action: "setConfig", data: { config: ${JSON.stringify(
           pristine,
         )} } });
         return !!(res && res.ok);
       })()`,
    ).catch(() => false);
    if (!applied) {
      // Not fatal: this is a precondition, and a group that never reads the
      // moved key (a content-only group with a dead chrome layer) should not
      // fail its first test over a repair it never needed. Record it and let
      // the test that actually depends on the value be the one to fail.
      ctx.repaired.push(`config ${keys.join(", ")} NOT restored (setConfig refused)`);
      return;
    }
    const after = await evalIn(
      ctx.probe,
      `browser.storage.local.get("config").then(r => JSON.stringify(r.config || {}))`,
    ).catch(() => null);
    if (after) {
      const got = JSON.parse(after as string);
      const still = differingKeys(expected, got);
      if (still.length) {
        // Name the value the product kept. "did not take" on its own is the
        // kind of note that gets skimmed past for sixty tests; with the two
        // values beside it, the reader can see WHICH normalisation happened —
        // and see it once.
        noteOnce(
          `config ${still.join(", ")} did not take (asked ${show(
            still.length === 1 ? expected[still[0]] : still.map((k) => [k, expected[k]]),
          )}, product kept ${show(
            still.length === 1 ? got[still[0]] : still.map((k) => [k, got[k]]),
          )})`,
        );
        return;
      }
      // A key the product added back while settling is a DEFAULT it
      // materialised, not a leak, so it joins the baseline instead of starting
      // the same argument again on the next test.
      for (const k of Object.keys(got)) if (!(k in ctx.pristineConfig)) ctx.pristineConfig[k] = got[k];
    }
    ctx.repaired.push(`config ${keys.join(", ")} restored`);
  };
}
