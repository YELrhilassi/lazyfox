// The custom split-view page: renders the panes (from the URL hash config) as
// iframes side by side or stacked, with a slim split bar (pane tabs, a URL
// input to navigate the active pane) and draggable dividers. Pane-focus
// switching is driven by the background over runtime messaging (the leader
// `;[` / `;]` on the chrome helper relays to the background, which broadcasts
// a focus request here).

import { core } from "../shared/core";
import { parseSplitUrl, SPLIT_HASH_PREFIX, splitPayload } from "../shared/split";
import type { SplitView } from "../shared/types";

(function () {
  "use strict";

  const bar = document.getElementById("bar") as HTMLElement;
  const orientEl = document.getElementById("orient") as HTMLElement;
  const tabsEl = document.getElementById("tabs") as HTMLElement;
  const addrInput = document.getElementById("addrInput") as HTMLInputElement;
  const panesEl = document.getElementById("panes") as HTMLElement;

  let cfg: SplitView | null = parseSplitUrl(location.href);
  if (!cfg) {
    document.body.textContent = "invalid split config";
    return;
  }

  const myId = splitPayload(location.href);
  const iframes: HTMLIFrameElement[] = [];
  const paneEls: HTMLElement[] = [];

  function activePane(): number {
    const n = cfg ? cfg.panes.length : 0;
    const a = cfg ? cfg.activePane : 0;
    return n ? Math.min(Math.max(0, a), n - 1) : 0;
  }

  // Persist the current config into the tab URL (hash-only change; no reload)
  // so session capture and the status bar always read the latest layout.
  function persist(): void {
    if (!cfg) return;
    const payload = JSON.stringify({
      id: cfg.id || "",
      o: cfg.orientation,
      p: cfg.panes.map((p) => ({ u: p.url, t: p.title })),
      a: cfg.activePane,
    });
    const b64 = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    try {
      const base = location.href.split("#")[0];
      history.replaceState(null, "", base + "#" + SPLIT_HASH_PREFIX + b64);
    } catch (e) {
      // ignore (older browsers/history quirks)
    }
  }

  function renderTabs(): void {
    tabsEl.textContent = "";
    if (!cfg) return;
    cfg.panes.forEach((p, i) => {
      const tab = document.createElement("span");
      tab.className = "pane-tab" + (i === activePane() ? " on" : "");
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(i + 1);
      const label = document.createElement("span");
      label.textContent = p.title || p.url || "about:blank";
      tab.appendChild(n);
      tab.appendChild(label);
      tab.addEventListener("click", () => focusPane(i));
      tabsEl.appendChild(tab);
    });
  }

  function renderPanes(): void {
    panesEl.textContent = "";
    iframes.length = 0;
    paneEls.length = 0;
    if (!cfg) return;
    panesEl.classList.toggle("vertical", cfg.orientation === "vertical");
    orientEl.textContent = cfg.orientation === "vertical" ? "stacked" : "side-by-side";
    cfg.panes.forEach((p, i) => {
      const pane = document.createElement("div");
      pane.className = "pane" + (i === activePane() ? " active" : "");
      const iframe = document.createElement("iframe");
      iframe.setAttribute("data-lf-split-pane", String(i));
      iframe.src = p.url || "about:blank";
      iframe.addEventListener("load", () => {
        // The parent cannot read cross-origin titles; keep the label stable.
      });
      pane.appendChild(iframe);
      pane.addEventListener("click", () => focusPane(i));
      panesEl.appendChild(pane);
      paneEls.push(pane);
      iframes.push(iframe);

      if (i < cfg.panes.length - 1) {
        const div = document.createElement("div");
        div.className = "divider";
        div.addEventListener("mousedown", (ev) => startDrag(ev, i));
        panesEl.appendChild(div);
      }
    });
    renderTabs();
    addrInput.value = cfg.panes[activePane()] ? cfg.panes[activePane()]!.url : "";
  }

  function focusPane(i: number): void {
    if (!cfg) return;
    const n = cfg.panes.length;
    if (!n) return;
    // Wrap around (tmux-style) so ;[ / ;] cycle through all panes.
    const idx = ((i % n) + n) % n;
    cfg.activePane = idx;
    paneEls.forEach((el, j) => el.classList.toggle("active", j === idx));
    // NOTE: do not move focus into the pane's iframe here. The iframe is
    // cross-origin, so once it has focus the splitview page no longer sees
    // leader keys (and no content script runs inside it). Keep keyboard focus
    // in the split chrome; the user clicks into a pane when they want to type.
    renderTabs();
    addrInput.value = cfg.panes[idx] ? cfg.panes[idx]!.url : "";
    persist();
  }

  // Toggle between side-by-side and stacked without recreating iframes.
  function changeOrientation(orientation: "horizontal" | "vertical"): void {
    if (!cfg) return;
    cfg.orientation = orientation;
    panesEl.classList.toggle("vertical", orientation === "vertical");
    orientEl.textContent = orientation === "vertical" ? "stacked" : "side-by-side";
    persist();
  }

  // Draggable divider: adjust the flex-basis of the pane left of the divider.
  function startDrag(ev: MouseEvent, i: number): void {
    ev.preventDefault();
    const horizontal = cfg && cfg.orientation !== "vertical";
    const containerRect = panesEl.getBoundingClientRect();
    const move = (e: MouseEvent) => {
      if (!cfg || !paneEls[i]) return;
      const total = horizontal ? containerRect.width : containerRect.height;
      const pos = horizontal ? e.clientX - containerRect.left : e.clientY - containerRect.top;
      const pct = Math.max(0.1, Math.min(0.9, pos / total));
      paneEls[i]!.style.flex = pct + " 1 0";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function navigateActive(url: string): void {
    if (!cfg) return;
    const i = activePane();
    cfg.panes[i]!.url = url;
    cfg.panes[i]!.title = url;
    iframes[i]!.src = url;
    renderTabs();
    persist();
  }

  addrInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = addrInput.value.trim();
    if (!v) return;
    void core.normalizeUrl(v).then((u) => {
      navigateActive(u);
      addrInput.blur();
    });
  });

  // Background-driven pane focus (leader `;[` / `;]` from the chrome helper
  // or the content scripts inside panes).
  browser.runtime.onMessage.addListener((msg: { action?: string; splitId?: string; dir?: number }) => {
    if (!msg || msg.action !== "lfSplitFocus") return undefined;
    if (myId && msg.splitId && msg.splitId !== myId) return undefined;
    if (!cfg) return undefined;
    const dir = msg.dir || 1;
    focusPane(activePane() + dir);
    return Promise.resolve({ ok: true });
  });

  // Direct leader-key handling (the split view is an extension page: no content
  // script runs here, and the chrome helper cannot reliably see keys typed into
  // this document). Mirrors optionskeys.ts: `;` arms a one-shot leader, then
  // `[`/`]` cycle panes, `|`/`_` toggle orientation and `\\` closes the view.
  let leaderPending = false;
  function runLeader(k: string): void {
    if (k === "[") focusPane(activePane() - 1);
    else if (k === "]") focusPane(activePane() + 1);
    else if (k === "|") changeOrientation("horizontal");
    else if (k === "_") changeOrientation("vertical");
    else if (k === "\\") {
      void browser.runtime.sendMessage({ action: "sessionUnsplit" }).catch(() => {});
    }
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (leaderPending) {
        e.preventDefault();
        e.stopPropagation();
        leaderPending = false;
        if (e.key === "Escape") return;
        runLeader(e.key);
        return;
      }
      // Let the address input keep normal typing (it has its own Enter handler).
      if (e.target === addrInput) return;
      if (e.key === ";") {
        e.preventDefault();
        e.stopPropagation();
        leaderPending = true;
      }
    },
    true
  );

  window.addEventListener("load", () => {
    renderPanes();
  });

  renderPanes();
  void core.normalizeUrl("").catch(() => {}); // warm the wasm core
  void bar; // keep referenced for clarity
})();
