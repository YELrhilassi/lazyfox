// Process script injected into every content process by the profile loader
// (chrome/loader/config.js).
//
// Resource-protocol substitutions are per process. The browser process maps
// resource://lazyfox/ → <profile>/chrome so it can load userChrome.uc.js, but
// each content process needs the same mapping before the window actor's child
// module (resource://lazyfox/lazyfox-child.sys.mjs) can be imported there. That
// module is what gives pages the content script cannot reach — about: pages,
// the page you land on after a bad URL, restricted sites — the leader key and
// the vim scroll keys.
//
// Best-effort by design: if this process script mechanism is unavailable, the
// mapping is never set, the actor module cannot load, and Lazyfox simply keeps
// the behavior it had before. Nothing here can break a page.
(function () {
  "use strict";

  try {
    const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
    const res = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsISubstitutingProtocolHandler);
    res.setSubstitution("lazyfox", Services.io.newFileURI(dir));
  } catch (e) {
    try {
      Services.console.logStringMessage("lazyfox process boot: " + e);
    } catch (x) {
      // ignore
    }
  }
})();
