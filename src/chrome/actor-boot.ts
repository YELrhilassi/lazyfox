// Process script injected into every content process by the profile loader
// (chrome/loader/config.js), through Services.ppmm.loadProcessScript.
//
// WHAT BROKE, TWICE, and why the sharedData indirection is the fix rather than
// a workaround:
//
//   1. `Services.dirsvc.get("UChrm")` DOES NOT WORK in a content process.
//      Measured on a live Firefox: every content process threw NS_ERROR_FAILURE
//      here (nsIProperties.get), the resource://lazyfox substitution was never
//      made, and the module registered as resource://lazyfox/... could not be
//      imported in the one process the child actor runs in.
//
//   2. Registering the module by its resolved file:// URI instead ALSO does not
//      work: "System modules must be loaded from a trusted scheme". The
//      preflight in config.js dies on the import itself, before registration,
//      and the actor stays absent — measured, and visible in the loader console
//      lines the alive announce relays into extension storage (lfLoaderErrs).
//
// So the directory URI travels as a plain STRING: config.js runs in the parent
// (where UChrm is servable), resolves the file URI, and stores it in the
// process manager's sharedData — which Gecko propagates into every content
// process, at spawn for new ones, synchronously for already-running ones. This
// script reads it and sets the SUBSTITUTION only; no directory service call,
// no file:// import. The modules then load as resource://lazyfox/*.sys.mjs,
// which IS a trusted scheme for system-module imports.
//
// The parent keeps its dirsvc fallback (it works there), and a content process
// that starts before sharedData arrives reports honestly rather than silently
// — but by the time config.js runs, sharedData is set BEFORE the process
// script is loaded, so the race is not load-bearing.
(function () {
  "use strict";

  function setSub(uriSpec: string | null | undefined): void {
    if (!uriSpec || typeof uriSpec !== "string" || uriSpec.indexOf("file:") !== 0) return;
    const res = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsISubstitutingProtocolHandler);
    res.setSubstitution("lazyfox", Services.io.newURI(uriSpec, null, null));
  }

  try {
    // sharedData value written by the parent's loader (config.js): the
    // profile-chrome directory as a full file:// URI, with trailing "/".
    // READ ON THE CHILD SIDE: Services.cpmm is the content process's
    // ProcessMessageManager — ppmm exists only in the parent, so an actor
    // module booted in a content process answers through cpmm (with ppmm as
    // the parent-side fallback for the loadProcessScript run that happens
    // in-process).
    const pm: any = (Services as any).cpmm || (Services as any).ppmm;
    const dirSpec =
      (pm && pm.sharedData && pm.sharedData.get("lazyfox-dir")) || null;
    if (dirSpec) {
      setSub(String(dirSpec));
      return;
    }
    // No sharedData value: the script is running before the parent stored it,
    // or this IS the parent process. dirsvc works in the parent, so probing it
    // distinguishes the two — in a content process it throws and the run ends
    // with a reported reason instead of silence.
    const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
    setSub(Services.io.newFileURI(dir).spec);
  } catch (e) {
    try {
      Services.console.logStringMessage("lazyfox process boot: " + e);
    } catch (x) {
      // The console service itself is gone — nothing left to report to.
    }
  }
})();
