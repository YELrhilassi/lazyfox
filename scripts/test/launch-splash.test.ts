// The launch splash, asserted in Node.
//
// WHY THIS FILE EXISTS. The splash is the one surface that exists to hide a
// failure the user was watching: windows appearing and being rebuilt while a
// saved session is reapplied. Its whole value is in three timings that are easy
// to get wrong and impossible to notice when they are — paint too eagerly and
// EVERY launch flashes a logo, never paint and the restore is the flash the user
// already reported, and forget the failsafe and a helper that never hears "the
// resume is over" leaves the window behind a logo.
//
// The controller is driven against `createFakeChromeEnv()` and a local clock, so
// each of those timings is a decision the test makes rather than a wall-clock
// wait: the module schedules through `env.setTimeout`, and the test owns the
// queue.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createFakeChromeEnv } from "../../src/chrome/env-fake.ts";
import { createSplash } from "../../src/chrome/splash.ts";

/**
 * The fake env plus a clock the test fires by hand.
 *
 * The fake's own `setTimeout` drains every wave at once, which is right for the
 * modules that arm a poller and wrong for this one: "it is painted" and "the
 * failsafe has taken it down" happen at two different moments, and collapsing
 * them would make the paint unobservable.
 */
function clockedSplash(baseUrl: string | null = "moz-extension://abc/") {
  const env = createFakeChromeEnv();
  const queue = new Map<number, () => void>();
  let nextId = 0;
  env.setTimeout = ((fn: () => void) => {
    const id = ++nextId;
    queue.set(id, fn);
    return id;
  }) as any;
  env.clearTimeout = ((h: any) => {
    queue.delete(h);
  }) as any;
  const splash = createSplash({ env, baseUrl: () => baseUrl });
  return {
    env,
    queue,
    splash,
    /** Fire the oldest pending timer (the next thing the module asked for). */
    fire(): void {
      const [id, fn] = [...queue.entries()][0] || [];
      if (id == null || !fn) throw new Error("no timer was scheduled");
      queue.delete(id);
      fn();
    },
    /** The FIRST host the splash mounted, if it has mounted one yet. */
    host(): any {
      return env.appended.find((e: any) => e && e.attrs && e.attrs.id === "lf-splash") || null;
    },
    /** Every element with this id, in the order it was appended. */
    mounts(id = "lf-splash"): any[] {
      return env.appended.filter((e: any) => e && e.attrs && e.attrs.id === id);
    },
  };
}

describe("the launch splash", () => {
  test("nothing is painted before the delay", () => {
    const t = clockedSplash();
    t.splash.set(true);
    // The launch that settles in milliseconds must show NO logo: the paint is
    // pending, not done.
    assert.equal(t.mounts().length, 0, "the splash painted before its delay elapsed");
    assert.equal(t.queue.size, 1, "exactly one pending paint was expected");
  });

  test("an early off cancels the paint entirely", () => {
    const t = clockedSplash();
    t.splash.set(true);
    t.splash.set(false);
    // Both halves matter: the pending paint is cleared, and the module will not
    // paint even if a stale timer reaches it.
    assert.equal(t.queue.size, 0, "the pending paint was left on the clock");
    assert.equal(t.mounts().length, 0, "a cancelled splash still painted");
  });

  test("a resume that outlives the delay covers the window, and the failsafe lifts it", () => {
    const t = clockedSplash();
    t.splash.set(true);
    t.fire();
    const host = t.host();
    assert.ok(host, "the splash never painted");
    assert.equal(host.style.cssText.includes("position:fixed"), true, "the cover is not fixed over the window");
    assert.equal(host.style.cssText.includes("pointer-events:none"), true, "the cover would swallow the user's clicks");
    assert.equal(host.parent, t.env.document.documentElement, "the cover was not mounted on the document");
    // The mark, the spinner and the reason, in that order.
    const tags = host.children.map((c: any) => c.tagName);
    assert.deepEqual(tags, ["IMG", "DIV", "DIV"], `unexpected cover contents: ${JSON.stringify(tags)}`);
    assert.equal(host.children[0].attrs.src, "moz-extension://abc/icons/icon256.png");
    assert.ok(String(host.children[2].textContent).length > 0, "the cover says nothing about what is happening");
    // And it cannot outlive the restore it announced, even if the background
    // never says the resume is over (a suspended event page, a crashed helper).
    t.fire();
    assert.equal(host.parent, null, "the failsafe never lifted the cover");
    assert.equal(t.mounts("lf-splash-css")[0].parent, null, "the injected stylesheet outlived the splash");
  });

  test("repeated announces paint one cover", () => {
    const t = clockedSplash();
    // The background sends this per window that might be waiting, and a window
    // can be told twice (its own announce ack and the broadcast).
    t.splash.set(true);
    t.splash.set(true);
    t.fire();
    assert.equal(t.mounts().length, 1, "the splash painted twice");
  });

  test("a cover already down paints again for the next resume", () => {
    const t = clockedSplash();
    t.splash.set(true);
    t.fire();
    t.splash.set(false);
    t.splash.set(true);
    t.fire();
    assert.equal(t.mounts().length, 2, "the second resume was not covered");
    const second = t.mounts()[1];
    assert.notEqual(second.parent, null, "the second cover is not on screen");
  });

  test("an unreadable mark costs the logo, not the splash", () => {
    // No base URL (the policy lookup came back empty): the spinner and the line
    // still say what is happening, with no broken-image placeholder standing in
    // for the mark.
    const t = clockedSplash(null);
    t.splash.set(true);
    t.fire();
    const host = t.host();
    assert.ok(host, "the splash never painted");
    assert.deepEqual(
      host.children.map((c: any) => c.tagName),
      ["DIV", "DIV"],
      "an img was painted with no base URL to read it from",
    );
  });

  test("a mark that fails to load removes itself", () => {
    const t = clockedSplash();
    t.splash.set(true);
    t.fire();
    const img = t.host().children[0];
    img.dispatchEvent({ type: "error" });
    assert.equal(img.parent, null, "a broken mark was left in place");
    assert.equal(t.host().children.length, 2, "the splash went with the mark");
  });
});
