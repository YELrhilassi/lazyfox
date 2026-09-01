// The chrome helper's download manager. It polls Firefox's Downloads.sys.mjs
// and hands every fresh snapshot to the Go status store, which OWNS the
// merged cache, the dismissed flags, the seeded history and the speed EMA
// (see core/status.go). This module keeps only what Go cannot: the real
// Download objects needed to run actions (open, reveal, remove, retry) and
// the Firefox-read snapshot itself. The status bar and the downloads popup
// both read the store's snapshot, so they always agree — and there is exactly
// one place the download state lives.

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

// Real Download objects by stable key (full target path), for actions only.
const objs = new Map<string, any>();

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
      if (d.succeeded || d.error || d.canceled) return Promise.resolve();
      // refresh() can reject (the download left the store, or its target was
      // cleaned up). One bad entry must never kill the whole poll — that would
      // freeze the status bar at a stale state forever. Guard each refresh.
      return Promise.resolve()
        .then(() => d.refresh())
        .catch(() => {});
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
    // Path is the stable key (pathless entries fall back to a key anchored on
    // startTime so a shifting index can't make a dismissed flag leak across
    // different downloads between polls).
    const key = path || url || "dl:" + startTime + ":" + out.length;
    if (path) objs.set(key, d);
    const filename =
      (path ? path.split(/[\\\\/]/).pop() : "") ||
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

// Poll once and push the fresh snapshot into the Go store (the single source
// of truth: it merges, carries dismissed flags, seeds history and derives
// the speed EMA). Returns the entry count for the caller, or throws so the
// poller can decide how to degrade.
export async function updateDownloads(): Promise<number> {
  const fresh = await snapshot();
  await core.statusDownloads(fresh);
  return fresh.length;
}

// The merged list (newest first) for the downloads popup, from the store.
export async function listDownloads(): Promise<DownloadEntry[]> {
  return core.downloadsList();
}

// Dismiss download notification(s) from the status bar (the popup still shows
// them). With no key, every bar-visible notification is dismissed; with a
// key, just that one. Dismissal is store state.
export function dismissDownload(key?: string): Promise<void> {
  return core.statusDismiss(key != null ? [key] : []);
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
    return true;
  } catch (e) {
    return false;
  }
}

export async function retryDownload(key: string): Promise<boolean> {
  const d = objs.get(key);
  if (!d) return false;
  try {
    if (d.error && typeof d.retry === "function") {
      // Failed download: Firefox restarts it from its source.
      await d.retry();
      return true;
    }
    if (d.stopped && typeof d.start === "function") {
      // Paused download: resume in place.
      await d.start();
      return true;
    }
    // In-progress or complete — nothing to retry.
    return false;
  } catch (e) {
    return false;
  }
}
