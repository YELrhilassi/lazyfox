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
import { boxOf, canEscalate, pressForReal, pressPointIntact, type PressBox } from "./escalate";
import {
  ESCALATION_WATCH_MS,
  flushLifeCounting,
  LIFE_TICKS_MS,
  LIFE_WATCH_MS,
  type LifeSnapshot,
  pageResponded,
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
  // The narrow class that gets a real press instead of the synthetic sequence:
  // a control drawn inside a player's own video box. See escalate.pressForReal.

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
  // For ordinary pages this is the escalation path, and it is deliberately the
  // second attempt rather than the first: the synthetic sequence above is free,
  // instant and in process, and it handles the overwhelming majority of
  // controls. Only when the watcher can prove the TARGET did nothing does this
  // get tried, because it costs a privileged path and is the one route a page
  // could try to abuse.
  //
  // THE EXCEPTION IS A PLAYER'S OWN OVERLAY (escalate.pressForReal), and it is
  // not a reordering of the same logic: there the widget filters on isTrusted
  // AND flips a pressed class for any press, so the "did the target react"
  // question can never answer "no" — the second attempt was unreachable, which
  // is why "Skip ad" stopped working. For that narrow class this press is the
  // ONLY press (never an addition to the synthetic one), so nothing is
  // double-activated.
  //
  // Returns false when the actor is not listening — on any page without the
  // chrome layer installed, and on every page when Lazyfox is running
  // standalone. The caller reports that honestly instead of implying a trusted
  // press was attempted when no one was listening for it.
  function trustedClick(x: number, y: number): boolean {
    try {
      // The handshake token travels as a DOM attribute set by the chrome actor
      // (<html data-lf-trusted>), not as a window property: a property written
      // from system code onto the content window is measurably invisible to
      // this realm (and to the page's), which left this probe answering
      // "nobody is listening" on every page. The DOM is the boundary that
      // crosses reliably — the same direction data-lf-content already flows —
      // and the token is obfuscation, not authentication (actor-child.ts).
      const nonce = document.documentElement.getAttribute("data-lf-trusted");
      if (!nonce) return false;
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
  function watchForLife(
    el: Element,
    before: LifeSnapshot,
    desc: string,
    // The press that just happened WAS the real one (see pressForReal): its effect
    // is not observable from this realm at dispatch time, so the verdict is read
    // one window later and no further press is attempted.
    pressedForReal = false,
    // Where the control was when the press was sent, so the retry can tell "the
    // page ignored it" from "the page reacted and the control MOVED/opened
    // something over itself". See pressPointIntact.
    pressedBox: PressBox | null = null,
  ): void {
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
      // NOT stopLifeCounting(): the ambient window survives an activation, and
      // must — it is the page's background rate, which the NEXT press needs in
      // order to tell a reaction from a heartbeat. hints/session.ts ends it
      // when the batch closes.
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
      // THE REAL PRESS, ALREADY SENT. Nothing to escalate to and nothing to
      // infer from the target's own cosmetic flip — the question is only whether
      // the page moved in the window after the press.
      if (pressedForReal) {
        // THE BASELINE IS THE MOMENT BEFORE THE PRESS, not the end of the first
        // watch window: a player acts fast, and a title or route change that
        // landed inside those 320ms would otherwise be missed and reported as
        // "still no response". The verdict is permissive on purpose here too —
        // the press was a genuine one, so any change counts as its result.
        timers.push(
          window.setTimeout(() => {
            if (done) return;
            const own2 = targetSignal(el, before);
            const page2 = pageSignal(el, before);
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
              signal: "",
              watchedMs: LIFE_WATCH_MS + ESCALATION_WATCH_MS,
              ignored: true,
              trustedRetry: true,
            });
            toast("still no response from " + desc);
          }, ESCALATION_WATCH_MS) as unknown as number,
        );
        return;
      }
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
      // THE PAGE MOVED, SO THE PRESS WORKED — and the retry must NOT be sent.
      //
      // This is the question `pageSignal` cannot answer on its own. It reports
      // "anything changed", which on a page with a heartbeat is always true, so
      // the retry used to be gated on the TARGET alone — and a control whose
      // effect lands elsewhere (a search field opening, a modal appearing, a
      // sidebar collapsing) changes nothing about itself. The result was two
      // presses, one a third of a second apart, and the second undid the first: a
      // field that opened and closed, a modal that appeared and vanished, a
      // sidebar that shrank and grew back. That is the report, and it is a
      // data-loss-shaped bug rather than a missed activation.
      //
      // `pageResponded` is the same facts judged against the page's own ambient
      // rate, so a genuinely busy page (a player, a clock, a chat transcript)
      // still shows up as silent and still gets its privileged retry — which is
      // the one case the retry exists for.
      const responded = pageResponded(el, before, LIFE_WATCH_MS);
      if (responded) {
        settle({ target: desc, signal: responded, watchedMs: LIFE_WATCH_MS, ignored: false });
        return;
      }
      // Silent target, and a page that did not react beyond its own background
      // activity. Before calling that a failure, try the privileged path once: a
      // site that filters on event.isTrusted (YouTube's ad skip button is the
      // canonical case) rejects the synthetic click outright, and the user has
      // no way to know that. One retry, never a loop.
      const page = pageSignal(el, before);
      let escalated = false;
      const warranted = canEscalate(el);
      // THE LAYOUT ALREADY ANSWERED. Before spending the privileged second press,
      // ask whether the first one changed the ground it was fired from: a panel
      // that opened over the control, a sidebar whose collapse moved it, a modal
      // that pushed it. A real press at the old coordinates would then land on
      // that panel/backdrop/neighbour and undo the action the user just got —
      // the reported "it runs and then reverts". A press the page ignored leaves
      // the box and its topmost owner unchanged, which is the only state the
      // retry is for.
      if (warranted && !pressPointIntact(el, pressedBox)) {
        settle({
          target: desc,
          signal: "the press moved the layout around it",
          watchedMs: LIFE_WATCH_MS,
          ignored: false,
        });
        return;
      }
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
          // NO PRIVILEGED PATH HERE (standalone, or no chrome helper). The
          // retry was warranted, but the page-noise question is answered
          // permissively again: a title or a mutation we could not attribute
          // still counts as “something happened”, because accusing a working
          // press is worse than missing the retry. Only total silence is named.
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
      // THE ORDER MATTERS: el.contains(t) is true for t === el, so the page's
      // own focus choice must be asked BEFORE the self-focus rule below.
      if (t !== el && (el.contains(t) || (t.contains && t.contains(el)))) {
        finish("it took focus");
        return;
      }
      // FOCUS ON THE TARGET ITSELF is usually NOT a page reaction: Gecko gives
      // any pressed control focus on mousedown (button, div[tabindex], …), so
      // a click on an isTrusted-gated button lands "focused but otherwise
      // silent" — and if that counted as life, the trusted press for exactly
      // the control it was built for (YouTube's ad Skip button) would always
      // be pre-empted. Measured on the busy-page fixture: the button's only
      // observation was its own focus, the report said success, no
      // privileged press was attempted.
      //
      // So self-focus counts only where focus IS the requested outcome: a
      // text endpoint (input, textarea, contenteditable, selector). Every
      // other control must prove itself with a real state change or leave the
      // verdict to the escalation.
      if (t === el && isFocusEndpoint(t)) finish("it took focus");
    }
    // The controls whose OWN focus is the response the user asked for. Skills
    // like URL editors land here through the click route and short: their
    // focus IS a page-level reaction, not a press side effect.
    function isFocusEndpoint(t: Element): boolean {
      try {
        const tag = String(t.tagName || "").replace(/^.*:/, "").toUpperCase();
        if (tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") return true;
        if (tag === "INPUT") {
          const type = String(t.getAttribute("type") || "text").toLowerCase();
          return type !== "button" && type !== "submit" && type !== "reset"
            && type !== "checkbox" && type !== "radio";
        }
        if ((t as HTMLElement).isContentEditable === true) return true;
        const ce = t.getAttribute && t.getAttribute("contenteditable");
        return ce === "" || ce === "true";
      } catch (err) {
        // A hostile element must not count as focusable anything.
        return false;
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
          //
          // AND NOT AT ALL WHEN WE PRESSED FOR REAL: on a player's overlay the
          // "reaction" is the pressed class the widget adds for ANY press, so
          // short-circuiting on it answers "it worked" before the real press has
          // had a chance to act — the same accident one level down.
          const own = targetSignal(el, before);
          if (own && !pressedForReal) finish(own);
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
    // Start counting BEFORE the snapshot, so the "mutations since" baseline is
    // the moment before the click, not the moment the watch began. The ambient
    // window is normally already open (the batch opened it); FLUSH is the part
    // that matters here — the labels are torn down in this same task, and those
    // records would otherwise be delivered inside the watch window and read as
    // the page reacting to a press it never saw.
    startLifeCounting();
    flushLifeCounting();
    const before = snapshotLife(el);
    const desc = describeTarget(el);
    // WHICH PRESS, decided up front, and exactly one of them is sent.
    //
    // The old rule was "synthetic first, privileged retry only if the target
    // stays silent", and it is right for ordinary pages. It cannot work for a
    // player's own overlay: that widget filters on isTrusted (so the synthetic
    // press can only be refused) and it flips a pressed class for any press (so
    // the target never looks silent). The retry was therefore unreachable at the
    // one place it was built for, and the press was reported as a success while
    // the ad kept playing. `pressForReal` names that class narrowly; here we
    // simply take its route, with the synthetic sequence as the fallback for
    // installs where no privileged channel exists (standalone, no chrome helper).
    //
    // WHAT MAKES THIS DIFFERENT FROM THE OLD REMOVED PATH: that one fired an
    // unverifiable request into the background AND treated its posting as
    // success, so the content script never clicked at all and the hint became a
    // dead key wherever the privileged side did not act. This one is taken only
    // when the channel answers, and the synthetic sequence still runs when it
    // does not.
    const pressedBox = boxOf(el);
    let pressedForReal = false;
    if (pressForReal(el)) {
      try {
        const r = el.getBoundingClientRect();
        pressedForReal = trustedClick(r.left + r.width / 2, r.top + r.height / 2);
      } catch (e) {
        pressedForReal = false;
      }
    }
    if (!pressedForReal) {
      try {
        emulateClick(el);
      } catch (e) {
        stopLifeCounting();
        throw e;
      }
    }
    watchForLife(el, before, desc, pressedForReal, pressedBox);
  }

  return { activate, lastActivation: () => lastAct };
}
