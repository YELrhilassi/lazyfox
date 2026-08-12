// Runs inside a CSP-free system sandbox created by userChrome.uc.js. The
// browser window's own CSP blocks WebAssembly.instantiate(), so the chrome
// helper never compiles wasm in the window realm — it loads this file into a
// sandbox and reads the core from __lfCoreReady / LazyfoxCore.
//
// The sandbox's global is a plain JS realm, so wasm_exec.js's required globals
// (performance, TextEncoder, TextDecoder) plus atob are seeded onto it by the
// parent before loadSubScript runs this file.

import "../vendor/wasm_exec.js";
import { WASM_BASE64 } from "../shared/wasm-embed";
import type { CoreApi } from "../shared/core";

const scope: any = globalThis;

(scope.__lfCoreReady = (async (): Promise<CoreApi> => {
  try {
    const GoCtor = scope.Go;
    if (!GoCtor) throw new Error("Lazyfox core: wasm runtime missing");
    const go = new GoCtor();
    const b64: string = scope.atob(WASM_BASE64);
    const raw = Uint8Array.from(b64, (c) => c.charCodeAt(0));
    const { instance } = await scope.WebAssembly.instantiate(raw, go.importObject);
    go.run(instance);
    const api = scope.LazyfoxCore as CoreApi | undefined;
    if (!api) throw new Error("Lazyfox core: LazyfoxCore export missing");
    return api;
  } catch (e) {
    const err = e as any;
    throw new Error(
      "corebootstrap init failed: name=" + (err && err.name) +
      " msg=" + JSON.stringify(err && err.message) +
      " str=" + String(err) +
      " stack=" + (err && err.stack)
    );
  }
})());
