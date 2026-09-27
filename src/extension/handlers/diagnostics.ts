// Diagnostics: what the diagnostics page, the setup page and the options page
// ask the background about itself and about the current page.
//
// These are the read-mostly actions, and the only ones whose responses are
// reports rather than results. They are grouped because they share a purpose —
// making the extension's state observable — rather than a dependency, which is
// why the pieces they need are injected: the page report walks the tab list and
// the page cache, both of which background.ts owns.
import type { CacheMode, CacheScope, CacheState, PageReport } from "../../shared/types";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "components" | "openSetup" | "openDiagnostics" | "quit" | "pageReport" | "diagnoseTabs" | "cacheState" | "cacheSet" | "hardReload";

export interface DiagnosticsDeps {
  componentsInfo(): Promise<{
    extension: string;
    wasm: string;
    nativeHost: string | null;
    nativeProtocol: string | null;
    chromeHelper: string | null;
  }>;
  pageReport(data?: { tabId?: number }): Promise<{ report: PageReport | null; tabId: number | null }>;
  diagnoseTabs(): Promise<{ tabs: { id: number; title: string; url: string; active: boolean }[] }>;
  openSetupTab(): Promise<{ ok: boolean }>;
  openDiagnosticsTab(): Promise<{ ok: boolean }>;
  cacheState(): Promise<CacheState>;
  cacheSet(scope: CacheScope, mode: CacheMode): Promise<{ ok: boolean; state?: CacheState; error?: string }>;
  hardReload(): Promise<{ ok: boolean }>;
  quitBrowser(): Promise<{ ok: boolean }>;
}

export function createDiagnosticsHandlers(deps: DiagnosticsDeps): Domain<Owns> {
  return {
    components: () => deps.componentsInfo(),

    openSetup: () => deps.openSetupTab(),
    openDiagnostics: () => deps.openDiagnosticsTab(),
    quit: () => deps.quitBrowser(),

    // Ask a tab's content script for a live self-report. A page with no content
    // script (about:/error pages, restricted domains) throws inside — that is an
    // answer, not a failure, so it comes back as report: null.
    pageReport: (data) => deps.pageReport(data),
    diagnoseTabs: () => deps.diagnoseTabs(),

    cacheState: () => deps.cacheState(),
    cacheSet: (data) => deps.cacheSet(data.scope, data.mode),
    hardReload: () => deps.hardReload(),
  };
}
