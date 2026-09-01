import "../vendor/wasm_exec.js";
import { WASM_BASE64 } from "./wasm-embed";
import type { StatusBarData } from "./statusbar";
import type { DownloadEntry, HistoryRow, Lfc, RecoveryRow, VisitedItem, WkItem, WkPage } from "./types";

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
  organizeHistory(
    items: { url: string; title: string; time: number }[],
    query: string,
    now: number,
    tzOffsetMinutes: number
  ): HistoryRow[];
  organizeRecovery(
    items: { key: string; kind: string; title: string; url: string; tabCount: number; time: number }[],
    now: number
  ): RecoveryRow[];
  splitPairsOf(ids: number[]): [number, number][];
  encodeSplits(pairs: [number, number][]): string;
  decodeSplits(encoded: string): [number, number][];
  splitPartnerOf(pairs: [number, number][], i: number): number;
  coalescePair(pre: string[], anchor: string, partner: string): string[];
  coalesceIntoGroup(pre: string[], members: string[], tab: string): string[];
  planStrip(current: string[], desired: string[], groups: string[][]): [string, number][];
  yankParse(text: string): { lines: number; total: number; lineStart: number[] };
  yankMotion(op: string, arg: string, line: number, col: number): { line: number; col: number };
  yankObject(
    op: string,
    line: number,
    col: number
  ): { ok: boolean; sl: number; sc: number; el: number; ec: number };
  formatBytes(n: number): string;
  formatSpeed(n: number): string;
  downloadProgress(received: number, total: number): number;
  mergeDownloads(prev: DownloadEntry[], fresh: DownloadEntry[]): DownloadEntry[];
  activeDownloads(downloads: DownloadEntry[]): DownloadEntry[];
  // ---- status store: single source of truth for the status bar ----
  // All events flow IN via these setters (JSON for structured payloads); the
  // render model flows OUT via statusSnapshot(). The chrome helper pushes and
  // paints; nothing else owns bar state.
  statusSession(state: string): void;
  statusTab(selected: number, tabIndex: number, tabCount: number): void;
  statusUi(popup: boolean, leader: boolean): void;
  statusLeader(index: number, active: boolean): void;
  statusFind(index: number, cur: number, count: number): void;
  statusStealth(on: boolean): void;
  statusDownloads(fresh: string): void;
  statusDismiss(keys: string): void;
  statusSnapshot(): string;
  downloadsList(): string;
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
    organizeHistory: (
      items: { url: string; title: string; time: number }[],
      query: string,
      now: number,
      tzOffsetMinutes: number
    ): Promise<HistoryRow[]> =>
      call((a) => a.organizeHistory(items, query, now, tzOffsetMinutes)),
    organizeRecovery: (
      items: { key: string; kind: string; title: string; url: string; tabCount: number; time: number }[],
      now: number
    ): Promise<RecoveryRow[]> =>
      call((a) => a.organizeRecovery(items, now)),
    splitPairsOf: (ids: number[]): Promise<[number, number][]> =>
      call((a) => a.splitPairsOf(ids)),
    encodeSplits: (pairs: [number, number][]): Promise<string> =>
      call((a) => a.encodeSplits(pairs)),
    decodeSplits: (encoded: string): Promise<[number, number][]> =>
      call((a) => a.decodeSplits(encoded)),
    splitPartnerOf: (pairs: [number, number][], i: number): Promise<number> =>
      call((a) => a.splitPartnerOf(pairs, i)),
    coalescePair: (pre: string[], anchor: string, partner: string): Promise<string[]> =>
      call((a) => a.coalescePair(pre, anchor, partner)),
    coalesceIntoGroup: (pre: string[], members: string[], tab: string): Promise<string[]> =>
      call((a) => a.coalesceIntoGroup(pre, members, tab)),
    planStrip: (current: string[], desired: string[], groups: string[][]): Promise<[string, number][]> =>
      call((a) => a.planStrip(current, desired, groups)),
    yankParse: (text: string): Promise<{ lines: number; total: number; lineStart: number[] }> =>
      call((a) => a.yankParse(text)),
    yankMotion: (op: string, arg: string, line: number, col: number): Promise<{ line: number; col: number }> =>
      call((a) => a.yankMotion(op, arg, line, col)),
    yankObject: (
      op: string,
      line: number,
      col: number
    ): Promise<{ ok: boolean; sl: number; sc: number; el: number; ec: number }> =>
      call((a) => a.yankObject(op, line, col)),
    formatBytes: (n: number): Promise<string> => call((a) => a.formatBytes(n)),
    formatSpeed: (n: number): Promise<string> => call((a) => a.formatSpeed(n)),
    downloadProgress: (received: number, total: number): Promise<number> =>
      call((a) => a.downloadProgress(received, total)),
    mergeDownloads: (prev: DownloadEntry[], fresh: DownloadEntry[]): Promise<DownloadEntry[]> =>
      call((a) => a.mergeDownloads(prev, fresh)),
    activeDownloads: (downloads: DownloadEntry[]): Promise<DownloadEntry[]> =>
      call((a) => a.activeDownloads(downloads)),
    statusSession: (state: unknown): Promise<void> =>
      call((a) => {
        a.statusSession(JSON.stringify(state || {}));
      }),
    statusTab: (selected: number, tabIndex: number, tabCount: number): Promise<void> =>
      call((a) => {
        a.statusTab(selected, tabIndex, tabCount);
      }),
    statusUi: (popup: boolean, leader: boolean): Promise<void> =>
      call((a) => {
        a.statusUi(popup, leader);
      }),
    statusLeader: (index: number, active: boolean): Promise<void> =>
      call((a) => {
        a.statusLeader(index, active);
      }),
    statusFind: (index: number, cur: number, count: number): Promise<void> =>
      call((a) => {
        a.statusFind(index, cur, count);
      }),
    statusStealth: (on: boolean): Promise<void> =>
      call((a) => {
        a.statusStealth(on);
      }),
    statusDownloads: (fresh: DownloadEntry[]): Promise<void> =>
      call((a) => {
        a.statusDownloads(JSON.stringify(fresh || []));
      }),
    statusDismiss: (keys: string[]): Promise<void> =>
      call((a) => {
        a.statusDismiss(JSON.stringify(keys || []));
      }),
    statusSnapshot: (): Promise<StatusBarData> =>
      call((a) => JSON.parse(a.statusSnapshot())),
    downloadsList: (): Promise<DownloadEntry[]> =>
      call((a) => JSON.parse(a.downloadsList())),
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
