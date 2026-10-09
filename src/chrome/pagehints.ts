// Link hints for chrome-owned pages (about:, error pages) where no content
// script runs. Collects the visible links in the page's real DOM (reachable
// via contentWindow when the page is in-process), labels the first nine with
// 1-9, then captures the next key through the leader's one-shot slot: a digit
// opens that link in the current tab, Esc cancels. Never swallows a key when
// it cannot draw labels, so it can never break normal key handling.

import { digitExpect } from "../shared/leadersignal";
import { toast } from "../shared/overlay";
import type { LeaderController } from "../shared/leader";
import type { ChromeEnv, ChromeWindow } from "./env";

type HintEntry = { href: string; el: any };

export function createChromePageHints(
  env: ChromeEnv,
  win: ChromeWindow,
  leader: () => LeaderController | null
) {
  let entries: HintEntry[] = [];
  let labels: any[] = [];
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    for (const l of labels) {
      try {
        l.remove();
      } catch {
        // ignore
      }
    }
    labels = [];
    entries = [];
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
  }

  function openInSelectedTab(href: string, cw: any): void {
    try {
      const base = cw && cw.document && cw.document.baseURI;
      const url = new (cw ? cw.URL : URL)(href, base).href;
      const b = (win as any).gBrowser.selectedBrowser;
      if (b && typeof b.fixupAndLoadURIString === "function") {
        b.fixupAndLoadURIString(url, {
          triggeringPrincipal: env.services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
    } catch {
      // give up silently
    }
  }

  return {
    clear,
    show(): void {
      clear();
      let cw: any = null;
      let doc: any = null;
      try {
        const b = (win as any).gBrowser.selectedBrowser;
        cw = b && b.contentWindow;
        doc = cw && cw.document;
        if (!doc || !doc.querySelectorAll) return;
        const vwHeight = cw.innerHeight || 600;
        const anchors = Array.from(doc.querySelectorAll("a[href]")) as any[];
        for (const a of anchors) {
          const href = (a.getAttribute("href") || "").trim();
          // Skip pure-fragment anchors and invisible links.
          if (!href || href.charCodeAt(0) === 35 /* # */) continue;
          const r = a.getBoundingClientRect();
          if (!r || r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vwHeight) continue;
          entries.push({ href, el: a });
          if (entries.length >= 9) break;
        }
      } catch {
        return; // page unreachable — no hints (safe no-op)
      }
      if (!entries.length) {
        toast("no links on this page");
        return;
      }
      // Draw the 1-9 labels over each hintable link.
      try {
        const host = doc.body || doc.documentElement;
        entries.forEach((it, i) => {
          const r = it.el.getBoundingClientRect();
          const label = doc.createElement("span");
          label.textContent = String(i + 1);
          label.setAttribute(
            "style",
            "position:fixed;z-index:2147483647;background:#1e1e2e;color:#7aa2f7;" +
              "border:1px solid #414868;border-radius:4px;min-width:16px;height:16px;" +
              "line-height:16px;text-align:center;font:600 11px monospace;" +
              "top:" + (r.top + 2) + "px;left:" + (r.left + 2) + "px;pointer-events:none;"
          );
          host.appendChild(label);
          labels.push(label);
        });
      } catch {
        // Couldn't draw the labels — drop the mode so it never swallows a key.
        clear();
        return;
      }
      const snapshot = entries.map((it) => it.href);
      const l = leader();
      if (!l) return;
      l.armPending((e) => {
        const chose = e.key !== "Escape" ? Number(e.key) : 0;
        clear();
        if (!chose || chose < 1 || chose > snapshot.length) return true;
        const target = snapshot[chose - 1];
        if (target) openInSelectedTab(target, cw);
        return true;
      }, { timeoutMs: 8000, expect: digitExpect(snapshot.length) });
      cleanupTimer = setTimeout(clear, 8000);
    },
  };
}
