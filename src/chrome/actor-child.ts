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

/** The slice of nsIDOMWindowUtils this module uses. Present only for
 *  system-principal code, which is why it is reached through a cast rather
 *  than declared on Window globally: a global declaration would make the
 *  compiler think page content can reach it too, which is exactly the
 *  confusion worth avoiding in the file that grants that power. */
interface TrustedMouseUtils {
  sendMouseEvent(
    type: string,
    x: number,
    y: number,
    button: number,
    clickCount: number,
    modifiers: number,
    widgetTarget: boolean,
  ): void;
}

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
    this.installTrustedClick();
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

  // Listen for the content script's trusted-click request. See the long note
  // below for why this exists and what bounds it.
  private installTrustedClick(): void {
    const doc = this.document;
    const cw = this.contentWindow;
    if (!doc || !cw) return;
    try {
      // windowUtils is only exposed to system-principal code, which is exactly
      // what a JS window actor is. If it is missing, the whole path is
      // unavailable and the content script's probe will find no listener.
      const utils = (cw as unknown as { windowUtils?: TrustedMouseUtils }).windowUtils;
      if (!utils || typeof utils.sendMouseEvent !== "function") return;

      // A fresh random token per document. Obfuscation, not authentication —
      // the page can read this — but it is enough to stop a page that ships a
      // fixed payload aimed at a fixed event name.
      const nonce = Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
      (cw as unknown as Record<string, unknown>).__lazyfoxTrustedClick = nonce;

      const type = "lazyfox-trusted-click:" + nonce;
      const listener = (ev: Event): void => {
        const detail = (ev as CustomEvent).detail;
        if (!detail) return;
        const x = Number((detail as { x?: unknown }).x);
        const y = Number((detail as { y?: unknown }).y);
        // Reject rather than clamp: a NaN or an out-of-viewport point means
        // the caller is not the content script we expect, and guessing where
        // they meant to click is the worst possible failure mode here.
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < 0 || y < 0 || x > cw.innerWidth || y > cw.innerHeight) return;
        try {
          // move, then press, then release. The move first because some
          // widgets track the pointer before accepting a press; the release
          // last because that is what produces the click. Gecko derives the
          // click from this pair, so there is deliberately no click here.
          utils.sendMouseEvent("mousemove", x, y, 0, 0, 0, false);
          utils.sendMouseEvent("mousedown", x, y, 0, 1, 0, false);
          utils.sendMouseEvent("mouseup", x, y, 0, 1, 0, false);
        } catch (e) {
          // the page went away mid-click — nothing to do
        }
      };
      // Capture, so a page that stops propagation on a lower phase cannot
      // swallow the request before it reaches the window.
      cw.addEventListener(type, listener as EventListener, true);
    } catch (e) {
      // No windowUtils, no listener, no trusted clicks. The content script
      // falls back to the synthetic path it already had.
    }
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

}
