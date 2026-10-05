// The toast: a short-lived message in a closed shadow root, mirrored onto
// <html> so anything outside the page can read what the command just did.
//
// It is its own module because the toast is not popup UI. A popup is a mode the
// user is in; the toast is the product's one-line report of a command that
// already finished, and it must be able to fire *from inside* a popup without
// sharing a host, a style sheet or a lifetime with one.

import { mirror } from "./observability";
import { TOAST_CSS } from "./overlaycss";

const HOST_CSS =
  "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;";

// The toast lives in a *closed* shadow root, so the host's .shadowRoot is null
// even for the creating script — keep a direct reference to the box instead of
// re-querying through the host.
let toastHost: {
  host: HTMLElement;
  span: HTMLSpanElement;
  box: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
} | null = null;

export function toast(msg: string): void {
  if (!toastHost) {
    const host = document.createElement("div");
    host.style.cssText = HOST_CSS;
    host.style.pointerEvents = "none";
    const sh = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = TOAST_CSS;
    const box = document.createElement("div");
    box.className = "t";
    const span = document.createElement("span");
    box.appendChild(span);
    sh.appendChild(style);
    sh.appendChild(box);
    document.documentElement.appendChild(host);
    toastHost = { host, span, box, timer: null };
  }
  toastHost.span.textContent = msg;
  toastHost.box.classList.add("on");
  // Mirror the message onto <html>, the same way the find (data-lf-find),
  // yank (data-lf-yank), hint (data-lf-hints) and leader (data-lf-leader)
  // overlays do. The toast box lives in a CLOSED shadow root, so without this
  // nothing outside the page can read it — and the toast is the product's own
  // report of what a command did ("session “work”", "no session at marker 1"),
  // which is exactly the signal a caller needs to confirm the command ran.
  mirror("toast", msg);
  if (toastHost.timer) clearTimeout(toastHost.timer);
  toastHost.timer = setTimeout(() => {
    if (toastHost) toastHost.box.classList.remove("on");
    // The attribute expires with the toast, so a stale message can never be
    // mistaken for a fresh one by a later reader.
    mirror("toast", null);
  }, 1400);
}