// The session loader: what covers the window while a session is switched or
// resumed.
//
// WHY IT EXISTS. A session resume is not free to watch. Firefox's own restore
// brings the windows back a beat apart, the resume reconciles each one — an order
// that is close but not equal is REBUILT in place — and windows the session does
// not describe disappear while the ones it does are opened. All of that is the
// machinery doing its job, and none of it should be on screen: the reported
// experience was "a bunch of things flashing around while things are loading".
// So the window covers itself with the mark and a spinner until the restore says
// it has settled.
//
// PAINTING IS DELAYED FOR A LAUNCH, deliberately. A cover raised for every
// resume — including the common one where Firefox's native restore already
// matches the snapshot and everything settles in a few hundred milliseconds —
// would itself be a flash. The pending paint is cancelled outright by an early
// `off`, so a fast launch shows nothing at all and a slow one shows the splash
// for exactly the part the user would otherwise watch. A SWITCH is the opposite
// case: the user just asked for it, so a labelled announce paints on the next
// frame (see set).
//
// It is an OVERLAY, not a blocker: `pointer-events` are off, so a click lands on
// the window behind it, and a failsafe takes it down after MAX_SHOW_MS even if the
// background never says the resume is over (a suspended event page, a crashed
// helper, a quit mid-restore). Nothing here can strand a window behind a logo.
//
// It is mounted the way the popup host mounts (see popup.ts): a plain DOM tree on
// the chrome document, with the little CSS it needs injected as a stylesheet —
// the chrome document has no CSP, so a shadow root buys nothing here.

import { UI_FONT } from "../shared/theme";
import type { ChromeEnv, ChromeDocument } from "./env";

export interface SplashCtl {
  /**
   * Request the splash up (true) or take it down (false). Idempotent.
   *
   * `label` names what is loading. It also makes the paint IMMEDIATE: it is
   * only ever sent for a switch the user just asked for, where a delayed cover
   * would arrive after the strip has already started changing. An announce
   * without a label (the launch resume) keeps the delay, because a resume that
   * matches its snapshot settles in milliseconds and must not flash.
   */
  set(on: boolean, label?: string): void;
}

export interface SplashDeps {
  env: ChromeEnv;
  /**
   * The extension's base URL, resolved lazily: the mark is an extension asset and
   * the policy that answers for the base URL may not be reachable at the moment
   * this module is built. Null simply omits the image — the spinner and the line
   * of text still say what is happening.
   */
  baseUrl(): string | null;
}

const XHTML = "http://www.w3.org/1999/xhtml";

// How long `on` may be pending before anything is painted. Short enough that a
// real wait is covered from its first visible moment, long enough that the
// matching-restore case — which resolves in milliseconds — never paints at all.
const SHOW_DELAY_MS = 250;
// The backstop: a splash never outlives the operation it announced.
//
// A SWITCH is bounded by its own page wait (see sessions/restore.ts: 6s for the
// front page), so a labelled cover still up after that belongs to a background
// that went away mid-switch — a logo nobody will ever take down is worse than no
// cover, so it goes.
//
// A LAUNCH resume waits up to 10s for every tab, and a slow one is normal.
const SWITCH_MAX_SHOW_MS = 8000;
const MAX_SHOW_MS = 20000;
const DEFAULT_LABEL = "Restoring your session\u2026";

// Only the spinner needs a stylesheet: a keyframe animation cannot be written as
// an inline style. Everything else is inline, and every selector is scoped to the
// host id, so nothing here can reach the browser's own chrome.
const SPLASH_CSS =
  "#lf-splash .lf-spin{border:2px solid rgba(128,128,128,.35);border-top-color:#d79d00;" +
  "border-radius:50%;animation:lf-splash-spin .9s linear infinite}" +
  "@keyframes lf-splash-spin{to{transform:rotate(360deg)}}";

function el(doc: ChromeDocument, tag: string, attrs?: Record<string, string> | null, text?: string | null): any {
  const e = (doc as any).createElementNS(XHTML, tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
  }
  if (text != null) e.textContent = text;
  return e;
}

export function createSplash(deps: SplashDeps): SplashCtl {
  const env = deps.env;
  const doc = env.document;
  let host: any = null;
  let style: any = null;
  let showTimer: any = null;
  let failTimer: any = null;
  let on = false;
  // The line under the spinner. Kept separately from the host so a label that
  // arrives while the paint is still delayed lands on the paint that follows.
  let label = DEFAULT_LABEL;
  let textEl: any = null;

  function clearTimers(): void {
    if (showTimer != null) {
      env.clearTimeout(showTimer);
      showTimer = null;
    }
    if (failTimer != null) {
      env.clearTimeout(failTimer);
      failTimer = null;
    }
  }

  function mount(): void {
    if (host) return;
    try {
      const root = el(doc, "div", { id: "lf-splash" });
      // `all:initial` FIRST, so no browser-chrome style reaches this subtree, and
      // the declarations after it win over that reset (later wins inside one
      // style attribute). z-index is above every other Lazyfox surface — the
      // popup host sits one below it.
      root.style.cssText =
        "all:initial;position:fixed;inset:0;z-index:2147483647;display:flex;" +
        "flex-direction:column;align-items:center;justify-content:center;gap:18px;" +
        "background:Canvas;color:CanvasText;pointer-events:none;" +
        "user-select:none;-moz-user-select:none;font:13px/1.4 " + UI_FONT + ";";
      const base = deps.baseUrl();
      if (base) {
        const img = el(doc, "img", {
          class: "lf-logo",
          src: base + "icons/icon256.png",
          alt: "",
          draggable: "false",
        });
        img.style.cssText = "width:96px;height:96px;display:block;";
        // The mark is decoration: if the asset cannot be read, the spinner and
        // the text still say what is happening, but a broken-image placeholder
        // would read as a failure — so the element takes itself out instead.
        img.addEventListener("error", () => {
          try {
            img.remove();
          } catch (e) {
            // ignore
          }
        });
        root.appendChild(img);
      }
      const spinner = el(doc, "div", { class: "lf-spin" });
      spinner.style.cssText = "width:22px;height:22px;";
      const text = el(doc, "div", null, label);
      text.style.cssText = "opacity:.72;letter-spacing:.02em;";
      root.appendChild(spinner);
      root.appendChild(text);
      textEl = text;
      if (!style) {
        style = el(doc, "style", { id: "lf-splash-css" });
        style.textContent = SPLASH_CSS;
        doc.documentElement.appendChild(style);
      }
      doc.documentElement.appendChild(root);
      host = root;
    } catch (e) {
      // A window whose document is already going away cannot paint a splash;
      // that is not a reason to disturb the restore it is reporting on.
      host = null;
    }
  }

  function unmount(): void {
    try {
      if (host) host.remove();
    } catch (e) {
      // ignore — a host that is already gone is the desired state
    }
    host = null;
    textEl = null;
    try {
      if (style) style.remove();
    } catch (e) {
      // ignore
    }
    style = null;
  }

  // The label changed while the cover is up: say the new thing rather than
  // leaving the previous operation's name over this one.
  function relabel(next: string): void {
    label = next || DEFAULT_LABEL;
    try {
      if (textEl) textEl.textContent = label;
    } catch (e) {
      // a torn-down text node is not worth a throw on a keypress path
    }
  }

  // The operation that is covered RIGHT NOW gets a budget of its own. Without
  // this, a run of quick switches kept one timer armed from the FIRST paint, so
  // the fail-safe could fire in the middle of a later switch and uncover its
  // rebuild — and a background that died during the third switch left the logo
  // up for whatever was left of the first one's twenty seconds.
  function armFailsafe(switchLabel: boolean): void {
    if (failTimer != null) env.clearTimeout(failTimer);
    failTimer = env.setTimeout(() => set(false), switchLabel ? SWITCH_MAX_SHOW_MS : MAX_SHOW_MS);
  }

  function set(next: boolean, nextLabel?: string): void {
    const wanted = nextLabel ? nextLabel : DEFAULT_LABEL;
    const isSwitch = !!nextLabel;
    if (next === on) {
      // A re-announce can carry a better label (the switch that replaced a
      // resume). Paint the latest one, and give it its own budget.
      if (next) {
        if (wanted !== label) relabel(wanted);
        if (host) armFailsafe(isSwitch);
      }
      return;
    }
    on = next;
    if (next) {
      label = wanted;
      // Already pending or already painted: the announce is idempotent.
      if (showTimer != null || host) {
        relabel(label);
        if (host) armFailsafe(isSwitch);
        return;
      }
      showTimer = env.setTimeout(() => {
        showTimer = null;
        // The operation can finish inside the delay, which is the whole point of
        // having one: `off` has already cleared this path's reason to run.
        if (!on) return;
        mount();
        armFailsafe(isSwitch);
      }, isSwitch ? 0 : SHOW_DELAY_MS);
      return;
    }
    clearTimers();
    unmount();
    label = DEFAULT_LABEL;
  }

  return { set };
}
