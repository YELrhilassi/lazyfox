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
//                        #lfr=rq.<id>.<action>.<jsonArg>  (this page forwards it
//                        over the port, then clears the hash)
//       page  -> helper: the page rewrites its own URL (history.replaceState,
//                        no reload) to
//                        #lfr=rp.<id>.<jsonResult>  (reply to a request)
//                        #lfr=cm.<seq>.<lost>.<action>.<jsonArg>
//                                                    (background -> chrome cmd)
//                        and the helper (which polls the tab URL every 500ms)
//                        picks them up and clears the slot.
//
// The command carries the background's own sequence number (seq) AND this
// page's count of commands it has had to throw away (lost). A command is the
// one message whose loss is SILENT — a dropped reply times its caller out — and
// those two numbers are how the helper sees a loss at all, and which side of
// this page it happened on. See chrome/relayseq.ts.
//
// The encoding and decoding of those three shapes live in
// shared/relay-wire.ts, NOT here. The format used to be hand-parsed on each
// side, so a change on one end could silently fail to match the other — and a
// message that does not match on a URL-hash channel fails by never arriving,
// which is close to undebuggable from the outside.
//
// The URL is a single slot: at most one message in flight at a time. This page
// never clobbers a pending request hash (the helper's rq) — outbound replies/
// commands buffer until the slot frees, so a reply can never be overwritten.
//
// The page is deliberately tiny: it renders nothing and only shuttles messages,
// so a hidden relay tab costs almost nothing.
import { HASH_PREFIX, decodeRequest, encodeCommand, encodeReply, isRelayHash, relayFragment } from "../shared/relay-wire";
(function () {
  "use strict";
  if (window.top !== window) return;

  let port: any = null;
  let portName = "lazyfox-relay";
  const base = (() => {
    try {
      return location.href.split("#")[0];
    } catch (e) {
      return "";
    }
  })();
  // Outbound messages (rp/cm) buffered while a request hash occupies the slot.
  //
  // `seq` rides along for a command (see encodeOutbound): it is the background's
  // number, and it must survive the buffer, because a command that waits here
  // and is then dropped is exactly the loss the counter exists to name.
  const pendingOut: Array<{ hash: string }> = [];
  const OUT_TTL = 6000;
  const PENDING_KEY = "lfRelayPending";
  // HOW MANY OUTBOUND COMMANDS THIS PAGE HAS THROWN AWAY. It is stamped on every
  // command this page writes (encodeCommand's `lost`), so the helper can tell a
  // command this buffer discarded from one the background never handed over.
  // Persisted with the buffer, so a reload does not reset it to zero and make
  // the two commands either side of it incomparable.
  let relayLost = 0;

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
        JSON.stringify({ pending: pendingOut.map((p) => p.hash), lost: relayLost })
      );
    } catch (e) {
      // ignore
    }
  }

  function loadPending(): void {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      // A bare array is a buffer written by a build that kept only the hashes;
      // reading it costs one `typeof` and avoids losing the buffer of whatever
      // page was on screen during an upgrade.
      const hashes = Array.isArray(saved) ? saved : saved && saved.pending;
      if (Array.isArray(hashes)) {
        for (const h of hashes) {
          if (typeof h === "string" && h) pendingOut.push({ hash: h });
        }
      }
      if (saved && !Array.isArray(saved) && typeof saved.lost === "number" && saved.lost > 0) {
        relayLost = Math.floor(saved.lost);
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
      return isRelayHash(location.hash);
    } catch (e) {
      return false;
    }
  }

  // Write an outbound rp/cm hash into the URL (same-document, no reload).
  // Answers whether the slot really took it: a write that threw means the
  // message is GONE, and a command that is gone is a number the helper counts.
  function writeHash(hash: string): boolean {
    try {
      history.replaceState(null, "", base + HASH_PREFIX + hash);
      return true;
    } catch (e) {
      return false;
    }
  }

  // A command this page could not deliver. Counted, not silently forgotten —
  // see relayLost.
  function noteLostCommand(hash: string): void {
    if (hash.indexOf("cm.") !== 0) return;
    relayLost++;
  }

  function flushPendingOut(): void {
    while (pendingOut.length && !slotBusy()) {
      const m = pendingOut.shift()!;
      if (!writeHash(m.hash)) noteLostCommand(m.hash);
    }
    persistPending();
  }

  // Forward a helper request (rq hash) over the port, then free the slot.
  function handleReqHash(frag: string): void {
    const req = decodeRequest(frag);
    if (!req) return;
    if (!port) {
      // No port yet (background still loading): drop — the helper's request
      // has its own timeout and retries (the announce loop / pollers).
      clearHash();
      return;
    }
    try {
      port.postMessage({ type: "req", id: req.id, action: req.action, arg: req.arg });
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
      if (!isRelayHash(h)) {
        // Any non-relay hash (or none): the slot is free — flush anything the
        // helper hasn't picked up yet.
        flushPendingOut();
        return;
      }
      const frag = relayFragment(h);
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
          // BY HASH, not by object identity. This used to be
          // `pendingOut.indexOf({ hash: hash })`, which never matches anything —
          // so the TTL below had never removed a single entry in its life, and a
          // command could sit in this buffer long past the point where it was
          // worth delivering. TTL expiry is a LOSS and is counted as one.
          const i = pendingOut.findIndex((p) => p.hash === hash);
          if (i >= 0) {
            pendingOut.splice(i, 1);
            noteLostCommand(hash);
            persistPending();
          }
        }, OUT_TTL);
        if (pendingOut.length > 64) {
          // The cap drops the OLDEST first; each one it drops is a lost command.
          for (const dropped of pendingOut.splice(0, pendingOut.length - 64)) {
            noteLostCommand(dropped.hash);
          }
        }
        persistPending();
        return;
      }
      if (!writeHash(hash)) noteLostCommand(hash);
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
      if (msg.type === "resp") return encodeReply(msg.id, msg.result);
      if (msg.type === "cmd") {
        // `msg.seq` is the background's per-window number and `relayLost` this
        // page's own discard count, at the moment of writing. Both are read by
        // the helper's counter (chrome/relayseq.ts).
        return encodeCommand(msg.seq, relayLost, String(msg.action || ""), msg.arg);
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
