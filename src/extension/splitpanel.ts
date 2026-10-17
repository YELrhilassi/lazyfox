// The native-split companion pane. When the chrome helper splits a tab it
// drops this page into the new pane instead of about:blank. It does exactly
// one job well: type a search/URL to navigate the pane, or hit a digit (or
// click) to move that tab into the current split view.

import { esc } from "../shared/dom";
import { send } from "../shared/protocol";

interface SplitTab {
  index: number;
  id: number;
  url: string;
  title: string;
  active: boolean;
  inSplit: boolean;
  favIconUrl?: string;
}

/**
 * `example.com/docs` — the part of a URL that identifies a page to a human.
 *
 * The panel used to print `id 123 \u00B7 https://\u2026`, and the id was the whole
 * problem: it is an implementation number the user has never seen anywhere else,
 * printed beside a URL that was long enough to be cut off. What identifies a tab
 * is its title and its site, which is what the tab strip shows and what the
 * list shows now.
 */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return (u.host + path).slice(0, 120);
  } catch {
    return url;
  }
}

(function () {
  "use strict";

  const input = document.getElementById("input") as HTMLInputElement;
  const list = document.getElementById("tabs") as HTMLUListElement;

  let tabs: SplitTab[] = [];

  function looksLikeUrl(s: string): boolean {
    if (/^(https?:\/\/|about:|moz-extension:|file:)/i.test(s)) return true;
    return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) && !/\s/.test(s);
  }

  function toUrl(s: string): string {
    return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s;
  }

  /**
   * The list of tabs you can put in this pane.
   *
   * MINIMAL, and that is a design decision rather than a lack of one: a tab's
   * title, its site, its number, its icon. No ids, no full URLs, no "already in
   * split" rows interleaved with the ones you can actually pick — the tabs that
   * are already here are simply not choices, and listing them as disabled rows
   * made the list longer to say the same thing. What remains is exactly what the
   * user needs to recognise the tab they meant, which is the whole reason this
   * pane exists: nobody should have to remember a number to move a tab.
   */
  function render(): void {
    const movable = tabs.filter((t) => !t.inSplit);
    if (!movable.length) {
      list.innerHTML =
        "<li class='empty'>No other tabs to move into this split.</li>";
      return;
    }
    list.innerHTML = movable
      .map((t) => {
        const title = esc(t.title || t.url || "(untitled)");
        const sub = esc(shortUrl(t.url || ""));
        const fav = t.favIconUrl
          ? "<img class='fav' src='" + esc(t.favIconUrl) + "' alt=''>"
          : "<span class='fav none'></span>";
        return (
          "<li data-index='" +
          t.index +
          "' title='" +
          esc(t.url || "") +
          "'>" +
          "<span class='kbd'>" +
          t.index +
          "</span>" +
          fav +
          "<span class='txt'><span class='t'>" +
          title +
          "</span><span class='s'>" +
          sub +
          "</span></span>" +
          (t.active ? "<span class='dot'></span>" : "") +
          "<span class='go'>\u21B5</span>" +
          "</li>"
        );
      })
      .join("");
  }

  async function refresh(): Promise<void> {
    const r = await send("splitPanelTabs");
    if (r && r.tabs) {
      tabs = r.tabs;
      render();
    }
  }

  function move(index: number): void {
    const t = tabs.find((x) => x.index === index);
    if (!t || t.inSplit) return; // already in this split — nothing to do
    void send("moveTabToSplit", { index: index });
  }

  function submit(): void {
    const v = input.value.trim();
    if (!v) return;
    if (looksLikeUrl(v)) void send("openUrl", { url: toUrl(v), newTab: false });
    else void send("searchInPlace", { query: v });
    input.value = "";
  }

  function typing(): boolean {
    // Pierces open shadow roots: custom-element inputs (Reddit's
    // <faceplate-search-input>, ...) host their real field in shadow DOM and
    // only the host appears as document.activeElement.
    let a = document.activeElement as Element | null;
    let depth = 0;
    while (a && depth < 10) {
      const sr = (a as HTMLElement).shadowRoot;
      if (!sr || sr.mode !== "open") break;
      const ae = sr.activeElement as Element | null;
      if (!ae) break;
      a = ae;
      depth++;
    }
    if (!a) return false;
    const tag = a.tagName || "";
    return tag === "INPUT" || tag === "TEXTAREA" || !!(a as HTMLElement).isContentEditable;
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      input.value = "";
      input.blur();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || typing()) return;
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      move(Number(e.key));
      return;
    }
    if (e.key === "i") {
      e.preventDefault();
      input.focus();
    }
  });

  list.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("[data-index]");
    if (li) move(Number(li.getAttribute("data-index")));
  });

  // Refresh the tab list whenever the page regains visibility/focus AND live
  // on every tab change AND on a short poll, so a tab opened/closed/moved
  // elsewhere appears (or disappears) in the list immediately — a stale list
  // is exactly the "I can't see the tabs" symptom.
  window.addEventListener("focus", () => void refresh());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  try {
    browser.tabs.onCreated.addListener(() => void refresh());
    browser.tabs.onRemoved.addListener(() => void refresh());
    browser.tabs.onUpdated.addListener(() => void refresh());
    browser.tabs.onActivated.addListener(() => void refresh());
  } catch (e) {
    // extension page without tabs permission — ignore
  }
  setInterval(() => void refresh(), 1500);

  void refresh();
})();
