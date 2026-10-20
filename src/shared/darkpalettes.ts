// The dark mode's color schemes, as data.
//
// The engine's palette has always been three poles — canvas, ink, accent —
// stored as `dark.background` / `dark.foreground` / `dark.accent` and handed
// to `buildTheme` as-is. This module adds the thing a user actually asks for:
// "themes like this one, but in the palette I like". A preset is therefore NOT
// a new source of truth (the engine still reads the three stored fields); it
// is a PICKER that writes those three fields at once, so the settings page can
// show a name ("Gruvbox Dark"), the keyboard can cycle them (`;Y p`), and a
// user who tweaks one colour afterwards is simply customizing their chosen
// scheme.
//
// Pure: presets in, preset out, no DOM and no config side effects — which is
// why the picker needs no browser to be pinned (scripts/test/dark-palettes.test.ts).

export interface DarkPalette {
  /** Stable id, stored in `config.dark.palette`. */
  id: string;
  /** Human name shown in settings and in the `;Y p` toast. */
  name: string;
  /** Canvas pole. */
  bg: string;
  /** Ink pole. */
  fg: string;
  /** Accent pole (unstyled links, selection, the reader's marks). */
  accent: string;
}

// The table itself. Tokyo Night is first AND is the default, because the rest
// of this product's surfaces are drawn from it; every entry keeps the contrast
// a dark page needs (the engine's own contrast floors do the rest).
export const DARK_PALETTES: DarkPalette[] = [
  { id: "tokyonight",   name: "Tokyo Night",      bg: "#16161e", fg: "#c0caf5", accent: "#7aa2f7" },
  { id: "tokyonight-storm", name: "Tokyo Night Storm", bg: "#1a1b26", fg: "#c0caf5", accent: "#7dcfff" },
  { id: "nord",         name: "Nord",             bg: "#2e3440", fg: "#d8dee9", accent: "#88c0d0" },
  { id: "gruvbox",      name: "Gruvbox Dark",     bg: "#282828", fg: "#ebdbb2", accent: "#83a598" },
  { id: "dracula",      name: "Dracula",          bg: "#282a36", fg: "#f8f8f2", accent: "#bd93f9" },
  { id: "catppuccin",   name: "Catppuccin Mocha", bg: "#1e1e2e", fg: "#cdd6f4", accent: "#89b4fa" },
  { id: "rosepine",     name: "Rosé Pine",        bg: "#191724", fg: "#e0def4", accent: "#9ccfd8" },
  { id: "solarized",    name: "Solarized Dark",   bg: "#002b36", fg: "#93a1a1", accent: "#268bd2" },
  { id: "everforest",   name: "Everforest Dark",  bg: "#2b3339", fg: "#d3c6aa", accent: "#83c092" },
  { id: "cosmo",        name: "Cyberpunk Neon",   bg: "#0d1117", fg: "#e6edf3", accent: "#f778ba" },
];

/** The default id. Kept beside the table so a rename cannot drift from it. */
export const DEFAULT_PALETTE = "tokyonight";

/** A stored palette id, or the default when it names nothing (hand-edited
 * config, an old release, a typo): an unknown id is a default, never a crash. */
export function paletteById(id: string | undefined | null): DarkPalette {
  return DARK_PALETTES.find((p) => p.id === id) || DARK_PALETTES[0]!;
}

/** The palette AFTER `id`, wrapping. Unknown/absent ids start from the top. */
export function nextPalette(id: string | undefined | null): DarkPalette {
  const at = DARK_PALETTES.findIndex((p) => p.id === id);
  return DARK_PALETTES[(at + 1) % DARK_PALETTES.length]!;
}

/** How the settings page's select orders and labels them. */
export function paletteOptions(): Array<{ id: string; name: string }> {
  return DARK_PALETTES.map((p) => ({ id: p.id, name: p.name }));
}
