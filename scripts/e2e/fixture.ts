// The per-test fixture — the COMPOSITION ROOT of the e2e harness.
//
// This file holds no behaviour. It creates one `ctx` bag (the session handle,
// the mutable tab/CC state and the per-test bookkeeping) and installs the
// per-concern helper modules onto it:
//
//   pages        one browsing context: open/navigate/activate/read the CC
//   tabs         the window as a list: read it, count it, clean it up
//   numbering    which NUMBER a tab is, as the product numbers them
//   keys         how a key reaches the product (BiDi input or #lfc=keys)
//   waits        deterministic waits on the product's own signals
//   probe        the extension-realm probe tab: the only handle on browser.*
//   chromestate  what the chrome helper believes, over #lfc=state
//   config       bootstrap + restore the shared config
//   lifecycle    reset(): the preconditions every test may assume
//
// Each module exports `install<Group>(ctx)` and imports only the bidi helpers it
// uses, so reading one concern never means reading all of them. The modules
// reference each other through `ctx` (keys calls ctx.chromeOwnsLeader, tabs
// calls ctx.ensureProbe), which is why install order does not matter: nothing
// runs until the whole bag exists.
//
// WHAT IS NEW HERE, and why it is the most important file in the harness.
//
// The old harness created this object once and mutated it for the entire run.
// Every test therefore inherited whatever the previous one left behind — a
// disarmed or an ARMED leader, an open popup, a dissolved split, an extra
// dozen tabs, and a probe tab that might have been swept away by a session
// restore thirty seconds earlier. That inheritance is the root cause of the
// order dependence documented at the top of runner.ts.
//
// `reset()` (fixture/lifecycle.ts) now runs BEFORE every test and asserts the
// preconditions a test would otherwise have to assume:
//
//   * the leader is DISARMED  — an armed leader eats `;` as a binding, so a
//     test that presses `;` to begin a sequence silently starts from the wrong
//     state. The held-leader test already had to assert this by hand because
//     the harness would not guarantee it.
//   * no popup is open
//   * no split is armed
//   * no digit capture is armed (it expires after 3s and would eat the first
//     digit of a test that arrived too early)
//   * the probe is LIVE, and is rebuilt if it is not
//   * the config is at its known values, written through the background's own
//     handler so its cache cannot overwrite us
//
// The probe check alone removes the single largest source of noise in the old
// suite: one stale browsing-context id used to make ~10 later tests fail with
// "no such frame", none of which were about those tests.

import { installPages } from "./fixture/pages.ts";
import { installTabs } from "./fixture/tabs.ts";
import { installNumbering } from "./fixture/numbering.ts";
import { installKeys } from "./fixture/keys.ts";
import { installWaits } from "./fixture/waits.ts";
import { installProbe } from "./fixture/probe.ts";
import { installChromestate } from "./fixture/chromestate.ts";
import { installConfig } from "./fixture/config.ts";
import { installLifecycle } from "./fixture/lifecycle.ts";

export type { KeyOpts } from "./fixture/types.ts";
export { contextsOf } from "./fixture/contexts.ts";

export function createCtx(runtime): any {
  // The helpers are installed one module at a time, so the object literal below
  // cannot name them. The `any` type is what lets the suites call ctx.waitPopup /
  // ctx.leaderPress / … and keeps the harness typechecked (tsconfig.e2e.json)
  // for the errors that matter there: a helper used without importing it, a
  // duplicate identifier, an arity mistake on a lib function.
  const ctx: any = {
    // Session/state carried through the whole run.
    h: runtime.h,
    profile: runtime.profile,
    server: runtime.server,
    port: runtime.port,
    base: runtime.base,
    tabA: runtime.tabA,
    probe: null,
    ccUrl: null,
    ccBase: null,

    // Set by the runner before each test and unset after, so every BiDi call
    // a test makes can be cancelled when it overruns. Without this a stalled
    // test held its contexts and the NEXT test ran against the wreckage.
    signal: undefined as AbortSignal | undefined,
    // Diagnostics for the failure report: what reset() had to repair before
    // this test ran. A test that fails after reset() rebuilt the probe is a
    // different problem from one that did not, and the report says so.
    repaired: [] as string[],
    // True while a test is deliberately rebuilding the window (a session
    // restore or a marker hot-swap replaces every tab). The leak sweep stands
    // down for the duration: during a rebuild the correct tab count is
    // genuinely unknown.
    rebuilding: false,
    // Which source answered the last tabCount(), so the next failure says so
    // instead of making the reader infer it.
    tabCountWhy: "",

    // The config as it was before the first test ran, captured in bootstrap().
    // reset() diffs against it and puts back anything a test moved, so a `;q`
    // or a "save persists" options test cannot leak its setting into the next
    // group's first test. See fixture/config.ts for why this is a whole-object
    // write rather than per-test setup calls.
    pristineConfig: null as Record<string, any> | null,
    // Whether pristineConfig has been through its first-reset settle.
    configSettled: false,
  };

  // Composition. Order is irrelevant — every module only touches `ctx` at call
  // time, never at install time — but it is kept in the order a reader would
  // want: the window and its contents, then how to talk to it, then the
  // preconditions.
  installPages(ctx);
  installTabs(ctx);
  installNumbering(ctx);
  installKeys(ctx);
  installWaits(ctx);
  installProbe(ctx);
  installChromestate(ctx);
  installConfig(ctx);
  installLifecycle(ctx);

  return ctx;
}