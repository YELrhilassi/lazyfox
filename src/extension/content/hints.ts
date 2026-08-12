// Link hints + "focus first input" for the content script. All hint key
// generation comes from the Go core (core.makeHints); this module only owns
// the DOM overlay, the typed-prefix filtering and the activation click/focus.

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

export interface LinkHints {
  readonly active: boolean;
  start(): Promise<void>;
  handleKey(e: KeyboardEvent): boolean;
  exit(): void;
}

export function createLinkHints(getHintChars: () => string): LinkHints {
  let active = false;
  let items: HintItem[] = [];
  let typed = "";
  let host: (HTMLElement & { _box: HTMLElement }) | null = null;

  async function start(): Promise<void> {
    if (active) return;
    const all = document.querySelectorAll(
      "a[href], button, input:not([type='hidden']), textarea, select, [role='link'], " +
        "[role='button'], [onclick], [contenteditable='true']"
    );
    const visible = Array.prototype.filter.call(all, isVisible).slice(0, 300) as Element[];
    if (!visible.length) {
      toast("no hints");
      return;
    }
    let keys: string[];
    try {
      keys = await core.makeHints(visible.length, getHintChars() || "asdfjkl;gh");
    } catch (e) {
      toast("core unavailable");
      return;
    }
    items = visible.map((el, i) => ({ el: el, key: keys[i]! }));
    typed = "";
    active = true;
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
    render();
  }

  function render(): void {
    const box = host!._box;
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

  function handleKey(e: KeyboardEvent): boolean {
    const hintChars = getHintChars();
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
    if (e.key.length === 1 && hintChars.indexOf(e.key.toLowerCase()) !== -1) {
      typed = (typed + e.key).toLowerCase();
      const exact = items.find((i) => i.key === typed);
      const isPrefixOfMore = items.some(
        (i) => i.key !== typed && i.key.indexOf(typed) === 0
      );
      if (exact && !isPrefixOfMore) {
        activate(exact);
      } else {
        render();
      }
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
    (el as HTMLElement).click();
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
