// Chrome-side wasm core bootstrap. The browser window's own CSP blocks
// WebAssembly.instantiate(), so the core runs inside a CSP-free system sandbox
// (corebootstrap.js). This module owns that sandbox and exposes the single
// ensureChromeCore() promise that shared/core is pointed at.

import { setCoreApi, type CoreApi } from "../shared/core";
import { dbg } from "../shared/dev";

let chromeCore: Promise<CoreApi> | null = null;

export function ensureChromeCore(): Promise<CoreApi> {
  if (!chromeCore) {
    chromeCore = (async () => {
      const sb = new Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal());
      const w = globalThis as unknown as Record<string, unknown>;
      for (const k of [
        "atob", "btoa", "TextEncoder", "TextDecoder", "performance", "crypto",
        "setTimeout", "clearTimeout", "setInterval", "clearInterval"
      ]) {
        try {
          sb[k] = typeof w[k] === "function" ? (w[k] as (...a: unknown[]) => unknown).bind(w) : w[k];
        } catch (e) {
          // ignore missing globals
        }
      }
      // Dev-only diagnostics: decisive probe of whether wasm compiles in (a)
      // the chrome window realm and (b) the sandbox realm, using the same async
      // WebAssembly.instantiate API that corebootstrap.js uses. (The sync new
      // WebAssembly.Module() constructor hits a separate stricter gate and
      // stays blocked even when instantiate works.) Tree-shaken from prod.
      if (__DEV__) {
        const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
        const probeWasmAsync = (tag: string) => {
          try {
            WebAssembly.instantiate(bytes).then(
              () => dbg("wasm probe " + tag + ": OK"),
              (e) => dbg("wasm probe " + tag + " BLOCKED: name=" + (e && e.name) + " msg=" + JSON.stringify(e && e.message))
            );
          } catch (e: unknown) {
            const err = e as { name?: string; message?: string };
            dbg("wasm probe " + tag + " threw sync: " + (err && err.name) + " " + (err && err.message));
          }
        };
        probeWasmAsync("window");
        // Probe inside the sandbox realm itself. A function assigned from the
        // window realm (like the closure above) keeps its creation realm and
        // runs under the window CSP, so define the probe with evalInSandbox.
        try {
          const probeSrc =
            "globalThis.__lfProbe = function () {" +
            "try { return WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0])).then(" +
            "() => 'OK'," +
            "(e) => 'BLOCKED: name=' + (e && e.name) + ' msg=' + JSON.stringify(e && e.message));" +
            "} catch (e) { return Promise.resolve('threw sync: ' + (e && e.name) + ' ' + (e && e.message)); }" +
            "};";
          Cu.evalInSandbox(probeSrc, sb);
          (Cu.waiveXrays(sb).__lfProbe() as Promise<string>).then((r) => dbg("wasm probe sandbox: " + r));
        } catch (e) {
          dbg("wasm probe sandbox setup threw: " + (e as Error).message);
        }
      }

      const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
      const f = dir.clone();
      f.append("corebootstrap.js");
      // Firefox 155 (bug 1974213) rejects file:/jar: URLs in loadSubScript
      // unless the caller opts in; loadSubScriptWithOptions + allowUnsafeURL
      // works on older Firefox too (the unknown option is ignored there).
      Services.scriptloader.loadSubScriptWithOptions(Services.io.newFileURI(f).spec, {
        target: sb,
        allowUnsafeURL: true,
      });
      const ready = Cu.waiveXrays(sb).__lfCoreReady;
      return await ready;
    })().catch((e) => {
      if (__DEV__) {
        dbg(
          "chrome core sandbox FAILED: name=" + (e && e.name) +
          " msg=" + JSON.stringify(e && e.message) +
          " str=" + String(e) +
          " stack=" + (e && e.stack)
        );
      }
      throw e;
    });
  }
  return chromeCore;
}

// Points the shared core facade at the sandbox core. Call once at startup.
export function initChromeCore(): void {
  setCoreApi(ensureChromeCore());
}
