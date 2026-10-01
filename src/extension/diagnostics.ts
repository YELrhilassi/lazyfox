// Diagnostics & performance page script.
//
// This is the "special page": everything Lazyfox can see about the page it is
// running on, why detection succeeded or failed, how much the page and the
// browser are costing, and the page-cache controls. Nothing here mutates the
// page — the only side effect is the cache policy, and only when Apply is
// pressed.
//
// The page asks a tab's content script for a live report through the
// background. It can diagnose ANY tab (the tab picker), defaulting to the last
// real page tab. A null report is itself the answer (about:/error/restricted
// pages have no content script), which the UI states plainly instead of
// pretending the page is broken.

import { send } from "../shared/protocol";
import type { CacheMode, CacheScope, CacheState, PageReport } from "../shared/types";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/* ------------------------------------------------------------------ rows */

type Cls = "" | "ok" | "bad" | "warn";

function rows(host: HTMLElement, items: Array<[string, string, Cls?, boolean?]>): void {
  host.textContent = "";
  for (const [k, v, cls, mono] of items) {
    const row = document.createElement("div");
    row.className = "row";
    const kk = document.createElement("div");
    kk.className = "k";
    kk.textContent = k;
    const vv = document.createElement("div");
    vv.className = "v" + (cls ? " " + cls : "") + (mono ? " mono" : "");
    vv.textContent = v;
    row.appendChild(kk);
    row.appendChild(vv);
    host.appendChild(row);
  }
}

function fmtKB(kb: number): string {
  if (kb < 1024) return kb + " KB";
  return (Math.round((kb / 1024) * 10) / 10) + " MB";
}

/* ---------------------------------------------------------- installation */

async function renderInstall(): Promise<{ components: boolean }> {
  const host = $("installRows");
  const c = await send("components").catch(() => null);
  const items: Array<[string, string, Cls?, boolean?]> = [];
  items.push([
    "Extension",
    c && c.extension ? c.extension : "unknown",
    c ? "ok" : "bad",
    true,
  ]);
  items.push(["Go wasm core", c && c.wasm ? c.wasm : "unknown", c && c.wasm && c.wasm !== "?" ? "ok" : "warn", true]);
  items.push([
    "Native host",
    c && c.nativeHost ? c.nativeHost + (c.nativeProtocol ? " (proto " + c.nativeProtocol + ")" : "") : "not installed",
    c && c.nativeHost ? "ok" : "",
    true,
  ]);
  items.push([
    "Window chrome",
    c && c.chromeHelper ? c.chromeHelper : "not installed — scroll regions, per-tab cache and splits need it",
    c && c.chromeHelper ? "ok" : "warn",
    true,
  ]);
  // Whether the helper reached the CONTENT process. This is separate from the
  // row above and earns its own line: the helper can be installed, announce
  // itself, and still fail to register its window actor — in which case
  // chrome-only features work, the bar works, and the page is simply dead to
  // the keyboard. That failure presents as "keys do nothing here", so it has
  // to be visible somewhere or it is indistinguishable from a broken page.
  items.push([
    "Content bridge",
    c && c.bridge === "ok"
      ? "actor registered in the content process"
      : c && c.bridge === "missing"
        ? "the window actor did not register — leader keys are dead in page content"
        : "not reported yet",
    c && c.bridge === "ok" ? "ok" : c && c.bridge === "missing" ? "bad" : "",
    true,
  ]);
  rows(host, items);
  return { components: !!c };
}

/* ----------------------------------------------------------- page report */

function renderPage(r: PageReport | null, note?: string): void {
  const host = $("pageRows");
  const probeTable = $("probeTable").querySelector("tbody")!;
  const probeWrap = $("probeWrap");
  probeTable.textContent = "";

  if (!r) {
    rows(host, [
      ["Active page", note || "no content script on this page", "warn"],
      ["Why", "about:/error/restricted pages and extension pages have no content script, so hint/scroll reporting is unavailable here — this is expected, not a failure.", ""],
    ]);
    probeWrap.style.display = "none";
    return;
  }

  rows(host, [
    ["URL", r.url || "(empty)", "", true],
    ["Title", r.title || "(untitled)", ""],
    ["Ready state", r.readyState || "?", r.readyState === "complete" ? "ok" : "warn"],
    ["Scroll target", r.scroll.target + (r.scroll.custom ? " (custom scroller)" : " (document)"), r.scroll.custom ? "warn" : "ok"],
    ["Scroll regions", r.scroll.regions.length ? r.scroll.regions.map((g) => g.label + " [" + g.clientHeight + "/" + g.scrollHeight + "]").join(", ") : "none beyond the document", ""],
    ["Active editor", r.editor, r.editor === "none" ? "ok" : "warn"],
    [
      "Hint candidates",
      String(r.hints.candidates) +
        " found · " + r.hints.hinted + " hinted · rejected: " +
        r.hints.rejected.hidden + " hidden, " +
        r.hints.rejected.covered + " covered, " +
        r.hints.rejected.duplicate + " duplicate",
      r.hints.hinted ? "ok" : "warn",
    ],
    ["Shadow roots pierced", String(r.hints.shadowRoots), r.hints.shadowRoots ? "ok" : ""],
    ["Pointer-only controls", String(r.hints.pointerControls), r.hints.pointerControls ? "warn" : ""],
  ]);

  probeWrap.style.display = r.hints.probes.length ? "" : "none";
  for (let i = 0; i < r.hints.probes.length; i++) {
    const p = r.hints.probes[i]!;
    const tr = document.createElement("tr");
    const cells: Array<[string, string]> = [
      [String(i + 1), ""],
      [p.tag, ""],
      [p.role, ""],
      [p.name, "name"],
      [p.href ? "yes" : "", "yes"],
      [p.cursor, ""],
      [p.reachable ? "yes" : "no", p.reachable ? "yes" : "no"],
      [p.reason, "why"],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      td.textContent = text;
      td.title = text;
      tr.appendChild(td);
    }
    probeTable.appendChild(tr);
  }
}

/* ------------------------------------------------------- perf & resources */

function renderPerf(r: PageReport | null): void {
  const host = $("perfRows");
  const bar = $("fpsBar");
  const note = $("fpsNote");
  if (!r) {
    rows(host, [["Efficiency", "unavailable without a content script on this page", "warn"]]);
    bar.style.width = "0%";
    note.textContent = "";
    return;
  }
  const p = r.perf;
  const hit = p.resources ? Math.round((p.cachedResources / p.resources) * 100) : 0;
  rows(host, [
    ["DOM nodes", String(p.domNodes), p.domNodes > 6000 ? "warn" : "ok"],
    ["Resources", p.resources + " (" + p.cachedResources + " from cache, " + p.networkResources + " over the network)", ""],
    ["Cache hit rate", p.resources ? hit + "%" : "n/a", hit >= 60 ? "ok" : p.resources ? "warn" : ""],
    ["Transferred", fmtKB(p.transferKB), ""],
    ["JS heap", p.heapMB == null ? "not exposed by this build" : p.heapMB + " MB", p.heapMB != null && p.heapMB > 300 ? "warn" : ""],
    ["Load time", p.loadMs >= 0 ? p.loadMs + " ms" : "n/a", ""],
    ["DOMContentLoaded", p.domContentLoadedMs >= 0 ? p.domContentLoadedMs + " ms" : "n/a", ""],
  ]);
  if (p.fps < 0) {
    bar.style.width = "0%";
    note.textContent = "Frame rate unavailable (page hidden or never painted).";
  } else {
    const pct = Math.max(0, Math.min(100, (p.fps / 60) * 100));
    bar.style.width = pct + "%";
    note.textContent = p.fps + " fps measured over ~400 ms." + (p.fps < 30 ? " Below 30 fps — the page is janky." : "");
  }
}

/* ------------------------------------------------------------- page cache */

let lastCache: CacheState | null = null;

function renderCache(s: CacheState, note?: string): void {
  lastCache = s;
  const host = $("cacheRows");
  const desc = $("cacheDesc");
  const noteEl = $("cacheNote");
  ($("cacheScope") as HTMLSelectElement).value = s.scope;
  ($("cacheMode") as HTMLSelectElement).value = s.mode;
  const scopeLabel = s.scope === "global" ? "Everywhere" : s.scope === "session" ? "This session" : "This tab";
  desc.textContent = s.note;
  rows(host, [
    ["In force", scopeLabel + " · " + (s.mode === "normal" ? "Firefox default" : s.mode === "fresh" ? "revalidate every load" : "no cached copies"), s.mode === "normal" ? "ok" : "warn"],
    ["Global switch", s.globalSupported ? "available" : "not exposed by this Firefox build", s.globalSupported ? "ok" : "warn"],
    ["Per-tab enforcement", s.chromeSupported ? "chrome layer installed" : "needs the window chrome (installer)", s.chromeSupported ? "ok" : "warn"],
    ["Covered tabs", s.scope === "global" ? "everywhere" : s.tabIds.length ? s.tabIds.join(", ") : "none", ""],
  ]);
  const apply = $("cacheApply") as HTMLButtonElement;
  apply.disabled = s.scope !== "global" && !s.chromeSupported;
  if (note) noteEl.textContent = note;
}

async function loadCache(): Promise<void> {
  const s = await send("cacheState").catch(() => null);
  if (s) renderCache(s);
}

/* ------------------------------------------------------------------ loop */

let live = true;
let timer: number | null = null;
let busy = false;
// null = automatic (the background picks the last real page tab).
let selectedTabId: number | null = null;

// Populate the tab picker from every tab in the window. The selection is kept
// across refreshes when the tab still exists; otherwise it falls back to Auto.
async function renderTabPicker(): Promise<void> {
  const sel = $("tabPick") as HTMLSelectElement;
  const res = await send("diagnoseTabs").catch(() => null);
  const tabs = res ? res.tabs : [];
  if (selectedTabId != null && !tabs.some((t) => t.id === selectedTabId)) {
    selectedTabId = null;
  }
  const prev = sel.value;
  sel.textContent = "";
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "Auto — the last page I was on";
  sel.appendChild(auto);
  for (const t of tabs) {
    const o = document.createElement("option");
    o.value = String(t.id);
    o.textContent = (t.active ? "● " : "") + (t.title || t.url || "tab " + t.id).slice(0, 90);
    o.title = t.url || "";
    sel.appendChild(o);
  }
  sel.value = selectedTabId != null ? String(selectedTabId) : "auto";
  if (!sel.value) sel.value = prev || "auto";
}

async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const stamp = $("stamp");
    stamp.textContent = "updating…";
    await renderInstall();
    await renderTabPicker();
    const rep = await send("pageReport", selectedTabId != null ? { tabId: selectedTabId } : {}).catch(() => null);
    const r = rep ? rep.report : null;
    renderPage(r);
    renderPerf(r);
    await loadCache();
    stamp.textContent = "updated " + new Date().toLocaleTimeString() + " · live: " + (live ? "on" : "off");
  } finally {
    busy = false;
  }
}

function schedule(): void {
  if (timer != null) window.clearInterval(timer);
  timer = null;
  if (live) timer = window.setInterval(() => void refresh(), 1500);
}

/* ------------------------------------------------------------------- init */

(async () => {
  try {
    const img = document.getElementById("logoImg") as HTMLImageElement;
    img.src = browser.runtime.getURL("lazyfox-logo.svg");
  } catch (e) {
    // ignore — header works without the logo
  }

  ($("live") as HTMLInputElement).addEventListener("change", (e) => {
    live = (e.target as HTMLInputElement).checked;
    schedule();
    void refresh();
  });
  $("refresh").addEventListener("click", () => void refresh());

  ($("tabPick") as HTMLSelectElement).addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    selectedTabId = v && v !== "auto" ? Number(v) : null;
    void refresh();
  });

  $("cacheApply").addEventListener("click", async () => {
    const scope = ($("cacheScope") as HTMLSelectElement).value as CacheScope;
    const mode = ($("cacheMode") as HTMLSelectElement).value as CacheMode;
    const note = $("cacheNote");
    note.textContent = "applying…";
    const res = await send("cacheSet", { scope: scope, mode: mode }).catch(() => null);
    if (!res) {
      note.textContent = "Could not reach the background.";
      return;
    }
    if (!res.ok) {
      note.textContent = res.error || "Could not apply that policy.";
      if (res.state) renderCache(res.state);
      return;
    }
    if (res.state) renderCache(res.state);
    note.textContent = "Applied. " + (lastCache ? lastCache.note : "");
  });

  $("cacheReload").addEventListener("click", async () => {
    const note = $("cacheNote");
    note.textContent = "reloading…";
    const res = await send("hardReload").catch(() => null);
    note.textContent = res && res.ok ? "Reloaded this tab bypassing the cache." : "Could not reload this tab.";
  });

  // The chrome helper cannot see keys typed into this page (extension pages run
  // out of process), so the page provides vim scrolling + `;g` back itself.
  let leaderPending = false;
  let gArmed = false;
  const pageScroll = (dy: number): void => window.scrollBy(0, dy);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (leaderPending) {
        e.preventDefault();
        leaderPending = false;
        if (e.key === "g" || e.key === "G") {
          if (window.history.length > 1) window.history.back();
        }
        return;
      }
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae ? String(ae.tagName).toUpperCase() : "";
      const inField =
        !!ae &&
        (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ae.isContentEditable);
      if (e.key === "Escape") {
        if (inField) {
          e.preventDefault();
          ae!.blur();
        }
        return;
      }
      if (inField || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === ";") {
        e.preventDefault();
        leaderPending = true;
        return;
      }
      if (e.key === "j") { e.preventDefault(); pageScroll(60); return; }
      if (e.key === "k") { e.preventDefault(); pageScroll(-60); return; }
      if (e.key === "d") { e.preventDefault(); pageScroll(Math.max(120, window.innerHeight * 0.5)); return; }
      if (e.key === "u") { e.preventDefault(); pageScroll(-Math.max(120, window.innerHeight * 0.5)); return; }
      if (e.key === "G") { e.preventDefault(); window.scrollTo(0, document.documentElement.scrollHeight); return; }
      if (e.key === "g") {
        e.preventDefault();
        if (gArmed) { gArmed = false; window.scrollTo(0, 0); }
        else { gArmed = true; setTimeout(() => { gArmed = false; }, 600); }
      }
    },
    true
  );

  await refresh();
  schedule();
})();
