// Preload module for `node --test`.
//
// Loaded with `--import`, so it runs before any test file is evaluated. Its
// only job is to install the project's extensionless-TS resolve hook ONCE for
// the whole run, rather than asking every test file to remember
// `register("../ts-resolve-hook.mjs", import.meta.url)` as its first import.
//
// Before this existed, 11 of the 18 test files carried that boilerplate and 7
// did not — and the 7 imported src/ modules with bare specifiers, which is
// exactly the shape that fails. This file removes the choice entirely: the
// hook is a property of the run, not a responsibility of each test.
//
// The hook itself is deliberately a RESOLVE hook and not a source transform
// (see ts-resolve-hook.mjs): the code under test is read exactly as written.
import { register } from "node:module";
register("../ts-resolve-hook.mjs", import.meta.url);

// The wasm bytes are no longer embedded in shared/core (see corefetch.ts), so a
// unit test that exercises a core call needs a source. Read the same file the
// browser fetches; nothing is instantiated until a test actually calls the
// core, so suites that never touch it pay one fs.stat and no wasm work.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const wasmPath = fileURLToPath(new URL("../../core/js/core.wasm", import.meta.url));
const { setCoreWasmSource } = await import("../../src/shared/core.ts");
setCoreWasmSource(async () => new Uint8Array(readFileSync(wasmPath)));