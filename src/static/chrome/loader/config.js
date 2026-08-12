// skip 1st line
lockPref("xpinstall.signatures.required", false);

function lfLoad(win) {
  try {
    if (!win || !win.gBrowser || win.__lazyfoxLoaded) return;
    var ucFile = Services.dirsvc.get("UChrm", Ci.nsIFile);
    ucFile.append("userChrome.uc.js");
    var ucUrl = Services.io.newFileURI(ucFile).spec;
    Services.scriptloader.loadSubScript(ucUrl, win);
    win.__lazyfoxLoaded = true;
  } catch (e) {
    try {
      Services.console.logStringMessage("lazyfox userChrome.uc.js: " + e);
    } catch (x) {}
  }
}

try {
  Services.obs.addObserver(
    function (subject) {
      try {
        lfLoad(subject);
      } catch (e) {}
    },
    "browser-delayed-startup-finished",
    false
  );
} catch (e) {}
