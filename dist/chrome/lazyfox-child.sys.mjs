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
    void this.sendQuery("lazyfox-config", null).then((cfg) => {
      if (cfg && typeof cfg.leader === "string" && cfg.leader) this.leaderKey = cfg.leader;
    }).catch(() => {
    });
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
  // Dispatch the full press through windowUtils, which is what makes the events
  // TRUSTED: isTrusted is true, user activation is granted, and the browser's
  // own default activation behaviour runs (a native <summary> toggle, a form
  // submit, a checkbox). A content-script-dispatched MouseEvent cannot do any
  // of that, which is exactly why stubborn controls need this path.
  //
  // The coordinates are viewport-relative (what getBoundingClientRect reports),
  // and sendMouseEvent takes them offset from the window, so they are used
  // as-is. The sequence is move -> down -> up -> click: the move first because
  // some widgets track the pointer before accepting a press, and the click
  // last because that is the event which actually activates.
};
export {
  LazyfoxChild
};
