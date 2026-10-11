// Chrome-side typing detection: whether the user is typing into an editable
// (page input, URL bar, etc.). Chrome cannot reliably see which element inside
// remote content has focus, so a tiny frame script (chrome/frame.js) reports
// an extra signal; the rest comes from the forwarded key event's
// originalTarget and Services.focus. When the leader key is pressed while
// typing, it must type normally instead of opening the which-key bar.

function isTypingTarget(t: unknown): boolean {
  if (!t) return false;
  try {
    let el = t as Element;
    // Custom elements keep their real input in shadow DOM; the event target /
    // focusedElement reported here is the retargeted HOST, so pierce open
    // shadow roots down to the element that actually holds focus.
    let depth = 0;
    while (el && depth < 10) {
      const sr = (el as HTMLElement).shadowRoot;
      if (!sr || sr.mode !== "open") break;
      const ae = sr.activeElement as Element | null;
      if (!ae) break;
      el = ae;
      depth++;
    }
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
  // The element that actually holds focus, whichever signal found it (null when
  // focus is not in an editable). Used to tell the browser's own URL bar from a
  // page's editable — see isChromeUiFocus in main.ts.
  focusedTypingTarget(e: KeyboardEvent): Element | null;
  reset(): void;
}

export interface TypingChannelOptions {
  /**
   * Whether a typing signal that came from PAGE CONTENT can be believed right
   * now.
   *
   * It matters because the two content-derived signals are STICKY and outlive
   * the document that set them: `contentTyping` is a latch fed by the frame
   * script and reset only on window blur, and `lfTyping` is a session value on
   * the TAB, written by whichever content script last saw a caret in a field.
   * Neither is retracted when the document they describe goes away — a
   * navigation, a crash, a page whose script never runs again (a PDF viewer, a
   * restricted domain).
   *
   * While a stale one says "typing", the chrome helper declines EVERY key, and
   * on a chrome-owned page (about:, an extension page, an error page) nothing
   * else answers either: the leader key stops working, and so does every
   * binding, because the typing branch returns before any of them — while a
   * fresh tab in the same window works perfectly, which is why it reads as "it
   * stops responding for a while and then comes back on its own".
   *
   * So the host says when those signals can be trusted: only while this tab has
   * a content script that could still be reporting (see keystate's presence
   * model). The per-keystroke signals — the event's own target, the command
   * dispatcher, Services.focus — are always consulted, and they are the ones a
   * chrome-owned page needs.
   */
  contentSignalsLive?: () => boolean;
}

export function createTypingChannel(opts: TypingChannelOptions = {}): TypingChannel {
  const contentSignalsLive = opts.contentSignalsLive || (() => true);
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
    // The sticky, content-derived answers, and only while content is here to
    // keep them honest (see TypingChannelOptions.contentSignalsLive).
    let live = true;
    try {
      live = contentSignalsLive();
    } catch (err) {
      // A predicate that throws is not evidence of typing; the live per-event
      // signals above have already had their say.
      live = false;
    }
    if (!live) return false;
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
    focusedTypingTarget,
    reset: () => {
      contentTyping = false;
    },
  };
}
