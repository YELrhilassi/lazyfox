// Link hints for chrome-owned pages (about:, error pages) where no content
// script runs. Collects the visible links in the page's real DOM (reachable
// via contentWindow when the page is in-process), labels the first nine with
// 1-9, then captures the next key through the leader's one-shot slot: a digit
// opens that link in the current tab, Esc cancels. Never swallows a key when
// it cannot draw labels, so it can never break normal key handling.
//
// EVERY "nothing happened" OUTCOME IS SAID OUT LOUD. This engine reads the
// page's own document, so an iframe's contents and an unreachable document are
// both structural blind spots rather than search results — and a blind spot that
// reports "no links" is the defect ("hints doesn't work on a lot more sites"),
// while the same state reported as "I do not look in frames" is an answer the
// user can act on. The content-script side says the same thing about the same
// blind spot, so the two hosts cannot disagree about what `;f` does.

import { digitExpect } from "../shared/leadersignal";
import { hintLabelInlineStyle } from "../shared/hintlabel";
import { uiPalette } from "../shared/theme";
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
  // How many anchors were HINTABLE (in view, non-fragment), so the nine-link cap
  // can be admitted rather than silently dropping everything past the ninth. It
  // counts them all, not just the labelled ones: a page with twelve visible links
  // and nine labels is a page where three links do nothing, and that is exactly
  // the report this number exists to answer.
  let hintableCount = 0;

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

  // How many frames the user can actually SEE on this page. Frames are the one
  // part of the screen this engine cannot reach — its candidate set is the page's
  // own document, and an iframe is a different document with its own — so the
  // count is what turns "no links" into a truthful sentence.
  function visibleFrameCount(doc: any, cw: any): number {
    let n = 0;
    try {
      const frames = doc.querySelectorAll("iframe, frame") as ArrayLike<any>;
      const vh = cw.innerHeight || 600;
      const vw = cw.innerWidth || 800;
      for (let i = 0; i < frames.length; i++) {
        const r = frames[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw) {
          n++;
        }
      }
    } catch {
      // A hostile frame tree must not stop the answer being given.
      return 0;
    }
    return n;
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
        // The document is not readable: an out-of-process page, or a selected
        // browser mid-swap. Silent before, which is indistinguishable from "this
        // page has no links" — and those want opposite responses from the user.
        if (!doc || !doc.querySelectorAll) {
          toast("link hints: this page could not be inspected");
          return;
        }
        const vwHeight = cw.innerHeight || 600;
        const anchors = Array.from(doc.querySelectorAll("a[href]")) as any[];
        hintableCount = 0;
        for (const a of anchors) {
          const href = (a.getAttribute("href") || "").trim();
          // Skip pure-fragment anchors and invisible links.
          if (!href || href.charCodeAt(0) === 35 /* # */) continue;
          const r = a.getBoundingClientRect();
          if (!r || r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vwHeight) continue;
          hintableCount++;
          // Keep counting after the ninth so the truncation can be REPORTED; only
          // the first nine get a label (the grammar is one digit).
          if (entries.length >= 9) continue;
          entries.push({ href, el: a });
        }
      } catch {
        // The page threw while being read. Say so rather than returning in
        // silence, which reads as "Lazyfox found nothing here".
        toast("link hints: this page could not be inspected");
        return;
      }
      if (!entries.length) {
        // A visible frame is the honest explanation, and a different one from
        // "there is nothing on this page".
        toast(
          visibleFrameCount(doc, cw) > 0
            ? "no links in view \u2014 iframe contents aren't included"
            : "no links on this page"
        );
        return;
      }
      // Draw the 1-9 labels over each hintable link.
      try {
        const host = doc.body || doc.documentElement;
        // The palette's LITERAL colours (see the label style below): these
        // labels are plain spans in the page's own DOM, where `--lf-*` does not
        // exist and must not be injected — that would leak Lazyfox's variables
        // into the site.
        const pal = uiPalette();
        entries.forEach((it, i) => {
          const r = it.el.getBoundingClientRect();
          const label = doc.createElement("span");
          label.textContent = String(i + 1);
          // THE SAME LABEL the content script draws. This used to be its own
          // look — a bordered dark chip with blue text, 11px — so `;f` on an
          // error page and `;f` on a video page read as two different features.
          // The numbers come from shared/hintlabel.ts; only the POSITION is this
          // host's business, because the rects here are the page's own.
          //
          // No min-width/line-height box: the padding and the font are the shared
          // ones, so a label is exactly as big as its digit needs to be, the same
          // way it is in the content script.
          label.setAttribute(
            "style",
            hintLabelInlineStyle(
              "top:" + (r.top + 2) + "px;left:" + (r.left + 2) + "px",
              pal.accent,
              pal.onAccent
            )
          );
          host.appendChild(label);
          labels.push(label);
        });
      } catch {
        // Couldn't draw the labels — drop the mode so it never swallows a key.
        clear();
        return;
      }
      // Nine is the whole grammar here (a single digit opens a link), so a page
      // with more links than that is TRUNCATED — and a truncation the user is not
      // told about is a link that "does not work".
      if (hintableCount > entries.length) {
        toast("link hints: first " + entries.length + " links (1-9)");
      }
      const snapshot = entries.map((it) => it.href);
      const l = leader();
      if (!l) return;
      l.armPending((e) => {
        // A MODIFIED key is not an answer to "which link?". `Ctrl+1` is not
        // "open link 1": it is one keystroke away from a chord the user or the
        // browser meant, and consuming it here opens a page they did not ask
        // for. Declining returns the key to the dispatcher, which hands it to
        // whoever else wants it (and never to the page as a stray character).
        if (e.ctrlKey || e.altKey || e.metaKey) {
          clear();
          return false;
        }
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
