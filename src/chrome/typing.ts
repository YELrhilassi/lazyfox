// Chrome-side typing detection: whether the user is typing into an editable
// (page input, URL bar, etc.). Chrome cannot reliably see which element inside
// remote content has focus, so a tiny frame script (chrome/frame.js) reports
// an extra signal; the rest comes from the forwarded key event's
// originalTarget and Services.focus. When the leader key is pressed while
// typing, it must type normally instead of opening the which-key bar.

function isTypingTarget(t: unknown): boolean {
  if (!t) return false;
  try {
    const el = t as Element;
    // Content key events forwarded to chrome arrive with namespaced tag names
    // like "html:input" (lowercase, namespaced), so strip any "prefix:" and
    // upper-case before comparing.
    const tag = String(el.tagName || "").replace(/^.*:/, "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    const ce = el.getAttribute && el.getAttribute("contenteditable");
    if (ce === "true" || ce === "") return true;
    if (el.getAttribute && el.getAttribute("role") === "textbox") return true;
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
  } catch (e) {
    return false;
  }
  return false;
}

export interface TypingChannel {
  focusedIsTyping(e: KeyboardEvent): boolean;
  focusedTypingValue(e: KeyboardEvent): string;
  reset(): void;
}

export function createTypingChannel(): TypingChannel {
  let contentTyping = false;

  function initFrameChannel() {
    try {
      const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
      const res = Services.io
        .getProtocolHandler("resource")
        .QueryInterface(Ci.nsISubstitutingProtocolHandler);
      res.setSubstitution("lazyfox", Services.io.newFileURI(dir));
      const mm = Services.mm || (window as unknown as { messageManager?: unknown }).messageManager;
      if (mm) {
        try {
          mm.loadFrameScript("resource://lazyfox/frame.js", true);
        } catch (e) {
          // Frame scripts may be disabled on some builds; the fallbacks below
          // still cover the common cases.
        }
        mm.addMessageListener("lazyfox:editing", (m: { data?: { typing?: boolean } }) => {
          contentTyping = !!(m && m.data && m.data.typing);
        });
      }
    } catch (e) {
      try {
        Services.console.logStringMessage("lazyfox frame channel: " + e);
      } catch (x) {
        // ignore
      }
    }
  }
  initFrameChannel();

  function focusedTypingTarget(e: KeyboardEvent): Element | null {
    try {
      const t = (e as unknown as { originalTarget?: unknown }).originalTarget;
      if (isTypingTarget(t as Element)) return t as Element;
    } catch (err) {
      // ignore
    }
    try {
      const fd = (document as unknown as { commandDispatcher?: { focusedElement?: unknown } })
        .commandDispatcher;
      if (fd && isTypingTarget(fd.focusedElement as Element)) return fd.focusedElement as Element;
    } catch (err) {
      // ignore
    }
    try {
      const f = Services.focus.focusedElement;
      if (isTypingTarget(f)) return f;
    } catch (err) {
      // ignore
    }
    // In-process pages (the command center): the chrome command dispatcher and
    // Services.focus see same-process focus, but a process-isolated extension
    // page is only reported through the (possibly inert) frame script — ask
    // the page's own document directly. Cross-process accesses throw and are
    // caught, so remote content falls through to the other signals.
    try {
      const tab = window.gBrowser && window.gBrowser.selectedTab;
      const cw = tab && tab.linkedBrowser && tab.linkedBrowser.contentWindow;
      if (cw && cw.document && cw.document.activeElement && isTypingTarget(cw.document.activeElement)) {
        return cw.document.activeElement;
      }
    } catch (err) {
      // ignore
    }
    // Direct content-window probe: in-process pages (command center,
    // about: pages) may have a focused input that the chrome-level signals
    // (originalTarget, commandDispatcher, Services.focus) report as the
    // <browser> wrapper rather than the element inside it.
    try {
      const b = window.gBrowser && window.gBrowser.selectedBrowser;
      if (b && b.contentWindow && b.contentWindow.document) {
        const ae = b.contentWindow.document.activeElement;
        if (ae && isTypingTarget(ae)) return ae;
      }
    } catch (err) {
      // cross-process: ignore
    }
    return null;
  }

  function focusedIsTyping(e: KeyboardEvent): boolean {
    if (focusedTypingTarget(e)) return true;
    try {
      const tab = window.gBrowser && window.gBrowser.selectedTab;
      if (tab && typeof SessionStore !== "undefined" && SessionStore.getCustomTabValue) {
        if (SessionStore.getCustomTabValue(tab, "lfTyping") === "1") return true;
      }
    } catch (err) {
      // ignore
    }
    if (contentTyping) return true;
    return false;
  }

  // The text inside the focused typing target ("" when none or empty). Used to
  // tell "the user is composing text" from "an empty input merely holds focus"
  // — the command center's empty home input must still let `;` arm the leader.
  function focusedTypingValue(e: KeyboardEvent): string {
    const t = focusedTypingTarget(e);
    if (!t) return "";
    try {
      const tag = String(t.tagName || "").replace(/^.*:/, "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return (t as HTMLInputElement).value || "";
      const he = t as HTMLElement;
      if (he.isContentEditable || (t.getAttribute && t.getAttribute("contenteditable") === "true")) {
        return he.textContent || "";
      }
    } catch (err) {
      // ignore
    }
    return "";
  }

  return {
    focusedIsTyping,
    focusedTypingValue,
    reset: () => {
      contentTyping = false;
    },
  };
}
