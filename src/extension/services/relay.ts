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
// Commands queued while no port was connected yet (the relay tab may still be
// coming up); flushed on connect, dropped after the TTL so a stale command can
// never fire late.
const relayCmdQueues = new Map<number, Array<{ action: string; arg?: any }>>();
const RELAY_QUEUE_TTL = 6000;

export function isRelayUrl(url: string | undefined | null): boolean {
  return !!url && url.indexOf("relay.html") !== -1;
}

// Called by background.ts for every runtime.onConnect port.
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
      port.postMessage({ type: "cmd", action: c.action, arg: c.arg !== undefined ? c.arg : "" });
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
      const winId = ts && ts[0] ? ts[0].windowId : null;
      if (winId == null) return;
      const entry = { action, arg };
      const tryPost = (): boolean => {
        const port = relayPorts.get(winId);
        if (!port) return false;
        try {
          // Always an object, never "": the chrome side reads named fields.
          port.postMessage({ type: "cmd", action, arg: arg === undefined ? {} : arg });
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
    })
    .catch(() => {});
}
