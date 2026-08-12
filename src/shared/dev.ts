// Development-only diagnostics. `__DEV__` is defined globally in globals.d.ts
// and replaced at build time by esbuild (false in prod, true for
// `npm run build:dev`). When every debug call site guards on `__DEV__`
// directly, esbuild folds the literal `false` and tree-shakes the dbg() body
// (and dbg itself, once unreferenced) out of production bundles, so no debug
// strings ship to dist/. isDev()/dbg() here are convenience wrappers; they are
// NOT folded by the bundler, so they should only ever be called from inside an
// already-`__DEV__`-gated block.

export function isDev(): boolean {
  return __DEV__;
}

export function dbg(area: string, ...m: unknown[]): void {
  if (!__DEV__) return;
  try {
    const d = (globalThis as { dump?: (s: string) => void }).dump;
    if (d) d("[lazyfox-" + area + "] " + m.map((x) => String(x)).join(" ") + "\n");
  } catch {
    // Diagnostics must never break the app.
  }
}
