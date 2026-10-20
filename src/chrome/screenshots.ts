// The screenshot tool: Firefox's NATIVE Screenshots feature, behind one
// Lazyfox entry point.
//
// Firefox ships a full screenshot surface (resource:///modules/
// ScreenshotsUtils.sys.mjs): the region picker, the copy / download /
// preview flow, the UI the user already knows. Rewriting any of it would be a
// second, worse screenshot tool. What was missing is everything around it — a
// way to REACH it from the keyboard (the native UI is a toolbar button / a
// right-click menu entry, neither of which survives Lazyfox's hidden
// chrome), and a stated failure when the module is not there. So:
//
//   `;C f`  TakeFullPageScreenshot  — the native overlay, selection armed
//   `;C v`  TakeVisibleScreenshot   — the viewport, straight to the capture
//
// Both paths are the product's own; this module is the door. Errors are
// REPORTED as toasts (a silent miss reads as a dead key), and the import is
// retry-lazy: the module registers lazily in some Firefox versions, so one
// throw is not a verdict.
//
// Node-fake friendly: env carries both window and ChromeUtils (see env.ts),
// so the wiring is unit-testable and the import is the only privileged part.

import { toast } from "../shared/overlay";
import type { ChromeEnv } from "./env";

export type ScreenshotShot = "full" | "visible";

interface ScreenshotsUtils {
  TakeFullPageScreenshot(browser: unknown, downloadType?: string): void;
  TakeVisibleScreenshot(browser: unknown, downloadType?: string): void;
}

/** Load the native module. Returns null when this Firefox has none (or has
 * it under a different resource URI) — the caller toasts, never throws. */
function nativeUtils(env: ChromeEnv): ScreenshotsUtils | null {
  const uris = [
    "resource:///modules/ScreenshotsUtils.sys.mjs",
    "resource://gre/modules/ScreenshotsUtils.sys.mjs",
  ];
  for (const uri of uris) {
    try {
      const mod: any = (env.ChromeUtils as any).importESModule(uri);
      if (mod && mod.ScreenshotsUtils) return mod.ScreenshotsUtils as ScreenshotsUtils;
    } catch {
      // try the next URI
    }
  }
  return null;
}

/**
 * Drive Firefox's own screenshot flow for the selected tab.
 *
 * No Lazyfox overlay, no capture of our own: the native picker owns region
 * selection, the preview and where the bytes go. This is the "Firefox already
 * has something native" — Lazyfox's job is the keyboard door in front of it.
 */
export function takeScreenshot(env: ChromeEnv, shot: ScreenshotShot): void {
  let utils: ScreenshotsUtils | null = null;
  try {
    utils = nativeUtils(env);
  } catch {
    utils = null;
  }
  if (!utils) {
    toast("screenshots unavailable in this Firefox build");
    return;
  }
  let browser: unknown = null;
  try {
    browser = (env.window as any).gBrowser && (env.window as any).gBrowser.selectedBrowser;
  } catch {
    browser = null;
  }
  if (!browser) {
    toast("no page to capture");
    return;
  }
  try {
    if (shot === "visible") utils.TakeVisibleScreenshot(browser);
    else utils.TakeFullPageScreenshot(browser);
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 140);
    toast("screenshot failed: " + msg);
  }
}
