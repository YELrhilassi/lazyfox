// The chrome document's environment, as a parameter.
//
// WHY THIS FILE EXISTS. Every module under src/chrome/ used to reach for
// `document`, `window.gBrowser`, `Services`, `Ci` and friends directly. That
// is invisible in the browser and fatal in a test: the module cannot be
// constructed in Node at all, because the globals simply are not there. The
// key-dispatch module solved this long ago — `createChromeKeyDown(deps)` takes
// a `KeyDispatchDeps` and reads no global, which is why the whole key-hold
// feature (ownership, sticky, the repeat path, the lost-keyup blur release) is
// covered by 24 assertions in about a millisecond. This is that same seam,
// generalised so the rest of the chrome layer can use it too.
//
// The rule, then: a chrome module may not reference a browser global. It takes
// a `ChromeEnv` and reads `env.document`, `env.window`, `env.services`. One
// interface, two implementations — `createChromeEnv()` over the real browser,
// `createFakeChromeEnv()` for Node — and the module is identical in both.
//
// WHAT THIS IS NOT. It is not an attempt to make chrome logic browser-free at
// runtime. The real env is a thin adapter over exactly the same globals, so
// the production path is one property lookup away from what it was. It is a
// *testability* seam: the browser stays the browser, but the module no longer
// has to be handed to the browser to be exercised.
//
// See `src/chrome/dependency-audit.ts` for the check that keeps this from
// rotting, and docs/tasks/2026-10-02-DETERMINISTIC-CHROME-TESTING.md §1 for
// why.

/** The subset of `document` the chrome layer actually touches. */
export interface ChromeDocument {
  documentElement: any;
  body?: any;
  activeElement?: any;
  getElementById(id: string): any;
  querySelector(sel: string): any;
  querySelectorAll(sel: string): ArrayLike<any>;
  createElementNS(ns: string, tag: string): any;
  createElement(tag: string): any;
  implementation?: { createHTMLDocument(title: string): any };
  addEventListener(type: string, fn: (e: any) => void, opts?: any): void;
  removeEventListener(type: string, fn: (e: any) => void, opts?: any): void;
  visibilityState?: string;
  commandDispatcher?: { focusedElement?: any };
  fullscreenElement?: any;
}

/** The subset of `window` the chrome layer actually touches. */
export interface ChromeWindow {
  document: ChromeDocument;
  gBrowser?: any;
  focus(): void;
  moveBy?(dx: number, dy: number): void;
  resizeBy?(dw: number, dh: number): void;
  addEventListener(type: string, fn: (e: any) => void, opts?: any): void;
  removeEventListener(type: string, fn: (e: any) => void, opts?: any): void;
  messageManager?: any;
  getComputedStyle?: any;
  [k: string]: any;
}

/**
 * The XPCOM/XPCOM-ish globals the chrome layer reaches for, as one object.
 *
 * These are `any` on purpose. They are Mozilla's interfaces, there is no type
 * for them without shipping Mozilla's IDL, and stubbing them faithfully in a
 * fake is not the job — the fake supplies the three or four methods a given
 * module calls and throws loudly for anything else, so a test cannot silently
 * pass against a `Services` that answered a question nothing asked.
 */
export interface ChromeServices {
  prefs: {
    getBoolPref(name: string, fallback?: boolean): boolean;
    getStringPref(name: string, fallback?: string): string;
    setBoolPref?(name: string, value: boolean): void;
    setStringPref?(name: string, value: string): void;
  };
  dirsvc?: any;
  io?: any;
  search?: any;
  focus?: any;
  scriptSecurityManager?: any;
  console?: any;
  mm?: any;
  [k: string]: any;
}

/** Everything ambient the chrome layer needs, in one injectable object. */
export interface ChromeEnv {
  window: ChromeWindow;
  document: ChromeDocument;
  services: ChromeServices;
  /** `Ci` — the Mozilla interface constants. */
  Ci: any;
  /** `Cc` — the Mozilla class constants. */
  Cc: any;
  /** `Cu` — component utils; `Cu.isDeadWrapper` is how a torn-down tab is detected. */
  Cu: any;
  /** `ChromeUtils.importESModule` for PlacesUtils / SearchSuggestionController. */
  ChromeUtils?: any;
  /** `SessionStore`, for per-tab custom values. */
  SessionStore?: any;
  /** `WebExtensionPolicy` — the add-on registry the `#lfc=diag` probe reads. */
  WebExtensionPolicy?: any;
  /**
   * `ZoomManager` — the chrome zoom module. On the env rather than left as a
   * bare global because a zoom test wants to read the zoom level back out
   * without a browser; the fake keeps a per-browser level for exactly that.
   */
  ZoomManager?: any;
  /** `window.setTimeout` — injected so a test can run timers synchronously. */
  setTimeout(fn: () => void, ms?: number): any;
  clearTimeout(id: any): void;
  setInterval(fn: () => void, ms?: number): any;
  clearInterval(id: any): void;
  btoa(s: string): string;
  atob(s: string): string;
  /** `getComputedStyle` — a function, not a window method, so the fake can answer it. */
  getComputedStyle(el: any): any;
  console: {
    log(...a: any[]): void;
    error(...a: any[]): void;
  };
}

// ---------------------------------------------------------------------------
// The real environment.
//
// A thin adapter. Each field is the global it replaces, read at the moment it
// is used rather than captured, so a module that injects this behaves exactly
// as it did when it read the global.
// ---------------------------------------------------------------------------

/**
 * The chrome document's own environment.
 *
 * Called once at startup in `src/chrome/main.ts` and threaded into every
 * module that needs it. `ChromeServices` etc. are read off `globalThis` at
 * access time: in the chrome window they are ambient properties, and reading
 * them lazily is what keeps this adapter honest if one of them is defined
 * later than the module that wants it.
 */
export function createChromeEnv(): ChromeEnv {
  const g = globalThis as any;
  return {
    get window() {
      return g;
    },
    get document() {
      return g.document;
    },
    get services() {
      return g.Services;
    },
    get Ci() {
      return g.Ci;
    },
    get Cc() {
      return g.Cc;
    },
    get Cu() {
      return g.Cu;
    },
    get ChromeUtils() {
      return g.ChromeUtils;
    },
    get SessionStore() {
      return g.SessionStore;
    },
    get WebExtensionPolicy() {
      return g.WebExtensionPolicy;
    },
    get ZoomManager() {
      return g.ZoomManager;
    },
    setTimeout: (fn: () => void, ms?: number) => g.setTimeout(fn, ms),
    clearTimeout: (id: any) => g.clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => g.setInterval(fn, ms),
    clearInterval: (id: any) => g.clearInterval(id),
    btoa: (s: string) => g.btoa(s),
    atob: (s: string) => g.atob(s),
    getComputedStyle: (el: any) => g.getComputedStyle(el),
    console: {
      log: (...a: any[]) => g.console.log(...a),
      error: (...a: any[]) => g.console.error(...a),
    },
  };
}

// ---------------------------------------------------------------------------

// The Node-side TEST DOUBLE for this environment lives in env-fake.ts. It is a
// separate module rather than a second half of this one because it has the
// opposite dependency direction: it needs the types below, and nothing below
// needs it. Keeping them apart is what lets env.ts stay readable as the list
// of what the chrome layer is allowed to touch.
export type { FakeChromeEnv } from "./env-fake";
export { fakeElement } from "./env-fake";
