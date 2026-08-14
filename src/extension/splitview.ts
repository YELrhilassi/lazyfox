// The custom split-view page: renders the panes (from the URL hash config) as
// iframes side by side, separated by 1px draggable dividers. This is the
// fallback for Firefox without the native split view (the native view is the
// primary path; stacked/vertical splits were removed). The chrome helper owns
// the status bar and the leader keys on this page, so the only page-side
// responsibilities are the panes, focus switching (driven by the background
// over runtime messaging) and pane navigation.

import { parseSplitUrl, SPLIT_HASH_PREFIX, splitPayload } from "../shared/split";
import type { SplitView } from "../shared/types";

(function () {
  "use strict";

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

  function renderPanes(): void {
    panesEl.textContent = "";
    iframes.length = 0;
    paneEls.length = 0;
    if (!cfg) return;
    cfg.panes.forEach((p, i) => {
      const pane = document.createElement("div");
      pane.className = "pane" + (i === activePane() ? " active" : "");
      const iframe = document.createElement("iframe");
      iframe.setAttribute("data-lf-split-pane", String(i));
      // Assign src while the iframe is still detached, then append: Firefox
      // navigates the iframe from this initial src, whereas assigning src
      // after insertion can leave the frame stuck on about:blank.
      iframe.src = p.url || "about:blank";
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
    persist();
  }

  function navigateActive(url: string): void {
    if (!cfg) return;
    const i = activePane();
    cfg.panes[i]!.url = url;
    cfg.panes[i]!.title = url;
    iframes[i]!.src = url;
    persist();
  }

  // Draggable divider: adjust the flex-basis of the pane left of the divider.
  function startDrag(ev: MouseEvent, i: number): void {
    ev.preventDefault();
    const containerRect = panesEl.getBoundingClientRect();
    const move = (e: MouseEvent) => {
      if (!cfg || !paneEls[i]) return;
      const total = containerRect.width;
      const pos = e.clientX - containerRect.left;
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

  // Background-driven messages: pane focus (leader ;[ / ;] from the chrome
  // helper) and pane navigation (leader ;o routed to the active pane).
  browser.runtime.onMessage.addListener(
    (msg: { action?: string; splitId?: string; dir?: number; url?: string }) => {
      if (!msg || !cfg) return undefined;
      if (myId && msg.splitId && msg.splitId !== myId) return undefined;
      if (msg.action === "lfSplitFocus") {
        const dir = msg.dir || 1;
        focusPane(activePane() + dir);
        return Promise.resolve({ ok: true });
      }
      if (msg.action === "lfSplitNavigate" && msg.url) {
        navigateActive(msg.url);
        return Promise.resolve({ ok: true });
      }
      return undefined;
    }
  );

  // Direct leader-key fallback (in case the chrome helper is absent and no
  // content script runs here): `;` arms a one-shot leader, then `[`/`]` cycle
  // panes and `\` closes the view.
  let leaderPending = false;
  function runLeader(k: string): void {
    if (k === "[") focusPane(activePane() - 1);
    else if (k === "]") focusPane(activePane() + 1);
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
      if (e.key === ";") {
        e.preventDefault();
        e.stopPropagation();
        leaderPending = true;
      }
    },
    true
  );

  // Single render only: the script runs at the end of <body>, so the DOM is
  // ready. A second render on window.load would destroy the iframes mid-
  // navigation (cancelling their loads) and recreate them.
  renderPanes();
})();
