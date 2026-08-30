// Native messaging host client (see docs/MESSAGING.md, Stage 2).
//
// The Go host (native-host/, built as lazyfox-host and installed by the
// installer with a native-messaging manifest) speaks JSON-RPC 2.0 over stdio.
// This module is the extension's thin client: browser.runtime.connectNative
// + request/response over the port, with an automatic reconnect and a
// `hostAvailable` flag so callers degrade cleanly when the host is missing —
// which is the NORMAL state for AMO/store installs that never ran the
// installer's host step.
//
// The host owns only what an external process can do (health/diagnostics +
// system-level ops). Everything else (tabs, sessions, history, …) stays in
// the extension's browser.* APIs, so this client only ever calls host.*
// methods.
import { dbg } from "../shared/dev";

const HOST_NAME = "lazyfox";

// One in-flight request at a time is plenty for health checks; the caller
// serializes anyway. Reconnect-on-drop so a host that dies mid-session is
// picked up on the next call.
let port: any = null;
let hostAvailable: boolean | null = null;
let seq = 0;
let waiter: { resolve: (v: any) => void; method: string } | null = null;

export function hostStatus(): { available: boolean | null } {
  return { available: hostAvailable };
}

function connect(): boolean {
  if (port) return true;
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
  }
  if (!port) {
    hostAvailable = false;
    return false;
  }
  hostAvailable = true;
  port.onMessage.addListener((msg: any) => {
    if (!waiter) return;
    const w = waiter;
    waiter = null;
    if (msg && msg.error) {
      w.resolve({ ok: false, error: String(msg.error.message || msg.error) });
    } else {
      w.resolve({ ok: true, result: msg && msg.result !== undefined ? msg.result : null });
    }
  });
  port.onDisconnect.addListener(() => {
    // The host is gone (not installed, crashed, or Firefox is shutting it
    // down). Drop the port; the next call reconnects. A pending waiter gets
    // the failure so it never hangs.
    port = null;
    hostAvailable = false;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve({ ok: false, error: "native host disconnected" });
    }
  });
  return true;
}

// Call one host method. Returns { ok: true, result } or { ok: false, error } —
// never throws, so callers can treat a missing host as a normal condition.
export function hostCall(method: string, params?: any): Promise<{ ok: boolean; result?: any; error?: string }> {
  return new Promise((resolve) => {
    if (!connect()) {
      resolve({ ok: false, error: "native host not available" });
      return;
    }
    // A previous call still pending (the port is busy): fail fast rather than
    // interleave replies. Health checks never overlap in practice.
    if (waiter) {
      resolve({ ok: false, error: "host call already in flight" });
      return;
    }
    const id = ++seq;
    waiter = { resolve: resolve, method: method };
    try {
      port.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    } catch (e) {
      const w = waiter;
      waiter = null;
      port = null;
      hostAvailable = false;
      w.resolve({ ok: false, error: String((e && (e as Error).message) || e) });
    }
  });
}

export async function hostInfo(): Promise<any | null> {
  const r = await hostCall("host.info");
  return r.ok ? r.result : null;
}

export async function hostPing(): Promise<number | null> {
  const t0 = Date.now();
  const r = await hostCall("host.ping");
  if (!r.ok) return null;
  return Date.now() - t0;
}

export async function hostDiag(): Promise<any | null> {
  const r = await hostCall("host.diag");
  return r.ok ? r.result : null;
}

// Dev-only smoke test: log the host's diag once at startup so a working host
// is visible in the console, and a missing one is a single silent no-op (the
// host is optional; absence must never spam).
export function probeHostOnce(): void {
  let done = false;
  void hostDiag().then((d) => {
    if (done) return;
    done = true;
    if (d && d.host) {
      dbg("native host ok: " + d.host + " v" + d.version + " pid=" + d.pid);
    }
  });
}
