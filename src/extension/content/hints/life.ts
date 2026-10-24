// Watching a just-clicked target to find out whether the page did anything.
//
// A dispatched MouseEvent is untrusted and a great many controls ignore it, so
// "the key did nothing" is indistinguishable, from the outside, between "the
// hint found the wrong element" and "the hint found the right one and the page
// ignored it". This module is the difference: a fingerprint of the target AND
// the page, taken either side of the click.
//
// The bias is deliberate and one-sided: ANY observable change counts as success
// (element state, title, route, scroll, any DOM mutation, focus, navigation).
// Only total silence is reported as ignored, because accusing a working click
// of doing nothing is worse than saying nothing — the user would be told
// something untrue. (The first version watched only the element and called a
// working click ignored on a page whose entire reaction was setting the title.)

// How long to watch a target for a sign of life before telling the user it did
// nothing. Long enough for a framework route change or a re-render (the common
// case), short enough that the toast is not in the way of the next keystroke.
export const LIFE_WATCH_MS = 320;

// The observation points. Two early ticks catch a synchronous handler; the last
// one catches anything that needs a frame or two (a re-render, a class toggle
// after a transition).
export const LIFE_TICKS_MS = [0, 60, 160, LIFE_WATCH_MS];

// How long to keep watching AFTER the privileged press has been dispatched.
//
// The trusted press's effect cannot be observed from the content realm (the
// actor calls windowUtils out of band), so neither outcome may be declared at
// dispatch time: this window is what turns the two cases that used to be
// indistinguishable — "the real press worked" and "even a real press did
// nothing" — into a success and a toast.
export const ESCALATION_WATCH_MS = 420;

export interface LifeSnapshot {
  connected: boolean;
  cls: string;
  disabled: string;
  aria: string;
  value: string;
  checked: boolean;
  href: string;
  // Page-level signals. These matter more than they look: most real activations
  // change something that is NOT the element — a handler that sets the title,
  // pushes a route, scrolls, swaps a sibling. Watching only the target called a
  // working click "ignored" (verified against the local player fixture, where
  // the button's whole effect was `document.title = ...`), and a false
  // "no response" is worse than silence: it tells the user something untrue.
  title: string;
  scrollX: number;
  scrollY: number;
  // How many DOM mutations the document has seen since the click. A single
  // observer on the document element catches "the page did anything at all",
  // which covers the long tail (a counter, a toast, a re-render of an unrelated
  // subtree) without knowing what the site was going to do.
  mutations: number;
  // The same count with page chrome (<head>) and Lazyfox's own nodes excluded:
  // the body's reaction, which is what the retry decision is made on.
  quiet: number;
}

// A mutation counter for the whole document, running for as long as the hints
// are OPEN (not only for the 320ms after a click). Counting is cheaper than
// inspecting, and the count alone answers two questions:
//
//   * "did the page do ANYTHING since the press" (the verdict), and
//   * "how much of that is just the page's own background activity" — the
//     AMBIENT rate, which is what makes the verdict's twin question answerable.
//
// THE AMBIENT RATE IS THE FIX FOR A DESTRUCTIVE BUG, so it is worth stating in
// full. The privileged retry is a SECOND press, so it may only be sent when the
// first one provably did nothing. "The target did nothing" is not enough
// evidence: a control whose effect lands elsewhere — a search field opening, a
// modal appearing, a sidebar collapsing — changes nothing about itself, and the
// page reaction it does cause was indistinguishable from a player's progress bar
// ticking, because the counter started at zero at the press. So every such
// control was pressed TWICE, and the second press undid the first: the field
// opened and closed, the modal appeared and vanished, the sidebar shrank and
// grew back about a third of a second later (the watch window).
//
// Measured against its own background, the two are trivially different: a modal
// inserting itself is a burst of mutations over a page that was quiet, while a
// heartbeat produces the same trickle whether a key was pressed or not. So the
// observer starts when the batch opens, and this module keeps the rate it has
// seen since then.
let lifeObserver: MutationObserver | null = null;
// Every page mutation (see snapshotLife's `mutations`).
let lifeMutations = 0;
// ...and the subset that is NOT page chrome (<head>). The retry decision is
// made on these: a title update is how a trust-gated control says it refused a
// synthetic press, so it must not read as "the press worked" — while the
// verdict still counts it (pageSignal compares document.title itself anyway).
let lifeQuiet = 0;
// When the ambient window opened (0 = not open). performance.now() based, like
// every other clock in the hints engine.
let ambientFrom = 0;

/**
 * Is this record Lazyfox's own bookkeeping rather than the page's activity?
 *
 * The hints overlay, the toasts, the popups and the dark-mode sampler all live
 * in the page's document and all mutate. Counting them made an idle page look
 * busy — measured on the quietest possible fixture, the "ambient" rate was
 * almost entirely `data-lf-*` attributes on <html> and the overlay host's own
 * `popover` attribute, which both inflated the rate and buried the one mutation
 * the page made in reply to a press. "The page did something" has to mean the
 * PAGE.
 *
 * Narrow on purpose: our own attributes (`data-lf-*`), and anything inside one
 * of our hosts (`#lazyfox-*`). A page is free to use those names, but a page
 * that does is already indistinguishable from us elsewhere in the product.
 */
function isOwnMutation(rec: MutationRecord): boolean {
  try {
    if (rec.type === "attributes" && rec.attributeName && rec.attributeName.indexOf("data-lf-") === 0) {
      return true;
    }
    let n: Node | null = rec.target as Node | null;
    for (let i = 0; n && i < 10; i++) {
      const el = n as HTMLElement;
      const id = el.id || "";
      if (id.indexOf("lazyfox-") === 0) return true;
      n = el.parentNode;
    }
  } catch (e) {
    // A record that refuses inspection counts as the page's: silence would be
    // the more misleading answer.
    return false;
  }
  return false;
}

/**
 * Is this record a change to the page's own chrome — its `<head>`?
 *
 * The title is the case that matters: a trust-gated control that refuses a
 * synthetic press often says so by retitling the document, and treating that as
 * a reaction would report success and leave the control dead. The verdict still
 * sees it (`pageSignal` compares the title strings), so nothing is lost.
 */
function isHeadMutation(rec: MutationRecord): boolean {
  try {
    let n: Node | null = rec.target as Node | null;
    for (let i = 0; n && i < 10; i++) {
      if (n === document.head) return true;
      n = (n as Element).parentNode;
    }
  } catch (e) {
    return false;
  }
  return false;
}

/**
 * Count one batch of records: [page mutations, quiet page mutations]. Both
 * exclude Lazyfox's own nodes; the second also excludes `<head>`.
 */
function countRecords(records: MutationRecord[]): [number, number] {
  let all = 0;
  let quiet = 0;
  for (const r of records) {
    if (isOwnMutation(r)) continue;
    all++;
    if (!isHeadMutation(r)) quiet++;
  }
  return [all, quiet];
}

function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (e) {
    // fall through
  }
  return Date.now();
}

/**
 * Start (or keep) the ambient window. Called when a hint batch opens, and again
 * at every activation — idempotent, and deliberately NOT a reset: a watch is
 * "since the press", but the background rate is "since hints opened".
 */
export function startLifeCounting(): void {
  if (!ambientFrom) ambientFrom = nowMs();
  if (lifeObserver) return;
  try {
    lifeObserver = new MutationObserver((records) => {
      const [all, quiet] = countRecords(records);
      lifeMutations += all;
      lifeQuiet += quiet;
    });
    // ATTRIBUTE-CHURN IS FILTERED, and this one mattered: a hint session can
    // stay open for minutes on exactly the apps that write classes and styles
    // every frame, and an unfiltered `attributes: true` on the whole subtree
    // makes Gecko record EVERY one of those writes for a counter that only
    // needs "did something happen". The filter keeps the attributes that mean
    // "the page reacted" (a state class, an expanded/selected flag, a hidden
    // panel, a disabled control) and drops the rest; new nodes and changed
    // text are still counted, which is where most responses show up anyway.
    lifeObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "open",
        "disabled",
        "aria-hidden",
        "aria-expanded",
        "aria-selected",
        "aria-checked",
        "aria-disabled",
        "aria-pressed",
      ],
    });
  } catch (e) {
    lifeObserver = null;
  }
}

/**
 * Fold the observer's pending records into the count NOW.
 *
 * MutationObserver delivers on a microtask, so a synchronous read of the count
 * can be one batch behind — which matters at exactly the wrong moment: the
 * batch's labels are torn down (a real document mutation) in the same task
 * that presses the hinted control, so without this drain those records land
 * INSIDE the watch window and every activation reads as "the page responded".
 * Taking them here, before the baseline snapshot, files them where they belong:
 * before the press.
 */
export function flushLifeCounting(): void {
  if (!lifeObserver) return;
  try {
    const [all, quiet] = countRecords(lifeObserver.takeRecords());
    lifeMutations += all;
    lifeQuiet += quiet;
  } catch (e) {
    // ignore — the count is then merely one batch behind
  }
}

export function stopLifeCounting(): number {
  const n = lifeMutations;
  ambientFrom = 0;
  lifeMutations = 0;
  lifeQuiet = 0;
  if (lifeObserver) {
    try {
      lifeObserver.disconnect();
    } catch (e) {
      // ignore
    }
    lifeObserver = null;
  }
  return n;
}

// A cheap fingerprint of everything a click normally changes. Reading it twice
// is how we tell "the page did something" from "the page ignored us" without
// any cooperation from the page.
export function snapshotLife(el: Element): LifeSnapshot {
  const he = el as HTMLElement;
  const input = el as HTMLInputElement;
  return {
    connected: !!el.isConnected,
    cls: typeof he.className === "string" ? he.className : "",
    disabled: el.getAttribute("disabled") || "",
    aria: el.getAttribute("aria-pressed") || el.getAttribute("aria-expanded") ||
      el.getAttribute("aria-checked") || el.getAttribute("aria-selected") ||
      el.getAttribute("aria-current") || "",
    value: typeof input.value === "string" ? input.value : "",
    checked: typeof input.checked === "boolean" ? input.checked : false,
    href: el.getAttribute("href") || "",
    title: document.title,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    mutations: lifeMutations,
    quiet: lifeQuiet,
  };
}

/**
 * How many mutations per millisecond the page produced on its own, before and
 * between acts of the user. 0 means "no ambient activity observed" (a quiet
 * page, or a window too short to estimate from).
 */
export function ambientMutationRate(): number {
  if (!lifeObserver || !ambientFrom) return 0;
  const elapsed = nowMs() - ambientFrom;
  // Too short to be an estimate — claiming a rate from 20ms of observation is
  // how a quiet page gets mistaken for a busy one.
  if (elapsed < 120) return 0;
  return lifeQuiet / elapsed;
}

/**
 * Did the page react to the press — as opposed to merely being busy?
 *
 * Same facts as pageSignal, with the mutation count judged against the page's
 * own AMBIENT rate over an equivalent window. This is the question the
 * privileged retry must be gated on (see the note above): `pageSignal` answers
 * "is anything different", and on a page with a heartbeat that is always yes,
 * which made the retry fire after a press that had already worked.
 *
 * NO TITLE CLAUSE, deliberately, and the reason is the one control that needs
 * the retry: a trust-gated widget refuses the synthetic click and often SAYS SO
 * in the document title ("not allowed", a status update). Counting that as a
 * reaction would report success and leave the control dead. A title change is
 * also not evidence of the press being consumed: a real navigation destroys
 * this document and settles through pagehide — what remains here is a page that
 * merely restated something. A DOM reaction, on the other hand, is the shape
 * every open/close/sidebar toggle has, so it does suppress the retry.
 *
 * The bias is still one-sided. Border cases count as a reaction: missing one
 * trust-gated control is a smaller loss than pressing a working toggle twice.
 */
export function pageResponded(
  el: Element,
  before: LifeSnapshot,
  watchedMs: number,
  // Injectable for the same reason selectHintables' probes are: the rule is a
  // POLICY (how much growth means "the page responded"), and a policy should be
  // testable in Node, where there is no MutationObserver and therefore no
  // ambient rate at all.
  deps: { now?: () => LifeSnapshot; rate?: () => number } = {},
): string {
  flushLifeCounting();
  const now = deps.now ? deps.now() : snapshotLife(el);
  if (!el.isConnected || !before.connected) return "the element was replaced";
  if (now.scrollX !== before.scrollX || now.scrollY !== before.scrollY) {
    return "the page scrolled";
  }
  const growth = now.quiet - before.quiet;
  if (growth <= 0) return "";
  const rate = deps.rate ? deps.rate() : ambientMutationRate();
  const expected = rate * watchedMs;
  // A QUIET PAGE HAS NO BACKGROUND TO SUBTRACT, and this is the arm that keeps
  // the reported bug fixed. One class flip is ONE record, so a proportional
  // test alone drowns it: a hint session that has been open for a second and
  // seen a couple of its own setup mutations already "expects" about that many,
  // and the response is then indistinguishable from noise on paper. Below two
  // expected records there is no rate worth believing, so any change counts —
  // which is also the one-sided bias this whole module keeps: a missed retry is
  // cheaper than a press that undoes a working one.
  if (expected < 2) return "the page updated itself";
  // Above that the page really is muttering to itself, and a response has to
  // stand out from it (a modal's subtree, a re-render) rather than merely exist.
  if (growth > expected * 1.5) return "the page updated itself";
  return "";
}

// THE TARGET's own reaction, with none of the page-level signals folded in.
//
// The split exists because the two answers are needed for two different
// decisions. "Did the page do anything" is the verdict (permissive on purpose,
// see lifeSignal). "Did the CONTROL do anything" is the trigger for the
// privileged retry — and while they were one function, that retry was
// unreachable on exactly the pages it was built for: a video player, a chat
// transcript or a clock mutates continuously, so the page-level half always
// reported life and a trust-gated control that ignored the click was never
// escalated. Measured on the fixture in the hint suite: with a mutation
// heartbeat running, the isTrusted-gated control stayed silent and untried.
export function targetSignal(el: Element, before: LifeSnapshot): string {
  // A framework that swapped the node for a fresh one is the strongest possible
  // "it worked" — checked first because it is the most common on SPA pages.
  if (!el.isConnected || !before.connected) return "the element was replaced";
  const now = snapshotLife(el);
  if (now.disabled !== before.disabled) return "it became disabled";
  if (now.cls !== before.cls) return "its class changed";
  if (now.aria !== before.aria) return "its ARIA state changed";
  if (now.value !== before.value) return "its value changed";
  if (now.checked !== before.checked) return "it got toggled";
  if (now.href !== before.href) return "its link changed";
  return "";
}

// Everything AROUND the target: title, route, scroll, any mutation anywhere in
// the document. All of these are ordinary consequences of a click that worked,
// so any of them counts as success — the caller must never accuse a working
// click of doing nothing.
export function pageSignal(el: Element, before: LifeSnapshot): string {
  if (!el.isConnected || !before.connected) return "the element was replaced";
  const now = snapshotLife(el);
  if (now.title !== before.title) return "the page title changed";
  if (now.scrollX !== before.scrollX || now.scrollY !== before.scrollY) {
    return "the page scrolled";
  }
  if (now.mutations > before.mutations) return "the page updated itself";
  return "";
}

// The combined verdict: the target first (it is the specific answer), then the
// page. Returns a short name for the first difference found, or "" only when
// nothing anywhere changed.
export function lifeSignal(el: Element, before: LifeSnapshot): string {
  return targetSignal(el, before) || pageSignal(el, before);
}

// A short, human description of an element, for the "nothing happened" toast
// and the diagnostics page. Deliberately cheap and never throws.
