// The native-split companion pane. When the chrome helper splits a tab it
// drops this page into the new pane instead of about:blank. It does exactly
// one job well: type a search/URL to navigate the pane, or hit a digit (or
// click) to move that tab into the current split view.

import { send } from "../shared/protocol";

interface SplitTab {
  index: number;
  id: number;
  url: string;
  title: string;
  active: boolean;
  inSplit: boolean;
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

  function render(): void {
    if (!tabs.length) {
      list.innerHTML = "<li class='empty'>No other tabs to move into this split.</li>";
      return;
    }
    // Show every real tab (the background already skips splitpanel / #lfc=
    // UI tabs), so the list is never empty when the window has tabs. Tabs
    // already in this split are dimmed and disabled; the rest are movable
    // targets whose number matches ;+N.
    list.innerHTML = tabs
      .map(
        (t) =>
          "<li data-index='" +
          t.index +
          "' class='" +
          (t.inSplit ? "insplit" : "") +
          "'><span class='kbd'>" +
          t.index +
          "</span><span class='txt'><span class='t'></span><span class='s'></span></span><span class='st'></span></li>"
      )
      .join("");
    for (const t of tabs) {
      const li = list.querySelector<HTMLElement>("[data-index='" + t.index + "']");
      if (!li) continue;
      (li.querySelector(".t") as HTMLElement).textContent = t.title || t.url || "(untitled)";
      (li.querySelector(".s") as HTMLElement).textContent = t.url || "";
      const st = li.querySelector(".st") as HTMLElement;
      st.textContent = t.inSplit ? "\u00B7 in split" : "";
    }
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
    const a = document.activeElement;
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
