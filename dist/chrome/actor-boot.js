"use strict";
(() => {
  // src/chrome/actor-boot.ts
  (function() {
    "use strict";
    function setSub(uriSpec) {
      if (!uriSpec || typeof uriSpec !== "string" || uriSpec.indexOf("file:") !== 0) return;
      const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsISubstitutingProtocolHandler);
      res.setSubstitution("lazyfox", Services.io.newURI(uriSpec, null, null));
    }
    try {
      const pm = Services.cpmm || Services.ppmm;
      const dirSpec = pm && pm.sharedData && pm.sharedData.get("lazyfox-dir") || null;
      if (dirSpec) {
        setSub(String(dirSpec));
        return;
      }
      const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
      setSub(Services.io.newFileURI(dir).spec);
    } catch (e) {
      try {
        Services.console.logStringMessage("lazyfox process boot: " + e);
      } catch (x) {
      }
    }
  })();
})();
