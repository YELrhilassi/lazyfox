// The synthetic key channel (#lfc=keys), extracted from channel.ts.
//
// This is the e2e harness's way to press keys: geckodriver's BiDi input is
// rejected on moz-extension ("privileged scope") contexts and Marionette keys
// never reach the chrome window's listener, so the real user code path —
// leader, popups, typing — would never see a synthetic key. The harness
// instead navigates a REAL tab to #lfc=keys.<payload>, and this module
// synthesizes the key sequence through the same dispatch the capture-phase
// listener owns, then answers via a reply hash (#lfc=keys.ok/err.<nonce>).
//
// Everything here touches no relay state; its only inputs are the key
// sequence payload and the chrome window. The pure pieces (shiftedKey, the
// SPECIAL_KEYS/keycode arithmetic) are unit-tested without a browser in
// scripts/test-chrome-keys.ts.

export interface KeysDeps {
  // The chrome window's capture-phase keydown dispatch (leader, popups,
  // hotkeys, typing guard). Returns whether the key was consumed; a key it
  // lets through is delivered to the focused element below.
  dispatch(e: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  }): boolean;
}

// Apply the Shift modifier to a printable key the way a real keyboard does
// (the harness asks for `;|` as key "\\" + shift, `;+` as "=" + shift). The
// real key path has Firefox compute the shifted character; the synthetic
// #lfc=keys path must do it itself or the leader sees "\\" instead of "|".
export function shiftedKey(key: string): string {
  if (key.length !== 1) return key;
  if (key >= "a" && key <= "z") return key.toUpperCase();
  const map: Record<string, string> = {
    "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%",
    "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
    "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|",
    ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
  };
  return map[key] || key;
}

// Key names -> DOM_VK_ key codes for sendKeyEvent (printable chars use
// charCode with keyCode 0).
export const SPECIAL_KEYS: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
};

// Synthesize a key sequence through the trusted input path (sendKeyEvent),
// so the chrome document's capture-phase keydown listener AND the focused
// page see exactly what a real key produces.
// Build a synthetic KeyboardEvent matching a key spec, dispatching through
// the normal DOM path so a page's window/document keydown listeners see it.
// The constructor comes from the TARGET window's realm: an event created
// with the chrome window's KeyboardEvent and dispatched into a content
// document is invisible to the page's listeners (its internal Window is the
// creator's), which is exactly what broke cross-realm dispatch.
export function buildKeyEvent(
  type: string,
  ev: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  ctor: typeof KeyboardEvent = KeyboardEvent
): KeyboardEvent {
  const keyCode = SPECIAL_KEYS[ev.key] !== undefined ? SPECIAL_KEYS[ev.key] : ev.key.length === 1 ? ev.key.toUpperCase().charCodeAt(0) : 0;
  const charCode = ev.key.length === 1 ? ev.key.charCodeAt(0) : 0;
  return new ctor(type, {
    key: ev.key,
    code: ev.key,
    keyCode,
    which: keyCode || charCode,
    charCode,
    bubbles: true,
    cancelable: true,
    shiftKey: ev.shiftKey,
    ctrlKey: ev.ctrlKey,
    altKey: ev.altKey,
    metaKey: ev.metaKey,
  });
}

// Synthetic (untrusted) key events never run the browser's native text
// insertion, which pages rely on for typing. Emulate it exactly: only when
// the keydown was NOT defaultPrevented (the page left the default action
// to the browser) and the target is a text field, insert the character.
export function maybeInsertText(
  target: Element | null,
  ev: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  notCanceled: boolean
): void {
  if (!notCanceled || !target) return;
  if (ev.key.length !== 1 || ev.ctrlKey || ev.altKey || ev.metaKey) return;
  try {
    const tag = String(target.tagName || "").replace(/^.*:/, "").toUpperCase();
    const input = tag === "INPUT" || tag === "TEXTAREA"
      ? (target as HTMLInputElement)
      : target.closest && target.closest("input, textarea")
        ? (target.closest("input, textarea") as HTMLInputElement)
        : null;
    if (!input || input.readOnly || input.disabled) return;
    const s = input.selectionStart == null ? input.value.length : input.selectionStart;
    const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, s) + ev.key + input.value.slice(en);
    try {
      input.setSelectionRange(s + 1, s + 1);
    } catch (e) {
      // ignore
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (e) {
    // ignore
  }
}

// Deliver an unconsumed key to wherever focus lives: the chrome popup input
// when a popup is open, otherwise the target tab's content (the command
// center). This mirrors what a real key would do after the chrome capture
// listener lets it through. `targetTab` is the tab the harness asked to
// address (defaults to the selected tab) — the chrome-level dispatch runs on
// the REAL selection (so relative actions like ;[/;] switch the actual active
// pane), but a key the chrome layer lets through lands in the addressed tab.
function dispatchToFocused(
  ev: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  },
  targetTab: any
): void {
  try {
    const popupInput = document.querySelector(".lf-input") as HTMLElement | null;
    if (popupInput) {
      // No keypress: the editor inserts text natively on a trusted keypress,
      // so a synthetic one would double-insert alongside maybeInsertText.
      // Neither the command center nor the popups listen to keypress.
      const notCanceled = popupInput.dispatchEvent(buildKeyEvent("keydown", ev));
      popupInput.dispatchEvent(buildKeyEvent("keyup", ev));
      maybeInsertText(popupInput, ev, notCanceled);
      return;
    }
  } catch (e) {
    // fall through to content
  }
  try {
    const tab = targetTab || (window.gBrowser && window.gBrowser.selectedTab);
    const cw = tab && tab.linkedBrowser && tab.linkedBrowser.contentWindow;
    if (cw && cw.document) {
      const ctor = (cw as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent || KeyboardEvent;
      const target = cw.document.activeElement || cw.document.documentElement;
      // No keypress (see the popup path): a synthetic keypress with a
      // charCode makes the editor insert the text natively, double-inserting
      // alongside maybeInsertText.
      const notCanceled = target.dispatchEvent(buildKeyEvent("keydown", ev, ctor));
      target.dispatchEvent(buildKeyEvent("keyup", ev, ctor));
      maybeInsertText(target, ev, notCanceled);
    }
  } catch (e) {
    // ignore
  }
}

// Handle a #lfc=keys.<payload>.<nonce> payload: decode the base64 key
// sequence, drive each key through the real chrome dispatch (falling through
// to the focused element when the chrome layer does not consume it), and
// answer via the reply hash. `setHash` is the channel's deferred reply writer.
export function handleKeys(
  deps: KeysDeps,
  browser: any,
  rest: string,
  setHash: (b: any, h: string) => void
): void {
  // Reply loop guard: our own reply hash (keys.ok.<nonce>) re-enters via
  // onLocationChange. base64 payloads never start with "ok."/"err.".
  if (rest.startsWith("ok.") || rest.startsWith("err.")) return;
  const dot = rest.indexOf(".");
  const payload = dot < 0 ? rest : rest.slice(0, dot);
  const nonce = dot < 0 ? "" : rest.slice(dot + 1);
  let req: { idx?: number; keys?: Array<{ k: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }> } = {};
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    req = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    setHash(browser, "#lfc=keys.err." + nonce);
    return;
  }
  const seq = Array.isArray(req.keys) ? req.keys : [];
  const errReply = (e: unknown): void => {
    try {
      const msg = String((e && (e as Error).message) || e);
      const st = String((e && (e as Error).stack) || "").split("\n").slice(0, 2).join(" @ ");
      Services.console.logStringMessage("lfc keys error: " + msg + " @ " + st);
      setHash(browser, "#lfc=keys.err." + btoa(msg + " @ " + st).replace(/=+$/g, "") + "." + nonce);
    } catch (e2) {
      setHash(browser, "#lfc=keys.err." + nonce);
    }
  };
  // Resolve the tab the harness addressed (idx -1 means the selected tab).
  // The chrome key dispatch runs on the REAL current selection, so leader
  // actions that are relative to the active pane (;[/;], ;+N, ;|) work on
  // whatever pane is actually active; only keys the chrome layer lets through
  // (typing) are routed to the addressed tab's content. Never force-select
  // req.idx here: that would reset the active pane mid-split and make ;[ /
  // ;] switch from the wrong pane (and it undid ;c's selection of the copy).
  let targetTab: any = window.gBrowser && window.gBrowser.selectedTab;
  try {
    if (typeof req.idx === "number" && req.idx >= 0 && window.gBrowser.tabs[req.idx]) {
      targetTab = window.gBrowser.tabs[req.idx];
    }
  } catch (e) {
    // ignore
  }
  let i = 0;
  const step = (): void => {
    if (i >= seq.length) {
      setHash(browser, "#lfc=keys.ok." + nonce);
      return;
    }
    const k = seq[i++] || { k: "" };
    try {
      const ev = {
        key: k.shift ? shiftedKey(k.k) : k.k,
        ctrlKey: !!k.ctrl,
        altKey: !!k.alt,
        shiftKey: !!k.shift,
        metaKey: !!k.meta,
        isComposing: false,
      };
      const consumed = deps.dispatch(ev);
      if (!consumed) dispatchToFocused(ev, targetTab);
    } catch (e) {
      errReply(e);
      return;
    }
    setTimeout(step, 20);
  };
  step();
}
