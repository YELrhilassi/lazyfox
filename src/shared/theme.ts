// Single source of truth for the app-wide UI font, shared by every embedded
// stylesheet (status bar, which-key overlay, popups, find widget, toasts).
// One stack everywhere keeps the UI visually consistent; the native system
// sans reads cleanly at every size the overlays use. Monospace is reserved
// for key caps / hint badges / commands (see the individual stylesheets).
export const UI_FONT =
  'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';