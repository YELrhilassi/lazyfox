// Turning a keypress into a real interaction with the page, and finding out
// afterwards whether it had any effect.
//
// Two responsibilities that used to live inside the session closure and are
// inseparable in practice: the click itself — a full pointer/mouse sequence at
// the target, then a native .click() so the browser's own activation behaviour
// runs — and the verdict (life.ts decides what counts as a reaction).
//
// There are two report paths because the two activation routes have different
// observable effects: a control is judged by watching the page, while a FIELD
// is judged by whether focus actually landed. A field that refuses focus is the
// same silent failure as a button that ignores a click.
import { toast } from "../../../shared/overlay";
import { deepHit, describeTarget } from "./probe";
import {
  LIFE_TICKS_MS,
  LIFE_WATCH_MS,
  type LifeSnapshot,
  lifeSignal,
  snapshotLife,
  startLifeCounting,
  stopLifeCounting,
} from "./life";
import type { HintActivation } from "../../../shared/types";

export interface Activator {
  /** Activate a resolved target. `kind` selects the observable to judge. */
  activate(el: Element, kind: "click" | "focus"): void;
  /** What the last activation did — the diagnostics page's answer to "nothing happened". */
  lastActivation(): HintActivation | null;
}

export function createActivator(): Activator {
  let lastAct: HintActivation | null = null;

  // Fire the full pointer + mouse sequence, then a native `.click()`. Some
  // pages (video overlays like YouTube's "Skip", custom widgets) act on
  // pointer/mouse events, while a native click is what runs the browser's
  // real activation behaviour (form submit, checkbox toggle, `<summary>`).
  // The synthetic sequence intentionally omits a MouseEvent "click" so the
  // element is not activated twice.
  function emulateClick(el: Element): void {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Fire the pointer/mouse sequence on the DEEPEST thing under the pointer
    // (the text or icon INSIDE a button) rather than always on the outer box:
    // a framework widget may attach its handler to that inner node, or read
    // event.target. Events bubble, so a handler on `el` still fires. The native
    // .click() is reserved for `el` itself so activation happens exactly once.
    let dispatchTo: Element = el;
    const deepest = deepHit(x, y);
    if (deepest && (deepest === el || el.contains(deepest))) dispatchTo = deepest;
    const opts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      detail: 1,
    };
    // A full, realistic pointer interaction. `pointermove` is included because
    // some players track the pointer position before accepting a press (a
    // synthetic press with no preceding move can be ignored).
    const types = [
      "pointerover",
      "mouseover",
      "pointermove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
    ];
    for (const type of types) {
      let ev: Event;
      try {
        ev =
          typeof PointerEvent !== "undefined" && type.indexOf("pointer") === 0
            ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, opts))
            : new MouseEvent(type, opts);
      } catch (e) {
        ev = new MouseEvent(type, opts);
      }
      try {
        dispatchTo.dispatchEvent(ev);
      } catch (e) {
        // ignore
      }
    }
    try {
      if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
      else el.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {
      try {
        el.dispatchEvent(new MouseEvent("click", opts));
      } catch (e2) {
        // ignore
      }
    }
  }

  // Watch a just-clicked target for a sign that the page reacted, and report it
  // when it did not.
  //
  // This is the one piece of feedback the engine had never had. Without it, a
  // control that refuses untrusted events, a handler on an ancestor that stops
  // propagation, or a control that was never really the thing under the cursor
  // all look IDENTICAL from the user's side: a label, a keypress, silence. That
  // ambiguity is what made every hint bug in docs/HINTS.md expensive — there
  // was no way to tell "the hint found the wrong element" from "the hint found
  // the right element and the page ignored it".
  //
  // The watcher is deliberately dumb and local: it re-reads a small fingerprint
  // of the element a few times and looks for a difference, plus one focus and
  // one navigation signal, which together cover essentially every real
  // response (a re-render, a class/ARIA toggle, a value change, a focus move, a
  // route change). It mutates nothing and never blocks the next keystroke.
  function watchForLife(el: Element, before: LifeSnapshot, desc: string): void {
    const timers: number[] = [];
    let done = false;
    const finish = (signal: string): void => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("hashchange", onLeave);
      stopLifeCounting();
      lastAct = { target: desc, signal: signal, watchedMs: LIFE_WATCH_MS, ignored: !signal };
      if (!signal) {
        // Say it plainly. The user pressed a key for a specific control and got
        // nothing; telling them which control, and that the page ignored it,
        // turns a mystery into a fact (and the diagnostics page records it).
        //
        // This only fires when NOTHING observable happened anywhere on the page
        // — no element change, no title, no route, no scroll, no mutation, no
        // focus. Anything short of that silence is treated as success, because
        // accusing a working click is worse than staying quiet.
        toast("no response from " + desc);
      }
    };
    function onFocus(e: FocusEvent): void {
      const t = e.target as Element | null;
      if (!t) return;
      if (t === el || el.contains(t) || (t.contains && t.contains(el))) {
        finish("it took focus");
      }
    }
    // A navigation is the clearest possible "it worked", and it destroys this
    // document anyway, so the toast must not be the thing that survives it.
    function onLeave(): void {
      finish("the page navigated");
    }
    document.addEventListener("focusin", onFocus, true);
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("hashchange", onLeave);
    for (const ms of LIFE_TICKS_MS) {
      timers.push(
        window.setTimeout(() => {
          if (done) return;
          if (!el.isConnected) {
            // A framework replaced the node: something clearly happened.
            finish("the element was replaced");
            return;
          }
          const signal = lifeSignal(el, before);
          if (signal) finish(signal);
          else if (ms >= LIFE_WATCH_MS) finish("");
        }, ms) as unknown as number,
      );
    }
  }

  // A FIELD is judged differently: focusing a field is the activation, and a
  // field that took focus is already observable — but a field that REFUSED
  // focus (covered, readonly in a custom widget, inside a modal that stole it)
  // is exactly the silent failure worth reporting. So this is the focus-route
  // counterpart of watchForLife: no waiting, just "did focus actually land?".
  function reportActivation(el: Element): void {
    const desc = describeTarget(el);
    const took = document.activeElement === el || el.contains(document.activeElement);
    lastAct = {
      target: desc,
      signal: took ? "it took focus" : "",
      watchedMs: 0,
      ignored: !took,
    };
    if (!took) toast("no response from " + desc);
  }

  function activate(el: Element, kind: "click" | "focus"): void {
    if (kind === "focus") {
      reportActivation(el);
      return;
    }
    // Activation is the synthetic sequence in emulateClick, and nothing else.
    //
    // There WAS a "trusted press" path here: ask the chrome side to press at
    // this element's center through windowUtils, so the click would carry
    // isTrusted === true. It was removed because it made hints worse, not
    // better — see docs/HINTS.md. The short version: the background could only
    // report that it had POSTED the request, never that the press happened, so
    // the content script treated "a relay port exists" as success and skipped
    // its own click. On every page where the privileged side did not act, the
    // hint became a dead key.
    // Start counting BEFORE the snapshot, so the "mutations since" baseline is
    // the moment before the click, not the moment the watch began.
    startLifeCounting();
    const before = snapshotLife(el);
    const desc = describeTarget(el);
    try {
      emulateClick(el);
    } catch (e) {
      stopLifeCounting();
      throw e;
    }
    watchForLife(el, before, desc);
  }

  return { activate, lastActivation: () => lastAct };
}
