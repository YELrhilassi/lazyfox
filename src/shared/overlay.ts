// Shared popup engine + toast. The old chrome helper and the content script
// each carried their own copy of a "Selector" list engine plus popup CSS; this
// is the merged, single implementation. Both contexts render the same panel
// chrome and navigate it with the same keys. The only difference is where the
// key events come from (content intercepts them at the window capture handler;
// the chrome helper binds a keydown listener on the input element).

// Style sheet used by both the shadow-DOM popups (content) and the chrome
// helper's plain-DOM popups (chrome.ts injects the same text into its root).
export const PANEL_CSS = `
.lf-popup{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;
  justify-content:center;background:rgba(8,8,14,.4);font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;}
.lf-panel{width:640px;max-width:92vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;
  background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;
  box-shadow:0 24px 70px rgba(0,0,0,.6);}
.lf-title{padding:10px 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7aa2f7;
  border-bottom:1px solid #2a2f45;flex:none;}
.lf-main{display:flex;flex:1;overflow:hidden;}
.lf-list{flex:1;overflow-y:auto;padding:4px 0;}
.lf-list::-webkit-scrollbar{width:8px;}
.lf-list::-webkit-scrollbar-thumb{background:#3b4261;border-radius:4px;}
.lf-item{padding:8px 16px;cursor:pointer;border-left:3px solid transparent;line-height:1.35;}
.lf-item:hover{background:#252a3a;}
.lf-item.lf-tab{padding:4px 14px;}
.lf-item .t{font-size:13px;color:#c0caf5;}
.lf-item .s{font-size:11px;color:#565f89;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-item.selected{background:#292e42;border-left-color:#7aa2f7;}
.lf-item.selected .t{color:#ffffff;}
.lf-empty{padding:26px;text-align:center;color:#565f89;font-size:12px;flex:1;}
.lf-input{flex:none;background:#16161e;border:none;border-top:1px solid #2a2f45;color:#c0caf5;
  padding:12px 16px;font-family:inherit;font-size:14px;outline:none;}
.lf-foot{flex:none;padding:8px 16px;font-size:11px;color:#565f89;border-top:1px solid #2a2f45;
  display:flex;gap:6px;align-items:center;}
.lf-panel.wide{width:820px;max-width:94vw;}
.lf-split{display:flex;flex:1;overflow:hidden;}
.lf-col{display:flex;flex-direction:column;flex:1 1 50%;min-width:0;border-right:1px solid #2a2f45;}
.lf-col:last-child{border-right:none;}
.lf-col-head{padding:6px 14px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#7aa2f7;
  border-bottom:1px solid #2a2f45;flex:none;}
.lf-tabs{flex:1;overflow-y:auto;padding:4px 0;}
.lf-tabs .lf-item.active{border-left-color:#9ece6a;}
.lf-tabs-empty{padding:26px 16px;text-align:center;color:#565f89;font-size:12px;}
.lf-col.active{background:rgba(122,162,247,.05);}
.lf-col.active .lf-col-head{color:#9ece6a;}
.lf-status{flex:1;color:#7aa2f7;}
.lf-badge{color:#7aa2f7;}
.kbd{display:inline-block;min-width:26px;text-align:center;background:#16161e;border:1px solid #414868;
  border-bottom-width:2px;border-radius:5px;padding:1px 7px;margin-right:8px;color:#7aa2f7;font-size:12px;}
.lf-native-tag{display:inline-block;font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  background:#292e42;color:#9aa5ce;border-radius:4px;padding:1px 6px;margin-right:8px;vertical-align:1px;}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#7aa2f7;margin-right:6px;}
.dot.new{background:#9ece6a;border-radius:2px;}
.lf-marker{display:inline-block;min-width:16px;text-align:center;background:#16161e;border:1px solid #414868;
  border-radius:4px;padding:0 4px;margin-right:8px;color:#2ac3de;font-size:11px;}
.lf-item.selected.lf-armed{background:#3a1f2a;border-left-color:#f7768e;}
.lf-item.selected.lf-armed .t{color:#f7768e;}
.lf-arm{color:#f7768e;font-weight:700;font-size:11px;}
.dl-state{display:inline-block;font-size:9px;letter-spacing:.08em;text-transform:uppercase;
  background:#292e42;color:#9aa5ce;border-radius:4px;padding:0 6px;margin-left:8px;vertical-align:1px;}
.dl-pct{color:#7aa2f7;font-size:12px;margin-left:8px;font-weight:700;}
.dl-bar{height:3px;background:#16161e;border-radius:2px;margin-top:5px;overflow:hidden;}
.dl-fill{height:100%;background:#7aa2f7;border-radius:2px;}
.dl-fill.done{background:#9ece6a;}
.dl-fill.fail{background:#f7768e;}
.hint{position:fixed;z-index:2147483646;background:#2ac3de;color:#16161e;font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;
  padding:2px 5px;border-radius:4px;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.4);}
`;

export interface SelectorOpts<T> {
  listEl: HTMLElement;
  inputEl: HTMLInputElement;
  emptyEl: HTMLElement;
  search(q: string): Promise<T[]>;
  render(item: T): string;
  onPick(item: T): void;
  emptyText?: string;
  itemClass?: string;
  debounceMs?: number;
  pageStep?: number;
  maxItems?: number;
  // When false, the empty-query j/k navigation shortcuts are disabled
  // (search/url popups use them for nothing and j/k must stay typable).
  vimNav?: boolean;
  // When true, onKey performs manual Backspace/Delete and printable-character
  // insertion. Required in the content script where the window-capture
  // keydown handler preventDefaults every key before the selector sees it.
  manualText?: boolean;
  extraKeys?: (e: KeyboardEvent, ctx: { empty: boolean; index: number; item: T | null; refresh(): void }) => boolean;
  // Called when Enter is pressed. When it returns true the key is consumed
  // (the default "pick the highlighted item" is skipped). Lets popups whose
  // data source is debounced/async handle Enter deterministically from the
  // raw input value instead of racing the in-flight search.
  onEnter?: (value: string, item: T | null) => boolean;
  onChange?: (idx: number, item: T | null, count: number) => void;
}

export interface SelectorCtl {
  onKey(e: KeyboardEvent): boolean;
  refresh(): void;
  close(): void;
}

const HOST_CSS =
  "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;";

export interface PopupCtl extends SelectorCtl {
  focus?(): void;
}

// Opens a popup in a closed shadow root on <html>. `build` returns the popup
// controller; focus() (if provided) runs on the next tick like the original
// popups. Clicking the backdrop calls `onClose` (the caller should tear down
// its popup state there); if no onClose is given the host is removed directly.
export function openPopup(
  html: string,
  build: (root: HTMLElement) => PopupCtl,
  onClose?: () => void
): PopupCtl {
  const host = document.createElement("div");
  host.id = "lazyfox-popup";
  host.style.cssText = HOST_CSS;
  const sh = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  const root = document.createElement("div");
  root.className = "lf-popup";
  root.innerHTML = html;
  sh.appendChild(style);
  sh.appendChild(root);
  document.documentElement.appendChild(host);

  root.addEventListener("click", (e) => {
    if (e.target === root) {
      if (onClose) onClose();
      else host.remove();
    }
  });

  let ctl: PopupCtl | null = null;
  try {
    ctl = build(root);
  } catch (e) {
    console.error("lazyfox popup build failed", e);
  }
  const inner: PopupCtl = ctl || {
    onKey: () => false,
    refresh: () => {},
    close: () => {},
    focus: () => {},
  };
  setTimeout(() => {
    if (inner.focus) inner.focus();
  }, 0);
  return {
    onKey: inner.onKey,
    refresh: inner.refresh,
    close: () => {
      inner.close();
      host.remove();
    },
    focus: inner.focus,
  };
}

export function createSelector<T>(opts: SelectorOpts<T>): SelectorCtl {
  let shown: T[] = [];
  let idx = 0;
  // True once the user has *chosen* a row (arrow/vim/Home/End/PageUp/Down or a
  // click). A fresh search resets it, so Enter on a freshly-typed query is
  // treated as "open what I typed", not "open the first suggestion".
  let navigated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounce = opts.debounceMs ?? 40;
  const step = opts.pageStep ?? 8;
  const maxItems = opts.maxItems ?? 100;

  function render() {
    const list = opts.listEl;
    list.textContent = "";
    if (!shown.length) {
      opts.emptyEl.style.display = "block";
      opts.emptyEl.textContent = opts.emptyText || "";
      if (opts.onChange) opts.onChange(idx, null, 0);
      return;
    }
    opts.emptyEl.style.display = "none";
    const frag = document.createDocumentFragment();
    const cls = "lf-item" + (opts.itemClass ? " " + opts.itemClass : "");
    shown.forEach((item, i) => {
      const div = document.createElement("div");
      div.className = cls + (i === idx ? " selected" : "");
      div.innerHTML = opts.render(item);
      div.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        opts.onPick(item);
      });
      // No mouseenter selection hijack here: moving the highlight on hover
      // stole the keyboard selection (Enter opened the hovered row instead of
      // the typed value, and arrow navigation snapped back to the hovered row
      // on every re-render). Hover feedback is pure CSS; the selected row is
      // only changed by the keyboard (move/Home/End) or a real click.
      frag.appendChild(div);
    });
    list.appendChild(frag);
    const sel = list.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
    if (opts.onChange) opts.onChange(idx, shown[idx] || null, shown.length);
    // The popup lives in a closed shadow root, so nothing outside it can read
    // the rows directly. Dispatch a composed, bubbling event on the list so
    // page-level observers (and the e2e harness) can see the current selection
    // and item count without reaching into the shadow DOM.
    list.dispatchEvent(
      new CustomEvent("lazyfox:list", {
        bubbles: true,
        composed: true,
        detail: { count: shown.length, idx, q: opts.inputEl.value || "" },
      })
    );
  }

  function search(q: string) {
    if (timer) clearTimeout(timer);
    const current = q;
    timer = setTimeout(() => {
      opts
        .search(current)
        .then((items) => {
          if (current !== (opts.inputEl.value || "")) return;
          shown = (items || []).slice(0, maxItems);
          idx = 0;
          navigated = false;
          render();
        })
        .catch(() => {});
    }, debounce);
  }

  function refresh() {
    search(opts.inputEl.value || "");
  }

  function move(d: number) {
    if (!shown.length) return;
    idx = (idx + d + shown.length) % shown.length;
    navigated = true;
    render();
  }

  function onKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const empty = (opts.inputEl.value || "") === "";
    if (k === "ArrowDown") {
      e.preventDefault();
      move(1);
      return true;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      move(-1);
      return true;
    }
    if (k === "PageDown") {
      e.preventDefault();
      move(step);
      return true;
    }
    if (k === "PageUp") {
      e.preventDefault();
      move(-step);
      return true;
    }
    if (k === "Home") {
      e.preventDefault();
      idx = 0;
      navigated = true;
      render();
      return true;
    }
    if (k === "End") {
      e.preventDefault();
      idx = shown.length - 1;
      navigated = true;
      render();
      return true;
    }
    if (e.ctrlKey && (k === "n" || k === "p")) {
      e.preventDefault();
      move(k === "n" ? 1 : -1);
      return true;
    }
    if (opts.vimNav !== false && empty && k === "j") {
      e.preventDefault();
      move(1);
      return true;
    }
    if (opts.vimNav !== false && empty && k === "k") {
      e.preventDefault();
      move(-1);
      return true;
    }
    if (k === "Enter") {
      e.preventDefault();
      const value = opts.inputEl.value || "";
      // Only hand the highlighted row to onEnter when the user actually moved
      // to it. Right after typing, idx is 0 with no navigation, so onEnter sees
      // null and can open the typed value instead of the first suggestion.
      const item = navigated ? (shown[idx] || null) : null;
      if (opts.onEnter && opts.onEnter(value, item)) {
        return true;
      }
      const pick = shown[idx];
      if (pick) opts.onPick(pick);
      return true;
    }
    if (opts.extraKeys) {
      if (
        opts.extraKeys(e, { empty: empty, index: idx, item: shown[idx] || null, refresh: refresh }) === true
      ) {
        return true;
      }
    }
    if (opts.manualText) {
      const input = opts.inputEl;
      const s = input.selectionStart == null ? input.value.length : input.selectionStart;
      const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      const sel = s !== en;
      const atEnd = s >= input.value.length;
      const atStart = s <= 0;
      if (k === "Backspace" || k === "Delete") {
        e.preventDefault();
        if (sel) {
          input.value = input.value.slice(0, s) + input.value.slice(en);
          try {
            input.setSelectionRange(s, s);
          } catch (err) {}
        } else if (k === "Backspace" && !atStart) {
          input.value = input.value.slice(0, s - 1) + input.value.slice(en);
          try {
            input.setSelectionRange(s - 1, s - 1);
          } catch (err) {}
        } else if (k === "Delete" && !atEnd) {
          input.value = input.value.slice(0, s) + input.value.slice(en + 1);
          try {
            input.setSelectionRange(s, s);
          } catch (err) {}
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      if (k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        input.value = input.value.slice(0, s) + k + input.value.slice(en);
        try {
          input.setSelectionRange(s + 1, s + 1);
        } catch (err) {}
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  opts.inputEl.addEventListener("input", refresh);

  refresh();

  return { onKey, refresh, close: () => {} };
}

// --- toast ---

// The toast lives in a *closed* shadow root, so the host's .shadowRoot is null
// even for the creating script — keep a direct reference to the box instead of
// re-querying through the host.
let toastHost: {
  host: HTMLElement;
  span: HTMLSpanElement;
  box: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
} | null = null;

const TOAST_CSS = `
.t{position:fixed;bottom:52px;left:50%;transform:translateX(-50%);z-index:2147483647;
  background:rgba(22,22,30,.96);color:#c0caf5;font:13px ui-monospace,Menlo,Consolas,monospace;
  padding:8px 14px;border:1px solid #414868;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);
  opacity:0;transition:opacity .12s ease;pointer-events:none;}
.t.on{opacity:1;}
`;

export function toast(msg: string): void {
  if (!toastHost) {
    const host = document.createElement("div");
    host.style.cssText = HOST_CSS;
    host.style.pointerEvents = "none";
    const sh = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = TOAST_CSS;
    const box = document.createElement("div");
    box.className = "t";
    const span = document.createElement("span");
    box.appendChild(span);
    sh.appendChild(style);
    sh.appendChild(box);
    document.documentElement.appendChild(host);
    toastHost = { host, span, box, timer: null };
  }
  toastHost.span.textContent = msg;
  toastHost.box.classList.add("on");
  if (toastHost.timer) clearTimeout(toastHost.timer);
  toastHost.timer = setTimeout(() => {
    if (toastHost) toastHost.box.classList.remove("on");
  }, 1400);
}
