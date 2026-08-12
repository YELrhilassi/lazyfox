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
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
  } catch (e) {
    return false;
  }
  return false;
}

export interface TypingChannel {
  focusedIsTyping(e: KeyboardEvent): boolean;
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

  function focusedIsTyping(e: KeyboardEvent): boolean {
    try {
      if (isTypingTarget((e as unknown as { originalTarget?: unknown }).originalTarget)) return true;
    } catch (err) {
      // ignore
    }
    try {
      const fd = (document as unknown as { commandDispatcher?: { focusedElement?: unknown } })
        .commandDispatcher;
      if (fd && isTypingTarget(fd.focusedElement)) return true;
    } catch (err) {
      // ignore
    }
    try {
      if (isTypingTarget(Services.focus.focusedElement)) return true;
    } catch (err) {
      // ignore
    }
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

  return {
    focusedIsTyping,
    reset: () => {
      contentTyping = false;
    },
  };
}
