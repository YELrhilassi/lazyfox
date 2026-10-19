// The globals the PRODUCT modules the harness imports expect to exist.
//
// The harness deliberately imports a few product modules instead of
// re-implementing their rules — the tab-count predicate (shared/transient.ts)
// and the config schema (extension/store.ts) — because two copies of a rule is
// how the harness and the product come to disagree about what they are both
// looking at. Those modules read globals that exist only inside Firefox's
// extension realm: `browser` (storage/tabs) and the build-time `__DEV__` flag.
// Neither exists in the Node process the harness runs in, and neither is
// reached at import time — only inside functions the harness never calls.
//
// This is NOT src/shared/globals.d.ts. That file is the chrome helper's
// ambient surface, and it declares `Window.gBrowser` as
// `import("../chrome/tabs").GBrowser` — so including it here drags the whole
// chrome-window type graph (and its DOM lib requirement) into a harness that
// runs in Node, and the first error is then about a file the harness neither
// imports nor runs. Two loose declarations are enough, and they keep the
// failure pointing at the harness when the harness is what is wrong.
declare const browser: any;
declare const __DEV__: boolean;
