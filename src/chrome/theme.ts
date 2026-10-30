// The window chrome's palette.
//
// userChrome.css draws the toolbar and URL bar from `--lf-*` tokens and ships
// Tokyo Night values in its `:root` block, because a stylesheet cannot read the
// extension's config. This module closes that gap: the chrome helper turns the
// configured preset into inline custom properties on the browser document, which
// beat the stylesheet's defaults (inline wins over :root) and therefore paint
// the window in the user's palette.
//
// The user's own `chrome/userChrome.css` still wins over both where it sets a
// property — that file is theirs, and this only ever adds variables, never
// `!important` rules.
//
// Changes land at the next window start, which is why Settings → Appearance says
// the window chrome updates on relaunch: the helper boots before the first paint
// of the next window.

import { applyUiTheme, resolvePalette, setUiPalette } from "../shared/theme";
import type { ChromeCfg } from "./config";

export function applyChromeTheme(cfg: ChromeCfg): void {
  // resolvePalette first, so the overlays this window mounts (splash, popups,
  // status bar) read the same palette even if the document root is unavailable
  // for some reason.
  const p = resolvePalette(cfg.config.theme);
  setUiPalette(p);
  try {
    applyUiTheme(cfg.config.theme);
  } catch (e) {
    // A window whose root refuses a style write is still usable; the stylesheet
    // defaults paint it.
  }
}
