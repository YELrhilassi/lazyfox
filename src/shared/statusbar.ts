// Shared status bar, rendered identically by the content script (web pages)
// and the chrome helper (about:/moz-extension pages). It is a fixed,
// pointer-transparent strip whose position (top/bottom) is config. Flat
// segments read left-to-right; the session pills are one control, not a chip
// rack:
//
//   [▤ 3/12][1 work 5][2 mail 3][3 dev]   ...  [;N][☾ dark][🔇 muted]
//
// Only the CURRENT session wears the accent; every other pill shares one quiet
// fill and the 1px gap between them says where each starts and ends. Icons are
// one flat set (shared/icons.ts) and carry the meaning so labels stay short.
// The bar is 18px so it never gets in the way of content.
//
// Rendered in a closed shadow root so page CSS cannot restyle it.
import {
  leaderSeqText,
  makeLeaderSignal,
  type LeaderSignal,
} from "./leadersignal";
import { darkSegment, sessionPillHtml, statusMirrorFragment } from "./statusbar-segments";
import { STATUS_BAR_CSS } from "./statusbar-css";
import { iconHtml, iconNode, setIcon } from "./icons";
import { uiCss } from "./theme";
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
      "<style>" + uiCss(CSS) + "</style>" +
      "<div class='lf-status " + this.position + "'>" +
      // WHAT THIS BAR SAYS, left to right:
      //
      //   ▤ 3/12  [pills…]  🔍 2/9  ⭳  ...  ;N  ☾ dark  🔇 muted │
      //
      // There is no "current session" cell any more: the pills ARE the list,
      // and the active one is the accent, so a separate name cell repeated what
      // the highlighted pill already said — in a colour nothing else used.
      "<span class='seg tabs'>" + iconHtml("tabs") +
      "<b></b><span class='cnt'></span></span>" +
      "<span class='seg stealth' style='display:none' title='Stealth tab'>" +
      iconHtml("stealth") + "<span class='lbl'>Stealth</span></span>" +
      "<span class='seg chips'></span>" +
      "<span class='seg find' style='display:none'>" + iconHtml("search") +
      "<b class='cur'></b><span class='cnt'></span></span>" +
      "<span class='seg dl' style='display:none'>" + iconHtml("download") +
      "<span class='items'></span></span>" +
      // The spacer takes every spare pixel, so the right-hand group is flush
      // right: the leader indicator (a transient) first, then the dark-mode
      // verdict, and the muted badge last — it belongs to the tab you are on.
      "<span class='spacer'></span>" +
      "<span class='seg leader' style='display:none'></span>" +
      "<span class='seg dark' style='display:none'><span class='ic'></span>" +
      "<span class='lbl'></span></span>" +
      // Muted: the tab strip that used to show it is gone, so the bar is the
      // ONLY place this state can be seen. Shown at all times while muted, not
      // on hover: a muted tab that looks identical to a silent one is how a user
      // ends up hunting for audio that is already off.
      "<span class='seg mute' style='display:none' title='Tab muted'>" +
      iconHtml("muted") + "<span class='lbl'>Muted</span></span>" +
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
  // The session list the chips were last rebuilt from, so a repaint that only
  // changed the leader chord does not regenerate every pill.
  private chipsKey: string | null = null;

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

  /**
   * Paint the muted badge from the selected tab.
   *
   * Deliberately NOT a store op: the Go status store models what a SESSION is
   * (name, marker, tab counts, stealth), while this is a property of one tab's
   * document that can change without the session moving at all (a site starts
   * its own audio, a tab is muted from its context menu). setData's merge keeps
   * the field across the store's own repaints, so the next snapshot cannot
   * clear it — the next compute() re-reads the tab and decides again.
   */
  setMuted(on: boolean): void {
    const next = !!on;
    if (!!this.data.muted === next) return;
    this.data.muted = next;
    this.lastKey = JSON.stringify(this.data);
    this.render();
  }

  private render(): void {
    if (!this.host) return;
    // Self-heal: if the body appeared after we first reserved (content script
    // ran at document_start), push the padding onto it now.
    this.reserveBody();
    const sh = this.host._sh;
    const leader = sh.querySelector(".leader") as HTMLElement | null;
    const stealth = sh.querySelector(".stealth") as HTMLElement | null;
    const tabs = sh.querySelector(".tabs") as HTMLElement | null;
    const tabIdx = tabs ? (tabs.querySelector("b") as HTMLElement | null) : null;
    const tabCnt = tabs ? (tabs.querySelector(".cnt") as HTMLElement | null) : null;
    const mute = sh.querySelector(".mute") as HTMLElement | null;
    const dark = sh.querySelector(".dark") as HTMLElement | null;
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
    if (tabIdx) tabIdx.textContent = String(this.data.tabIndex);
    if (tabCnt) tabCnt.textContent = "/" + this.data.tabCount;
    if (tabs) tabs.style.display = this.data.tabCount > 0 ? "" : "none";
    if (stealth) stealth.style.display = this.data.activeStealth ? "" : "none";
    if (mute) mute.style.display = this.data.muted ? "" : "none";

    // Live find-in-page count: "🔍 cur/count" while a find session is open
    // on the page, "🔍 0" (red) when a query has no matches.
    if (find && findCur && findCnt) {
      const f = this.data.find;
      if (f && f.count > 0) {
        // cur is 1-based (0 = a query is typed but nothing walked to yet).
        find.style.display = "";
        find.classList.remove("none");
        findCur.textContent = String(f.cur > 0 ? f.cur : 0);
        findCnt.textContent = "/" + f.count;
        findCur.style.display = "";
      } else if (f && f.count === 0) {
        find.style.display = "";
        find.classList.add("none");
        findCur.textContent = "0";
        findCnt.textContent = "";
        findCur.style.display = "";
      } else {
        find.style.display = "none";
      }
    }

    // The dark segment: one icon, one word. `title` carries the longer story
    // for a hover, because the bar is 18px tall and a sentence does not fit.
    if (dark) {
      const seg = darkSegment(this.data.dark);
      dark.style.display = seg ? "" : "none";
      if (seg) {
        dark.className = "seg dark tone-" + seg.tone;
        setIcon(dark.querySelector(".ic"), seg.icon);
        const lbl = dark.querySelector(".lbl");
        if (lbl) lbl.textContent = seg.label;
        dark.title =
          "Dark mode: " +
          (this.data.dark && this.data.dark.mode ? this.data.dark.mode : "?") +
          " \u00B7 " +
          (this.data.dark && this.data.dark.engine ? this.data.dark.engine : "?");
      }
    }

    if (dl && dlItems) {
      dl.style.display = this.data.downloads.length > 0 ? "" : "none";
      dlItems.textContent = "";
      for (const d of this.data.downloads) {
        const item = this.doc.createElement("span");
        item.className = "dlitem";
        item.title = "Dismiss";
        const name = this.doc.createElement("span");
        name.className = "n";
        name.textContent = d.filename;
        item.appendChild(name);
        if (d.state === "complete") {
          // small green indicator for a finished download
          const ok = this.doc.createElement("span");
          ok.className = "ok";
          ok.appendChild(iconNode(this.doc, "done"));
          item.appendChild(ok);
        } else if (d.state === "failed") {
          // small red indicator for a failed download
          const bad = this.doc.createElement("span");
          bad.className = "bad";
          bad.appendChild(iconNode(this.doc, "failed"));
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
      // Session list as chevron chips: the stylesheet shapes each pill and
      // leaves a 1px gap, so the row reads as >>. Only the current one is the
      // accent; every other one shares a quiet fill, so the list reads as one
      // control with one active position instead of as nine unrelated colours.
      //
      // Rebuilt only when the list actually changed: a leader key repaints this
      // bar, and regenerating a dozen pills for it is work nobody asked for.
      const ck = JSON.stringify(this.data.sessions);
      if (ck !== this.chipsKey) {
        this.chipsKey = ck;
        chips.innerHTML = this.data.sessions.slice(0, 12).map(sessionPillHtml).join("");
      }
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
