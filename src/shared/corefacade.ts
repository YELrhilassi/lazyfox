// The promise facade over the CoreApi.
//
// Every CoreApi method is synchronous; the facade makes each one
// promise-returning by resolving the API once per call through getApi(). The
// method list is declared once (METHODS) and the facade is built from it, so
// adding a core function is one interface entry + one table entry — not
// another 30-line wrapper block.
//
// statusBatch is the exception, and deliberately hand-written: it exists to
// apply a whole batch of status ops and read the snapshot in ONE synchronous
// stretch (see its comment below for why the per-call asynchrony was a real
// bug there, not just overhead).

import type { CoreApi } from "./core";
import type { StatusBarData } from "./statusbar";
import type { DownloadEntry, HistoryRow, Lfc, NavState, RecoveryRow, VisitedItem, WkItem, WkPage } from "./types";
import { applyStatusOps, type StatusOp } from "./core";

type P<T> = Promise<T>;

/** Every CoreApi method the facade forwards, with its exact signature. */
export interface CoreFacade {
  version(): P<string>;
  bindings(): P<WkItem[]>;
  normalizeUrl(text: string): P<string>;
  isLikelyUrl(text: string): P<boolean>;
  rankVisited(items: VisitedItem[], query: string): P<VisitedItem[]>;
  makeHints(n: number, chars: string): P<string[]>;
  wkPageCount(): P<number>;
  wkPageSlice(page: number): P<WkPage>;
  wkClampSel(sel: number, page: number): P<number>;
  wkFlip(page: number, dir: number): P<number>;
  wkNav(sel: number, page: number, dir: number): P<number>;
  lfcParse(fragment: string): P<Lfc>;
  lfcOpen(target: string, closeTab: boolean): P<string>;
  lfcCfg(nonce: string, encodedPayload: string): P<string>;
  lfcReq(action: string, arg: string): P<string>;
  lfcOk(nonce: string): P<string>;
  lfcErr(nonce: string): P<string>;
  assignSessionMarker(taken: number[]): P<number>;
  organizeHistory(
    items: { url: string; title: string; time: number }[],
    query: string,
    now: number,
    tzOffsetMinutes: number
  ): P<HistoryRow[]>;
  organizeRecovery(
    items: { key: string; kind: string; title: string; url: string; tabCount: number; time: number }[],
    now: number
  ): P<RecoveryRow[]>;
  splitPairsOf(ids: number[]): P<[number, number][]>;
  encodeSplits(pairs: [number, number][]): P<string>;
  decodeSplits(encoded: string): P<[number, number][]>;
  splitPartnerOf(pairs: [number, number][], i: number): P<number>;
  coalescePair(pre: string[], anchor: string, partner: string): P<string[]>;
  coalesceIntoGroup(pre: string[], members: string[], tab: string): P<string[]>;
  planStrip(current: string[], desired: string[], groups: string[][]): P<[string, number][]>;
  yankParse(text: string): P<{ lines: number; total: number; lineStart: number[] }>;
  yankMotion(op: string, arg: string, line: number, col: number): P<{ line: number; col: number }>;
  yankObject(
    op: string,
    line: number,
    col: number
  ): P<{ ok: boolean; sl: number; sc: number; el: number; ec: number }>;
  formatBytes(n: number): P<string>;
  formatSpeed(n: number): P<string>;
  downloadProgress(received: number, total: number): P<number>;
  mergeDownloads(prev: DownloadEntry[], fresh: DownloadEntry[]): P<DownloadEntry[]>;
  activeDownloads(downloads: DownloadEntry[]): P<DownloadEntry[]>;
  statusSession(state: unknown): P<void>;
  statusTab(selected: number, tabIndex: number, tabCount: number): P<void>;
  statusUi(popup: boolean, leader: boolean): P<void>;
  statusLeader(index: number, active: boolean): P<void>;
  statusFind(index: number, cur: number, count: number): P<void>;
  statusStealth(on: boolean): P<void>;
  // The far-right leader indicator: armed + the prefix typed so far + what the
  // next key must be (empty when any key will do).
  statusLeaderSignal(armed: boolean, prefix: string, expect: string): P<void>;
  // The active tab's history-stack shape.
  statusNav(nav: NavState): P<void>;
  statusDownloads(fresh: DownloadEntry[]): P<void>;
  statusDismiss(keys: string[]): P<void>;
  statusSnapshot(): P<StatusBarData>;
  downloadsList(): P<DownloadEntry[]>;
  sessionSummary(
    sessions: { name: string; marker: number; tabCount: number; splits: string; legacySplitTabs: number }[],
    current: string
  ): P<{ marker: number; name: string; current: boolean; tabCount: number; splitCount: number }[]>;
  statusBatch(ops: StatusOp[]): P<StatusBarData>;
}

// The forwarding table: facade method -> CoreApi method with its argument
// adaptation. Most entries forward args unchanged; the JSON-shape setters
// stringify their structured argument here so the call sites never see the
// wire encoding. The table body returns the SYNC CoreApi result; the facade
// wraps every entry in a promise.
type SyncMethod = (a: CoreApi, args: any[]) => unknown;
// statusBatch is hand-written below (it needs the atomic batch application),
// so the table omits it.
type TableMethods = Omit<CoreFacade, "statusBatch">;
const METHODS: { [K in keyof TableMethods]: SyncMethod } = {
  version: (a) => a.version(),
  bindings: (a) => a.bindings(),
  normalizeUrl: (a, [text]) => a.normalizeUrl(text),
  isLikelyUrl: (a, [text]) => a.isLikelyUrl(text),
  rankVisited: (a, [items, q]) => a.rankVisited(items, q),
  makeHints: (a, [n, chars]) => a.makeHints(n, chars),
  wkPageCount: (a) => a.wkPageCount(),
  wkPageSlice: (a, [page]) => a.wkPageSlice(page),
  wkClampSel: (a, [sel, page]) => a.wkClampSel(sel, page),
  wkFlip: (a, [page, dir]) => a.wkFlip(page, dir),
  wkNav: (a, [sel, page, dir]) => a.wkNav(sel, page, dir),
  lfcParse: (a, [fragment]) => a.lfcParse(fragment),
  lfcOpen: (a, [target, closeTab]) => a.lfcOpen(target, closeTab),
  lfcCfg: (a, [nonce, encodedPayload]) => a.lfcCfg(nonce, encodedPayload),
  lfcReq: (a, [action, arg]) => a.lfcReq(action, arg),
  lfcOk: (a, [nonce]) => a.lfcOk(nonce),
  lfcErr: (a, [nonce]) => a.lfcErr(nonce),
  assignSessionMarker: (a, [taken]) => a.assignSessionMarker(taken),
  organizeHistory: (a, [items, query, now, tz]) => a.organizeHistory(items, query, now, tz),
  organizeRecovery: (a, [items, now]) => a.organizeRecovery(items, now),
  splitPairsOf: (a, [ids]) => a.splitPairsOf(ids),
  encodeSplits: (a, [pairs]) => a.encodeSplits(pairs),
  decodeSplits: (a, [encoded]) => a.decodeSplits(encoded),
  splitPartnerOf: (a, [pairs, i]) => a.splitPartnerOf(pairs, i),
  coalescePair: (a, [pre, anchor, partner]) => a.coalescePair(pre, anchor, partner),
  coalesceIntoGroup: (a, [pre, members, tab]) => a.coalesceIntoGroup(pre, members, tab),
  planStrip: (a, [current, desired, groups]) => a.planStrip(current, desired, groups),
  yankParse: (a, [text]) => a.yankParse(text),
  yankMotion: (a, [op, arg, line, col]) => a.yankMotion(op, arg, line, col),
  yankObject: (a, [op, line, col]) => a.yankObject(op, line, col),
  formatBytes: (a, [n]) => a.formatBytes(n),
  formatSpeed: (a, [n]) => a.formatSpeed(n),
  downloadProgress: (a, [received, total]) => a.downloadProgress(received, total),
  mergeDownloads: (a, [prev, fresh]) => a.mergeDownloads(prev, fresh),
  activeDownloads: (a, [downloads]) => a.activeDownloads(downloads),
  statusSession: (a, [state]) => { a.statusSession(JSON.stringify(state || {})); },
  statusTab: (a, [selected, tabIndex, tabCount]) => a.statusTab(selected, tabIndex, tabCount),
  statusUi: (a, [popup, leader]) => a.statusUi(popup, leader),
  statusLeader: (a, [index, active]) => a.statusLeader(index, active),
  statusFind: (a, [index, cur, count]) => a.statusFind(index, cur, count),
  statusStealth: (a, [on]) => a.statusStealth(on),
  statusLeaderSignal: (a, [armed, prefix, expect]) =>
    a.statusLeaderSignal(armed, prefix, expect),
  statusNav: (a, [nav]) => { a.statusNav(JSON.stringify(nav || { canBack: false, canForward: false, index: 0, count: 0 })); },
  statusDownloads: (a, [fresh]) => { a.statusDownloads(JSON.stringify(fresh || [])); },
  statusDismiss: (a, [keys]) => { a.statusDismiss(JSON.stringify(keys || [])); },
  statusSnapshot: (a) => JSON.parse(a.statusSnapshot()),
  downloadsList: (a) => JSON.parse(a.downloadsList()),
  sessionSummary: (a, [sessions, current]) => a.sessionSummary(sessions, current),
};

export function createCoreFacade(getApi: () => Promise<CoreApi>): CoreFacade {
  const facade: Record<string, unknown> = {};
  for (const name of Object.keys(METHODS) as (keyof TableMethods)[]) {
    facade[name] = (...args: unknown[]) =>
      getApi().then((a) => (METHODS[name] as SyncMethod)(a, args));
  }
  // Apply several status-store updates and return the resulting snapshot, in
  // ONE call. Composing the per-op methods would be both slow and, in a way
  // that mattered, wrong: each promise hop is an AWAIT BOUNDARY, so two
  // callers pushing at once could interleave and one caller's paint could
  // read a snapshot torn between two writers. The store is meant to be the
  // single source of truth; a torn snapshot is the opposite of that. Every
  // setter in the Go core is synchronous and returns void — resolving once
  // and applying the whole batch without yielding makes the mutations atomic
  // with respect to each other AND to the snapshot read that follows. Falls
  // back to the per-op path if the core is not ready yet (it just pays the
  // old cost).
  facade["statusBatch"] = (ops: StatusOp[]): Promise<StatusBarData> =>
    getApi().then((a) => {
      applyStatusOps(a, ops);
      return JSON.parse(a.statusSnapshot());
    });
  return facade as unknown as CoreFacade;
}
