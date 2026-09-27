"use strict";
(() => {
  // src/chrome/actor-boot.ts
  (function() {
    "use strict";
    try {
      const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
      const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsISubstitutingProtocolHandler);
      res.setSubstitution("lazyfox", Services.io.newFileURI(dir));
    } catch (e) {
      try {
        Services.console.logStringMessage("lazyfox process boot: " + e);
      } catch (x) {
      }
    }
  })();
})();
