// THE ADD-ONS PAGE: everything installed, controlled from one quiet list.
//
// Deliberately NOT an installer. The WebExtension management API can install
// nothing here, and this page offers no install surface — it exists to turn
// what is already there on and off, open what is already there's settings, and
// remove what is already there. Firefox's own about:addons remains one link
// away for anything this page does not show.
//
// The state shown is Firefox's, never a cache: every render re-reads
// management.getAll(). An add-on's enabled flag also changes from outside this
// page (a crash, another tab, Firefox's own UI), so the page subscribes to the
// management events and re-reads rather than mutating its own copy.

import { esc } from "../shared/dom";

interface AddonInfo {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  enabled?: boolean;
  type?: string;
  optionsUrl?: string;
  icons?: { size?: number; url?: string }[] | Record<string, string>;
  isSelf?: boolean;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

let addons: AddonInfo[] = [];
let shown: AddonInfo[] = [];
let sel = 0;
let filter = "";

/* --------------------------------------------------------------- rendering */

function iconOf(info: AddonInfo): string {
  let url = "";
  try {
    const icons = info.icons;
    if (Array.isArray(icons)) {
      // The largest icon Firefox offers: a 16px one in a 28px slot is the
      // fuzzy pixel every add-ons list has.
      const best = icons
        .filter((i) => i && i.url)
        .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
      if (best) url = String(best.url);
    } else if (icons && typeof icons === "object") {
      const best = Object.keys(icons)
        .sort((a, b) => Number(b) - Number(a))
        .map((k) => icons[k])[0];
      if (best) url = String(best);
    }
  } catch {
    url = "";
  }
  if (url) return `<img src="${esc(url)}" alt="">`;
  const glyph = info.type === "theme" ? "\u{1F3A8}" : info.type === "dictionary" ? "\u{1F4D6}" : "\u{1F9E9}";
  return `<span class="glyph">${glyph}</span>`;
}

function typeTag(info: AddonInfo): string {
  if (info.isSelf) return `<span class="tag">this add-on</span>`;
  if (info.type === "theme") return `<span class="tag">theme</span>`;
  if (info.type === "dictionary") return `<span class="tag">dictionary</span>`;
  return "";
}

function rowHtml(info: AddonInfo, index: number): string {
  const off = info.enabled === false;
  const isSelf = !!info.isSelf;
  const toggleLabel = isSelf ? "" : off ? "Enable" : "Disable";
  return `
    <li class="row${off ? " off" : ""}${index === sel ? " sel" : ""}" data-i="${index}" data-id="${esc(info.id)}">
      <span class="icon">${iconOf(info)}</span>
      <span class="who">
        <span class="name">${esc(info.name || info.id)}
          ${info.version ? `<span class="ver">${esc(info.version)}</span>` : ""}
          ${typeTag(info)}
        </span>
        ${info.description ? `<span class="desc">${esc(info.description)}</span>` : ""}
      </span>
      <span class="actions">
        ${isSelf ? "" : `<span class="switch" role="presentation"></span>`}
        ${isSelf ? "" : `<button data-act="toggle" data-id="${esc(info.id)}">${toggleLabel}</button>`}
        ${info.optionsUrl ? `<button data-act="options" data-id="${esc(info.id)}">Settings</button>` : ""}
        ${isSelf ? "" : `<button class="danger" data-act="remove" data-id="${esc(info.id)}">Remove</button>`}
      </span>
    </li>`;
}

function render(): void {
  const ql = filter.trim().toLowerCase();
  shown = ql
    ? addons.filter((a) =>
        ((a.name || "") + " " + (a.description || "") + " " + a.id).toLowerCase().indexOf(ql) !== -1
      )
    : addons.slice();
  if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
  if (sel < 0) sel = 0;
  const list = $("list");
  list.innerHTML = shown.map((a, i) => rowHtml(a, i)).join("");
  $("empty").hidden = shown.length > 0 || addons.length === 0;
  const enabled = addons.filter((a) => a.enabled !== false).length;
  $("count").textContent = addons.length
    ? `${shown.length}/${addons.length} shown \u00b7 ${enabled} on \u00b7 ${addons.length - enabled} off`
    : "";
  const selRow = list.querySelector(".row.sel") as HTMLElement | null;
  if (selRow && typeof selRow.scrollIntoView === "function") {
    try {
      selRow.scrollIntoView({ block: "nearest" });
    } catch {
      // a row scrolled away is not a reason to stop rendering
    }
  }
}

function fail(what: string, e: unknown): void {
  const el = $("error");
  el.hidden = false;
  el.textContent = what + ": " + String((e && (e as Error).message) || e);
}

/* ----------------------------------------------------------------- actions */

async function refresh(): Promise<void> {
  try {
    const all = (await browser.management.getAll()) as AddonInfo[];
    let selfId = "";
    try {
      selfId = String((await browser.management.getSelf()).id || "");
    } catch {
      selfId = "";
    }
    addons = (all || [])
      .filter((a) => a && a.id)
      .map((a) => ({ ...a, isSelf: a.id === selfId }))
      // Alphabetical, case-insensitively: the page is a list to scan, not a
      // feed. Firefox's own manager orders by install date, which is a fact the
      // user cannot see anywhere on this page.
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { sensitivity: "base" }));
    $("error").hidden = true;
    render();
  } catch (e) {
    fail("could not read the add-ons list", e);
  }
}

function find(id: string): AddonInfo | undefined {
  return addons.find((a) => a.id === id);
}

async function toggle(id: string): Promise<void> {
  const info = find(id);
  if (!info || info.isSelf) return;
  try {
    await browser.management.setEnabled(id, info.enabled === false);
    await refresh();
  } catch (e) {
    fail("could not " + (info.enabled === false ? "enable" : "disable") + " " + (info.name || id), e);
  }
}

async function remove(id: string): Promise<void> {
  const info = find(id);
  if (!info || info.isSelf) return;
  try {
    // Firefox's own confirmation is the one that names what is about to be
    // deleted; a second dialog of ours would only be a dialog on a dialog.
    await browser.management.uninstall(id, { showConfirmDialog: true });
    await refresh();
  } catch (e) {
    fail("could not remove " + (info.name || id), e);
  }
}

function openOptions(id: string): void {
  const info = find(id);
  if (!info || !info.optionsUrl) return;
  // A new tab, not `browser.runtime.openOptionsPage`: that only ever opens
  // LAZYFOX's options, and this row can belong to any add-on.
  void browser.tabs.create({ url: info.optionsUrl, active: true }).catch((e: unknown) => {
    fail("could not open the settings", e);
  });
}

/* --------------------------------------------------------------- keyboard */

function select(next: number): void {
  if (!shown.length) return;
  const n = Math.max(0, Math.min(shown.length - 1, next));
  if (n === sel) return;
  sel = n;
  const list = $("list");
  for (const row of Array.from(list.querySelectorAll(".row")) as HTMLElement[]) {
    row.classList.toggle("sel", Number(row.dataset.i) === sel);
  }
  const selRow = list.querySelector(".row.sel") as HTMLElement | null;
  if (selRow) {
    try {
      selRow.scrollIntoView({ block: "nearest" });
    } catch {
      // ignore
    }
  }
}

function current(): AddonInfo | undefined {
  return shown[sel];
}

function onKey(e: KeyboardEvent): void {
  const input = $("filter") as HTMLInputElement;
  const inFilter = document.activeElement === input;
  if (e.key === "Escape") {
    if (inFilter && filter) {
      input.value = "";
      filter = "";
      render();
    } else if (inFilter) {
      input.blur();
    }
    e.preventDefault();
    return;
  }
  if (e.key === "/" && !inFilter) {
    input.focus();
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowDown" || (e.key === "Tab" && inFilter)) {
    if (inFilter) input.blur();
    select(sel + 1);
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowUp") {
    if (inFilter && !shown.length) return;
    if (inFilter) input.blur();
    select(sel - 1);
    e.preventDefault();
    return;
  }
  const info = current();
  if (e.key === "Enter" || e.key === " ") {
    if (info) void toggle(info.id);
    e.preventDefault();
    return;
  }
  if (e.key === "o" && info && info.optionsUrl) {
    openOptions(info.id);
    e.preventDefault();
    return;
  }
  if (e.key === "u" && info && !info.isSelf) {
    void remove(info.id);
    e.preventDefault();
    return;
  }
  if (e.key === "r") {
    void refresh();
    e.preventDefault();
  }
}

/* -------------------------------------------------------------------- boot */

(function () {
  "use strict";

  const input = $("filter") as HTMLInputElement;
  input.addEventListener("input", () => {
    filter = input.value;
    render();
  });

  $("list").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest(".row") as HTMLElement | null;
    if (row && typeof row.dataset.i === "string") {
      select(Number(row.dataset.i));
    }
    const btn = target.closest("button[data-act]") as HTMLElement | null;
    if (!btn) return;
    const id = btn.dataset.id || "";
    const act = btn.dataset.act;
    if (act === "toggle") void toggle(id);
    else if (act === "options") openOptions(id);
    else if (act === "remove") void remove(id);
  });

  document.addEventListener("keydown", onKey);

  // Firefox owns the truth; every event that can change it re-reads. Installing
  // through Firefox's own UI is exactly such an event — the list must not go
  // stale just because this page never installs anything.
  try {
    browser.management.onEnabled.addListener(() => void refresh());
    browser.management.onDisabled.addListener(() => void refresh());
    browser.management.onInstalled.addListener(() => void refresh());
    browser.management.onUninstalled.addListener(() => void refresh());
  } catch {
    // an older build without one of the events: the r key and a reload still work
  }

  void refresh();
})();
