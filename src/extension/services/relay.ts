// The persistent relay channel between the extension background and the
// chrome helper (see docs/MESSAGING.md for the full design).
//
// The chrome helper cannot use browser.runtime directly, so ONE hidden relay
// tab (relay.html) carries every helper<->background message over a
// long-lived runtime port. Nothing is created or removed per message — the
// old design opened a throwaway tab per request and churned the tab strip.
//
// This module owns the background side: port lifecycle, queued command
// delivery to the helper, and the chromeAlive/transient-tab bookkeeping.

// windowId -> live Port (the relay page reconnects if it drops).
const relayPorts = new Map<number, any>();

// THE COMMAND SEQUENCE NUMBER — the background's half of the lost-command
// counter (see chrome/relayseq.ts and shared/relay-wire.ts).
//
// It is PER WINDOW, because each window has its own relay tab and its own chrome
// helper, and the helper is the one counting gaps: a single global counter would
// interleave two windows' commands (window A sees 1, 3, 5 and reports two losses
// per command) on a machine that merely has two windows open. It is minted when
// the background DECIDES to send rather than when a post succeeds, so a command
// that is dropped still consumes its number — which is the only way its absence
// can be seen at all.
//
// It is deliberately NOT persisted: a background restart resets it, and a
// restart also drops every command in flight, so a reset would read as a jump
// BACKWARD at the helper (counted as out-of-order, never as a loss).
const relayCmdSeq = new Map<number, number>();

function nextCmdSeq(winId: number): number {
  const n = (relayCmdSeq.get(winId) || 0) + 1;
  relayCmdSeq.set(winId, n);
  return n;
}
// Commands queued while no port was connected yet (the relay tab may still be
// coming up); flushed on connect, dropped after the TTL so a stale command can
// never fire late.
// Each queued entry keeps the sequence number it was MINTED with (see
// nextCmdSeq): the queue delays a command, and re-stamping it at delivery time
// would hide the delay from the counter that exists to measure it.
const relayCmdQueues = new Map<number, Array<{ action: string; arg?: any; seq: number }>>();
import { isRelayUrl } from "../../shared/relay-wire";

const RELAY_QUEUE_TTL = 6000;

// Re-exported so the existing `from "./services/relay"` importers keep working;
// the definition lives in shared/relay-wire.ts with the rest of the relay's wire
// facts, where it is readable (and testable) from Node.
export { isRelayUrl };

// Called by background.ts for every runtime.onConnect port.
//
// NOTE: an `onRelayUp` hook was tried here — re-push the durable state whenever
// a relay port (re)connects, to recover pushes lost while it was down. It is
// the wrong place, and measurably so: the relay tab navigates constantly (every
// hash write reloads the page and its port), so "port connected" fires far too
// often. Re-pushing on each one put a sessionState command into the relay's
// SINGLE url slot, which then starved the split and leader commands behind it:
// the full e2e run went from 180/183 to 163/183, with the relay sitting on a
// stuck `#lfr=cm.sessionState…` hash. The queue below has to stay a queue.
export function acceptRelayPort(
  port: any,
  onReq: (action: string, arg: unknown) => Promise<unknown>,
  transientTabIds: Set<number>
): void {
  if (!port || !port.name || port.name.indexOf("lazyfox-relay") !== 0) return;
  // The relay page carries its windowId in the connection name
  // ("lazyfox-relay:<windowId>") because sender.tab is not guaranteed; fall
  // back to sender.tab when the name lacks it.
  const nameWin = /^lazyfox-relay:(\d+)$/.exec(port.name);
  const sender = port.sender;
  const tab = sender && sender.tab;
  const tabId = tab && tab.id != null ? tab.id : null;
  const winId =
    (nameWin && nameWin[1] != null ? Number(nameWin[1]) : null) ||
    (tab && tab.windowId != null ? tab.windowId : null);
  if (winId == null) return;
  // The relay tab is invisible plumbing: never a user tab, never in the strip.
  // NOTE: deliberately NOT hidden via browser.tabs.hide() — hiding detaches
  // the tab's browsing context, which broke the helper<->relay window bridge.
  // The chrome helper hides it natively (tab.hidden = true, cosmetic), and
  // both sides filter relay tabs from every count/strip/list.
  if (tabId != null) transientTabIds.add(tabId);
  relayPorts.set(winId, port);
  // Flush commands queued while no port was connected.
  const q = relayCmdQueues.get(winId) || [];
  relayCmdQueues.delete(winId);
  for (const c of q) {
    try {
      port.postMessage({
        type: "cmd",
        action: c.action,
        arg: c.arg !== undefined ? c.arg : "",
        // The number the command was minted with, so the drain delivers the
        // stamp the command would have carried if the port had been up. Its own
        // seq, not a fresh one: the counter measures the COMMAND's journey, and
        // re-stamping it here would hide exactly the delay this queue causes.
        seq: c.seq,
      });
    } catch {
      // ignore
    }
  }
  port.onMessage.addListener((msg: any) => {
    if (!msg || msg.type !== "req") return;
    onReq(String(msg.action || ""), msg.arg)
      .then((result) => {
        try {
          port.postMessage({ type: "resp", id: msg.id, result: result !== undefined ? result : null });
        } catch {
          // ignore
        }
      })
      .catch((e: any) => {
        try {
          port.postMessage({ type: "resp", id: msg.id, error: String((e && e.message) || e) });
        } catch {
          // ignore
        }
      });
  });
  port.onDisconnect.addListener(() => {
    if (relayPorts.get(winId) === port) relayPorts.delete(winId);
  });
}

// Relay tabs are invisible plumbing — register them the moment they appear
// (the port-connect handler does the same, but only after the page loads).
// Registered by background.ts on tabs.onCreated / tabs.onUpdated, and dropped
// on tabs.onRemoved.
export function registerTransientRelayTab(tab: any, transientTabIds: Set<number>): void {
  if (tab && tab.id != null && isRelayUrl(tab.url)) transientTabIds.add(tab.id);
}

// Find the relay tab for the current window (the chrome helper CREATES it at
// startup — the extension must never create a second one). Query-only: when no
// relay tab exists there is no chrome helper attached yet, so pushes are
// dropped — the helper's own requests recreate the channel the moment its
// ccBaseUrl resolves.
function findRelayTab(): Promise<any | null> {
  return browser.tabs
    .query({ currentWindow: true })
    .then((ts: any[]) => (ts || []).find((t: any) => isRelayUrl(t.url)) || null)
    .catch(() => null);
}

// The window whose relay port we can currently post to, or null. Used only as
// the fallback when the "active tab" lookup came back empty.
function firstPortedWindow(): number | null {
  for (const winId of relayPorts.keys()) return winId;
  return null;
}

// Deliver one command to ONE window's chrome helper, minting the sequence
// number and (when that window has no live port yet) queueing it.
//
// Split out of requestChrome so a caller that already knows which window it
// means can address it without going through the focus lookup. Session restore
// is exactly that caller: it rebuilds several windows and each one's split
// layout belongs to that window's helper, so "whichever window has the active
// tab" is the wrong question once there is more than one.
function sendChromeCommand<K extends string>(winId: number, action: K, arg?: any): void {
  // Minted here, ONCE per request: the retry loop below may post this entry
  // much later, and the point of the number is that it belongs to the
  // DECISION to send — an entry that is never delivered must still leave a
  // hole where the helper can see it.
  const entry = { action, arg, seq: nextCmdSeq(winId) };
  const tryPost = (): boolean => {
    const port = relayPorts.get(winId);
    if (!port) return false;
    try {
      // Always an object, never "": the chrome side reads named fields.
      port.postMessage({
        type: "cmd",
        action,
        arg: arg === undefined ? {} : arg,
        seq: entry.seq,
      });
      return true;
    } catch {
      // Dead port (its relay tab was removed); drop it so the next
      // attempt re-queues.
      relayPorts.delete(winId);
      return false;
    }
  };
  if (tryPost()) return;
  // No live port: the relay tab may be coming up (the helper creates it
  // and the page connects a beat later). Queue the command and keep
  // retrying until the port delivers or the command ages out — without
  // ever creating a relay tab ourselves (the helper owns that). The entry
  // stays queued so onConnect's drain can deliver it; the retry loop
  // stops the moment the entry leaves the queue, so a command is never
  // posted twice.
  void findRelayTab().then(() => {
    const started = Date.now();
    const q = relayCmdQueues.get(winId) || [];
    q.push(entry);
    relayCmdQueues.set(winId, q);
    const tick = () => {
      const cur = relayCmdQueues.get(winId) || [];
      const i = cur.indexOf(entry);
      if (i < 0) return; // already delivered by onConnect's drain
      if (tryPost()) {
        cur.splice(i, 1);
        return;
      }
      if (Date.now() - started > RELAY_QUEUE_TTL) {
        cur.splice(i, 1);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

// Ask a NAMED window's chrome helper to do something. Used by multi-window
// session restore: a window it just created has no active tab and no focus yet,
// so the focus-based targeting below would either miss it or hit the wrong
// window. The helper in each window is its own (see chrome/main.ts), which is
// what makes a per-window command meaningful at all.
export function requestChromeToWindow<K extends string>(winId: number, action: K, arg?: any): void {
  if (typeof winId !== "number" || !isFinite(winId)) return;
  sendChromeCommand(winId, action, arg);
}

// Ask the chrome helper to do something only it can (native splits, status
// pushes): post the command over the relay's runtime port.
//
// Delivery must survive the relay tab being torn down: a session restore
// removes every unpinned tab (the relay included), so the port in relayPorts
// can be DEAD while the map still holds it (the disconnect listener is
// async). So: verify the port is live, fall through to queue-when-dead, and
// keep retrying until the port is actually delivering — or the command ages
// out, so a stale command can never fire late.
export function requestChrome<K extends string>(action: K, arg?: any): void {
  browser.tabs
    .query({ currentWindow: true, active: true })
    .then((ts: any[]) => {
      // The active tab's window is the right target, and normally the only one.
      // But "no active tab in the current window" is a real, transient state —
      // a window mid-rebuild has none — and the old `if (winId == null) return;`
      // dropped the command there WITHOUT EVEN QUEUEING IT, so it could not be
      // delivered by a later reconnect either. Any window we already hold a
      // live relay port for is a strictly better answer than dropping: the
      // helper is per-window and there is normally exactly one.
      const active = ts && ts[0] ? ts[0].windowId : null;
      const winId = active != null ? active : firstPortedWindow();
      if (winId == null) return;
      sendChromeCommand(winId, action, arg);
    })
    .catch(() => {});
}
