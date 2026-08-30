// Persistent relay bridge page (relay.html). One hidden tab carries every
// chrome-helper <-> background message; see docs/MESSAGING.md for the full
// design.
//
// Two worlds meet here:
//
//   - The background owns a runtime Port connected by this page
//     (browser.runtime.connect, name "lazyfox-relay[:<windowId>]").
//   - The chrome helper (chrome-privileged, no browser.runtime) reaches this
//     page through the TAB's URL — not the page's window object. Remote
//     (out-of-process) extension pages have NO window object reachable from
//     the chrome process (contentWindow / browsingContext.window are null on
//     the chrome side for OOP tabs), so postMessage cannot cross that
//     boundary. Same-document URL navigation works in both directions, so the
//     relay rides URL hashes:
//
//       helper -> page : helper navigates the tab to
//                        #lfr=rq.<id>.<action>.<argEnc>  (this page forwards it
//                        over the port, then clears the hash)
//       page  -> helper: the page rewrites its own URL (history.replaceState,
//                        no reload) to
//                        #lfr=rp.<id>.<jsonEnc>   (reply to a request)
//                        #lfr=cm.<action>.<jsonEnc>  (background -> chrome cmd)
//                        and the helper (which polls the tab URL every 500ms)
//                        picks them up and clears the slot.
//
// The URL is a single slot: at most one message in flight at a time. This page
// never clobbers a pending request hash (the helper's rq) — outbound replies/
// commands buffer until the slot frees, so a reply can never be overwritten.
//
// The page is deliberately tiny: it renders nothing and only shuttles messages,
// so a hidden relay tab costs almost nothing.
(function () {
  "use strict";
  if (window.top !== window) return;

  let port: any = null;
  let portName = "lazyfox-relay";
  const HASH_PREFIX = "#lfr=";
  const base = (() => {
    try {
      return location.href.split("#")[0];
    } catch (e) {
      return "";
    }
  })();
  // Outbound messages (rp/cm) buffered while a request hash occupies the slot.
  const pendingOut: Array<{ hash: string }> = [];
  const OUT_TTL = 6000;
  const PENDING_KEY = "lfRelayPending";

  // The helper writes its rq hashes by NAVIGATING this tab, and a fragment
  // navigation from the chrome side can be a FULL RELOAD rather than a
  // same-document hash change. A reload destroys every in-memory variable —
  // including pendingOut — while the URL may have lost the hash the helper
  // was about to poll. So the outbound buffer is mirrored into sessionStorage
  // (survives reloads within the same tab) and re-flushed on every boot.
  function persistPending(): void {
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify(pendingOut.map((p) => p.hash))
      );
    } catch (e) {
      // ignore
    }
  }

  function loadPending(): void {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const h of arr) {
          if (typeof h === "string" && h) pendingOut.push({ hash: h });
        }
      }
      sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {
      // ignore
    }
  }

  // True while the URL holds our own rp/cm (waiting for the helper to read) or
  // the helper's rq (waiting for us to forward). The slot is otherwise free.
  function slotBusy(): boolean {
    try {
      return location.hash.indexOf(HASH_PREFIX) !== -1;
    } catch (e) {
      return false;
    }
  }

  // Write an outbound rp/cm hash into the URL (same-document, no reload).
  function writeHash(hash: string): void {
    try {
      history.replaceState(null, "", base + HASH_PREFIX + hash);
    } catch (e) {
      // ignore
    }
  }

  function flushPendingOut(): void {
    while (pendingOut.length && !slotBusy()) {
      const m = pendingOut.shift()!;
      writeHash(m.hash);
    }
    persistPending();
  }

  // Forward a helper request (rq hash) over the port, then free the slot.
  function handleReqHash(frag: string): void {
    // #lfr=rq.<id>.<action>.<argEnc>
    const rest = frag.slice(3);
    const d1 = rest.indexOf(".");
    if (d1 < 0) return;
    const id = Number(rest.slice(0, d1));
    const d2 = rest.indexOf(".", d1 + 1);
    const action = d2 < 0 ? decodeURIComponent(rest.slice(d1 + 1)) : decodeURIComponent(rest.slice(d1 + 1, d2));
    const arg = d2 >= 0 && rest.slice(d2 + 1) ? decodeURIComponent(rest.slice(d2 + 1)) : "";
    if (!port) {
      // No port yet (background still loading): drop — the helper's request
      // has its own timeout and retries (the announce loop / pollers).
      clearHash();
      return;
    }
    try {
      port.postMessage({ type: "req", id: id, action: action, arg: arg });
    } catch (e) {
      // ignore
    }
    clearHash();
  }

  function clearHash(): void {
    try {
      if (location.hash) history.replaceState(null, "", base);
    } catch (e) {
      // ignore
    }
    flushPendingOut();
  }

  // The helper navigates the tab (loadURI) to write rq hashes; we see them as
  // hashchange (same-document) or pageshow (a fresh load). Polling is the
  // backstop for both.
  function processHash(): void {
    try {
      const h = location.hash;
      if (h.indexOf(HASH_PREFIX) !== 0) {
        // Any non-relay hash (or none): the slot is free — flush anything the
        // helper hasn't picked up yet.
        flushPendingOut();
        return;
      }
      const frag = h.slice(HASH_PREFIX.length);
      if (frag.indexOf("rq.") === 0) handleReqHash(frag);
      // rp./cm. hashes are OUR OWN writes (awaiting the helper's read); the
      // helper clears them. Leave them alone.
    } catch (e) {
      // ignore
    }
  }

  // Keep a live port: the background (re)loads, disconnects and crashes just
  // like any other process; the relay tab survives and must reconnect.
  function connect(): void {
    try {
      port = browser.runtime.connect({ name: portName });
    } catch (e) {
      port = null;
    }
    if (!port) {
      setTimeout(connect, 500);
      return;
    }
    // background -> helper: reply (rp) or command (cm) written into our URL;
    // the helper polls it. Never clobber a pending request hash — buffer.
    port.onMessage.addListener((msg: any) => {
      if (!msg) return;
      const hash = encodeOutbound(msg);
      if (!hash) return;
      if (slotBusy()) {
        pendingOut.push({ hash: hash });
        persistPending();
        setTimeout(() => {
          const i = pendingOut.indexOf({ hash: hash });
          if (i >= 0) pendingOut.splice(i, 1);
          persistPending();
        }, OUT_TTL);
        if (pendingOut.length > 64) pendingOut.splice(0, pendingOut.length - 64);
        persistPending();
        return;
      }
      writeHash(hash);
      persistPending();
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
    // A port (re)connect frees the slot: the helper may have cleared a hash
    // while we were disconnected, so re-flush any buffered messages.
    flushPendingOut();
  }

  function encodeOutbound(msg: any): string | null {
    try {
      if (msg.type === "resp") {
        const json = msg.result !== undefined ? JSON.stringify(msg.result) : "null";
        return "rp." + String(msg.id) + "." + encodeURIComponent(json);
      }
      if (msg.type === "cmd") {
        const json = msg.arg !== undefined ? JSON.stringify(msg.arg) : "null";
        return "cm." + encodeURIComponent(String(msg.action || "")) + "." + encodeURIComponent(json);
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

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
  // Restore any outbound messages buffered before a reload (the helper's rq
  // navigations can fully reload this page, which otherwise destroys the
  // in-memory pendingOut). Re-flush once the slot is free.
  loadPending();
  connect();

  window.addEventListener("hashchange", processHash);
  window.addEventListener("pageshow", processHash);
  setInterval(processHash, 100);
})();
