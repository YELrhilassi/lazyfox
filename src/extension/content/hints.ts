// Link hints + "focus first input" for the content script. All hint key
// generation comes from the Go core (core.makeHints); this module only owns
// the DOM overlay, the typed-prefix filtering and the activation click/focus.
//
// Hints are "virtual": only elements whose rect intersects the current
// viewport are hinted at any one time, so the label count stays small and the
// keys stay short. `]` / `[` (and Tab / Shift+Tab) scroll the document to the
// next / previous batch of links and re-hint them; typing a prefix that
// matches links below the fold scrolls them into view and re-hints the
// now-visible matches with fresh short keys.

import { core } from "../../shared/core";
import { isVisible } from "../../shared/dom";
import { toast } from "../../shared/overlay";

interface HintItem {
  el: Element;
  key: string;
}

const HINT_CSS =
  ".hint{position:fixed;z-index:2147483646;background:#2ac3de;color:#16161e;" +
  "font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;padding:2px 5px;border-radius:4px;" +
  "pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.4)}";

const HINTABLE_SELECTOR =
  "a[href], button, input:not([type='hidden']), textarea, select, [role='link'], " +
  "[role='button'], [onclick], [contenteditable='true']";

// Cap per viewport so even a dense grid of links never yields long keys.
const MAX_HINTS = 120;
// How far ] / [ page when scrolling between hint batches (fraction of the
// viewport height, so a batch roughly fills the screen).
const PAGE_FACTOR = 0.8;
// Bounded retries when paging toward a section that has no links.
const PAGE_GUARD = 8;

export interface LinkHints {
  readonly active: boolean;
  start(): Promise<void>;
  handleKey(e: KeyboardEvent): boolean;
  exit(): void;
}

// Like isVisible but WITHOUT the viewport check: an element is "hintable" if
// it is connected and has real size, even when it sits below the fold (those
// get hinted once the user pages to them).
function basicVisible(el: Element): boolean {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return true;
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
}

export function createLinkHints(getHintChars: () => string): LinkHints {
  let active = false;
  let pool: Element[] = []; // every hintable element, in document order
  let items: HintItem[] = []; // currently hinted items (viewport subset)
  let typed = "";
  let host: (HTMLElement & { _box: HTMLElement }) | null = null;

  function hintChars(): string {
    // The leader key (';' by default) must never double as a hint char —
    // strip it even if an older saved config still lists it.
    return (getHintChars() || "asdfjklgh").replace(/;/g, "");
  }

  async function start(): Promise<void> {
    if (active) return;
    const all = document.querySelectorAll(HINTABLE_SELECTOR);
    pool = Array.prototype.filter.call(all, basicVisible) as Element[];
    if (!pool.length) {
      toast("no hints");
      return;
    }
    // If the current viewport has no links (e.g. a blank section), page down
    // until a batch of links comes into view.
    let vis = viewportItems();
    let guard = 0;
    while (!vis.length && guard < PAGE_GUARD) {
      pageScroll(1);
      guard++;
      vis = viewportItems();
    }
    if (!vis.length) {
      toast("no hints");
      return;
    }
    active = true;
    mountHost();
    await assign(vis);
    if (!items.length) exit();
  }

  // The elements of `pool` that are currently inside the viewport, keeping
  // isVisible's style/visibility checks for the (small) visible subset.
  function viewportItems(): Element[] {
    return pool.filter((el) => inViewport(el) && isVisible(el));
  }

  function pageScroll(dir: number): void {
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    window.scrollBy(0, dir * Math.round(vh * PAGE_FACTOR));
  }

  // Re-hint a batch of elements. When the batch is identical to the current
  // one, the existing keys are kept (so a no-op page doesn't reshuffle the
  // labels the user is already typing).
  async function assign(list: Element[]): Promise<void> {
    if (!list.length) return;
    const chosen = list.slice(0, MAX_HINTS);
    if (
      items.length === chosen.length &&
      chosen.every((el, i) => items[i] && items[i]!.el === el)
    ) {
      typed = "";
      render();
      return;
    }
    let keys: string[];
    try {
      keys = await core.makeHints(chosen.length, hintChars());
    } catch (e) {
      toast("core unavailable");
      exit();
      return;
    }
    items = chosen.map((el, i) => ({ el: el, key: keys[i]! }));
    typed = "";
    render();
  }

  function mountHost(): void {
    host = document.createElement("div") as unknown as HTMLElement & { _box: HTMLElement };
    host.id = "lazyfox-hints";
    const sh = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = HINT_CSS;
    const box = document.createElement("div");
    sh.appendChild(style);
    sh.appendChild(box);
    host._box = box;
    document.documentElement.appendChild(host);
    try {
      document.documentElement.setAttribute("data-lf-hints", "1");
    } catch (e) {
      // ignore
    }
  }

  function render(): void {
    if (!host) return;
    const box = host._box;
    box.textContent = "";
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || it.key.indexOf(typed) !== 0) continue;
      const r = it.el.getBoundingClientRect();
      const label = document.createElement("span");
      label.className = "hint";
      label.textContent = it.key.slice(typed.length);
      label.style.left = r.left + "px";
      label.style.top = r.top + "px";
      box.appendChild(label);
    }
  }

  // Scroll to the next / previous batch of links and re-hint it. Keeps paging
  // (bounded) when the direction lands on a link-free section.
  function page(dir: number): void {
    for (let i = 0; i < PAGE_GUARD; i++) {
      const before = window.scrollY;
      pageScroll(dir);
      const vis = viewportItems();
      if (vis.length) {
        void assign(vis);
        return;
      }
      if (window.scrollY === before) break; // at the top/bottom of the page
    }
    toast("no more links");
  }

  async function typeChar(c: string): Promise<void> {
    const nt = typed + c;
    const matches = items.filter((i) => i.key.indexOf(nt) === 0);
    if (!matches.length) return; // no candidate for this prefix — ignore
    const exact = matches.find((i) => i.key === nt);
    const isPrefixOfMore = matches.some(
      (i) => i.key !== nt && i.key.indexOf(nt) === 0
    );
    if (exact && !isPrefixOfMore) {
      activate(exact);
      return;
    }
    typed = nt;
    // When the topmost candidate sits outside the viewport (e.g. the user
    // paged, then scrolled with the wheel), bring it into view and re-hint
    // the now-visible matches with fresh short keys instead of demanding a
    // long suffix.
    const top = matches[0]!;
    const r = top.el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (r.top < 0 || r.bottom > vh) {
      try {
        top.el.scrollIntoView({ block: "center", behavior: "auto" });
      } catch (e) {
        // ignore
      }
      const visible = matches
        .filter((i) => inViewport(i.el) && isVisible(i.el))
        .map((i) => i.el);
      if (visible.length && visible.length < matches.length) {
        await assign(visible);
        return;
      }
    }
    render();
  }

  function handleKey(e: KeyboardEvent): boolean {
    const chars = hintChars();
    if (e.key === "Escape") {
      exit();
      return true;
    }
    if (e.key === "Backspace") {
      typed = typed.slice(0, -1);
      render();
      return true;
    }
    if (e.key === "Enter") {
      const found = items.filter((i) => i.key.indexOf(typed) === 0);
      if (found.length) activate(found[0]!);
      else exit();
      return true;
    }
    if (e.key === "]" || (e.key === "Tab" && !e.shiftKey)) {
      page(1);
      return true;
    }
    if (e.key === "[" || (e.key === "Tab" && e.shiftKey)) {
      page(-1);
      return true;
    }
    if (e.key.length === 1 && chars.indexOf(e.key.toLowerCase()) !== -1) {
      void typeChar(e.key.toLowerCase());
      return true;
    }
    return false;
  }

  function activate(it: HintItem): void {
    exit();
    const el = it.el;
    const t = el.tagName;
    if (t === "A" && (el as HTMLAnchorElement).href) {
      (el as HTMLElement).click();
      return;
    }
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      (el as HTMLElement).focus();
      const anyEl = el as HTMLInputElement;
      if (anyEl.select) {
        try {
          anyEl.select();
        } catch (e) {
          // ignore
        }
      }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if ((el as HTMLElement).isContentEditable) {
      (el as HTMLElement).focus();
      return;
    }
    emulateClick(el);
  }

  // Some pages (video overlays like YouTube's "Skip", custom widgets) attach
  // their handlers to pointer/mouse events or ignore a bare synthetic
  // .click() — fire the full pointer + mouse sequence at the element's
  // center so they respond like a real user click.
  function emulateClick(el: Element): void {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of types) {
      let ev: Event;
      try {
        ev =
          typeof PointerEvent !== "undefined" && type.indexOf("pointer") === 0
            ? new PointerEvent(type, opts)
            : new MouseEvent(type, opts);
      } catch (e) {
        ev = new MouseEvent(type, opts);
      }
      el.dispatchEvent(ev);
    }
  }

  function exit(): void {
    active = false;
    try {
      document.documentElement.removeAttribute("data-lf-hints");
    } catch (e) {
      // ignore
    }
    if (host) {
      host.remove();
      host = null;
    }
    items = [];
    pool = [];
    typed = "";
  }

  return {
    get active() {
      return active;
    },
    start,
    handleKey,
    exit,
  };
}

export function focusFirstInput(): void {
  const found = Array.prototype.filter.call(
    document.querySelectorAll(
      "input:not([type='hidden']), textarea, select, [contenteditable='true']"
    ),
    isVisible
  ) as Element[];
  if (!found.length) {
    toast("no input found");
    return;
  }
  const el = found[0] as HTMLInputElement;
  el.focus();
  if (el.select) {
    try {
      el.select();
    } catch (e) {
      // ignore
    }
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  toast("input focused");
}
