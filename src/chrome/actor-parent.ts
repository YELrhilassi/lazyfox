// Parent-process half of Lazyfox's window actor (the "Lazyfox" JS window actor
// — see actor-child.ts for the why). It receives the keys the child half
// forwards from pages the extension's content script cannot reach, hands them
// to the chrome helper's own key dispatcher (installed as
// window.__lazyfoxActorKey), and sends back a scroll instruction when the key
// is a vim scroll key the chrome helper cannot perform on an out-of-process
// page.
//
// It also answers the child's one config question: what is the leader key?
// That lives in the browser's Lazyfox prefs, which the content process cannot
// read.

function getChromeWindow(fallbackCtx: any): any {
  try {
    const w = fallbackCtx && fallbackCtx.topChromeWindow;
    if (w) return w;
  } catch (e) {
    // fall through to the window mediator
  }
  try {
    return Services.wm.getMostRecentWindow("navigator:browser");
  } catch (e) {
    return null;
  }
}

function helperLeaderKey(): string {
  try {
    const raw = Services.prefs.getStringPref("lazyfox.chrome.config", "{}");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.leader === "string" && cfg.leader) return cfg.leader;
  } catch (e) {
    // unset or unparseable — the default leader stands
  }
  return ";";
}

// Taken from the process global, not referenced directly: this module is also
// imported by the browser process during the loader's pre-flight, and the
// fallback keeps that import from throwing if the class name differs on some
// build. Where the actor is actually instantiated the real base is used.
const BaseParent: typeof JSWindowActorParent = ((globalThis as any).JSWindowActorParent ||
  class {}) as typeof JSWindowActorParent;

export class LazyfoxParent extends BaseParent {
  receiveMessage(msg: any): any {
    if (!msg) return undefined;
    if (msg.name === "lazyfox-config") {
      return { leader: helperLeaderKey() };
    }
    if (msg.name !== "lazyfox-key") return undefined;
    const data = msg.data || {};
    const win = getChromeWindow(this.browsingContext);
    if (!win || typeof win.__lazyfoxActorKey !== "function") return null;
    let result: { scrollY?: number; goto?: "top" | "bottom" } | null = null;
    try {
      result = win.__lazyfoxActorKey(data);
    } catch (e) {
      result = null;
    }
    if (result && typeof result.scrollY === "number" && result.scrollY !== 0) {
      try {
        this.sendAsyncMessage("lazyfox-scroll", { dy: result.scrollY });
      } catch (e) {
        // child gone mid-key — nothing else to do
      }
    } else if (result && result.goto) {
      // A whole-document jump has to be measured in the content process (the
      // parent cannot see the page's height), so hand the child the intent.
      try {
        this.sendAsyncMessage("lazyfox-scroll", { goto: result.goto });
      } catch (e) {
        // ignore
      }
    }
    return null;
  }
}
