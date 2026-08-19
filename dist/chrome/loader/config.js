// skip 1st line
lockPref("xpinstall.signatures.required", false);

function lfLoad(win) {
  try {
    if (!win || !win.gBrowser || win.__lazyfoxLoaded) return;
    var ucFile = Services.dirsvc.get("UChrm", Ci.nsIFile);
    ucFile.append("userChrome.uc.js");
    var ucUrl = Services.io.newFileURI(ucFile).spec;
    // Firefox 155 (bug 1974213) stopped trusting file:/jar: URLs in
    // loadSubScript; the explicit allowUnsafeURL opt-in keeps the profile's
    // chrome/ scripts loadable on both old and new Firefox (older versions
    // simply ignore the unknown option).
    Services.scriptloader.loadSubScriptWithOptions(ucUrl, {
      target: win,
      allowUnsafeURL: true,
    });
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
