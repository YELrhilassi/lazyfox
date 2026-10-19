// The Node-side TEST DOUBLE for the chrome environment.
//
// Split out of env.ts, which is the only module allowed to name the ambient
// chrome globals. This one names none of them: it is what makes every chrome
// module constructible outside Firefox, which is the whole reason the seam
// exists (see env.ts for the interfaces).
//
// Enough chrome document for the modules that render (popup, status bar) and
// enough chrome window for the modules that classify (keystate,
// commandcenterfocus). Deliberately STRICT: anything not explicitly faked
// throws, so a test that exercises a code path nobody prepared fails loudly
// instead of quietly reading `undefined` and taking the fallback branch.
//
// The one place strictness is relaxed is `querySelectorAll`, which answers
// `[]` for an unknown selector — that is what the real document does for a
// selector that matches nothing, and several modules probe with a selector
// that only sometimes exists.

import type { ChromeEnv } from "./env";
// The fake environment.
//
// Enough chrome document for the modules that render (popup, status bar) and
// enough chrome window for the modules that classify (keystate,
// commandcenterfocus). Deliberately STRICT: anything not explicitly faked
// throws, so a test that exercises a code path nobody prepared fails loudly
// instead of quietly reading `undefined` and taking the fallback branch.
//
// The one place strictness is relaxed is `querySelectorAll`, which answers
// `[]` for an unknown selector — that is what the real document does for a
// selector that matches nothing, and several modules probe with a selector
// that only sometimes exists.
// ---------------------------------------------------------------------------

export interface FakeChromeEnv extends ChromeEnv {
  /** Everything mounted on the fake documentElement, by id. */
  readonly ids: Map<string, any>;
  /** Tabs currently in the strip. */
  readonly tabs: any[];
  /** The tab `gBrowser.selectedTab` points at. */
  selectedTab: any;
  /** Every element appended to the document, in order. */
  readonly appended: any[];
  /** Every `btoa` input, so a wire test can decode what a handler encoded. */
  readonly encoded: string[];
  /**
   * The tab progress listeners `gBrowser.addTabsProgressListener` received.
   *
   * The keyboard's LOAD trigger lives in one of these (`onStateChange`,
   * chrome/winsync.ts) and a listener that is registered but never driven from
   * a test is a rule nobody checks — which is how the freeze it exists for
   * reached a user in the first place.
   */
  readonly progressListeners: any[];
  /** Deliver a TabSelect to the tab container's listeners. */
  dispatchTabSelect(): void;
  /** Timers scheduled through `setTimeout`, runnable by `runTimers()`. */
  runTimers(): void;
  /** Add an element to the document under `id`. */
  mount(id: string, el: any): any;
  /**
   * Deliver an event to the window's own listeners, in the order they were
   * registered — the chrome window's capture phase, as far as a Node test can
   * have one.
   *
   * The window listeners are the one place the helper's rules about KEYS live
   * (a consumed keydown's keypress/keyup tail), and until this existed that
   * module could not be exercised at all outside Firefox: `addEventListener`
   * was a no-op, so a test could construct the listeners and assert nothing
   * about them. `type` picks the listeners for one event name; `ev` is the
   * event object, and `type` is stamped on it so a listener can read it.
   *
   * Returns the event, so a test can assert on what a listener did to it
   * (`defaultPrevented`, `stopped`) — which is the whole question here.
   */
  dispatchWindow(type: string, ev?: any): any;
}

/**
 * The observable event shape the fake dispatches. Enough for the key rules:
 * `preventDefault` / `stopImmediatePropagation` flip flags a test reads back,
 * and `defaultPrevented` is what the listener itself consults.
 */
function mkEvent(type: string, over: any = {}): any {
  const ev: any = {
    type,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
    stopPropagation() {
      ev.stopped = true;
    },
    stopImmediatePropagation() {
      ev.stopped = true;
    },
    ...over,
  };
  return ev;
}

interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  style: Record<string, string>;
  className: string;
  textContent: string;
  innerHTML: string;
  value: string;
  listeners: Array<{ type: string; fn: (e: any) => void; opts?: any }>;
  [k: string]: any;
}

function mkEl(tag: string): any {
  const e: FakeEl = {
    tagName: String(tag).toUpperCase(),
    attrs: {},
    children: [],
    parent: null,
    style: {} as Record<string, string>,
    className: "",
    textContent: "",
    innerHTML: "",
    value: "",
    listeners: [],
    // The chrome layer sets `style.cssText` on popups; record it rather than
    // parsing it, because no test has ever needed to read a CSS declaration
    // back — only to know that one was set.
    get cssText() {
      return (this as any)._cssText || "";
    },
    set cssText(v: string) {
      (this as any)._cssText = v;
    },
    setAttribute(k: string, v: string) {
      e.attrs[k] = String(v);
    },
    getAttribute(k: string) {
      return k in e.attrs ? e.attrs[k] : null;
    },
    hasAttribute(k: string) {
      return k in e.attrs;
    },
    removeAttribute(k: string) {
      delete e.attrs[k];
    },
    appendChild(c: any) {
      e.children.push(c);
      c.parent = e;
      return c;
    },
    insertBefore(c: any, ref: any) {
      const i = e.children.indexOf(ref);
      if (i === -1) e.children.push(c);
      else e.children.splice(i, 0, c);
      c.parent = e;
      return c;
    },
    removeChild(c: any) {
      const i = e.children.indexOf(c);
      if (i !== -1) e.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    remove() {
      if (e.parent) e.parent.removeChild(e);
    },
    contains(n: any) {
      if (n === e) return true;
      return e.children.some((c) => (c.contains ? c.contains(n) : false));
    },
    querySelector(sel: string) {
      const all = e.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    querySelectorAll(sel: string) {
      const out: any[] = [];
      const cls = sel.replace(/^\./, "");
      const byTag = sel.replace(/^#/, "");
      const visit = (n: FakeEl) => {
        for (const c of n.children) {
          const hit = sel.startsWith(".")
            ? (c.className || "").split(/\s+/).indexOf(cls) !== -1
            : sel.startsWith("#")
              ? c.attrs["id"] === byTag
              : c.tagName === String(sel).toUpperCase();
          if (hit) out.push(c);
          visit(c);
        }
      };
      visit(e);
      return out as any;
    },
    get firstChild() {
      return e.children[0] || null;
    },
    addEventListener(type: string, fn: (ev: any) => void, opts?: any) {
      e.listeners.push({ type, fn, opts });
    },
    removeEventListener(type: string, fn: (ev: any) => void) {
      const i = e.listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) e.listeners.splice(i, 1);
    },
    dispatchEvent(ev: any) {
      for (const l of e.listeners) if (l.type === ev.type) l.fn(ev);
      return true;
    },
    focus() {
      (e as any)._focused = true;
    },
    blur() {
      (e as any)._focused = false;
    },
    matches() {
      return false;
    },
    getBoundingClientRect() {
      return { height: 0, width: 0, top: 0, left: 0 };
    },
    insertAdjacentHTML() {},
  };
  return e;
}

/**
 * A chrome environment that answers in Node.
 *
 * `opts.tabs` seeds the tab strip (each `{ url, active, muted, pinned }`); the
 * selected tab is the active one, or the first. `opts.ids` mounts elements
 * that `getElementById` can find. `opts.prefs` seeds the preference reads.
 *
 * Everything else is either absent (and therefore `undefined`, which the
 * modules' existing defensive reads already handle) or throws on purpose.
 */
export function createFakeChromeEnv(
  opts: {
    tabs?: Array<{ url: string; active?: boolean; muted?: boolean; pinned?: boolean; userContextId?: number }>;
    selected?: number;
    ids?: Record<string, any>;
    prefs?: Record<string, string | boolean>;
    /** Run scheduled timers on `setTimeout` immediately instead of queuing. */
    autoRunTimers?: boolean;
  } = {},
): FakeChromeEnv {
  const tabs: any[] = (opts.tabs || []).map((t) => {
    const el = mkEl("tab");
    el.url = t.url;
    el.muted = !!t.muted;
    el.pinned = !!t.pinned;
    el.userContextId = t.userContextId || 0;
    el.splitview = null;
    el.linkedBrowser = {
      currentURI: { spec: t.url },
      contentDocument: null,
      contentWindow: null,
      // COUNTED, not ignored: focusing the browser element is how the helper
      // gives a tab its keyboard back (see chrome/keyboardfocus.ts and
      // commandcenterfocus.focusSelectedContent), so a test has to be able to
      // see that it happened and to which browser.
      focusCount: 0,
      focus() {
        this.focusCount++;
      },
      fixupAndLoadURIString() {},
    };
    el._active = !!t.active;
    return el;
  });
  const ids = new Map<string, any>(Object.entries(opts.ids || {}));
  const appended: any[] = [];
  const encoded: string[] = [];
  const timers: Array<() => void> = [];
  const prefs: Record<string, string | boolean> = { ...(opts.prefs || {}) };

  const docEl = mkEl("html");
  const body = mkEl("body");
  docEl.appendChild(body);

  const document: any = {
    get documentElement() {
      return docEl;
    },
    body,
    activeElement: null,
    visibilityState: "visible",
    commandDispatcher: { focusedElement: null },
    fullscreenElement: null,
    getElementById: (id: string) => ids.get(id) || null,
    querySelector: (sel: string) => docEl.querySelector(sel),
    querySelectorAll: (sel: string) => docEl.querySelectorAll(sel),
    createElementNS: (_ns: string, tag: string) => mkEl(tag),
    createElement: (tag: string) => mkEl(tag),
    // The popup host parses an HTML fragment through
    // `implementation.createHTMLDocument`. A real fragment parser is out of
    // scope for a fake, so this returns a body whose innerHTML setter is
    // observable — tests assert on the markup that was assigned, which is the
    // claim worth making anyway.
    implementation: {
      createHTMLDocument: () => ({ body: mkEl("body") }),
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const win: any = {
    document,
    /** Window listeners, in registration order, per event name. */
    listeners: [] as Array<{ type: string; fn: (e: any) => void; capture?: boolean }>,
    focus() {
      (win as any)._focused = true;
    },
    moveBy() {},
    resizeBy() {},
    addEventListener(type: string, fn: (e: any) => void, opts?: any) {
      win.listeners.push({ type, fn, capture: !!(opts && opts.capture) });
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      const i = win.listeners.findIndex((l: any) => l.type === type && l.fn === fn);
      if (i !== -1) win.listeners.splice(i, 1);
    },
    getComputedStyle: (el: any) => ({ display: el && el.attrs && el.attrs.hidden ? "none" : "block" }),
    // The window's own timers. Recorded as a no-op handle rather than run: a
    // module that arms a poller here (winsync's relay/status tick) must be able
    // to be constructed by a test, and a poller that fires mid-test would make
    // assertions about what a trigger did depend on how long the test took.
    setInterval: () => 0,
    clearInterval: () => {},
  };
  // The tab container's own TabSelect listeners, and the progress listeners
  // gBrowser hands a listener object to. Both are RECORDED rather than ignored:
  // the keyboard's tab-select / document-loaded triggers are registered here,
  // and a fake that swallowed them could not tell a wired trigger from a
  // missing one.
  const tabSelectListeners: Array<(e?: any) => void> = [];
  const progressListeners: any[] = [];
  win.gBrowser = {
    tabs,
    tabContainer: {
      addEventListener(type: string, fn: (e?: any) => void) {
        if (type === "TabSelect") tabSelectListeners.push(fn);
      },
      removeEventListener() {},
    },
    addTabsProgressListener(fn: any) {
      progressListeners.push(fn);
    },
    removeTabsProgressListener() {},
    get selectedTab() {
      const i = opts.selected != null ? opts.selected : tabs.findIndex((t) => t._active);
      return i >= 0 && i < tabs.length ? tabs[i] : tabs[0] || null;
    },
    get selectedBrowser() {
      const t = win.gBrowser.selectedTab;
      return t ? t.linkedBrowser : null;
    },
    addTab: (url: string) => {
      const el = mkEl("tab");
      el.url = url;
      el.linkedBrowser = {
        currentURI: { spec: url },
        contentDocument: null,
        contentWindow: null,
        focusCount: 0,
        focus() {
          this.focusCount++;
        },
      };
      tabs.push(el);
      return el;
    },
    removeCurrentTab() {
      const t = win.gBrowser.selectedTab;
      const i = tabs.indexOf(t);
      if (i !== -1) tabs.splice(i, 1);
    },
    // The two tab-strip operations the split code calls. PERFORMED on the fake
    // strip rather than recorded and ignored, because the questions the split
    // tests ask are about the strip afterwards: did unsplit put the tabs back in
    // their slots, and was our own panel pane actually closed.
    moveTabTo: (tab: any, opts: any) => {
      const to = opts && typeof opts.tabIndex === "number" ? opts.tabIndex : -1;
      const from = tabs.indexOf(tab);
      if (from === -1 || to < 0 || to >= tabs.length || to === from) return;
      tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
    },
    removeTab: (tab: any) => {
      const i = tabs.indexOf(tab);
      if (i !== -1) tabs.splice(i, 1);
    },
    selectedIndex: 0,
  };

  const services: any = {
    prefs: {
      getBoolPref: (n: string, f?: boolean) =>
        typeof prefs[n] === "boolean" ? (prefs[n] as boolean) : !!f,
      getStringPref: (n: string, f?: string) =>
        typeof prefs[n] === "string" ? (prefs[n] as string) : (f as string),
      setBoolPref: (n: string, v: boolean) => {
        prefs[n] = v;
      },
      setStringPref: (n: string, v: string) => {
        prefs[n] = v;
      },
    },
    dirsvc: { get: (name: string) => ({ leafName: name, path: "/" + name }) },
    io: {
      newURI: (s: string) => ({ spec: s }),
      getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitution() {} }) }),
    },
    focus: { focusedElement: null },
    console: { logStringMessage() {} },
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
  };

  const schedule = (fn: () => void): any => {
    if (opts.autoRunTimers) {
      fn();
      return 0;
    }
    timers.push(fn);
    return timers.length;
  };

  const env: FakeChromeEnv = {
    ids,
    tabs,
    appended,
    encoded,
    selectedTab: win.gBrowser.selectedTab,
    window: win as any,
    document: document as any,
    services: services as any,
    Ci: {
      nsIFile: 1,
      nsISubstitutingProtocolHandler: 2,
      nsINavHistoryQueryOptions: { SORT_BY_DATE_DESCENDING: 100 },
      // The real IDL's values, so a test drives the product through the same
      // flag arithmetic the browser does (chrome/winsync.ts reads these).
      nsIWebProgressListener: {
        STATE_START: 0x00000001,
        STATE_STOP: 0x00000010,
        STATE_IS_DOCUMENT: 0x00020000,
        STATE_IS_WINDOW: 0x00080000,
      },
    },
    Cc: {},
    Cu: { isDeadWrapper: (o: any) => !!(o && o.__dead) },
    ChromeUtils: { importESModule: () => null, generateQI: () => ({}) },
    // Real zoom levels, keyed by browser object, so a test can drive
    // `;zoom` twice and assert the level actually moved.
    ZoomManager: {
      getZoomForBrowser: (b: any) => (b && b.__zoom != null ? b.__zoom : 1),
      setZoomForBrowser: (b: any, level: number) => {
        if (b) b.__zoom = level;
      },
    },
    setTimeout: schedule,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    // The same globals the real env hands out, not a Node-only base64 helper:
    // a fake that encoded differently from production would make a wire replay
    // assert against a different grammar than the one the product speaks. (Both
    // throw on a non-latin1 input, in the fake and in the browser — faithfully.)
    btoa: (s: string) => {
      encoded.push(s);
      return btoa(s);
    },
    atob: (s: string) => atob(s),
    getComputedStyle: win.getComputedStyle,
    console: { log() {}, error() {} },
    progressListeners,
    dispatchTabSelect() {
      for (const fn of tabSelectListeners.slice()) fn({});
    },
    runTimers() {
      // Drain in waves: a timer can schedule another, and the popup host
      // relies on exactly that (focus() runs in a 0ms timer).
      let guard = 0;
      while (timers.length && guard++ < 100) {
        const batch = timers.splice(0, timers.length);
        for (const fn of batch) fn();
      }
    },
    dispatchWindow(type: string, ev?: any) {
      // The event is the caller's fields OVER the observable defaults, so a
      // test can pass `{ key, code, target }` and still read
      // `defaultPrevented` back off it — which is the only thing these
      // listeners are judged by.
      const e = mkEvent(type, ev || {});
      // `stopImmediatePropagation` stops the REST of the listeners — which is
      // exactly the rule the tail listener relies on, so the fake honours it
      // rather than running every listener regardless.
      for (const l of win.listeners.slice()) {
        if (l.type !== type) continue;
        l.fn(e);
        if (e.stopped) break;
      }
      return e;
    },
    mount(id: string, el: any) {
      const node = el || mkEl("div");
      node.setAttribute("id", id);
      ids.set(id, node);
      docEl.appendChild(node);
      appended.push(node);
      return node;
    },
  } as FakeChromeEnv;

  // Keep `appended` in step with anything mounted straight onto the root.
  const origAppend = docEl.appendChild.bind(docEl);
  docEl.appendChild = (c: any) => {
    appended.push(c);
    return origAppend(c);
  };

  return env;
}

/** The element factory the fake env uses, so a test can build fixtures. */
export function fakeElement(tag: string): any {
  return mkEl(tag);
}