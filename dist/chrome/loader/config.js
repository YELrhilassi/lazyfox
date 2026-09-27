// skip 1st line
lockPref("xpinstall.signatures.required", false);

// Report a loader failure, and never throw while doing it.
//
// This is the fallback path of a fallback: everything it reports has already
// failed, including possibly Services.console itself in a process that is not a
// chrome window. An empty catch is correct here precisely BECAUSE there is
// nothing left to try -- it used to be written out six times, which is why this
// is now one function.
function lfLog(msg) {
  try {
    Services.console.logStringMessage(msg);
  } catch (x) {}
}

// resource://lazyfox/ -> <profile>/chrome, so the actor modules (and the frame
// script) can be referenced by a stable URL. Substitutions are per process;
// the content-process copy is installed by actor-boot.js below.
try {
  var lfRes = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsISubstitutingProtocolHandler);
  lfRes.setSubstitution("lazyfox", Services.io.newFileURI(Services.dirsvc.get("UChrm", Ci.nsIFile)));
} catch (e) {
  lfLog("lazyfox resource mapping: " + e);
}

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
    lfLog("lazyfox userChrome.uc.js: " + e);
  }
}

// ---------------------------------------------------------------------------
// Content-process bridge (the "Lazyfox" JS window actor pair).
//
// The extension's content script cannot run on about: pages, on the error page
// you land on after a bad URL, or on the domains Firefox withholds content
// scripts from — so on those pages Lazyfox used to be unreachable and the user
// was stuck. A JS window actor is Firefox's supported way to run privileged
// code inside a content process; the pair registered here restores the leader
// key and the vim scroll keys on exactly those pages.
//
// Every step is best-effort and each is skipped independently: if the browser
// does not support process scripts or window actors, or the modules cannot be
// loaded, nothing is registered and Lazyfox keeps the behavior it had before.
// Nothing here can break a page.
// ---------------------------------------------------------------------------
(function lfActor() {
  // Mirror the resource:// mapping into content processes (see actor-boot.js).
  // The parent reads this file and injects its source into each content
  // process, which is why the URL may be a resource:// one of ours.
  try {
    Services.ppmm.loadProcessScript("resource://lazyfox/actor-boot.js", true);
  } catch (e) {
    lfLog("lazyfox process boot load: " + e);
  }

  // Pre-flight: prove the modules are importable and export the classes the
  // actor manager looks for (LazyfoxChild / LazyfoxParent) BEFORE registering.
  // A registration whose module cannot load would otherwise fail on every key
  // press in every process.
  var childURI = "resource://lazyfox/lazyfox-child.sys.mjs";
  var parentURI = "resource://lazyfox/lazyfox-parent.sys.mjs";
  try {
    var childMod = ChromeUtils.importESModule(childURI);
    var parentMod = ChromeUtils.importESModule(parentURI);
    if (typeof childMod.LazyfoxChild !== "function" || typeof parentMod.LazyfoxParent !== "function") {
      throw new Error("actor modules did not export the expected classes");
    }
  } catch (e) {
    lfLog("lazyfox actor preflight failed: " + e);
    return;
  }

  // Newer Firefox names the option esModuleURI; older releases only understand
  // moduleURI. Register with whichever this browser accepts.
  var options = {
    child: { events: { keydown: {} } },
    parent: {},
    allFrames: false,
  };
  options.child.esModuleURI = childURI;
  options.child.moduleURI = childURI;
  options.parent.esModuleURI = parentURI;
  options.parent.moduleURI = parentURI;
  try {
    ChromeUtils.registerWindowActor("Lazyfox", options);
    return;
  } catch (e) {
    lfLog("lazyfox actor register (combined): " + e);
  }
  // Retry without the keys the browser rejected, one family at a time.
  try {
    ChromeUtils.registerWindowActor("Lazyfox", {
      child: { esModuleURI: childURI, events: { keydown: {} } },
      parent: { esModuleURI: parentURI },
      allFrames: false,
    });
  } catch (e2) {
    try {
      ChromeUtils.registerWindowActor("Lazyfox", {
        child: { moduleURI: childURI, events: { keydown: {} } },
        parent: { moduleURI: parentURI },
        allFrames: false,
      });
    } catch (e3) {
      lfLog("lazyfox actor register failed: " + e3);
    }
  }
})();

try {
  Services.obs.addObserver(
    function (subject) {
      try {
        lfLoad(subject);
      } catch (e) {
        // One window failing to load must not stop the observer firing for the
        // next one; lfLoad is per-window and already reports its own errors.
      }
    },
    "browser-delayed-startup-finished",
    false
  );
} catch (e) {
  // Services.obs is unavailable in a context that is not a chrome window
  // (about: pages, the add-on manager). Nothing to observe, nothing to do.
}
