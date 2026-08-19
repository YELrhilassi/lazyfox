// Ambient declarations for globals that exist at runtime but are not part of
// the TypeScript DOM lib. Everything is typed loosely on purpose: the code is
// a faithful port of working JS and the priority is correct runtime behavior,
// not exhaustively-checked API surfaces.

// Build-time flag injected by esbuild's `define` (true for `npm run build:dev`,
// false for `npm run build`). Source sites MUST read `__DEV__` directly (not via
// isDev()/dbg() wrappers) so esbuild can fold `if (!__DEV__) return;` /
// `if (__DEV__) { ... }` against the literal `false` and tree-shake debug code
// (and the dbg() function itself) out of the production bundle entirely.
// `isDev()` / `dbg()` still exist for runtime callers but are NOT folded by the
// bundler, so using them as a sole guard leaves debug strings in dist.
declare const __DEV__: boolean

declare const browser: any;
declare const content: any;
declare function sendAsyncMessage(name: string, data: any): void;
declare function addEventListener(
  type: string,
  listener: EventListenerOrEventListenerObject,
  useCapture?: boolean
): void;

declare namespace Services {
  const prefs: any;
  const focus: any;
  const dirsvc: any;
  const io: any;
  const scriptSecurityManager: any;
  const scriptloader: any;
  const console: any;
  const mm: any;
  const search: any;
  const appinfo: any;
  const obs: any;
}

declare const Ci: any;
declare const Cc: any;
declare const Cu: any;
declare const Components: any;
declare const ChromeUtils: any;
declare const WebExtensionPolicy: any;
declare const ZoomManager: any;
declare const SessionStore: any;
declare const ExtensionParent: any;

// Chrome-window APIs available in the browser chrome context (userChrome.uc.js
// equivalent). Kept loose; they do not exist in web content.
declare interface Window {
  gBrowser?: any;
  fullScreen: boolean;
  moveBy(x: number, y: number): void;
  resizeBy(x: number, y: number): void;
  undoCloseTab(): void;
  switchToTabHavingURI?(url: string, openNew: boolean, options: any): void;
  gFindBar?: any;
}

declare interface Document {
  commandDispatcher?: any;
}

