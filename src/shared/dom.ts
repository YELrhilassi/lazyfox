// DOM helpers shared by every context. These touch the DOM, so they stay in
// TypeScript rather than the Go core.

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c] || c);
}

// Site favicon for a quick-launch app, via Google's favicon service so every
// web app shows its real icon without bundling artwork. Pure string math — no
// DOM — so it is safe from any context (command center, options page).
export function favicon(url: string): string {
  try {
    const host = new URL(url).hostname;
    return "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(host) + "&sz=64";
  } catch (e) {
    return "";
  }
}

// Deepest element actually focused inside an open shadow root. Custom
// elements (Reddit's <faceplate-search-input>, YouTube's search box, ...)
// host their real <input>/<textarea> in shadow DOM; the focused element the
// page reports (document.activeElement / the retargeted event target) is the
// HOST, not the editable inside. Follow shadowRoot.activeElement down so
// typing detection sees the real field instead of the wrapper.
export function deepTypingFocus(el: Element | null): Element | null {
  let cur = el;
  let depth = 0;
  while (cur && depth < 10) {
    const sr = (cur as HTMLElement).shadowRoot;
    if (!sr || sr.mode !== "open") break;
    const ae = sr.activeElement as Element | null;
    if (!ae) break;
    cur = ae;
    depth++;
  }
  return cur;
}

// Unified typing-target predicate. Strips any "html:" style namespace prefix
// (chrome's Services.focus reports namespaced tag names) and accepts the
// superset of conditions the old content/chrome/frame copies each knew.
export function isTypingTarget(el: Element | null): boolean {
  const target = deepTypingFocus(el);
  if (!target || !target.tagName) return false;
  const tag = String(target.tagName).replace(/^[^:]+:/, "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") {
    return true;
  }
  const he = target as HTMLElement;
  if (he.isContentEditable) return true;
  if (target.getAttribute && target.getAttribute("contenteditable") === "true") return true;
  if (target.getAttribute && target.getAttribute("role") === "textbox") return true;
  if (target.closest && target.closest('[contenteditable="true"]')) return true;
  return false;
}

export function isVisible(el: Element): boolean {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.bottom < -20 || r.top > (window.innerHeight || 0) + 20) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  return true;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

export function el(tag: string, attrs: Record<string, string> = {}, text = ""): HTMLElement {
  const node = document.createElement(tag);
  for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]!);
  if (text) node.textContent = text;
  return node;
}
