// Structural types for the XUL objects the chrome helper drives directly.
//
// The helper runs privileged, so it can reach gBrowser and the tab elements
// that no WebExtension API exposes. Firefox ships no TypeScript types for any
// of it, so these were 37 `gBrowser` references across 7 modules with every
// one of them `any` — and `any` there is not cosmetic. These objects are
// iterated and read constantly (the stable 1-9 numbering is literally an
// ordering over gBrowser.tabs), so a typo in a property name or a wrong
// assumption about a method's return type compiles fine and then fails at
// runtime, inside a keypress handler, on a dead tab wrapper.
//
// Everything here is deliberately minimal and structural: it describes what
// THIS codebase actually reads, not the whole of tabbrowser. A field that
// turns out to be needed gets added with a comment saying what it is and where
// it came from; the point is that the compiler can now see the shape, not that
// Firefox's tabbrowser is fully modelled.
//
// Two properties need explaining because they are the ones that actually bite:
//
//   closing  Set by Firefox when a tab has been scheduled for removal but the
//            element is still in gBrowser.tabs. Every strip-ordering path
//            has to filter it out — an unfiltered order list makes the Go
//            strip planner compute moves for a tab that no longer exists.
//
//   splitview  Firefox's native split view (bug 2016928 has no WebExtension
//            API). A stale reference can linger on a tab after an unsplit on
//            some builds, so callers must null-check and can expect a wrapper
//            whose `tabs` no longer includes the tab it is attached to. That
//            is why this is the loose member type rather than a real one: the
//            runtime genuinely lies to you here.

/** A XUL browser element's URI. Only `.spec` is ever read. */
export interface ChromeURI {
  spec: string;
}

/** The `browser` element hanging off a tab (gBrowser.tab.linkedBrowser). */
export interface ChromeBrowser {
  /** Unique, stable for the browser element's lifetime. Used as the fallback
   *  id in the strip planner's id space (see idOf in splitview). */
  readonly browserId?: number | null;
  currentURI?: ChromeURI;
  /** The content window, reachable only from chrome. */
  readonly contentWindow?: Window | null;
  /** The content document, reachable from chrome. Only the status bar reads
   *  it, to ask whether a page has focus. */
  readonly contentDocument?: Document | null;
  readonly browsingContext?: {
    embedderElement?: unknown;
    top?: unknown;
    /** The privileged per-window global. Reached from chrome only; it is how
     *  main.ts asks whether the content-side actor has registered. */
    currentWindowGlobal?: {
      getActor?(name: string): unknown;
    } | null;
  } | null;
  focus(): void;
  /** Firefox 149+ split the two loading APIs and deprecated the old one; both
   *  spellings are still live in current builds. */
  loadURI(spec: string, triggeringPrincipal?: unknown): void;
  fixupAndLoadURIString(url: string, triggeringPrincipal?: unknown): void;
}

/** Firefox's native split-view wrapper (Firefox 149+). */
export interface SplitViewWrapper {
  /** The panes, in visual order. Reversing this array reverses the panes. */
  tabs?: ChromeTab[];
  /** The wrapper is a DOM element, so isConnected detects a dissolved split. */
  readonly isConnected?: boolean;
  /** Unsplit the group. May throw; may be a no-op on a stale wrapper. */
  unsplitTabs?(): void;
  /** Add tabs to an existing split. Refuses a tab that still belongs to
   *  another view, which is why callers dissolve a stale group first. */
  addTabs?(tabs: ChromeTab[]): void;
}

/** A `<tab>` element in gBrowser.tabs. */
export interface ChromeTab {
  /** The XUL id. Unique and stable for the tab's lifetime — the preferred id
   *  in the strip planner's id space. */
  readonly linkedPanel?: string | null;
  readonly linkedBrowser?: ChromeBrowser;
  /** The split group this tab belongs to, if any. May be a STALE reference. */
  readonly splitview?: SplitViewWrapper | null;
  readonly pinned?: boolean;
  /** True once the tab is scheduled for removal but still listed. */
  readonly closing?: boolean;
  /** Which container this tab lives in. Per-tab rather than per-window, and
   *  the status bar uses it to label pinned tabs. */
  readonly userContextId?: number;
  /** The tab's display label (favicon + title, as the tab strip renders it).
   *  The tab list popup prefers this over the page title. */
  readonly label?: string;
  /** Whether this is the selected tab. */
  readonly selected?: boolean;
  /** Read-only since the toggleMute/toggleMuteTab helpers were removed; the
   *  `muted` attribute reflects the same state and is what the toggle writes. */
  readonly muted?: boolean;
  /** A <tab> is a XUL element, so both of these are present. isConnected is
   *  what detects a dissolved split (the wrapper leaves the DOM but the tab
   *  does not). */
  isConnected: boolean;
  remove(): void;
  /** The tab element is a XUL element, so the attribute API is present. The
   *  muted attribute is the only state this codebase reads off a tab (it
   *  reflects tab.muted, whose setter no longer exists in current Firefox). */
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
}

/** The find bar gFindBar hands back. Async because the bar may not exist yet
 *  on a window that has never opened it, which is why the caller has a
 *  fallback toast. */
export interface FindBar {
  open(): void;
}

/**
 * The slice of gBrowser this helper uses.
 *
 * Note the two split-view members: addTabSplitView and activeSplitView only
 * exist on builds that ship native split view, which is exactly the version
 * check the feature is gated on. They are therefore optional — accessing them
 * unguarded is a type error now, where before it was a silent undefined.
 */
export interface GBrowser {
  readonly tabs: ChromeTab[];
  /** The selected tab and its browser are declared non-null even though
   *  Firefox populates them only once the window is built. That is not
   *  laziness: every consumer either runs after the window is up or already
   *  null-checks (a truthiness check on a non-nullable compiles fine), so
   *  declaring them optional would force ~20 `!` or early-returns that
   *  document nothing. The one thing that IS genuinely nullable is the
   *  content window, and that stays optional above. */
  selectedTab: ChromeTab;
  selectedBrowser: ChromeBrowser;
  readonly tabContainer: Element;
  readonly currentURI?: ChromeURI;
  // Everything below here exists on every Firefox build this helper supports,
  // so it is declared required. Only the two split-view members at the bottom
  // are version-gated. That split matters: marking a universal method optional
  // would push a `!` onto every call site for a null case that cannot happen,
  // and the point of this file is that the compiler can tell the difference.
  addTab(url: string, options?: Record<string, unknown>): ChromeTab;
  removeTab(tab: ChromeTab): void;
  removeCurrentTab(): void;
  /** Accepts a bare index as well as the where-object; both spellings are
   *  used in this codebase (splitview wants the object so a future before/
   *  after variant is a one-line change, ops wants the number). */
  moveTabTo(tab: ChromeTab, where: number | { tabIndex?: number; before?: ChromeTab; after?: ChromeTab }): void;
  /** Returns null when the tab could not be duplicated, so callers must not
   *  assign the result straight to selectedTab without a check. */
  duplicateTab(tab: ChromeTab, where?: { tabIndex?: number }): ChromeTab | null;
  undoCloseTab(tab?: ChromeTab): ChromeTab | null;
  reload(tab?: ChromeTab, flags?: number): void;
  loadURI(spec: string, triggeringPrincipal?: unknown): void;
  goBack(tab?: ChromeTab): boolean;
  goForward(tab?: ChromeTab): boolean;
  getFindBar(tab?: ChromeTab): Promise<FindBar>;
  getBrowserForBrowsingContext(bc: unknown): ChromeTab | null;
  addTabsProgressListener(listener: unknown): void;
  /** Firefox 149+ only. */
  addTabSplitView?(tabs: ChromeTab[], options?: { insertBefore?: ChromeTab }): void;
  /** Firefox 149+, exposed later than addTabSplitView — hence both optional. */
  activeSplitView?: SplitViewWrapper | null;
}

// gBrowser is placed on Window by src/shared/globals.d.ts, which every chrome
// build already pulls in. Declaring it here too would be a conflicting
// duplicate, so this module owns the shape and globals.d.ts owns the
// placement. Nothing here needs an accessor function: all 37 gBrowser
// references across the chrome modules are already correctly null-guarded, and
// threading an accessor through them would add 37 new failure points to buy
// nothing.
