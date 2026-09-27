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
}

// A mutation counter for the whole document, started only while a watch is in
// flight. Counting is cheaper than inspecting, and the count alone is enough:
// we are asking "did the page do ANYTHING", not "did it do the right thing".
let lifeObserver: MutationObserver | null = null;
let lifeMutations = 0;

export function startLifeCounting(): void {
  // Reset the baseline every time: a watch is always about "since the click".
  lifeMutations = 0;
  if (lifeObserver) return;
  try {
    lifeObserver = new MutationObserver((records) => {
      lifeMutations += records.length;
    });
    lifeObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  } catch (e) {
    lifeObserver = null;
  }
}

export function stopLifeCounting(): number {
  const n = lifeMutations;
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
  };
}

// Compare a fresh snapshot with the pre-click one. Returns a short name for the
// first difference found, or "" when nothing changed.
export function lifeSignal(el: Element, before: LifeSnapshot): string {
  // A framework that swapped the node for a fresh one is the strongest possible
  // "it worked" — checked first because it is the most common on SPA pages.
  if (!el.isConnected) return "the element was replaced";
  const now = snapshotLife(el);
  if (!before.connected) return "the element was replaced";
  if (now.disabled !== before.disabled) return "it became disabled";
  if (now.cls !== before.cls) return "its class changed";
  if (now.aria !== before.aria) return "its ARIA state changed";
  if (now.value !== before.value) return "its value changed";
  if (now.checked !== before.checked) return "it got toggled";
  if (now.href !== before.href) return "its link changed";
  // Element-local state is unchanged, but the page moved: title, route or
  // scroll. All three are ordinary consequences of a click that WORKED.
  if (now.title !== before.title) return "the page title changed";
  if (now.scrollX !== before.scrollX || now.scrollY !== before.scrollY) {
    return "the page scrolled";
  }
  if (now.mutations > before.mutations) return "the page updated itself";
  return "";
}

// A short, human description of an element, for the "nothing happened" toast
// and the diagnostics page. Deliberately cheap and never throws.
