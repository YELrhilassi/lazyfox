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
import { editableRootOf, focusLandedOn } from "../../../shared/dom";
import { deepHit, describeTarget } from "./probe";
import { canEscalate } from "./escalate";
import {
  ESCALATION_WATCH_MS,
  LIFE_TICKS_MS,
  LIFE_WATCH_MS,
  type LifeSnapshot,
  pageSignal,
  snapshotLife,
  startLifeCounting,
  stopLifeCounting,
  targetSignal,
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
    // WHICH NODE RECEIVES THE SYNTHETIC SEQUENCE, and the rule is narrow on
    // purpose: the target, or a node inside it, and never anything else.
    //
    // Going one level deeper than `el` is what makes a framework widget work —
    // a button whose handler sits on the inner span, a player that reads
    // event.target — and the hit test answers "what is really on top at those
    // coordinates" so the sequence lands where a real pointer would. But a hit
    // target that is NEITHER the control NOR inside it is a third party: some
    // other element is covering the control right now. Delivering a pointer
    // press to it would let a hint key operate an element the user never chose
    // (a sticky banner, an ad layer, a modal backdrop), while the native click
    // below still fires at the control — i.e. two different elements would act
    // on one keystroke. A covered control is instead reported by the watcher,
    // which is the honest outcome: the press was attempted on what the user
    // asked for, and the page did nothing.
    //
    // Measured cost of the guard: none for the shapes that matter (the control's
    // own centre is covered by its own child, and the fixture's player button,
    // inner span, media wrapper and video are all self-or-descendant cases).
    let dispatchTo: Element = el;
    try {
      const hit = deepHit(x, y);
      if (hit && (hit === el || el.contains(hit))) dispatchTo = hit;
    } catch (e) {
      // A hostile page's hit test must not prevent the click.
    }

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
  // the watcher can prove the TARGET did nothing does this get tried, because it
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
    // Record a verdict once and release everything this watch held.
    const settle = (rec: HintActivation): void => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("hashchange", onLeave);
      stopLifeCounting();
      lastAct = rec;
    };
    const finish = (signal: string): void => {
      if (done) return;
      // The empty string is the "decide now" call, not a signal.
      if (!signal) return decide();
      settle({
        target: desc,
        signal: signal,
        watchedMs: LIFE_WATCH_MS,
        ignored: false,
      });
    };
    const decide = (): void => {
      // THE VERDICT, and the ORDER of the two questions is the whole fix.
      //
      // The target's own state is asked FIRST, the page's permissive signals
      // second. Deciding on page activity alone was how the privileged retry
      // became unreachable exactly where it was built for: a video player, a
      // chat transcript or a clock mutates continuously, so `pageSignal`
      // always reported "the page updated itself" and a control that ignores
      // untrusted events was never escalated. Measured on the hint suite's
      // fixture: with a mutation heartbeat running, the isTrusted-gated control
      // stayed silent and untried; with the split, it escalates.
      const own = targetSignal(el, before);
      if (own) {
        settle({ target: desc, signal: own, watchedMs: LIFE_WATCH_MS, ignored: false });
        return;
      }
      // The target did not react. Before calling that a failure, try the
      // privileged path once: a site that filters on event.isTrusted (YouTube's
      // ad skip button is the canonical case) rejects the synthetic click
      // outright, and the user has no way to know that. One retry, never a
      // loop.
      //
      // The cost of widening the trigger from "total silence" to "the TARGET
      // was silent" is an extra real press on a control whose effect is
      // elsewhere and leaves no trace on itself; that is a far better trade
      // than a privileged path that only ever fires on a page that is not
      // rendering anything, and it is bounded by canEscalate (never a link,
      // never a download) plus the one-retry rule.
      const page = pageSignal(el, before);
      let escalated = false;
      const warranted = canEscalate(el);
      if (warranted) {
        try {
          const r = el.getBoundingClientRect();
          escalated = trustedClick(r.left + r.width / 2, r.top + r.height / 2);
        } catch (e) {
          escalated = false;
        }
      }
      if (!escalated) {
        // THREE CASES, and the report has to tell them apart — that is the
        // whole point of the tri-state `trustedRetry`:
        //
        //   absent     no escalation was warranted (the target reacted, or the
        //              element is one the retry must never repeat)
        //   false      the target was silent so the retry WAS warranted, and no
        //              privileged path was available (standalone mode, or no
        //              chrome layer). Recorded even when the page was busy,
        //              which is what makes the trigger observable without an
        //              actor listening.
        //   true       the press was dispatched (recorded after the extra
        //              watch window, below)
        if (warranted) {
          settle({
            target: desc,
            signal: page,
            watchedMs: LIFE_WATCH_MS,
            ignored: !page,
            trustedRetry: false,
          });
          if (!page) toast("no response from " + desc);
          return;
        }
        if (page) {
          // Anything the page did counts as success: accusing a working click
          // is worse than staying quiet.
          settle({ target: desc, signal: page, watchedMs: LIFE_WATCH_MS, ignored: false });
          return;
        }
        settle({
          target: desc,
          signal: "",
          watchedMs: LIFE_WATCH_MS,
          ignored: true,
        });
        toast("no response from " + desc);
        return;
      }
      // A genuinely trusted press is out. Its effect is NOT observable from
      // this realm, so the watch is extended by one window rather than
      // declaring either outcome now: a target that comes back to life (or a
      // page that moves) is the press working, and continued silence after a
      // real press is the one honest "still no response".
      const afterBefore = snapshotLife(el);
      timers.push(
        window.setTimeout(() => {
          if (done) return;
          const own2 = targetSignal(el, afterBefore);
          const page2 = pageSignal(el, afterBefore);
          if (own2 || page2) {
            settle({
              target: desc,
              signal: own2 || page2,
              watchedMs: LIFE_WATCH_MS + ESCALATION_WATCH_MS,
              ignored: false,
              trustedRetry: true,
            });
            return;
          }
          settle({
            target: desc,
            signal: page,
            watchedMs: LIFE_WATCH_MS + ESCALATION_WATCH_MS,
            ignored: true,
            trustedRetry: true,
          });
          toast("still no response from " + desc);
        }, ESCALATION_WATCH_MS) as unknown as number,
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
          // Only the TARGET's own reaction short-circuits the watch. Page
          // activity is deliberately NOT a fast finish any more: it is the
          // verdict's fallback, and finishing on it early is what made a busy
          // page skip the privileged retry entirely.
          const own = targetSignal(el, before);
          if (own) finish(own);
          else if (ms >= LIFE_WATCH_MS) decide();
        }, ms) as unknown as number,
      );
    }
  }

  // FOCUS IS THE ACTIVATION for a field, so it gets the same treatment as a
  // click: aim at the element that can actually take focus, verify that focus
  // landed, and give a framework one frame to move it before saying it failed.
  // Three real shapes motivated each part:
  //
  //   * a paragraph INSIDE a contenteditable (ChatGPT's composer): focus() on a
  //     non-focusable descendant moves nothing, so the editable ROOT is the
  //     target — that is what the user meant by "the text field";
  //   * a field inside a CLOSED shadow root: document.activeElement reports the
  //     HOST, so the old check (`el === activeElement || el.contains(...)`)
  //     called a successful focus a failure and toasted at the user;
  //   * a framework that moves focus during its own render after the keystroke:
  //     one retry on the next frame turns a false failure into the result the
  //     user expected.
  function focusAndReport(el: Element): void {
    const desc = describeTarget(el);
    // The element that can actually take focus. For a node inside an editable
    // subtree that is the subtree's ROOT, not the node itself.
    const target = editableRootOf(el) || el;
    const attempt = (): boolean => {
      try {
        (target as HTMLElement).focus({ preventScroll: true });
      } catch (e) {
        try {
          (target as HTMLElement).focus();
        } catch (e2) {
          // ignore — the verdict below reports the outcome either way
        }
      }
      return focusLandedOn(el, target);
    };
    if (attempt()) {
      recordFocus(desc, true);
      return;
    }
    try {
      requestAnimationFrame(() => {
        if (attempt()) recordFocus(desc, true);
        else recordFocus(desc, false);
      });
    } catch (e) {
      recordFocus(desc, false);
    }
  }

  function recordFocus(desc: string, took: boolean): void {
    lastAct = {
      target: desc,
      signal: took ? "it took focus" : "",
      watchedMs: 0,
      ignored: !took,
    };
    // Named the same way as the click route's failure, because it IS the same
    // failure from the user's side: they pressed a key for a specific thing and
    // it did not happen. The target is named so the message identifies it.
    if (!took) toast("could not focus " + desc);
  }

  function activate(el: Element, kind: "click" | "focus"): void {
    if (kind === "focus") {
      focusAndReport(el);
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
