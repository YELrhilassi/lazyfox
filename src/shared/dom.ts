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

// The shadow root of `el` as THIS extension may see it.
//
// `el.shadowRoot` is null for a closed root, and nothing in the page's own API
// reaches one. Firefox gives extensions exactly one door into a closed root,
// and it comes in two shapes. Measured in Firefox 158, inside a content script:
// `el.openOrClosedShadowRoot` works, while `browser.dom` is not even defined
// (the probe read `api=undefined browser=object`). So the property is tried
// first and the `browser.dom` call is the fallback for a host that only
// exposes the function form. In a plain page neither exists and the call falls
// through to the page's own view, which is all a page can ever see.
function shadowRootFor(el: Element): ShadowRoot | null {
  try {
    const prop = (el as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
    if (prop) return prop;
  } catch (e) {
    // Not an extension context, or the element hosts no root.
  }
  try {
    const g = globalThis as unknown as {
      browser?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } };
    };
    const open = g.browser && g.browser.dom && g.browser.dom.openOrClosedShadowRoot;
    if (typeof open === "function") {
      const root = open(el);
      if (root) return root;
    }
  } catch (e) {
    // Not a WebExtension context, or the element hosts no root.
  }
  return (el as HTMLElement).shadowRoot;
}

// Deepest element actually focused inside a shadow root. Custom
// elements (Reddit's <faceplate-search-input>, YouTube's search box, ...)
// host their real <input>/<textarea> in shadow DOM; the focused element the
// page reports (document.activeElement / the retargeted event target) is the
// HOST, not the editable inside. Follow shadowRoot.activeElement down so
// typing detection sees the real field instead of the wrapper.
//
// CLOSED roots count. Measured in Firefox 158, typing `;x` into a field
// inside a closed root CLOSED A TAB: `e.target` is the host AND
// `e.composedPath()` is `[host, body, html, document, window]` — Gecko keeps
// the shadow tree out of the composed path too, so retargeting is not the only
// blind spot. Without the extension door above, Lazyfox cannot tell that the
// user is typing in exactly the inputs that motivated this function.
export function deepTypingFocus(el: Element | null): Element | null {
  let cur = el;
  let depth = 0;
  while (cur && depth < 10) {
    const sr = shadowRootFor(cur);
    if (!sr) break;
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

/**
 * The element a keydown ACTUALLY happened in, for typing detection.
 *
 * `e.target` is not that element. A keydown inside a shadow root is retargeted
 * to the HOST, so a field inside a closed root — YouTube's search box, Reddit's
 * input, most component libraries — looks like a custom element, which is not a
 * typing target.
 *
 * `composedPath()` looked like the answer and is not. Measured in Firefox 158
 * against a real closed-root field: the path is `[host, body, html, document,
 * window]` — Gecko keeps the shadow tree out of it, so `path[0]` is the host
 * too. (That measurement is what `deepTypingFocus` now handles through the
 * extension's own shadow-root door.) The composed path is still worth walking:
 * it is free, and it settles the OPEN-root and synthetic-event cases outright.
 * `isTypingTarget` does the deep walk on whatever it is handed, so returning
 * the host here still resolves to the field inside it.
 */
export function typingTargetOf(e: Event): Element | null {
  const path = typeof e.composedPath === "function" ? e.composedPath() : null;
  if (path && path.length) {
    // path[0] is the deepest node, which for a keystroke is the field itself;
    // walk outward to the first element that could hold text, because a
    // keydown can also target a wrapper inside the input's shadow tree.
    for (const node of path.slice(0, 6)) {
      const el = node as Element;
      if (el && el.nodeType === 1 && isTypingTarget(el)) return el;
    }
    const first = path[0] as Element;
    if (first && first.nodeType === 1) return first;
  }
  return deepTypingFocus(e.target as Element | null);
}

/** Is this event happening somewhere the user is typing? */
export function isTypingEvent(e: Event): boolean {
  return isTypingTarget(typingTargetOf(e));
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

// Mirror a value onto an <html> attribute without ever throwing (a hostile
// page can make setAttribute fail, and the mirrors are best-effort state for
// the host/tests). Used by the find widget's data-lf-* state mirrors.
export function setHtmlAttr(name: string, value: string): void {
  try {
    document.documentElement.setAttribute(name, value);
  } catch (e) {
    // ignore
  }
}

export function removeHtmlAttr(name: string): void {
  try {
    document.documentElement.removeAttribute(name);
  } catch (e) {
    // ignore
  }
}
