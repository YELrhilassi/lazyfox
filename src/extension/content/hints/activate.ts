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

  // Fire the full pointer + mouse sequence, then a native `.click()`.
  //
  // Two different mechanisms, on purpose, and the reason is worth recording
  // because it looks like a redundancy:
  //
  //   - The SYNTHETIC sequence reaches widgets that act on pointer/mouse
  //     events rather than on click: drag handles, sliders, YouTube's player
  //     overlay, anything tracking a hover-then-press interaction. Its events
  //     are always isTrusted:false.
  //   - `.click()` is GECKO-SPECIFIC and is why the hints can drive pages
  //     that check trust at all. Firefox synthesises the click from
  //     HTMLElement.click() with isTrusted TRUE; Blink and WebKit both use
  //     false. Replacing it with dispatchEvent(new MouseEvent("click")) to get
  //     a matching event.target would therefore be strictly worse — it would
  //     trade a trusted event for a consistent one. So the sequence and the
  //     click deliberately target different nodes, and the sequence stops short
  //     of click so the element is not activated twice.
  function emulateClick(el: Element): void {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // The sequence goes to the DEEPEST thing under the pointer (the label or
    // icon INSIDE a button) rather than always to the outer box, because a
    // framework widget may attach its handler to that inner node or read
    // event.target. deepHit can only return something that really is on top at
    // those coordinates, so the guard below is about a stale rect rather than
    // about hit-testing accuracy.
    let dispatchTo: Element = el;
    const deepest = deepHit(x, y);
    if (deepest && (deepest === el || el.contains(deepest))) dispatchTo = deepest;

    // `buttons` is the set of buttons CURRENTLY HELD DOWN, and it is the
    // field a press-state machine reads. The old code passed buttons:1 to
    // every event in the sequence, which means a `mouseup` claiming the button
    // was still down. Any widget that tracks "is a pointer currently down"
    // therefore never saw the release, and was left in a pressed state that no
    // later click could satisfy. That is the whole reason a click on some
    // player overlays did nothing while a click on a plain link worked.
    //
    // `detail` is the click count, so it is 0 for the hover/press events and 1
    // only for the click. Passing 1 throughout is the same class of mistake.
    const phase = (buttons: number, detail: number): MouseEventInit => ({
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons,
      detail,
    });

    // A full, realistic pointer interaction, in order. pointermove is included
    // because some players track the pointer position before accepting a press
    // (a synthetic press with no preceding move can be ignored), and the
    // out-events carry buttons:0 because nothing is held at that point.
    const steps: Array<{ type: string; buttons: number; detail: number }> = [
      { type: "pointerover", buttons: 0, detail: 0 },
      { type: "mouseover", buttons: 0, detail: 0 },
      { type: "pointermove", buttons: 0, detail: 0 },
      { type: "pointerdown", buttons: 1, detail: 1 },
      { type: "mousedown", buttons: 1, detail: 1 },
      { type: "pointerup", buttons: 0, detail: 1 },
      { type: "mouseup", buttons: 0, detail: 1 },
    ];
    for (const step of steps) {
      const opts = phase(step.buttons, step.detail);
      let ev: Event;
      try {
        ev =
          typeof PointerEvent !== "undefined" && step.type.indexOf("pointer") === 0
            ? new PointerEvent(
                step.type,
                Object.assign(
                  { pointerId: 1, pointerType: "mouse", isPrimary: true },
                  opts,
                ),
              )
            : new MouseEvent(step.type, opts);
      } catch (e) {
        ev = new MouseEvent(step.type, opts);
      }
      try {
        dispatchTo.dispatchEvent(ev);
      } catch (e) {
        // ignore
      }
    }
    try {
      if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
      else el.dispatchEvent(new MouseEvent("click", phase(0, 1)));
    } catch (e) {
      try {
        el.dispatchEvent(new MouseEvent("click", phase(0, 1)));
      } catch (e2) {
        // ignore
      }
    }
  }

  // Ask the window actor to synthesise a REAL click at these coordinates.
  //
  // This is the escalation path, and it is deliberately the second attempt
  // rather than the first: the synthetic sequence above is free, instant and in
  // process, and it handles the overwhelming majority of controls. Only when
  // the watcher can prove the page did nothing does this get tried, because it
  // costs a privileged path and is the one route a page could try to abuse.
  //
  // Returns false when the actor is not listening — on any page without the
  // chrome layer installed, and on every page when Lazyfox is running
  // standalone. The caller reports that honestly instead of implying a trusted
  // press was attempted when no one was listening for it.
  function trustedClick(x: number, y: number): boolean {
    try {
      const nonce = (window as unknown as Record<string, unknown>).__lazyfoxTrustedClick;
      if (typeof nonce !== "string" || !nonce) return false;
      window.dispatchEvent(
        new CustomEvent("lazyfox-trusted-click:" + nonce, {
          detail: { x: Math.round(x), y: Math.round(y) },
        }),
      );
      return true;
    } catch (e) {
      return false;
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
      if (signal) {
        lastAct = { target: desc, signal: signal, watchedMs: LIFE_WATCH_MS, ignored: false };
        return;
      }
      // Total silence. Before calling it a failure, try the privileged path
      // once: a site that filters on event.isTrusted (YouTube's ad skip button
      // is the canonical case) rejects the synthetic click outright, and the
      // user has no way to know that. One retry, never a loop — a loop would
      // re-run activation on any control that legitimately does nothing.
      let escalated = false;
      try {
        const r = el.getBoundingClientRect();
        escalated = trustedClick(r.left + r.width / 2, r.top + r.height / 2);
      } catch (e) {
        escalated = false;
      }
      lastAct = {
        target: desc,
        signal: "",
        watchedMs: LIFE_WATCH_MS,
        ignored: !escalated,
        // Recorded so the diagnostics page can distinguish "we never even
        // tried the trusted path" from "we tried and the page still ignored
        // it" — the second one means the button is not a button.
        trustedRetry: escalated,
      };
      // Say it plainly, and say which of the two things happened. The user
      // pressed a key for a specific control and got nothing; naming the
      // control turns a mystery into a fact.
      //
      // This only fires when NOTHING observable happened anywhere on the page
      // — no element change, no title, no route, no scroll, no mutation, no
      // focus. Anything short of that silence is treated as success, because
      // accusing a working click is worse than staying quiet.
      toast(
        escalated
          ? "still no response from " + desc
          : "no response from " + desc,
      );
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
