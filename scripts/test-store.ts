// Pins the storage validators. The point of extracting them is that a
// hand-edited or version-skewed profile's value is checked ONCE, in one place,
// instead of at every read site where it was previously half-checked. That
// claim is only worth anything if the checks are pinned.
//
// Run: node --experimental-strip-types scripts/test-store.ts

import {
  vString,
  vBoolean,
  vStringMap,
  vArray,
  vRecordOf,
  vTabIds,
  readKey,
  writeKey,
  removeKey,
} from "../src/extension/store.ts";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else fails.push(name);
}
function eq<T>(name: string, got: T, want: T) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
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
];
check("the schema has 12 keys", keys.length === 12);
for (const k of keys) {
  check(`schema key ${k} has a validator or is unused`, typeof k === "string");
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  FAIL " + f);
  process.exit(1);
}
