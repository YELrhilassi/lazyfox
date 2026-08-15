// The chrome helper's download manager. It is the single owner of the live
// download list: it polls Firefox's Downloads.sys.mjs, maps each entry to the
// shared DownloadEntry shape, and reconciles snapshots through the Go core
// (mergeDownloads keeps the user's "dismissed" flags across polls while
// activeDownloads decides what belongs on the status bar). Actions (open,
// reveal, remove) run against the real Download objects here.
//
// Nothing else should touch Downloads.sys.mjs directly; ops.ts (the popup) and
// main.ts (the status bar) both read from this module so the popup and the bar
// always agree on state.

import { core } from "../shared/core";
import type { DownloadEntry } from "../shared/types";

declare const ChromeUtils: any;

let downloadsModulePromise: Promise<any> | null = null;

function downloadsModule(): Promise<any> {
  if (!downloadsModulePromise) {
    downloadsModulePromise = Promise.resolve(
      ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs").Downloads
    );
  }
  return downloadsModulePromise;
}

// The live merged list, newest first (authoritative for the popup and bar).
let cache: DownloadEntry[] = [];
// Real Download objects by stable key (full target path).
const objs = new Map<string, any>();
// Previous byte counts + timestamps per key, to derive speed across polls.
const prevBytes = new Map<string, number>();
const prevAt = new Map<string, number>();

function stateOf(d: any): string {
  if (d.succeeded) return "complete";
  if (d.error) return "failed";
  if (d.canceled) return "canceled";
  if (d.stopped) return "paused";
  return "in_progress";
}

// Read the live list from Firefox and map it to DownloadEntry. In-progress
// entries are refreshed first so byte counts/progress are current.
async function snapshot(): Promise<DownloadEntry[]> {
  const Downloads = await downloadsModule();
  const list = await Downloads.getList(Downloads.ALL);
  const items = await list.getAll();
  await Promise.all(
    items.map((d: any) => {
      try {
        if (!d.succeeded && !d.error && !d.canceled) return d.refresh();
      } catch (e) {
        // ignore
      }
      return Promise.resolve();
    })
  );
  objs.clear();
  const out: DownloadEntry[] = [];
  for (const d of items) {
    let path = "";
    let url = "";
    let received = 0;
    let total = 0;
    let startTime = 0;
    let endTime = 0;
    try {
      path = (d.target && d.target.path) || "";
      url = (d.source && d.source.url) || "";
      received = d.currentBytes || 0;
      total = d.totalBytes || 0;
      startTime = d.startTime ? new Date(d.startTime).getTime() : 0;
      endTime = d.endTime ? new Date(d.endTime).getTime() : 0;
    } catch (e) {
      // ignore — a partial download may not expose target/source yet
    }
    const key = path || url || "dl:" + out.length;
    if (path) objs.set(key, d);
    const filename =
      (path ? path.split(/[\\/]/).pop() : "") ||
      (url ? url.split("/").pop() : "") ||
      url ||
      "";
    out.push({
      id: key,
      filename: filename,
      path: path,
      url: url,
      state: stateOf(d),
      received: received,
      total: total,
      speed: 0,
      dismissed: false,
      startTime: startTime,
      endTime: endTime,
    });
  }
  out.sort((a, b) => (b.startTime || b.endTime || 0) - (a.startTime || a.endTime || 0));
  return out;
}

// Poll once and reconcile into the live cache (dismissed flags survive).
export async function updateDownloads(): Promise<void> {
  const fresh = await snapshot();
  const now = Date.now();
  for (const d of fresh) {
    const pb = prevBytes.get(d.id);
    const pt = prevAt.get(d.id);
    if (pb != null && pt != null && now > pt) {
      d.speed = Math.max(0, Math.round((d.received - pb) / ((now - pt) / 1000)));
    }
    prevBytes.set(d.id, d.received);
    prevAt.set(d.id, now);
  }
  cache = await core.mergeDownloads(cache, fresh);
}

// The current merged list (no polling). Popup + bar read this.
export function listDownloads(): DownloadEntry[] {
  return cache.slice();
}

// The subset whose progress notification belongs on the status bar.
export async function activeDownloads(): Promise<DownloadEntry[]> {
  return core.activeDownloads(cache);
}

// Dismiss download notification(s) from the status bar (the popup still shows
// them). With no key, all in-progress notifications are dismissed; with a key,
// just that one.
export function dismissDownload(key?: string): void {
  if (key != null) {
    const d = cache.find((x) => x.id === key);
    if (d) d.dismissed = true;
    return;
  }
  for (const d of cache) {
    if (d.state === "in_progress" || d.state === "paused") d.dismissed = true;
  }
}

// Whether any in-progress download notification is currently un-dismissed
// (used by the status bar to decide whether to show a segment).
export function hasActiveNotification(): boolean {
  for (const d of cache) {
    if (!d.dismissed && (d.state === "in_progress" || d.state === "paused")) return true;
  }
  return false;
}

export async function openDownload(key: string): Promise<boolean> {
  const d = objs.get(key);
  if (!d) return false;
  try {
    d.launch();
    return true;
  } catch (e) {
    return false;
  }
}

export async function openDownloadLocation(key: string): Promise<boolean> {
  const d = objs.get(key);
  if (!d) return false;
  try {
    d.show();
    return true;
  } catch (e) {
    return false;
  }
}

export async function removeDownload(key: string): Promise<boolean> {
  const d = objs.get(key);
  if (!d) return false;
  try {
    await d.remove();
    // Drop it from the cache so the popup/bar agree immediately.
    cache = cache.filter((x) => x.id !== key);
    return true;
  } catch (e) {
    return false;
  }
}
