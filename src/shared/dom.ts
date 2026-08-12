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
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

// Unified typing-target predicate. Strips any "html:" style namespace prefix
// (chrome's Services.focus reports namespaced tag names) and accepts the
// superset of conditions the old content/chrome/frame copies each knew.
export function isTypingTarget(el: Element | null): boolean {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).replace(/^[^:]+:/, "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") {
    return true;
  }
  const he = el as HTMLElement;
  if (he.isContentEditable) return true;
  if (el.getAttribute && el.getAttribute("contenteditable") === "true") return true;
  if (el.getAttribute && el.getAttribute("role") === "textbox") return true;
  if (el.closest && el.closest('[contenteditable="true"]')) return true;
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
  for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
  if (text) node.textContent = text;
  return node;
}
