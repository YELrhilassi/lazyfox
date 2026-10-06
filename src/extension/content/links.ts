// "The link in front of you" — what `;K c` (copy) and `;K e` (edit) act on.
//
// The category is called Links and deliberately contains no search and no
// link-opening, because `;o`, `;O`, `;s` and `;S` already do those. What is
// left is the link you are LOOKING AT, and the hard part is not the copy or
// the edit: it is deciding which link that is.
//
// TWO ANSWERS, IN THIS ORDER, and both are things the user can see:
//
//   1. The hint layer, when it is open. `currentTarget()` is exactly what Enter
//      would activate at this instant — the same predicate, the same filter —
//      so "copy this link" cannot disagree with "open this link". If the two
//      disagreed, one of them is a lie and there is no way for the user to tell
//      which.
//
//   2. The link under the pointer. `elementFromPoint` at the last known mouse
//      position, walking up to the nearest anchor. This is what a person
//      pointing at a link expects "the current link" to mean.
//
//   3. Otherwise: nothing, and a toast saying so. Guessing "the first link on
//      the page" would be a silent wrong answer to a copy command, which is the
//      worst possible failure for something whose whole job is to hand you a
//      URL you are about to paste somewhere.

import { copyText } from "../../shared/dom";
import { toast } from "../../shared/overlay";

export interface CurrentLink {
  /** Absolute href. */
  url: string;
  /** The link's visible text, for identifying it in a toast. */
  text: string;
  /** The anchor itself, when there is one to write back to. */
  el: HTMLAnchorElement | null;
}

interface Deps {
  /** The open hint layer, or null when hints are not running. */
  hints: { active: boolean; currentTarget(): { url: string; text: string } | null } | null;
}

/** The last mouse position, so a stationary pointer still resolves. */
let lastX = 0;
let lastY = 0;
let sawPointer = false;

export function rememberPointer(e: MouseEvent): void {
  lastX = e.clientX;
  lastY = e.clientY;
  sawPointer = true;
}

function anchorAt(x: number, y: number): HTMLAnchorElement | null {
  let el: Element | null = null;
  try {
    el = document.elementFromPoint(x, y);
  } catch (e) {
    el = null;
  }
  if (!el) return null;
  const a = (el.closest && el.closest("a[href]")) as HTMLAnchorElement | null;
  return a && a.href ? a : null;
}

function describe(el: Element | null, url: string): string {
  const t = el ? ((el as HTMLElement).innerText || el.textContent || "") : "";
  const text = t.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 60) : url;
}

/**
 * The link the user means, or null — with the REASON, because "no link" is not
 * an answer a user can act on. Two different things produce it: there is no
 * pointer yet (they have not moved the mouse, so `;K h` is the thing to try),
 * or the pointer is over something that is not a link (move it). Saying which
 * is the difference between a dead key and a usable one.
 */
export function resolveLink(deps: Deps): { link: CurrentLink | null; reason: string } {
  const h = deps.hints;
  if (h && h.active) {
    const t = h.currentTarget();
    if (t && t.url) return { link: { url: t.url, text: t.text || t.url, el: null }, reason: "hints" };
  }
  if (!sawPointer) return { link: null, reason: "no pointer yet" };
  const a = anchorAt(lastX, lastY);
  if (a) return { link: { url: a.href, text: describe(a, a.href), el: a }, reason: "pointer" };
  return { link: null, reason: "pointer is not over a link" };
}

/** The link the user means, or null when there is not one. */
export function currentLink(deps: Deps): CurrentLink | null {
  return resolveLink(deps).link;
}

// ---- the inline editor -----------------------------------------------------

const EDITOR_ID = "lazyfox-linkedit";

function closeEditor(): void {
  const el = document.getElementById(EDITOR_ID);
  if (el) el.remove();
}

/**
 * A small input over the link being edited.
 *
 * An input rather than a prompt() because prompt() is a page-modal dialog: the
 * page's own scripts see it, cannot be styled, and (in some frames) are not
 * allowed to suppress it — so an editor the user cannot trust to appear is not
 * an editor. It also gives us a place to show the link's TEXT, which is what
 * makes it obvious whether the right link is being changed.
 *
 * Apply writes back only when the href is still valid, and reports what it did
 * rather than failing silently: an edit that quietly does nothing is the same
 * failure as no editor at all.
 */
export function editLink(deps: Deps): void {
  const found = resolveLink(deps);
  const link = found.link;
  if (!link) {
    toast("no link to edit: " + found.reason);
    return;
  }
  closeEditor();
  let rect: DOMRect | null = null;
  try {
    if (link.el) rect = link.el.getBoundingClientRect();
  } catch (e) {
    rect = null;
  }
  const x = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - 380)) : 24;
  const y = rect ? Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 150)) : 80;

  const box = document.createElement("div");
  box.id = EDITOR_ID;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Edit link");
  box.style.cssText = [
    "position:fixed",
    "left:" + x + "px",
    "top:" + y + "px",
    "z-index:2147483647",
    "width:360px",
    "max-width:94vw",
    "padding:10px 12px",
    "background:#1e1e2e",
    "color:#c0caf5",
    "border:1px solid #414868",
    "border-radius:8px",
    "box-shadow:0 24px 70px rgba(0,0,0,.6)",
    "font:12px/1.4 system-ui,sans-serif",
    "box-sizing:border-box",
  ].join(";");

  const label = document.createElement("div");
  label.textContent = link.text;
  label.style.cssText = "color:#9aa5ce;font-size:11px;margin-bottom:6px;" +
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  box.appendChild(label);

  const input = document.createElement("input");
  input.type = "text";
  input.value = link.url;
  input.style.cssText = "width:100%;box-sizing:border-box;background:#16161e;color:#c0caf5;" +
    "border:1px solid #414868;border-radius:5px;padding:5px 7px;font:12px ui-monospace,monospace";
  box.appendChild(input);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px";
  const hint = document.createElement("span");
  hint.style.cssText = "color:#565f89;font-size:10px;flex:1";
  hint.textContent = "Enter apply · Esc cancel";
  row.appendChild(hint);

  const btn = (labelText: string, primary: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = labelText;
    b.style.cssText = "background:" + (primary ? "#7aa2f7" : "#292e42") + ";color:" +
      (primary ? "#16161e" : "#c0caf5") + ";border:1px solid #414868;border-radius:5px;" +
      "padding:3px 10px;font:11px system-ui,sans-serif;cursor:pointer";
    row.appendChild(b);
    return b;
  };
  const cancel = btn("Cancel", false);
  const apply = btn("Apply", true);
  box.appendChild(row);
  document.documentElement.appendChild(box);

  const finish = (): void => {
    closeEditor();
    try {
      (document.activeElement as HTMLElement | null)?.blur();
    } catch (e) {
      // ignore
    }
  };

  const applyEdit = (): void => {
    const next = input.value.trim();
    finish();
    if (!next) {
      toast("link unchanged");
      return;
    }
    // A real anchor is written in place — that is what makes this an EDIT of
    // the page rather than a navigation somewhere else. With no anchor under
    // the pointer (the hint path, where the element is deliberately not kept)
    // there is nothing to rewrite, and saying so is better than pretending.
    if (!link.el) {
      void copyText(next);
      toast("no link to edit — copied instead");
      return;
    }
    try {
      // eslint-disable-next-line no-script-url
      const abs = new URL(next, location.href).href;
      link.el.setAttribute("href", abs);
      toast("link updated");
    } catch (e) {
      toast("not a usable URL");
    }
  };

  cancel.addEventListener("click", finish);
  apply.addEventListener("click", applyEdit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      applyEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    }
  });
  try {
    input.focus();
    input.select();
  } catch (e) {
    // ignore
  }
}

/** Copies the link in front of the user, or says why it could not. */
export function copyLink(deps: Deps): void {
  const found = resolveLink(deps);
  const link = found.link;
  if (!link) {
    toast("no link to copy: " + found.reason);
    return;
  }
  void copyText(link.url).then(() => toast("copied link"));
}

/** Attach the pointer tracker. Idempotent. */
export function installPointerTracker(): void {
  if ((window as any).__lfxPointerWired) return;
  (window as any).__lfxPointerWired = true;
  window.addEventListener("mousemove", rememberPointer, { passive: true, capture: true });
}