// Loaded into every content process by userChrome.uc.js (message manager).
// Chrome cannot see which element inside remote content has focus, so this
// tiny frame script reports whether an editable is focused. Chrome uses that
// to let the leader key type normally inside page inputs instead of opening
// the which-key bar.
//
// NOTE: on recent Firefox builds frame scripts (message managers) are inert
// for remote content, so this is a best-effort extra signal — chrome also
// detects a focused content input directly from the forwarded key event's
// originalTarget / Services.focus.focusedElement (whose tag names arrive
// namespaced as "html:input" and are matched by isTypingTarget).
(function () {
  "use strict";

  try {
    if (content.top !== content) return;
  } catch (e) {}

  // Deepest element actually focused inside an open shadow root: custom
  // elements (Reddit's <faceplate-search-input>, ...) keep their real input
  // in shadow DOM and only the host shows up as activeElement here.
  function deepFocus(el: Element | null): Element | null {
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

  function typingNow(): boolean {
    const ae = deepFocus(content.document.activeElement as Element | null);
    if (!ae || !ae.tagName) return false;
    const t = ae.tagName;
    return (
      t === "INPUT" ||
      t === "TEXTAREA" ||
      t === "SELECT" ||
      t === "ISINDEX" ||
      (ae as HTMLElement).isContentEditable ||
      (ae.getAttribute && ae.getAttribute("contenteditable") === "true") ||
      (ae.closest && ae.closest('[contenteditable="true"]') != null)
    );
  }

  let last: boolean | null = null;
  function report(): void {
    const typing = !!typingNow();
    if (typing === last) return;
    last = typing;
    try {
      sendAsyncMessage("lazyfox:editing", { typing: typing });
    } catch (e) {}
  }

  content.addEventListener("focusin", report, true);
  content.addEventListener("focusout", report, true);
  content.addEventListener("blur", report, true);
  report();
})();
