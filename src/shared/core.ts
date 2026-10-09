import "../vendor/wasm_exec.js";
import { WASM_BASE64 } from "./wasm-embed";
import { createCoreFacade } from "./corefacade";
import type { DownloadEntry, HistoryRow, Lfc, NavState, RecoveryRow, VisitedItem, WkItem, WkPage } from "./types";

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
  // The keymap rows (spec + display chord + action id + category sub-keys) and
  // the shift/unshift pair the TS spec normaliser is pinned against.
  keymap(): unknown[];
  keymapValidate(): string;
  unshiftKey(key: string): string;
  shiftKey(key: string): string;
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
  // The far-right leader indicator: armed + the prefix typed so far + what the
  // next key must be ("" when any key will do).
  statusLeaderSignal(armed: boolean, prefix: string, expect: string): void;
  // The active tab's history-stack shape (JSON NavState).
  statusNav(nav: string): void;
  statusDownloads(fresh: string): void;
  statusDismiss(keys: string): void;
  statusSnapshot(): string;
  downloadsList(): string;
  sessionSummary(
    sessions: { name: string; marker: number; tabCount: number; splits: string; legacySplitTabs: number }[],
    current: string
  ): { marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[];
}

/**
 * One status-store mutation. A discriminated union rather than a string tag and
 * an args array: the whole point of batching is that the operations are known
 * at compile time, and a tuple of unknown[] would throw that away — every
 * caller would be free to pass the wrong arity and get a runtime no-op.
 */
export type StatusOp =
  | { kind: "session"; state: unknown }
  | { kind: "tab"; selected: number; tabIndex: number; tabCount: number }
  | { kind: "ui"; popup: boolean; leader: boolean }
  | { kind: "leader"; index: number; active: boolean }
  | { kind: "find"; index: number; cur: number; count: number }
  | { kind: "stealth"; on: boolean }
  | { kind: "leaderSignal"; armed: boolean; prefix: string; expect: string }
  | { kind: "nav"; nav: NavState }
  | { kind: "downloads"; fresh: DownloadEntry[] }
  | { kind: "dismiss"; keys: string[] };

/**
 * Apply every op synchronously against an already-resolved core.
 *
 * Exported because the chrome helper's own status path builds a batch and needs
 * the same mapping, and because a second applier would be exactly the drift
 * this change exists to prevent.
 */
export function applyStatusOps(a: CoreApi, ops: StatusOp[]): void {
  for (const op of ops) {
    switch (op.kind) {
      case "session":
        a.statusSession(JSON.stringify(op.state || {}));
        break;
      case "tab":
        a.statusTab(op.selected, op.tabIndex, op.tabCount);
        break;
      case "ui":
        a.statusUi(op.popup, op.leader);
        break;
      case "leader":
        a.statusLeader(op.index, op.active);
        break;
      case "find":
        a.statusFind(op.index, op.cur, op.count);
        break;
      case "stealth":
        a.statusStealth(op.on);
        break;
      case "leaderSignal":
        a.statusLeaderSignal(op.armed, op.prefix, op.expect);
        break;
      case "nav":
        a.statusNav(JSON.stringify(op.nav || { canBack: false, canForward: false, index: 0, count: 0 }));
        break;
      case "downloads":
        a.statusDownloads(JSON.stringify(op.fresh || []));
        break;
      case "dismiss":
        a.statusDismiss(JSON.stringify(op.keys || []));
        break;
    }
  }
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

// The promise facade lives in corefacade.ts, built from one method table so
// adding a core function is one interface entry + one table entry.
export type { CoreFacade } from "./corefacade";

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
