// The links the page points at. They are duplicated in index.html only where a
// crawler needs them in the raw document (the JSON-LD block); keep the two in
// step if any of these move.
export const REPO_URL = "https://github.com/YELrhilassi/lazyfox";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const AMO_URL = "https://addons.mozilla.org/firefox/addon/lazyfox2/";
export const LICENSE_URL = "https://opensource.org/license/mit";

export const INSTALL_SH =
  "curl -fsSL https://github.com/YELrhilassi/lazyfox/releases/latest/download/install.sh | sh";
export const INSTALL_PS =
  "irm https://github.com/YELrhilassi/lazyfox/releases/latest/download/install.ps1 | iex";

// Vite rewrites bundled asset URLs for the deployment base, but a path that is
// merely written in a string is not a bundled asset. These two live in public/,
// so they are addressed through the base prefix instead.
export const asset = (file: string): string => `${import.meta.env.BASE_URL}${file}`;
