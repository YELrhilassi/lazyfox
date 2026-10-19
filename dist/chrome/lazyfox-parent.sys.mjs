// src/chrome/actor-parent.ts
function getChromeWindow(fallbackCtx) {
  try {
    const w = fallbackCtx && fallbackCtx.topChromeWindow;
    if (w) return w;
  } catch (e) {
  }
  try {
    return Services.wm.getMostRecentWindow("navigator:browser");
  } catch (e) {
    return null;
  }
}
function helperLeaderKey() {
  try {
    const raw = Services.prefs.getStringPref("lazyfox.chrome.config", "{}");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.leader === "string" && cfg.leader) return cfg.leader;
  } catch (e) {
  }
  return ";";
}
var BaseParent = globalThis.JSWindowActorParent || class {
};
var LazyfoxParent = class extends BaseParent {
  receiveMessage(msg) {
    if (!msg) return void 0;
    if (msg.name === "lazyfox-config") {
      return { leader: helperLeaderKey() };
    }
    if (msg.name !== "lazyfox-key") return void 0;
    const data = msg.data || {};
    const win = getChromeWindow(this.browsingContext);
    if (!win || typeof win.__lazyfoxActorKey !== "function") return null;
    let result = null;
    try {
      result = win.__lazyfoxActorKey(data);
    } catch (e) {
      result = null;
    }
    if (result && typeof result.scrollY === "number" && result.scrollY !== 0) {
      try {
        this.sendAsyncMessage("lazyfox-scroll", { dy: result.scrollY });
      } catch (e) {
      }
    } else if (result && result.goto) {
      try {
        this.sendAsyncMessage("lazyfox-scroll", { goto: result.goto });
      } catch (e) {
      }
    }
    return null;
  }
};
export {
  LazyfoxParent
};
