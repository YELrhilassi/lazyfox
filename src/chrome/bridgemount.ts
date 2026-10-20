// Mounting the "Lazyfox" window actor's trusted-click channel on every
// document, from the chrome side.
//
// WHY A CHROME-SIDE MOUNT EXISTS (root cause, not a workaround):
//
// The child actor is lazy by design: Gecko instantiates it on the first
// keydown that reaches the protocol's listener, or on the first message from
// the parent. The FIRST path is starving — the extension's own key capture
// listener runs first in the event path (capture, on the window) and stops
// propagation for every key it handles, so the keydown never descends to
// where the protocol listens, and a page with a content script — every
// ordinary page, YouTube included — mounts no actor at all. Measured in the
// trustgate diagnostic: only a `Meta` keydown the extension ignored ever
// reached the actor; the leader and hint keys did not. The consequences ran
// the whole way up the tower: the escalation's trustedClick() found no
// `data-lf-trusted` nonce on an isTrusted-gated control (YouTube's ad Skip
// button), and the user's first press was swallowed exactly where the
// privileged path was built to save it.
//
// The SECOND path cannot be starved by a page. From the parent process,
// `browser.browsingContext.currentWindowGlobal.getActor("Lazyfox")`
// instantiates the parent-side actor, and one message from it makes Gecko
// load the child module in the content process (ReceiveRawMessage →
// getActor). No page event, capture or propagation matters on that path —
// and the message content is inert by protocol.
//
// So: on every cross-document navigation and on a tab select, ping the
// selected tab's window global once with a `lazyfox-hello`. Everything is
// best-effort and idempotent — getActor returns the existing actor on the
// second call, and the child answers nothing (its receiveMessage ignores
// unknown names), so repeated mounts cost one message and nothing else.

import type { ChromeEnv } from "./env";

interface BrowserLike {
  browsingContext?: {
    currentWindowGlobal?: {
      getActor?: (name: string) => { sendAsyncMessage?: (name: string, data: unknown) => void } | undefined;
    };
  } | null;
}

/** Ping one browser's window global so the child actor mounts in its
 *  content process. Never throws: an absent global (tab mid-teardown), a
 *  navigation before the new window global exists, a page in a process where
 *  the module did not load — all are ordinary states in a browser session,
 *  and the next trigger pings again. */
function mount(browser: BrowserLike | null | undefined): void {
  try {
    if (!browser) return;
    const wg = browser.browsingContext && browser.browsingContext.currentWindowGlobal;
    const actor = wg && typeof wg.getActor === "function" ? wg.getActor("Lazyfox") : null;
    if (actor && typeof actor.sendAsyncMessage === "function") {
      actor.sendAsyncMessage("lazyfox-hello", {});
    }
  } catch {
    // No actor registered (older Firefox, no chrome layer yet), a torn-down
    // browsing context mid-swap, or a global that refuses our name — the
    // next navigation or selection re-runs the mount, and page behavior is
    // identical either way.
  }
}

export function installBridgeMount(env: ChromeEnv, win: ChromeEnv["window"]): void {
  const w = win as unknown as {
    gBrowser: {
      selectedBrowser: BrowserLike;
      addTabsProgressListener(listener: Record<string, unknown>): void;
      removeTabsProgressListener(listener: Record<string, unknown>): void;
      tabContainer: {
        addEventListener(type: string, fn: () => void): void;
        removeEventListener(type: string, fn: () => void): void;
      };
    };
    document?: Document;
  };
  if (!w.gBrowser || typeof w.gBrowser.addTabsProgressListener !== "function") return;

  // The document just committed a real navigation: the window global on the
  // screen is the one the user will press keys into next, so it is the one
  // that must have its trusted channel mounted BEFORE the extension's key
  // capture has any chance to starve a keystroke-driven instantiation.
  // LOCATION_CHANGE fires before content is painted, which is early enough;
  // the stop trigger below covers documents that finish without a location
  // change (restores, back/forward cache hits).
  const sameDocument = (): number => {
    try {
      const L = env.Ci && env.Ci.nsIWebProgressListener;
      if (L && typeof L.LOCATION_CHANGE_SAME_DOCUMENT === "number") return L.LOCATION_CHANGE_SAME_DOCUMENT;
    } catch {
      // the literal is the IDL's own value
    }
    return 0x4; // nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
  };
  const stop = (): number => {
    try {
      const L = env.Ci && env.Ci.nsIWebProgressListener;
      if (L && typeof L.STATE_STOP === "number") return L.STATE_STOP;
    } catch {
      // the literal is the IDL's own value
    }
    return 0x10; // nsIWebProgressListener.STATE_STOP
  };
  const isWindow = (): number => {
    try {
      const L = env.Ci && env.Ci.nsIWebProgressListener;
      if (L && typeof L.STATE_IS_WINDOW === "number") return L.STATE_IS_WINDOW;
    } catch {
      // the literal is the IDL's own value
    }
    return 0x80000; // nsIWebProgressListener.STATE_IS_WINDOW
  };

  const progress = {
    QueryInterface: env.ChromeUtils!.generateQI(["nsIWebProgressListener"]),
    onLocationChange(browser: BrowserLike, _wp: unknown, _req: unknown, loc: { scheme?: string } | null, flags: unknown): void {
      if (!loc) return;
      // Same-document navigations reuse the window global — its channel is
      // already mounted (or the mount was offered when the document arrived).
      if (Number(flags) & sameDocument()) return;
      mount(browser);
    },
    onStateChange(browser: BrowserLike, _wp: unknown, _req: unknown, stateFlags: unknown): void {
      const f = Number(stateFlags) || 0;
      if (!(f & stop()) || !(f & isWindow())) return;
      mount(browser);
    },
  };
  w.gBrowser.addTabsProgressListener(progress);

  // A tab selection changes WHICH window global the next keystroke lands on
  // without necessarily firing a location change at all (a tab loaded in the
  // background and switched to). One extra message for an already-mounted
  // document is cheaper than a page the user can see working differently
  // from its neighbors.
  const onSelect = (): void => mount(w.gBrowser.selectedBrowser);
  try {
    w.gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
  } catch {
    // A windowless context has no tab container; the progress covers it.
  }

  // The mounts survive this window closing as no state and nothing to undo:
  // both listeners belong to the window's own objects and die with it.
}
