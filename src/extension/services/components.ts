// Component inventory + diagnostics page plumbing.
//
// componentsInfo is the data behind the options page's Components panel: each
// Lazyfox piece (extension, Go wasm core, native host, chrome helper, content
// bridge) is versioned independently, so the report shows all of them rather
// than a single number.
//
// The diagnostics page functions own the "which tab do we report on?" rule:
// the diagnostics page is itself an extension tab, so "the active tab" is
// usually the diagnostics page — which has no content script. The most recent
// REAL web page tab is tracked instead, and the report falls back to it.

import { core } from "../../shared/core";
import type { PageReport } from "../../shared/types";
import { hostInfo } from "../host";
import { readKey, vString } from "../store";
import { getActiveTab, isCommandCenter } from "../tabs";

export async function componentsInfo(): Promise<{
  extension: string;
  wasm: string;
  nativeHost: string | null;
  nativeProtocol: string | null;
  chromeHelper: string | null;
  bridge: "ok" | "missing" | null;
}> {
  const [ext, wasm, host] = await Promise.all([
    Promise.resolve(browser.runtime.getManifest().version),
    core.version().catch(() => "?"),
    hostInfo().catch(() => null),
  ]);
  const stored = await readKey("chromeHelperVersion", vString, "");
  const bridge = await readKey("lfBridge", vString, "");
  return {
    extension: ext,
    wasm,
    nativeHost: host && host.version ? String(host.version) : null,
    nativeProtocol: host && host.protocol ? String(host.protocol) : null,
    chromeHelper: stored || null,
    bridge: bridge === "1" ? "ok" : bridge === "0" ? "missing" : null,
  };
}

// Shared tab-reuse rule for ;I (setup) and ;T (diagnostics): from the command
// center the tab is replaced in place so a second extension tab never stacks;
// from a real page a fresh tab opens (replacing the user's page would lose it).
function openExtensionPageInActiveOrNewTab(page: string): Promise<{ ok: boolean }> {
  const url = browser.runtime.getURL(page);
  return getActiveTab()
    .then((t) => {
      if (t && t.id && isCommandCenter(t)) {
        return browser.tabs.update(t.id, { url, active: true });
      }
      return browser.tabs.create({ url, active: true });
    })
    .then(() => ({ ok: true }))
    .catch(() => ({ ok: false, error: "tab failed" } as { ok: boolean }));
}

export function openSetupTab(): Promise<{ ok: boolean }> {
  return openExtensionPageInActiveOrNewTab("setup.html");
}

export function openDiagnosticsTab(): Promise<{ ok: boolean }> {
  return openExtensionPageInActiveOrNewTab("diagnostics.html");
}

const EXT_BASE = browser.runtime.getURL("");
let lastPageTabId: number | null = null;

function isWebPageTab(t: any): boolean {
  const url = (t && t.url) || "";
  if (!url) return false;
  if (url.indexOf(EXT_BASE) === 0) return false; // extension UI page
  if (url.indexOf("relay.html") !== -1 || url.indexOf("splitpanel.html") !== -1) return false;
  // about:/error/restricted pages are real answers too (they report null), so
  // they count as page tabs — the diagnostics page then says WHY.
  return true;
}

export function watchPageTabs(): void {
  browser.tabs.onActivated.addListener((info: any) => {
    browser.tabs
      .get(info.tabId)
      .then((t: any) => {
        if (isWebPageTab(t)) lastPageTabId = info.tabId;
      })
      .catch(() => {});
  });
}

// The live page report. With no tabId it reports the active tab, or the last
// real page tab; a tabId targets any specific tab. Returns { report: null }
// when the tab has no content script at all, which is itself the most useful
// diagnostic answer on about:/error/restricted/extension pages.
export async function pageReport(
  data?: { tabId?: number }
): Promise<{ report: PageReport | null; tabId: number | null }> {
  const want = data && typeof data.tabId === "number" ? data.tabId : null;
  try {
    const active = await getActiveTab();
    let t: any = null;
    if (want != null) {
      t = await browser.tabs.get(want).catch(() => null);
    } else if (active && isWebPageTab(active)) {
      t = active;
    } else if (lastPageTabId != null) {
      t = await browser.tabs.get(lastPageTabId).catch(() => null);
    }
    if (!t || !t.id) return { report: null, tabId: want };
    try {
      const res = await browser.tabs.sendMessage(t.id, { action: "pageReport" });
      return { report: ((res && res.report) || null) as PageReport | null, tabId: t.id };
    } catch {
      return { report: null, tabId: t.id };
    }
  } catch {
    return { report: null, tabId: want };
  }
}

// Every tab in the current window, in strip order, for the diagnostics tab
// picker. Deliberately unfiltered: diagnosing an about:/error/extension page
// is exactly the case the picker exists for.
export async function diagnoseTabs(): Promise<{
  tabs: { id: number; title: string; url: string; active: boolean }[];
}> {
  try {
    const tabs = await browser.tabs.query({ currentWindow: true });
    return {
      tabs: (tabs || []).map((t: any) => ({
        id: t.id,
        title: t.title || t.url || "about:blank",
        url: t.url || "",
        active: !!t.active,
      })),
    };
  } catch {
    return { tabs: [] };
  }
}
