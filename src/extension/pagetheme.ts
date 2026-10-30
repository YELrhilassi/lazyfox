// Paint a Lazyfox page with the user's UI palette.
//
// Every extension page (settings, command center, popup, setup, split panel,
// diagnostics, add-ons) is a plain document whose stylesheet reads `--lf-*`
// tokens with defaults in theme.css. This reads the stored config and writes the
// tokens onto the document root, so one call at startup themes the whole page.
//
// It is deliberately fire-and-forget: a page that paints in the default palette
// for a few milliseconds is a flash, while a page that waits for storage before
// rendering is a blank window. The defaults and the shipped default preset are
// the same palette, so the common case never flashes at all.

import { mergeConfig } from "../shared/config";
import { logoFile, applyUiTheme, uiPalette, type UiPalette } from "../shared/theme";
import type { UiThemeConfig } from "../shared/types";
import { readKey, vConfig } from "./store";

/**
 * The logo lockup for the current palette, as a URL.
 *
 * The wordmark is baked into the SVG (an <img> cannot inherit `currentColor`),
 * so a light UI gets the dark-wordmark file. Pages call this where they used to
 * hard-code the one file; applying a theme also repaints every `[data-lf-logo]`
 * image, which covers the page that builds its logo late.
 */
export function logoUrl(): string {
  try {
    return browser.runtime.getURL(logoFile(uiPalette()));
  } catch (e) {
    return logoFile(uiPalette());
  }
}

/** Swap every logo image on the page to the one its palette needs. */
function paintLogos(p: UiPalette): void {
  try {
    let url: string;
    try {
      url = browser.runtime.getURL(logoFile(p));
    } catch (e) {
      url = logoFile(p);
    }
    for (const el of Array.from(document.querySelectorAll("img[data-lf-logo]"))) {
      const img = el as HTMLImageElement;
      if (img.getAttribute("src") !== url) img.src = url;
    }
  } catch (e) {
    // A page mid-teardown keeps whatever it is already showing.
  }
}

export function applyStoredTheme(): Promise<UiPalette> {
  return readKey("config", vConfig, {})
    .then((stored) => {
      const p = applyUiTheme(mergeConfig(stored).theme);
      paintLogos(p);
      return p;
    })
    .catch(() => {
      // A page with no storage access (a torn-down context) keeps the defaults.
      const p = uiPalette();
      paintLogos(p);
      return p;
    });
}

/** For the settings page, which already has the config in hand (and repaints
 *  the preview as the user edits). */
export function applyTheme(theme: UiThemeConfig | null | undefined): UiPalette {
  const p = applyUiTheme(theme);
  paintLogos(p);
  return p;
}
