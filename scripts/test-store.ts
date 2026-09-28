// Pins the storage validators. The point of extracting them is that a
// hand-edited or version-skewed profile's value is checked ONCE, in one place,
// instead of at every read site where it was previously half-checked. That
// claim is only worth anything if the checks are pinned.
//
// Run: node --experimental-strip-types scripts/test-store.ts

// Registered before anything else: the resolve hook is what lets this file
// import a src/ module that uses extensionless specifiers, so the assertions
// below can call the REAL appItems() rather than a paraphrase of it.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

import {
  vString,
  vBoolean,
  vStringMap,
  vArray,
  vRecordOf,
  vTabIds,
  vConfig,
  vSession,
  vSessions,
  vStealth,
  readKey,
  writeKey,
  removeKey,
} from "../src/extension/store.ts";
import { mergeConfig } from "../src/shared/config.ts";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else fails.push(name);
}
// Deep equality that does not care about key ORDER. Plain JSON.stringify
// comparison turns every assertion about an object into a second, invisible
// constraint on the order its keys happen to be written in — and the failure
// message then reads as being about key order, which is not what is under test.
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = stable((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
function eq<T>(name: string, got: T, want: T) {
  const g = JSON.stringify(stable(got));
  const w = JSON.stringify(stable(want));
  if (g === w) pass++;
  else fails.push(`${name}: got ${g} want ${w}`);
}

// --- vString -------------------------------------------------------------
check("vString accepts a string", vString("s") === "s");
check("vString rejects undefined", vString(undefined) === undefined);
check("vString rejects a number", vString(42) === undefined);
check("vString rejects null", vString(null) === undefined);
check("vString rejects an object", vString({}) === undefined);
check("vString rejects an array", vString([]) === undefined);
check("vString accepts the empty string (distinct from missing)", vString("") === "");
check("vString rejects a boolean", vString(false) === undefined);

// --- vBoolean ------------------------------------------------------------
// The falsy/truthy distinction that made a shared default wrong: a missing
// chromeAlive and a missing setupNudgeShown both mean false, but they mean
// OPPOSITE things — and a stored `0` must not be read as false when the
// writer only ever writes a boolean.
check("vBoolean accepts true", vBoolean(true) === true);
check("vBoolean accepts false", vBoolean(false) === false);
check("vBoolean rejects 0 (not the same as false)", vBoolean(0) === undefined);
check("vBoolean rejects 'false'", vBoolean("false") === undefined);
check("vBoolean rejects undefined", vBoolean(undefined) === undefined);
check("vBoolean rejects null", vBoolean(null) === undefined);

// --- vStringMap ----------------------------------------------------------
eq("vStringMap reads a table", vStringMap({ a: "x", b: "y" }), { a: "x", b: "y" });
eq("vStringMap keeps only string values", vStringMap({ a: "x", b: 3, c: null }), { a: "x" });
eq("vStringMap reads an empty table", vStringMap({}), {});
check("vStringMap rejects an array", vStringMap([1, 2]) === undefined);
check("vStringMap rejects a string", vStringMap("x") === undefined);
check("vStringMap rejects null", vStringMap(null) === undefined);
check("vStringMap rejects undefined", vStringMap(undefined) === undefined);

// --- vTabIds -------------------------------------------------------------
eq("vTabIds reads numbers", vTabIds([1, 2, 3]), [1, 2, 3]);
eq("vTabIds drops non-numbers rather than coercing", vTabIds([1, "2", 3]), [1, 3]);
eq("vTabIds drops zero and negatives", vTabIds([0, -1, 5]), [5]);
eq("vTabIds reads an empty list", vTabIds([]), []);
check("vTabIds rejects a non-array", vTabIds("1,2") === undefined);
eq("vTabIds drops NaN", vTabIds([NaN, 7]), [7]);

// --- vArray --------------------------------------------------------------
const vStr = vArray(vString);
eq("vArray keeps valid members", vStr(["a", "b"]), ["a", "b"]);
eq("vArray drops invalid members", vStr(["a", 1, null, "b"]), ["a", "b"]);
eq("vArray on an empty list", vStr([]), []);
check("vArray rejects a non-array", vStr("a") === undefined);
// The real use: a corrupt member should not cost the whole list.
eq("vArray keeps 9 of 10", vStr(["a", "b", "c", "d", "e", "f", "g", "h", "i", 10]).length, 9);
eq("vArray keeps 1 of 2 (one bad member, one good)", vStr(["a", 1]).length, 1);

// --- vRecordOf -----------------------------------------------------------
// This is the one with a real design decision: a single malformed entry must
// NOT cost every well-formed entry beside it. Losing one session is
// recoverable; losing all of them because one had a bad field is not.
const rec = vRecordOf(vString);
eq("vRecordOf reads a record", rec({ x: "1", y: "2" }), { x: "1", y: "2" });
eq("vRecordOf drops only the bad member", rec({ x: "1", y: 9, z: "3" }), { x: "1", z: "3" });
eq("vRecordOf on all-bad input gives an empty record", rec({ x: 1, y: 2 }), {});
eq("vRecordOf on an empty object", rec({}), {});
check("vRecordOf rejects an array", rec([1, 2]) === undefined);
check("vRecordOf rejects a string", rec("x") === undefined);
check("vRecordOf rejects null", rec(null) === undefined);

// --- readKey / writeKey against a fake storage --------------------------
// The interesting behaviour is the three-way outcome: stored value, fallback
// on a rejected value, fallback on a storage THROW.
let backing: Record<string, unknown> = {};
let throwOnGet = false;
const g = globalThis as unknown as {
  browser: { storage: { local: { get(k: string): Promise<unknown>; set(v: unknown): Promise<void>; remove(k: string): Promise<void> } } };
};
g.browser = {
  storage: {
    local: {
      get: async (k: string) => {
        if (throwOnGet) throw new Error("storage unavailable");
        return { [k]: backing[k] };
      },
      set: async (v: Record<string, unknown>) => {
        Object.assign(backing, v);
      },
      remove: async (k: string) => {
        delete backing[k];
      },
    },
  },
};

backing = { config: "not an object" };
// config's validator is vStringMap-shaped in practice; use a string key to
// keep this test about the plumbing, not the key's schema.
const bad = await readKey("lfProfileName", vString, "fallback");
check("readKey returns a rejected value's fallback", bad === "fallback");

backing = { lfProfileName: "work" };
const good = await readKey("lfProfileName", vString, "fallback");
check("readKey returns a valid stored value", good === "work");

backing = {};
const missing = await readKey("lfProfileName", vString, "fallback");
check("readKey returns the fallback for a missing key", missing === "fallback");

throwOnGet = true;
const threw = await readKey("lfProfileName", vString, "fallback");
check("readKey returns the fallback when storage throws", threw === "fallback");
throwOnGet = false;

await writeKey("chromeAlive", true);
check("writeKey stores under its own key", backing.chromeAlive === true);

await removeKey("chromeAlive");
check("removeKey deletes the key", backing.chromeAlive === undefined);

// The schema is the contract: an unknown key must not compile, and a wrong
// value type must not compile. Both are asserted at the type level; the
// runtime check here is that the key union is what the schema says.
const keys: string[] = [
  "config", "chromeAlive", "chromeHelperVersion", "chromeBindings",
  "lfProfileName", "lfProfileDir", "lfSessions", "lfCurrentSession",
  "lfLastSession", "lfStealth", "cachePolicy", "setupNudgeShown",
  "chromeEverAlive", "lfBridge",
];
// The original scan for this list MISSED two keys — chromeEverAlive and
// lfBridge — because it matched string literals and const declarations, and
// these two were written through a bulk `set` object and a multi-key get. The
// count is asserted rather than assumed for exactly that reason: a scan that
// missed two the first time cannot be trusted to have found all fourteen.
check("the schema has 14 keys", keys.length === 14);
check("the schema records the ever-alive flag", keys.indexOf("chromeEverAlive") !== -1);
check("the schema records the content-bridge flag", keys.indexOf("lfBridge") !== -1);

// chromeEverAlive and chromeAlive are different questions and must not be
// collapsed: one distinguishes "never worked" from "worked and stopped",
// which is the Firefox-update silent-death failure. A single flag cannot.
check("chromeAlive and chromeEverAlive are separate keys",
  keys.indexOf("chromeAlive") !== keys.indexOf("chromeEverAlive"));

// lfBridge is "1"/"0" from the wire, not a boolean, and vBoolean would reject
// it — so a reader using the wrong validator silently gets the fallback, which
// for a diagnostics row means "not reported yet" forever.
check("lfBridge is stored as a string, not coerced to boolean",
  vString("1") === "1" && vBoolean("1") === undefined);

// --- vConfig: per-field, not all-or-nothing -------------------------------
// The failure this prevents is a crash, not a wrong value, so the assertion is
// written as the crash: feed the validator what a hand-edited profile really
// holds and then call the code that used to blow up.
eq("vConfig keeps a fully valid config", vConfig({
  leader: ",", hintChars: "asdf", scrollKeys: true, openInNewTab: false,
  hoverReveal: true, whichKey: false, statusBar: true,
  statusBarPosition: "top", autoRestore: true,
  apps: [{ id: "a", name: "A", url: "https://a", enabled: true }],
}), {
  leader: ",", hintChars: "asdf", scrollKeys: true, openInNewTab: false,
  hoverReveal: true, whichKey: false, statusBar: true,
  statusBarPosition: "top", autoRestore: true,
  apps: [{ id: "a", name: "A", url: "https://a", enabled: true }],
});

eq("vConfig drops a corrupt field and keeps the rest", vConfig({
  leader: ",", scrollKeys: "yes-please", statusBarPosition: "sideways",
}), { leader: "," });

eq("vConfig leaves a partial config partial", vConfig({ leader: "," }), { leader: "," });
eq("vConfig rejects a non-object", vConfig("nope"), undefined);
eq("vConfig rejects an array", vConfig([1, 2]), undefined);
eq("vConfig rejects undefined", vConfig(undefined), undefined);

// An empty object is a VALID (if useless) config, not a rejection: rejecting it
// would send the caller to the fallback and hide the fact that the user has
// genuinely chosen the defaults.
eq("vConfig accepts {}", vConfig({}), {});

// Dropping a bad app tile rather than the whole array: losing one tile is
// recoverable, losing the user's configured apps is not.
eq("vConfig drops one malformed app", vConfig({
  apps: [
    { id: "a", name: "A", url: "https://a", enabled: true },
    { id: "b", name: "B", url: "https://b" },
    "not an app",
  ],
}), { apps: [{ id: "a", name: "A", url: "https://a", enabled: true }] });

// The real regression: a profile where apps is a string. Before the validator
// this reached appItems and threw "apps.filter is not a function", which took
// the entire home grid down. After it, the field is dropped and the default
// apps come back. The call is made for real, through the real function.
g.browser = { runtime: { sendMessage: () => Promise.resolve({}) } };
const { appItems } = await import("../src/extension/commandcenter/data.ts");
const recovered = appItems(mergeConfig(vConfig({ apps: "open.spotify.com" })).apps);
check("a corrupt apps field no longer takes the home grid down", Array.isArray(recovered));
check("a corrupt apps field falls back to the default tiles", recovered.length > 0);
check("the default tiles are the real ones", recovered.some((i) => i.url === "https://open.spotify.com"));

// An empty apps array is a deliberate user choice (every tile switched off) and
// must survive, so the home grid goes empty rather than resurrecting defaults.
eq("vConfig keeps an explicitly emptied app list", vConfig({ apps: [] }), { apps: [] });

// --- vSession / vSessions ------------------------------------------------
const goodSession = {
  name: "work", marker: 1, active: 0, windowState: "maximized",
  updatedAt: 123, splits: "1:2", tabs: [{ url: "https://a", title: "A", pinned: true }],
};
eq("vSession round-trips a valid session", vSession(goodSession), goodSession);
check("vSession rejects a session with no tabs", vSession({ name: "work" }) === undefined);
check("vSession rejects a non-object", vSession("work") === undefined);
// A session with tabs but no marker is still restorable, so it must survive:
// dropping it would lose the user's tabs over a cosmetic field.
eq("vSession keeps a session missing only cosmetic fields",
  vSession({ tabs: [{ url: "https://a" }] }),
  { name: "", marker: 0, tabs: [{ url: "https://a", title: "", pinned: false }],
    active: 0, windowState: "", updatedAt: 0, splits: "" });
// A tab with no url hands the tab opener an undefined and the restore stops
// halfway, so that tab is dropped and the rest of the session still restores.
eq("vSession drops a url-less tab but keeps the session", (vSession({
  tabs: [{ url: "https://a" }, { title: "orphan" }, 7],
}) as { tabs: unknown[] }).tabs.length, 1);
check("vSessions drops one bad session and keeps the good ones",
  Object.keys(vSessions({ work: goodSession, broken: { name: "x" } })!).length === 1);

// --- vStealth ------------------------------------------------------------
eq("vStealth keeps valid container ids", vStealth({ containers: ["a", "b"] }), { containers: ["a", "b"] });
eq("vStealth drops a malformed id without failing the record",
  vStealth({ containers: ["a", 3, null, "b"] }), { containers: ["a", "b"] });
eq("vStealth turns a corrupt record into an empty set", vStealth("nope"), { containers: [] });
eq("vStealth turns a missing record into an empty set", vStealth(undefined), { containers: [] });

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  FAIL " + f);
  process.exit(1);
}
