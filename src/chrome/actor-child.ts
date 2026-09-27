// Content-process half of Lazyfox's window actor (the "Lazyfox" JS window
// actor, registered by the profile loader — chrome/loader/config.js). Firefox
// loads this module in every content process and instantiates LazyfoxChild per
// top-level frame.
//
// Why it exists: the extension's content script can only be injected into
// http/https/file pages. Everything else — about: pages, the page you land on
// after a bad URL (`about:neterror`), and the domains Firefox withholds content
// scripts from — has no Lazyfox at all, so the window is dead to the keyboard
// and the user is stuck there. A JS window actor is Firefox's supported way to
// run privileged code inside a content process, so this half gives those pages
// the vim scroll keys and forwards the leader key (plus the keys that follow
// it) to the parent half, which runs them through the chrome helper's ordinary
// dispatcher — so `;t`, `;o`, `;h`, `;g` … all work on an error page.
//
// It stays out of the way everywhere else:
//   * the content script stamps data-lf-content on <html> — the moment this
//     sees that attribute it does nothing at all;
//   * it bails on e.defaultPrevented, which is exactly the case on in-process
//     pages where the chrome helper's own capture listener already ran first,
//     so a key can never be handled twice;
//   * it only ever acts on the top-level frame, and never when the focus is in
//     an editable or a modifier is held, so page typing and browser shortcuts
//     keep working.
//
// Everything here is best-effort: if any step fails the actor simply does
// nothing, and Lazyfox keeps the behavior it had before.

// The vim scroll keys plus the leader/Escape we forward. `g` doubles for `gg`.
const SCROLL_KEYS = "jkdugG";

// How long after the leader key we keep forwarding everything. Covers the
// leader capture and the popups it opens (type-to-filter lists), without a
// cross-process state push.
const LEADER_WINDOW_MS = 15000;

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  try {
    const tag = String(el.tagName || "").replace(/^.*:/, "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") return true;
    const he = el as HTMLElement;
    if (he.isContentEditable) return true;
    const ce = el.getAttribute && el.getAttribute("contenteditable");
    if (ce === "true" || ce === "") return true;
    if (el.getAttribute && el.getAttribute("role") === "textbox") return true;
    return !!(el.closest && el.closest('[contenteditable="true"]'));
  } catch (e) {
    return false;
  }
}

// The base class is taken from the process global rather than referenced
// directly: this same module is imported by the browser process during the
// loader's pre-flight (see chrome/loader/config.js), where the child-side class
// may not exist. In the content process — the only place this actor is ever
// instantiated — JSWindowActorChild is always defined, so the real base is used
// there.
const BaseChild: typeof JSWindowActorChild = ((globalThis as any).JSWindowActorChild ||
  class {}) as typeof JSWindowActorChild;

export class LazyfoxChild extends BaseChild {
  private leaderKey = ";";
  private leaderUntil = 0;

  actorCreated(): void {
    // Ask the parent for the configured leader key. The first key after this
    // may still use the default (";"), which is what virtually every config
    // uses — the query just keeps a custom leader honest a moment later.
    void this.sendQuery("lazyfox-config", null)
      .then((cfg: { leader?: string } | null) => {
        if (cfg && typeof cfg.leader === "string" && cfg.leader) this.leaderKey = cfg.leader;
      })
      .catch(() => {
        // parent gone or query unsupported — the default stands
      });
  }

  handleEvent(event: Event): void {
    if (event.type !== "keydown") return;
    const e = event as KeyboardEvent;
    // Already handled upstream (the chrome helper's capture listener runs
    // first on in-process pages) — never act twice.
    if (e.defaultPrevented || e.isComposing) return;
    // Top-level frames only: one decision point per tab.
    try {
      if (this.browsingContext && this.browsingContext.parent) return;
    } catch (err) {
      // browsingContext unavailable — be conservative and do nothing
      return;
    }
    const doc = this.document;
    if (!doc || !doc.documentElement) return;
    // The content script owns this page; Lazyfox is already fully present.
    if (doc.documentElement.getAttribute("data-lf-content")) return;
    // Never touch browser shortcuts, and never steal typing.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isEditable(e.target as Element | null) || isEditable(doc.activeElement)) return;

    const k = e.key;
    const armed = Date.now() < this.leaderUntil;
    const isLeader = k === this.leaderKey;
    const isScroll = k.length === 1 && SCROLL_KEYS.indexOf(k) !== -1;
    const isNav = k === "Escape" || k === "Backspace";
    // Outside the leader window only the leader key and the vim scroll keys are
    // taken; a page's own keys (its Escape-to-close, its shortcuts) are left
    // alone. Once the leader is armed, everything a Lazyfox popup could need is
    // forwarded so type-to-filter works there too.
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
        vh: this.contentWindow ? this.contentWindow.innerHeight : 0,
      });
    } catch (err) {
      // parent unavailable — the key is swallowed, which is no worse than the
      // dead page we started from
    }
  }

  receiveMessage(msg: any): any {
    if (!msg) return undefined;
    if (msg.name !== "lazyfox-scroll") return undefined;
    try {
      const cw = this.contentWindow;
      if (!cw) return undefined;
      const dy = msg.data && msg.data.dy;
      if (typeof dy === "number") cw.scrollBy(0, dy);
      else if (msg.data && msg.data.goto === "top") cw.scrollTo(0, 0);
      else if (msg.data && msg.data.goto === "bottom") cw.scrollTo(0, 1e9);
    } catch (e) {
      // ignore
    }
    return undefined;
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
}
