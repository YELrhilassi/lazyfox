import "../vendor/wasm_exec.js";
import { WASM_BASE64 } from "./wasm-embed";
import type { DownloadEntry, Lfc, VisitedItem, WkItem, WkPage } from "./types";

// The Go core (core.wasm) is compiled to a single wasm module and exposed to
// JS as the "LazyfoxCore" object. Every Lazyfox context uses this facade; the
// core is initialized lazily on first use and cached, so page loads and window
// opens pay nothing until a leader key is actually pressed.
//
// The wasm is embedded as raw base64 so each bundle is self-contained and the
// runtime needs only atob() + WebAssembly.instantiate() — both available in
// every Lazyfox context (content scripts, extension pages, chrome). The chrome
// helper deliberately does NOT use this default init: the browser window's CSP
// blocks WebAssembly.instantiate(), so chrome.ts creates a CSP-free system
// sandbox (corebootstrap.js) and points this facade at that sandbox's core via
// setCoreApi().

export interface CoreApi {
  version(): string;
  bindings(): WkItem[];
  normalizeUrl(text: string): string;
  isLikelyUrl(text: string): boolean;
  rankVisited(items: VisitedItem[], query: string): VisitedItem[];
  makeHints(n: number, chars: string): string[];
  wkPageCount(): number;
  wkPageSlice(page: number): WkPage;
  wkClampSel(sel: number, page: number): number;
  wkFlip(page: number, dir: number): number;
  wkNav(sel: number, page: number, dir: number): number;
  lfcParse(fragment: string): Lfc;
  lfcOpen(target: string, closeTab: boolean): string;
  lfcCfg(nonce: string, encodedPayload: string): string;
  lfcReq(action: string, arg: string): string;
  lfcOk(nonce: string): string;
  lfcErr(nonce: string): string;
  assignSessionMarker(taken: number[]): number;
  splitPairsOf(ids: number[]): [number, number][];
  encodeSplits(pairs: [number, number][]): string;
  decodeSplits(encoded: string): [number, number][];
  splitPartnerOf(pairs: [number, number][], i: number): number;
  formatBytes(n: number): string;
  formatSpeed(n: number): string;
  downloadProgress(received: number, total: number): number;
  mergeDownloads(prev: DownloadEntry[], fresh: DownloadEntry[]): DownloadEntry[];
  activeDownloads(downloads: DownloadEntry[]): DownloadEntry[];
  sessionSummary(
    sessions: { name: string; marker: number; tabCount: number; splits: string; legacySplitTabs: number }[],
    current: string
  ): { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[];
}

declare global {
  interface Window {
    LazyfoxCore?: CoreApi;
  }
}

// Initializes the core inside an arbitrary global object. `scope` must have
// atob, WebAssembly and a Go constructor (wasm_exec.js evaluated there first).
// The Go program registers itself as scope.LazyfoxCore.
export async function initCoreIn(scope: any): Promise<CoreApi> {
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
}

// Builds a promise-returning facade over the CoreApi. getApi() is consulted on
// every call so a context can swap in a different backend (e.g. the chrome
// helper's sandbox core) without changing the call sites.
export function createCoreFacade(getApi: () => Promise<CoreApi>) {
  const call = <T>(fn: (a: CoreApi) => T): Promise<T> => getApi().then(fn);
  return {
    version: (): Promise<string> => call((a) => a.version()),
    bindings: (): Promise<WkItem[]> => call((a) => a.bindings()),
    normalizeUrl: (t: string): Promise<string> => call((a) => a.normalizeUrl(t)),
    isLikelyUrl: (t: string): Promise<boolean> => call((a) => a.isLikelyUrl(t)),
    rankVisited: (items: VisitedItem[], q: string): Promise<VisitedItem[]> =>
      call((a) => a.rankVisited(items, q)),
    makeHints: (n: number, chars: string): Promise<string[]> =>
      call((a) => a.makeHints(n, chars)),
    wkPageCount: (): Promise<number> => call((a) => a.wkPageCount()),
    wkPageSlice: (p: number): Promise<WkPage> => call((a) => a.wkPageSlice(p)),
    wkClampSel: (s: number, p: number): Promise<number> =>
      call((a) => a.wkClampSel(s, p)),
    wkFlip: (p: number, d: number): Promise<number> => call((a) => a.wkFlip(p, d)),
    wkNav: (s: number, p: number, d: number): Promise<number> =>
      call((a) => a.wkNav(s, p, d)),
    lfcParse: (f: string): Promise<Lfc> => call((a) => a.lfcParse(f)),
    lfcOpen: (t: string, c: boolean): Promise<string> =>
      call((a) => a.lfcOpen(t, c)),
    lfcCfg: (n: string, e: string): Promise<string> => call((a) => a.lfcCfg(n, e)),
    lfcReq: (act: string, arg: string): Promise<string> =>
      call((a) => a.lfcReq(act, arg)),
    lfcOk: (n: string): Promise<string> => call((a) => a.lfcOk(n)),
    lfcErr: (n: string): Promise<string> => call((a) => a.lfcErr(n)),
    assignSessionMarker: (taken: number[]): Promise<number> =>
      call((a) => a.assignSessionMarker(taken)),
    splitPairsOf: (ids: number[]): Promise<[number, number][]> =>
      call((a) => a.splitPairsOf(ids)),
    encodeSplits: (pairs: [number, number][]): Promise<string> =>
      call((a) => a.encodeSplits(pairs)),
    decodeSplits: (encoded: string): Promise<[number, number][]> =>
      call((a) => a.decodeSplits(encoded)),
    splitPartnerOf: (pairs: [number, number][], i: number): Promise<number> =>
      call((a) => a.splitPartnerOf(pairs, i)),
    formatBytes: (n: number): Promise<string> => call((a) => a.formatBytes(n)),
    formatSpeed: (n: number): Promise<string> => call((a) => a.formatSpeed(n)),
    downloadProgress: (received: number, total: number): Promise<number> =>
      call((a) => a.downloadProgress(received, total)),
    mergeDownloads: (prev: DownloadEntry[], fresh: DownloadEntry[]): Promise<DownloadEntry[]> =>
      call((a) => a.mergeDownloads(prev, fresh)),
    activeDownloads: (downloads: DownloadEntry[]): Promise<DownloadEntry[]> =>
      call((a) => a.activeDownloads(downloads)),
    sessionSummary: (
      sessions: { name: string; marker: number; tabCount: number; splits: string; legacySplitTabs: number }[],
      current: string
    ): Promise<
      { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[]
    > => call((a) => a.sessionSummary(sessions, current)),
  };
}
export type CoreFacade = ReturnType<typeof createCoreFacade>;

// The API object once it has been initialized (used for the synchronous hot
// path by WkSession). Both backends call setCoreApi with their init promise.
let apiPromise: Promise<CoreApi> | null = null;
let readyApi: CoreApi | null = null;

export function setCoreApi(p: Promise<CoreApi>): void {
  apiPromise = p;
  p.then((a) => {
    readyApi = a;
  }).catch(() => {});
}

// Default backend: the current realm (content script, extension page).
export function ensureCore(): Promise<CoreApi> {
  if (!apiPromise) setCoreApi(initCoreIn(globalThis));
  return apiPromise!;
}

export function coreReady(): boolean {
  return readyApi !== null;
}

export function coreSync(): CoreApi {
  if (!readyApi) throw new Error("lazyfox core not ready");
  return readyApi;
}

export const core = createCoreFacade(ensureCore);
