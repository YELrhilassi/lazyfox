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
export function shadowRootOf(el: Element): ShadowRoot | null {
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
}// Visit up to `limit` elements of a subtree, WITHOUT materializing the tree.
//
// Two callers walk a whole document looking for shadow roots (hints and the
// scroll controller), and both used to do it as
// `Array.prototype.slice.call(root.querySelectorAll("*"))` followed by
// `Math.min(all.length, MAX_SCAN)`. The cap was cosmetic: `querySelectorAll`
// had already built a NodeList of EVERY element and `slice` copied all of it
// into an array, so the bound applied to the loop and not to the allocation.
// On a large framework page that is a five-figure-element array allocated on
// every coalesced discovery tick, for a walk that stops at the first few
// thousand nodes anyway.
//
// A TreeWalker is lazy in exactly the way that was wanted: one node is produced
// at a time from any root (document, shadow root, element) and the loop can
// stop at the budget with nothing left over to collect. `truncated` says so, so
// a caller that hits the cap can state it rather than silently reporting "no
// more roots".
export function walkElements(
  root: ParentNode,
  limit: number,
  // `visit` may return `false` to STOP the walk: a caller with its own bound
  // (a time budget, a page that turned hostile) needs to end the traversal
  // rather than keep paying for the cap. `stopped` says which happened, so the
  // two reasons a walk ends early — the cap was reached and the caller gave up
  // — are never confused for each other in a report.
  visit: (el: Element) => void | boolean,
): { visited: number; truncated: boolean; stopped: boolean } {
  let visited = 0;
  try {
    const doc = (root as Document).createTreeWalker
      ? (root as Document)
      : ((root as ShadowRoot).ownerDocument as Document);
    if (!doc || typeof doc.createTreeWalker !== "function") {
      return { visited: 0, truncated: false, stopped: false };
    }
    // `root` may be a ShadowRoot, and createTreeWalker lives on Document but
    // accepts any node as the root of the walk.
    const walker = doc.createTreeWalker(root as unknown as Node, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (visited >= limit) return { visited, truncated: true, stopped: false };
      if (visit(node as Element) === false) {
        return { visited, truncated: false, stopped: true };
      }
      visited++;
      node = walker.nextNode();
    }
  } catch (e) {
    // A hostile page's tree must not break the caller; report what was seen.
  }
  return { visited, truncated: false, stopped: false };
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
    const sr = shadowRootOf(cur);
    if (!sr) break;
    const ae = sr.activeElement as Element | null;
    if (!ae) break;
    cur = ae;
    depth++;
  }
  return cur;
}

// The element that should RECEIVE focus for `el`.
//
// `el.isContentEditable` is true for every descendant of an editable root — it
// is inherited — so "the target is editable, focus it" sent focus to a `<p>`
// inside a composer such as ChatGPT's (whose editor is a contenteditable div
// full of them). `HTMLElement.focus()` on a non-focusable descendant moves
// nothing, and the field was then reported as refusing focus. The focusable
// thing is the closest editable ROOT, so that is what this answers: an input
// itself, and for anything inside a contenteditable, the host of the subtree.
//
// `closest` returns the element itself when it matches, and `contenteditable=""`
// means true; only an explicit `"false"` opts out (a non-editable island inside
// an editable document must never be promoted to the focus target).
export function editableRootOf(el: Element | null): Element | null {
  if (!el) return null;
  let tag = "";
  try {
    tag = String(el.tagName || "").replace(/^[^:]+:/, "").toUpperCase();
  } catch (e) {
    tag = "";
  }
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return el;
  try {
    if (typeof el.closest === "function") {
      const ce = el.closest("[contenteditable]");
      if (ce) {
        const v = String(ce.getAttribute("contenteditable") || "true").toLowerCase();
        if (v !== "false") return ce;
      }
    }
  } catch (e) {
    // A hostile page's DOM must not break the caller.
  }
  return el;
}

// Did focus land on `original`, or on something that legitimately stands in for
// it? Two stand-ins are real rather than theoretical, and both used to be
// reported as a failure:
//
//   * the editable ROOT of a composer, when the node we aimed at is a paragraph
//     inside it (`focus()` on a non-focusable descendant moves nothing, so the
//     root is what actually takes focus);
//   * the host a field inside a CLOSED shadow root reports: `document.activeElement`
//     is the host there, and `deepTypingFocus` resolves it back to the field, so
//     the field is the answer as long as the caller goes through the deep walk.
//
// `aimed` is the element `focus()` was actually given, when the caller aimed at
// a root rather than at the original node. `body` never counts: focus falling
// back to the document is exactly the failure this exists to detect.
export function focusLandedOn(original: Element, aimed?: Element | null): boolean {
  try {
    if (!original) return false;
    const target = aimed || editableRootOf(original) || original;
    const active = document.activeElement;
    const deep = deepTypingFocus(active) || active;
    if (!deep) return false;
    if (deep === document.body || deep === document.documentElement) return false;
    if (deep === target || target.contains(deep)) return true;
    if (deep === original || original.contains(deep)) return true;
    const root = editableRootOf(original);
    return !!root && deep === root;
  } catch (e) {
    return false;
  }
}

// Blur whatever actually holds focus, following shadow roots, and answer
// whether the user is no longer typing anywhere. Focus inside a closed root
// lives on the deep element while `document.activeElement` reports the host, so
// blurring only `activeElement` is a no-op there (a custom element host is not
// focusable) — the deep element is tried first, then the editable root, then
// the host.
export function blurTypingFocus(): boolean {
  let active: Element | null = null;
  try {
    active = document.activeElement;
  } catch (e) {
    return true;
  }
  const deep = deepTypingFocus(active);
  const candidates: Array<Element | null> = [deep, editableRootOf(deep), active];
  for (const c of candidates) {
    try {
      if (!isTypingTarget(document.activeElement)) break;
    } catch (e) {
      break;
    }
    if (!c || c === document.body || c === document.documentElement) continue;
    try {
      const he = c as HTMLElement;
      if (typeof he.blur === "function") he.blur();
    } catch (e) {
      // ignore — one candidate failing must not stop the next
    }
  }
  try {
    return !isTypingTarget(document.activeElement);
  } catch (e) {
    return true;
  }
}

// Unified typing-target predicate. Strips any "html:" style namespace prefix
// (chrome's Services.focus reports namespaced tag names) and accepts the
// superset of conditions the old content/chrome/frame copies each knew.
export function isTypingTarget(el: Element | null): boolean {
  const target = deepTypingFocus(el);
  if (!target || !target.tagName) return false;
  // `designMode` documents are typing surfaces EVERYWHERE.
  //
  // A document with designMode on makes its whole body editable — this is how
  // Google Docs and most legacy rich-text editors implement their canvas — so
  // none of the per-element tests below can identify it: the caret sits in a
  // <div>, there is no contenteditable attribute, and there is no focusable
  // field at all. Without this branch the guard answered "not typing" there and
  // every shortcut letter was consumed as a page key (the scroll keys take j, k,
  // d, u, g) while the user was writing a document. Measured behaviour before
  // the fix: typing `d` in a designMode editor scrolled the page instead.
  let doc: Document | null = null;
  try {
    doc = (target.ownerDocument || null) as Document | null;
  } catch (e) {
    doc = null;
  }
  if (doc && String((doc as Document & { designMode?: string }).designMode || "").toLowerCase() === "on") {
    return true;
  }
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
 * Is this field the owner of an OPEN suggestion list?
 *
 * THE REPORT (2026-10-20): "on Google it opens the search suggestions and I
 * still have to click outside to make that disappear." Measured in the harness
 * against google.com: Escape in the search box blurs it, the page's own keydown
 * handler NEVER runs (the ladder consumed the press), and the suggestion list
 * stays open. Blur does not close that list, and a synthetic Escape dispatched
 * at the field is ignored — so the page's own, trusted press is the only thing
 * that dismisses it.
 *
 * A field that announces an AVAILABLE POPUP is therefore the one typing target
 * whose Escape is unambiguous and field-scoped: "close my list". Everything
 * else keeps the §14.3 rule, where the press is consumed so a dialog holding a
 * half-filled form cannot close under the user.
 *
 * The test is the ARIA contract, not a site: `aria-expanded="true"` on an
 * element that is combobox-shaped — `role="combobox"`, a field that declares
 * `aria-autocomplete`, or one that names the popup it owns through
 * `aria-controls` / `aria-owns`. An expanded plain input also counts: it can
 * only be announcing a popup it owns.
 *
 * Bounded on purpose (four ancestors): a wrapper puts the state one or two
 * levels up, and a page that marks its whole app expanded must not make every
 * field on it a combobox.
 */
export function isExpandedCombobox(el: Element | null): boolean {
  let cur: Element | null = deepTypingFocus(el) || el;
  for (let depth = 0; cur && depth < 4; depth++) {
    try {
      const attr = (name: string): string => {
        const fn = (cur as Element).getAttribute;
        if (typeof fn !== "function") return "";
        return String(fn.call(cur, name) || "");
      };
      if (attr("aria-expanded").toLowerCase() === "true") {
        const role = attr("role").toLowerCase();
        const owns = attr("aria-controls") !== "" || attr("aria-owns") !== "";
        const auto = attr("aria-autocomplete") !== "";
        const tag = String((cur as Element).tagName || "")
          .replace(/^[^:]+:/, "")
          .toUpperCase();
        if (role === "combobox" || owns || auto || tag === "INPUT" || tag === "TEXTAREA") {
          return true;
        }
      }
    } catch (e) {
      // A hostile DOM must not decide this.
    }
    try {
      cur = (cur as Element).parentElement || null;
    } catch (e) {
      cur = null;
    }
  }
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

/**
 * Is this event happening somewhere the user is typing?
 *
 * MEMOISED PER EVENT, and that is not only about cost. The answer is a property
 * of the EVENT ("where did this keystroke happen"), not of the live DOM, so
 * recomputing it can only ever produce a worse answer. It also used to produce a
 * DIFFERENT one: the content dispatcher asks this question three times for one
 * keydown (the hint branch, the typing guard, the Ctrl+digit branch), and any
 * handler that runs in between can move focus — so the same keystroke could be
 * classified "typing" in one place and "not typing" twenty lines later, and the
 * two halves of one dispatch disagreed about whether the user was editing text.
 * Caching it also removes the real cost: each call allocates a composedPath and
 * walks up to six composed ancestors through the extension's shadow-root door.
 *
 * A WeakMap, not a property on the event: the event objects belong to the page's
 * realm and must not be mutated (a page can read what the extension writes to
 * its own objects in the same process), and a keypress/keyup tail is a DIFFERENT
 * event object that answers for itself.
 */
const typingAnswer = new WeakMap<Event, boolean>();

export function isTypingEvent(e: Event): boolean {
  let answer = typingAnswer.get(e);
  if (answer === undefined) {
    answer = isTypingTarget(typingTargetOf(e));
    typingAnswer.set(e, answer);
  }
  return answer;
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
