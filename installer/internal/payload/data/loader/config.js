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

// Boot-stage trace for the loader itself. Writes to the SAME console the
// failure reports use (Services.console), so one capture path shows both:
// the announce pipeline files these lines into extension storage, where the
// diagnostics read them. An earlier version wrote files instead — and its own
// writes failed silently, which is the failure mode this code exists to end.
var lfDiag = function (msg) {
  lfLog("lazyfox loader: " + msg);
};
lfDiag("loader booted (config.js ran)");

// resource://lazyfox/ -> <profile>/chrome, so the actor modules (and the frame
// script) can be referenced by a stable URL. Substitutions are per process;
// the content-process copy is installed by actor-boot.js below.
try {
  var lfRes = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsISubstitutingProtocolHandler);
  lfRes.setSubstitution("lazyfox", Services.io.newFileURI(Services.dirsvc.get("UChrm", Ci.nsIFile)));
  lfDiag("resource://lazyfox mapped to UChrm");
} catch (e) {
  lfLog("lazyfox resource mapping: " + e);
  lfDiag("resource mapping FAILED: " + e);
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
    try {
      lfDiag("userChrome.uc.js loading into a browser window");
      Services.scriptloader.loadSubScriptWithOptions(ucUrl, {
        target: win,
        allowUnsafeURL: true,
      });
      win.__lazyfoxLoaded = true;
      lfDiag("userChrome.uc.js loaded OK");
    } catch (e) {
      lfLog("lazyfox userChrome.uc.js: " + e);
      lfDiag("userChrome.uc.js load FAILED: " + e);
    }
  } catch (e) {
    // per-window; the inner catch already reported
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
    lfDiag("actor-boot.js loaded into process manager");
  } catch (e) {
    lfLog("lazyfox process boot load: " + e);
    lfDiag("actor-boot.js load FAILED: " + e);
    return;
  }

  // WHERE THE MODULES LIVE, measured rather than assumed:
  //
  //   * directory svc: UChrm resolves ONLY in the parent — every content
  //     process throws NS_ERROR_FAILURE there (lazyfox process boot: ...) and
  //     the substitution was never made, so a resource:// registered module
  //     could never load where the child actor runs.
  //   * file: URIs: Firefox REFUSES to import a .sys.mjs from them —
  //     "System modules must be loaded from a trusted scheme" — so the
  //     "self-describing registration" the file: scheme was chosen for dies in
  //     the preflight below, before registration is attempted, and the actor
  //     is absent ON EVERY INSTALL (visible in lfLoaderErrs).
  //
  // The bridge that makes resource://lazyfox/ resolvable in content processes:
  // sharedData. config.js runs in the parent, resolves the directory URI,
  // and stores the URI STRING in the process manager's sharedData — which
  // Gecko propagates into every content process (including ones spawned
  // later). The boot script (actor-boot.js) reads it back through
  // Services.cpmm.sharedData and sets the substitution from a plain string —
  // NO dirsvc, NO file:// import. The registered URI is then resource://, a
  // trusted scheme on both sides.
  var DIR_URI = "";
  try {
    DIR_URI = Services.io.newFileURI(Services.dirsvc.get("UChrm", Ci.nsIFile)).spec;
    if (DIR_URI.charAt(DIR_URI.length - 1) !== "/") DIR_URI += "/";
    // The string propagates to every content process; the boot script turns
    // it back into a substitution. Set BEFORE loadProcessScript so the first
    // run of the boot script already sees it.
    try {
      Services.ppmm.sharedData.set("lazyfox-dir", DIR_URI);
    } catch (e2) {
      lfDiag("sharedData distribute failed: " + e2);
    }
  } catch (e) {
    lfLog("lazyfox actor dir resolve failed: " + e);
    lfDiag("dir resolve FAILED: " + e);
  }
  var childURI  = "resource://lazyfox/lazyfox-child.sys.mjs";
  var parentURI = "resource://lazyfox/lazyfox-parent.sys.mjs";
  try {
    // The preflight imports the URI that will actually be REGISTERED.
    if (typeof ChromeUtils.importESModule === "function") {
      var childMod = ChromeUtils.importESModule(childURI);
      var parentMod = ChromeUtils.importESModule(parentURI);
      if (typeof childMod.LazyfoxChild !== "function" || typeof parentMod.LazyfoxParent !== "function") {
        throw new Error("actor modules did not export the expected classes");
      }
      lfDiag("preflight OK: child=" + childURI + " parent=" + parentURI);
    } else {
      ChromeUtils.importModule(childURI); // legacy path
      lfDiag("preflight (importModule legacy) OK: child=" + childURI);
    }
  } catch (e) {
    lfLog("lazyfox actor preflight failed: " + e);
    lfDiag("preflight FAILED: " + e);
    return;
  }

  // esModuleURI is the modern option, moduleURI the older spelling; try the
  // pair first, then the single-name forms, per the platform's acceptance.
  var attempts = [
    { kind: "combined", opt: makeOpt("both") },
    { kind: "esModuleURI", opt: makeOpt("es") },
    { kind: "moduleURI", opt: makeOpt("mod") },
  ];
  for (var i = 0; i < attempts.length; i++) {
    try {
      ChromeUtils.registerWindowActor("Lazyfox", attempts[i].opt());
      lfDiag("registered (" + attempts[i].kind + ")");
      return;
    } catch (e) {
      lfLog("lazyfox actor register (" + attempts[i].kind + "): " + e);
      lfDiag("register " + attempts[i].kind + " FAILED: " + e);
    }
  }
  
  function makeOpt(kind) {
    return function () {
      // wantUntrusted is what makes the harness — and any fake keydown a page
    // scripts — able to mount this actor: with the default (false) the
    // protocol's keydown listener ignores untrusted events, and a page whose
    // only keystrokes are synthetic sits with data-lf-actor set but no trusted
    // channel for an entire session. Instantiation alone is harmless; every
    // decision in handleEvent is per-event and stays deliberately strict.
    var child = { events: { keydown: { wantUntrusted: true } } };
      var parent = {};
      if (kind === "both") { child.esModuleURI = childURI; child.moduleURI = childURI; parent.esModuleURI = parentURI; parent.moduleURI = parentURI; }
      else if (kind === "es") { child.esModuleURI = childURI; parent.esModuleURI = parentURI; }
      else { child.moduleURI = childURI; parent.moduleURI = parentURI; }
      // safeForUntrustedWebProcess MUST be true: since Firefox 159 the actor
      // instantiation check refuses every web/file content process for actors
      // that do not set it (dom.jsipc.check_safeForUntrustedWebProcess), and
      // the refusal surfaces as the remote-type error that kept this whole
      // bridge dark: "Window protocol 'Lazyfox' doesn't match remote type
      // 'web'". This bridge IS built for web content — it only listens for
      // keydown and pings the page with trusted clicks — so the opt-in is what
      // the flag exists for. Older Firefox ignores the unknown key.
      return { child: child, parent: parent, allFrames: false, safeForUntrustedWebProcess: true };
    };
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
