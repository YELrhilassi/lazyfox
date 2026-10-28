// Loads the Go core's wasm bytes from the extension package instead of
// bundling them.
//
// WHY THIS EXISTS. core.wasm is 3.6 MB; base64 makes it 4.9 MB of JavaScript.
// That string used to be inlined into every bundle, so the content script
// carried it onto every page and decoded it in `ensureCore()` at document_start
// — 370 ms and ~77 MB of transient memory per top-level document before the
// page's own scripts ran (measured in V8; the shape is the same in SpiderMonkey).
// The background paid it at Firefox startup too. The bytes now ship once as
// dist/extension/core.wasm and are fetched by the contexts that actually run
// the core.
//
// The fetch is lazy (installFetchedCore only installs the source; the first
// `ensureCore()` triggers it) and deduplicated, so a page where the user never
// presses `;` never pays for the core at all.

import { setCoreWasmSource, type CoreWasm } from "./core";

let pending: Promise<CoreWasm> | null = null;

function fetchCoreWasm(): Promise<CoreWasm> {
  if (pending) return pending;
  pending = (async () => {
    const runtime = (globalThis as { browser?: { runtime?: { getURL?: (p: string) => string } } }).browser;
    const url = runtime?.runtime?.getURL?.("core.wasm");
    if (!url) throw new Error("Lazyfox core: wasm URL unavailable");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Lazyfox core: wasm fetch failed (" + res.status + ")");
    return new Uint8Array(await res.arrayBuffer());
  })();
  // A failed fetch must not poison the next attempt: a page that was still
  // loading when the core was requested can ask again.
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/** Point the core at the packaged wasm file. Idempotent. */
export function installFetchedCore(): void {
  setCoreWasmSource(() => fetchCoreWasm());
}
