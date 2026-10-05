// Shared status bar (lualine-style, nvim flavor), rendered identically by the
// content script (web pages) and the chrome helper (about:/moz-extension
// pages). It is a fixed, pointer-transparent strip whose position (top/bottom)
// is config. Colored chevron blocks read left-to-right like lualine:
//
//   [◈ 3 · work][▤ 3/12][⧉ 1/2]  ...other sessions (dim, right-aligned)
//
// The palette is tokyonight; icons carry the meaning so labels stay short.
// The bar is thin (20px) so it never gets in the way of content.
//
// Rendered in a closed shadow root so page CSS cannot restyle it.
import {
  leaderSeqText,
  makeLeaderSignal,
  type LeaderSignal,
} from "./leadersignal";
import { pillColorFor, sessionPillText, statusMirrorFragment } from "./statusbar-segments";
import { STATUS_BAR_CSS } from "./statusbar-css";
import type { StatusBarData } from "./types";

// The bar's data shape lives in types.ts alongside every other shared model:
// the pure formatters in statusbar-segments.ts read it without importing the
// bar, and a type-only import of this file from there would be a cycle.
export type { StatusBarSessions, StatusBarDownload, StatusBarData } from "./types";
// The active tab's history-stack shape lives in types.ts (both the Go status
// model and the nav popup use it); re-exported here for bar consumers.
export type { NavEntry, NavState } from "./types";


const CSS = STATUS_BAR_CSS;

type StatusHost = HTMLElement & { _sh: ShadowRoot };

const BAR_HEIGHT = 18;

// Pick readable text for a hex background: near-black on bright fills,
// near-white on dark ones (HSL lightness).
export class StatusBar {
  private host: StatusHost | null = null;
  private position: "top" | "bottom" = "bottom";
  // Whether to reserve real layout space so the bar never covers page content.
  // Web content scripts opt in (the bar reflows the page out of the way); the
  // chrome helper reserves on the XUL document too, so the window-level bar
  // never covers the bottom of the command center / split panel / options
  // pages.
  private readonly reserveSpace: boolean;
  // The scrolling element we pushed padding onto (html OR body, whichever the
  // page actually scrolls) and the class that does the pushing, so hide() can
  // restore it exactly.
  private reservedEl: Element | null = null;
  private reservedCls: string | null = null;
  private reserveStyle: HTMLStyleElement | null = null;
  // document.body can be null when a content script first runs at
  // document_start; once the body exists we must re-apply the class (the
  // element that actually scrolls is often body). Self-heal in render().
  private bodyReserved = false;
  // When set, the bar reserves space by adding a margin to this element (a
  // CSS selector) instead of padding the page's scrolling element. The chrome
  // helper uses this to shrink the browser content area (#browser) so the
  // window-level bar never overlaps web content — XUL padding on :root does
  // not reflow the tab strip.
  private readonly reserveSelector: string | null;

  // The document the bar mounts into. Defaults to the ambient one, so the
  // content script (which runs inside the page and has no ChromeEnv) is
  // unaffected; the chrome helper passes its own so the bar's mount/reserve/
  // render lifecycle can be exercised in Node (see src/chrome/env.ts).
  private readonly doc: any;

  // Called when a download notification on the bar is clicked (dismiss it).
  private onDownloadDismiss: ((key: string) => void) | null = null;

  constructor(reserveSpace = true, reserveSelector: string | null = null, doc?: any) {
    this.reserveSpace = reserveSpace;
    this.reserveSelector = reserveSelector;
    this.doc = doc || (typeof document !== "undefined" ? document : null);
  }

  setDownloadDismiss(fn: (key: string) => void): void {
    this.onDownloadDismiss = fn;
  }
  private data: StatusBarData = {
    name: "default",
    marker: 0,
    tabIndex: 1,
    tabCount: 0,
    inSplit: false,
    splitActive: 0,
    splitPanes: 0,
    mode: "NORMAL",
    sessions: [],
    downloads: [],
    activeStealth: false,
  };

  get mounted(): boolean {
    return this.host !== null;
  }

  show(): void {
    if (this.host) return;
    const host = this.doc.createElement("div") as unknown as StatusHost;
    host.id = "lazyfox-status";
    const sh = host.attachShadow({ mode: "closed" });
    // The leader segment is a small pulsing chevron shown only while the
    // leader key is armed — it is the ONLY visible sign when the which-key
    // overlay is disabled via ;q.
    sh.innerHTML =
      "<style>" + CSS + "</style>" +
      "<div class='lf-status " + this.position + "'>" +
      "<span class='seg sess'><span class='ic'>◈</span><span class='marker'></span><span class='name'></span></span>" +
      "<span class='seg tabs linked'><span class='ic'>▤</span><span class='st'>🕶</span><b></b><span class='cnt'></span></span>" +
      "<span class='seg find' style='display:none'><span class='ic'>🔍</span><b class='cur'></b><span class='cnt'></span></span>" +
      "<span class='seg chips'></span>" +
      "<span class='seg dl' style='display:none'><span class='ic'>⭳</span><span class='items'></span></span>" +
      // Far-right leader indicator: the leader glyph alone while waiting for a
      // first key, and `<glyph> <committed key>` once a chord is in progress.
      // Painted synchronously at key time via setLeaderSignal so it tracks the
      // leader press exactly.
      "<span class='seg leader' style='display:none'></span>" +
      "</div>";
    host._sh = sh;
    this.doc.documentElement.appendChild(host);
    this.host = host;
    this.reserve();
    this.render();
  }

  hide(): void {
    if (this.host) {
      try {
        this.host.remove();
      } catch (e) {
        // ignore
      }
      this.host = null;
    }
    this.unreserve();
  }

  setPosition(pos: "top" | "bottom"): void {
    if (this.position === pos && this.host) return;
    this.position = pos;
    if (this.host) {
      const bar = this.host._sh.querySelector(".lf-status");
      if (bar) {
        bar.classList.remove("top", "bottom");
        bar.classList.add(pos);
      }
      this.reserve();
      this.render();
    }
  }

  // One injected stylesheet with !important rules so page CSS can never defeat
  // the reservation (inline style would lose to a page's own !important). The
  // class goes on the element the page actually scrolls — html in standards
  // mode, but body when a page makes body the scroll container — so content
  // reflows out from under the fixed bar instead of rendering behind it.
  private ensureReserveStyle(): void {
    if (this.reserveStyle) return;
    try {
      const st = this.doc.createElement("style");
      st.id = "lazyfox-status-reserve";
      st.textContent =
        ":root.lf-status-reserve-bottom{padding-bottom:" + BAR_HEIGHT + "px !important;}" +
        ":root.lf-status-reserve-top{padding-top:" + BAR_HEIGHT + "px !important;}" +
        "body.lf-status-reserve-bottom{padding-bottom:" + BAR_HEIGHT + "px !important;}" +
        "body.lf-status-reserve-top{padding-top:" + BAR_HEIGHT + "px !important;}" +
        (this.reserveSelector
          ? this.reserveSelector + ".lf-status-reserve-bottom{margin-bottom:" + BAR_HEIGHT + "px !important;}" +
            this.reserveSelector + ".lf-status-reserve-top{margin-top:" + BAR_HEIGHT + "px !important;}"
          : "");
      (this.doc.head || this.doc.documentElement).appendChild(st);
      this.reserveStyle = st;
    } catch (e) {
      this.reserveStyle = null;
    }
  }

  // Push the page's content out from under the bar so the bar never hides
  // content behind it. The bar itself stays pointer-transparent, but reserving
  // real layout space means the page reflows instead of being overlapped.
  // The class goes on BOTH the scrolling element and body: some pages scroll
  // inside body (html overflow hidden, nested scrollers) where
  // document.scrollingElement still reports the root — extra padding is
  // harmless, missing padding hides the page's last rows behind the bar.
  private reserve(): void {
    if (!this.reserveSpace) return;
    this.unreserve();
    this.ensureReserveStyle();
    const cls =
      this.position === "top" ? "lf-status-reserve-top" : "lf-status-reserve-bottom";
    if (this.reserveSelector) {
      // Chrome helper: shrink the browser content area so the fixed window
      // bar sits in reserved space instead of over the page.
      const el = this.doc.querySelector(this.reserveSelector);
      if (el) {
        el.classList.add(cls);
        this.reservedEl = el;
        this.reservedCls = cls;
      }
      return;
    }
    // In a XUL chrome document document.scrollingElement is null; fall back to
    // the <window> root, which :root padding rules also match.
    const el = this.doc.scrollingElement || this.doc.documentElement;
    if (!el) return;
    el.classList.add(cls);
    this.reservedEl = el;
    this.reservedCls = cls;
    this.bodyReserved = false;
    this.reserveBody();
  }

  // Add the reservation class to body once it exists. The content script runs
  // at document_start, when document.body is still null — without this the
  // last rows of body-scrolling pages sit behind the fixed bar.
  private reserveBody(): void {
    if (!this.reservedEl || !this.reservedCls) return;
    if (this.bodyReserved) return;
    const body = this.doc.body;
    if (!body || body === this.reservedEl) return;
    try {
      body.classList.add(this.reservedCls);
      this.bodyReserved = true;
    } catch (e) {
      // ignore
    }
  }

  private unreserve(): void {
    if (!this.reservedEl || !this.reservedCls) return;
    try {
      this.reservedEl.classList.remove(this.reservedCls);
      const body = this.doc.body;
      if (body && body !== this.reservedEl) body.classList.remove(this.reservedCls);
    } catch (e) {
      // ignore
    }
    this.reservedEl = null;
    this.reservedCls = null;
    this.bodyReserved = false;
  }

  // The last rendered snapshot (serialized) — identical snapshots skip the
  // DOM write entirely. The Go store is the source of truth; this view only
  // paints when the store's model actually changed.
  private lastKey: string | null = null;

  setData(d: Partial<StatusBarData>): void {
    const next = Object.assign({}, this.data, d);
    const key = JSON.stringify(next);
    if (this.lastKey === key) return;
    this.lastKey = key;
    this.data = next;
    this.render();
  }

  // Paints the leader indicator SYNCHRONOUSLY, bypassing the async store
  // roundtrip. A `;` press runs the leader's onChange → statusBatch → wasm →
  // paint chain; that chain crosses several await boundaries and can land
  // visibly late (or land out of order behind a queued snapshot). Arming is a
  // state flag, not data, so paint it directly: zero hops between keypress and
  // pixel. The next store repaint simply confirms whatever this decided.
  setLeaderSignal(sig: LeaderSignal): void {
    this.data.leader = sig;
    const key = JSON.stringify(this.data);
    this.lastKey = key;
    this.render();
  }

  setMode(mode: string): void {
    // Mode is rendered only through setData (the LEADER state shows the
    // pulsing chevron); kept as a thin setter for callers that prefer it.
    if (this.data.mode === mode) return;
    this.data.mode = mode;
  }

  private render(): void {
    if (!this.host) return;
    // Self-heal: if the body appeared after we first reserved (content script
    // ran at document_start), push the padding onto it now.
    this.reserveBody();
    const sh = this.host._sh;
    const leader = sh.querySelector(".leader") as HTMLElement | null;
    const sess = sh.querySelector(".sess") as HTMLElement | null;
    const marker = sh.querySelector(".sess .marker") as HTMLElement | null;
    const name = sh.querySelector(".sess .name") as HTMLElement | null;
    const tabs = sh.querySelector(".tabs") as HTMLElement | null;
    const tabIdx = tabs ? (tabs.querySelector("b") as HTMLElement | null) : null;
    const tabCnt = tabs ? (tabs.querySelector(".cnt") as HTMLElement | null) : null;
    const stealth = tabs ? (tabs.querySelector(".st") as HTMLElement | null) : null;
    const find = sh.querySelector(".find") as HTMLElement | null;
    const findCur = find ? (find.querySelector(".cur") as HTMLElement | null) : null;
    const findCnt = find ? (find.querySelector(".cnt") as HTMLElement | null) : null;
    const dl = sh.querySelector(".dl") as HTMLElement | null;
    const dlItems = dl ? (dl.querySelector(".items") as HTMLElement | null) : null;
    const chips = sh.querySelector(".chips");

    if (leader) {
      // The indicator is armed while the leader bar is up OR a sequence is in
      // progress. setLeaderSignal paints this synchronously at key time — the
      // store snapshot (data.leader) only reconciles it on the next repaint.
      //
      // The prefix is rendered, not just stored: once `;W` has been pressed the
      // user has committed half the chord, and an indicator that looks the same
      // at `;` and at `;W` tells them nothing about which key they are now
      // waiting for. `leaderSeqText` owns the shape so it can be tested.
      const sig =
        this.data.leader ||
        makeLeaderSignal({ armed: this.data.mode === "LEADER" });
      leader.style.display = sig.armed ? "" : "none";
      if (sig.armed) {
        const txt = leaderSeqText(sig.prefix, sig.expect);
        leader.textContent = txt;
        leader.classList.toggle("seq", !!sig.prefix);
        // The pulse is the "we are waiting on you" signal, and it belongs on
        // exactly the states that have something to wait FOR: a bare leader
        // that takes any key, and a capture that wants a specific one. Pulsing
        // a bar that is merely idle would train the eye to ignore it.
        leader.classList.toggle("stale", true);
      }
    }
    if (name) name.textContent = this.data.name;
    if (marker) {
      marker.textContent = this.data.marker ? String(this.data.marker) : "";
      marker.style.display = this.data.marker ? "" : "none";
    }
    if (sess) sess.style.display = this.data.name ? "" : "none";
    if (tabIdx) tabIdx.textContent = String(this.data.tabIndex);
    if (tabCnt) tabCnt.textContent = "/" + this.data.tabCount;
    if (tabs) tabs.style.display = this.data.tabCount > 0 ? "" : "none";
    if (stealth) stealth.style.display = this.data.activeStealth ? "" : "none";

    // Live find-in-page count: "🔍 cur/count" while a find session is open
    // on the page, "🔍 0" (red) when a query has no matches.
    if (find && findCur && findCnt) {
      const f = this.data.find;
      if (f && f.count > 0) {
        // cur is 1-based (0 = a query is typed but nothing walked to yet).
        find.style.display = "";
        findCur.textContent = String(f.cur > 0 ? f.cur : 0);
        findCnt.textContent = "/" + f.count;
        findCur.style.display = "";
        findCur.classList.remove("none");
      } else if (f && f.count === 0) {
        find.style.display = "";
        findCur.textContent = "0";
        findCnt.textContent = "";
        findCur.style.display = "";
        findCur.classList.add("none");
      } else {
        find.style.display = "none";
      }
    }

    if (dl && dlItems) {
      dl.style.display = this.data.downloads.length > 0 ? "" : "none";
      dlItems.textContent = "";
      for (const d of this.data.downloads) {
        const item = this.doc.createElement("span");
        item.className = "dlitem";
        item.title = "dismiss";
        const name = this.doc.createElement("span");
        name.className = "n";
        name.textContent = d.filename;
        item.appendChild(name);
        if (d.state === "complete") {
          // small green indicator for a finished download
          const ok = this.doc.createElement("span");
          ok.className = "ok";
          ok.textContent = "\u2713";
          item.appendChild(ok);
        } else if (d.state === "failed") {
          // small red indicator for a failed download
          const bad = this.doc.createElement("span");
          bad.className = "bad";
          bad.textContent = "\u2717";
          item.appendChild(bad);
        } else {
          if (d.percent >= 0) {
            const pct = this.doc.createElement("span");
            pct.className = "pct";
            pct.textContent = d.percent + "%";
            item.appendChild(pct);
          }
          if (d.speed) {
            const spd = this.doc.createElement("span");
            spd.className = "pct";
            spd.textContent = d.speed;
            item.appendChild(spd);
          }
        }
        item.addEventListener("click", () => {
          if (this.onDownloadDismiss) this.onDownloadDismiss(d.key);
        });
        dlItems.appendChild(item);
      }
    }

    if (chips) {
      // Session list as connected chevron blocks right after the tabs segment:
      // each reads `id:name count` and links into the previous one. The active
      // session is already shown by the first (session-name) segment, so the
      // list needs no extra current marker; split counts were dropped as noise.
      const frag = this.doc.createDocumentFragment();
      this.data.sessions.slice(0, 12).forEach((s, i) => {
        // First block is a full chevron (> id:name count); every block after
        // it links into the previous one's point (> id:name count > ...).
        const block = this.doc.createElement("span");
        block.className = "sesspill" + (i > 0 ? " linked" : "");
        // Stable color keyed to the marker (not list position), so switching
        // sessions never recolors another one.
        // Stable color keyed to the marker (not list position), so switching
        // sessions never recolors another one — see statusbar-segments.ts.
        const c = pillColorFor(s.marker);
        block.style.background = c.gradient;
        block.style.color = c.ink;
        block.textContent = sessionPillText(s);
        frag.appendChild(block);
      });
      chips.textContent = "";
      chips.appendChild(frag);
    }

    // Testability/debug hook: mirror the state onto the document root (the
    // shadow root is closed, so suites read this attribute instead).
    try {
      this.doc.documentElement.setAttribute(
        "data-lf-status",
        statusMirrorFragment(this.data, this.position, this.data.leader)
      );
    } catch (e) {
      // ignore
    }
  }
}
