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

  function typingNow() {
    const ae = document.activeElement;
    if (!ae || !ae.tagName) return false;
    const t = ae.tagName;
    return (
      t === "INPUT" ||
      t === "TEXTAREA" ||
      t === "SELECT" ||
      t === "ISINDEX" ||
      ae.isContentEditable ||
      (ae.getAttribute && ae.getAttribute("contenteditable") === "true") ||
      (ae.closest && ae.closest('[contenteditable="true"]') != null)
    );
  }

  let last = null;
  function report() {
    const typing = !!typingNow();
    if (typing === last) return;
    last = typing;
    try {
      sendAsyncMessage("lazyfox:editing", { typing: typing });
    } catch (e) {}
  }

  addEventListener("focusin", report, true);
  addEventListener("focusout", report, true);
  addEventListener("blur", report, true);
  report();
})();
