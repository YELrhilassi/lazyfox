// src/chrome/actor-child.ts
var SCROLL_KEYS = "jkdugG";
var LEADER_WINDOW_MS = 15e3;
function isEditable(el) {
  if (!el) return false;
  try {
    const tag = String(el.tagName || "").replace(/^.*:/, "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") return true;
    const he = el;
    if (he.isContentEditable) return true;
    const ce = el.getAttribute && el.getAttribute("contenteditable");
    if (ce === "true" || ce === "") return true;
    if (el.getAttribute && el.getAttribute("role") === "textbox") return true;
    return !!(el.closest && el.closest('[contenteditable="true"]'));
  } catch (e) {
    return false;
  }
}
var BaseChild = globalThis.JSWindowActorChild || class {
};
var LazyfoxChild = class extends BaseChild {
  constructor() {
    super(...arguments);
    this.leaderKey = ";";
    this.leaderUntil = 0;
  }
  actorCreated() {
    this.installTrustedClick();
    void this.sendQuery("lazyfox-config", null).then((cfg) => {
      if (cfg && typeof cfg.leader === "string" && cfg.leader) this.leaderKey = cfg.leader;
    }).catch(() => {
    });
  }
  // Listen for the content script's trusted-click request. See the long note
  // below for why this exists and what bounds it.
  installTrustedClick() {
    const doc = this.document;
    const cw = this.contentWindow;
    if (!doc || !cw) return;
    try {
      const utils = cw.windowUtils;
      if (!utils || typeof utils.sendMouseEvent !== "function") return;
      const nonce = Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
      cw.__lazyfoxTrustedClick = nonce;
      const type = "lazyfox-trusted-click:" + nonce;
      const listener = (ev) => {
        const detail = ev.detail;
        if (!detail) return;
        const x = Number(detail.x);
        const y = Number(detail.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < 0 || y < 0 || x > cw.innerWidth || y > cw.innerHeight) return;
        try {
          utils.sendMouseEvent("mousemove", x, y, 0, 0, 0, false);
          utils.sendMouseEvent("mousedown", x, y, 0, 1, 0, false);
          utils.sendMouseEvent("mouseup", x, y, 0, 1, 0, false);
        } catch (e) {
        }
      };
      cw.addEventListener(type, listener, true);
    } catch (e) {
    }
  }
  handleEvent(event) {
    if (event.type !== "keydown") return;
    const e = event;
    if (e.defaultPrevented || e.isComposing) return;
    try {
      if (this.browsingContext && this.browsingContext.parent) return;
    } catch (err) {
      return;
    }
    const doc = this.document;
    if (!doc || !doc.documentElement) return;
    if (doc.documentElement.getAttribute("data-lf-content")) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isEditable(e.target) || isEditable(doc.activeElement)) return;
    const k = e.key;
    const armed = Date.now() < this.leaderUntil;
    const isLeader = k === this.leaderKey;
    const isScroll = k.length === 1 && SCROLL_KEYS.indexOf(k) !== -1;
    const isNav = k === "Escape" || k === "Backspace";
    const passThrough = k.length === 1 || isNav;
    if (!isLeader && !isScroll && !(armed && passThrough)) return;
    if (isLeader) this.leaderUntil = Date.now() + LEADER_WINDOW_MS;
    e.preventDefault();
    try {
      this.sendAsyncMessage("lazyfox-key", {
        key: k,
        shift: e.shiftKey,
        // The viewport height, so the parent can size a half-page scroll
        // without being able to see this window.
        vh: this.contentWindow ? this.contentWindow.innerHeight : 0
      });
    } catch (err) {
    }
  }
  receiveMessage(msg) {
    if (!msg) return void 0;
    if (msg.name !== "lazyfox-scroll") return void 0;
    try {
      const cw = this.contentWindow;
      if (!cw) return void 0;
      const dy = msg.data && msg.data.dy;
      if (typeof dy === "number") cw.scrollBy(0, dy);
      else if (msg.data && msg.data.goto === "top") cw.scrollTo(0, 0);
      else if (msg.data && msg.data.goto === "bottom") cw.scrollTo(0, 1e9);
    } catch (e) {
    }
    return void 0;
  }
  // --- Trusted click -----------------------------------------------------
  //
  // Why this exists, in one paragraph because it is load-bearing: a site can
  // tell a real user click from a scripted one by reading event.isTrusted, and
  // YouTube's ad "Skip" button does exactly that. The e2e suite has MEASURED
  // that our content-script path produces isTrusted FALSE even when it ends in
  // HTMLElement.click() — the widely-repeated claim that Gecko synthesises
  // .click() as trusted does not hold for a content script in a current
  // Firefox. So no amount of cleverness in the synthetic sequence fixes it:
  // the only way to produce a genuinely trusted click from inside the browser
  // is nsIDOMWindowUtils.sendMouseEvent, and the only code in this project
  // that can reach it is this actor, which is privileged and already runs in
  // the content process.
  //
  // How the content script reaches it: a DOM CustomEvent. That is deliberately
  // NOT a background message round trip. The alternative — content script ->
  // background -> relay port -> chrome -> actor — is four process hops and a
  // timeout budget to deliver two numbers, and it would only be reliable on
  // pages where the relay tab can be opened at all. A CustomEvent is in-process
  // and synchronous, so the trusted click lands in the same task the user's
  // keystroke started.
  //
  // SECURITY. This is a channel from a content script to a privileged click
  // synthesiser, and it deserves to be taken seriously rather than waved at:
  // any page can dispatch this event and get a trusted click at coordinates of
  // its choosing. In practice the blast radius is small — the page could
  // already call .click() on itself, and the coordinates are in its own
  // document — but "isTrusted becomes forgeable by page script" is not nothing.
  // Three things bound it, and each is load-bearing:
  //
  //   1. The event name carries a per-installation random token, stashed on
  //      the window by THIS code. A page can read it, so this is obfuscation
  //      rather than authentication — it stops a page that ships a static
  //      "skip YouTube ads" payload, which is the realistic case, and nothing
  //      more. It is honestly described as such rather than as a defence.
  //   2. The listener is installed on the window with capture, and refuses any
  //      event whose detail does not parse as a finite in-viewport point. A
  //      malformed or oversized detail is dropped rather than clamped.
  //   3. It is only ever SENT by the content script after the user has
  //      pressed a hint key. Nothing in this codebase dispatches it
  //      speculatively, and there is no timer, retry or pref that does so.
  //
  // Coordinates are viewport-relative (what getBoundingClientRect reports) and
  // sendMouseEvent expects exactly that, so they are passed through as-is.
  // Gecko synthesises the click itself from a mousedown/mouseup pair, so there
  // is no fourth event to send — sending one would double-activate.
};
export {
  LazyfoxChild
};
