// Persistent relay bridge page (relay.html). One hidden tab carries every
// chrome-helper <-> background message; see docs/MESSAGING.md for the full
// design.
//
// Two worlds meet here:
//
//   - The background owns a runtime Port connected by this page
//     (browser.runtime.connect, name "lazyfox-relay[:<windowId>]").
//   - The chrome helper (chrome-privileged, no browser.runtime) reaches this
//     page's window directly through postMessage.
//
// Wire protocol (all messages are { lfx: <msg> }):
//
//   helper -> page : { type: "req", id, action, arg }   (chrome -> background)
//   page  -> helper: { type: "resp", id, result }       (background reply)
//   page  -> helper: { type: "cmd", action, arg }       (background -> chrome)
//   page  -> helper: { type: "ready" }                  (port connected)
//
// The page is deliberately tiny: it renders nothing and only shuttles messages,
// so a hidden relay tab costs almost nothing.
(function () {
  "use strict";
  if (window.top !== window) return;

  let port: any = null;
  let portName = "lazyfox-relay";

  // The chrome helper attaches its window listener asynchronously (it polls
  // every 500ms and re-resolves the relay window after a recreation — a
  // session restore removes the relay tab, so the helper is often a beat
  // behind the new page). A background -> chrome command that lands before
  // the helper attached would be posted into an unlistened window and lost.
  // Buffer such commands until the helper announces itself ("hello"), then
  // flush in order. Commands are never re-posted: once helperReady, every
  // new command goes straight out.
  let helperReady = false;
  const pendingCmds: any[] = [];
  const CMD_TTL = 6000;
  const flushCmds = (): void => {
    if (!helperReady) return;
    while (pendingCmds.length) {
      const c = pendingCmds.shift()!;
      try {
        window.postMessage({ lfx: c }, "*");
      } catch (e) {
        // ignore
      }
    }
  };
  const bufferCmd = (c: any): void => {
    pendingCmds.push(c);
    // Bound the buffer so a dead helper can't grow it forever; a stale
    // command must never fire late.
    setTimeout(() => {
      const i = pendingCmds.indexOf(c);
      if (i >= 0) pendingCmds.splice(i, 1);
    }, CMD_TTL);
    if (pendingCmds.length > 64) pendingCmds.splice(0, pendingCmds.length - 64);
  };

  // Keep a live port: the background (re)loads, disconnects and crashes just
  // like any other process; the relay tab survives and must reconnect.
  function connect(): void {
    try {
      port = browser.runtime.connect({ name: portName });
    } catch (e) {
      port = null;
    }
    if (!port) {
      (window as any).__lfxReady = false;
      setTimeout(connect, 500);
      return;
    }
    // background -> helper: post into this window; the chrome helper listens
    // on the same window object. If the helper hasn't attached yet (window
    // just recreated after a restore), buffer until its "hello" arrives.
    port.onMessage.addListener((msg: any) => {
      if (helperReady) {
        try {
          window.postMessage({ lfx: msg }, "*");
        } catch (e) {
          // ignore
        }
        return;
      }
      bufferCmd(msg);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      (window as any).__lfxReady = false;
      setTimeout(connect, 500);
    });
    (window as any).__lfxReady = true;
    try {
      window.postMessage({ lfx: { type: "ready" } }, "*");
    } catch (e) {
      // ignore
    }
  }

  // helper -> page: forward reqs over the port; "hello" only marks the
  // helper as attached (its listener is live), then flushes buffered cmds.
  // The reply to a req comes back through the port and is posted into the
  // window again (see onMessage above).
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e && e.data;
    if (!d || !d.lfx || typeof d.lfx !== "object") return;
    if (d.lfx.type === "hello") {
      helperReady = true;
      flushCmds();
      return;
    }
    if (d.lfx.type !== "req") return;
    if (!port) return;
    try {
      port.postMessage(d.lfx);
    } catch (e2) {
      // ignore
    }
  });

  // The background must know which window this relay belongs to (each window
  // gets its own relay + port). runtime.Port.sender may omit tab details, so
  // carry the windowId explicitly in the connection name.
  try {
    browser.tabs.getCurrent().then((tab: any) => {
      if (tab && tab.windowId != null) portName = "lazyfox-relay:" + tab.windowId;
    }).catch(() => {});
  } catch (e) {
    // ignore — connect with the bare name
  }
  connect();
})();
