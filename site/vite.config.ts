import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { SITE_BASE, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "./config.mjs";

// index.html is the one file that has to carry absolute URLs (canonical, og:url,
// og:image) and the base-prefixed icon. The address those should point at is a
// deployment fact, not markup, so the document keeps readable placeholders and
// this plugin substitutes them for both the dev server and the build.
const TOKENS: Record<string, string> = {
  SITE_URL,
  SITE_BASE,
  SITE_NAME,
  SITE_TITLE,
  SITE_DESCRIPTION,
};

const tokens = (): Plugin => ({
  name: "lazyfox-site-tokens",
  transformIndexHtml: {
    order: "pre",
    handler: (html) => html.replace(/%([A-Z_]+)%/g, (whole, key: string) => TOKENS[key] ?? whole),
  },
});

export default defineConfig(({ command }) => ({
  // Dev serves the page at the root so `npm run dev` is a plain URL; a build is
  // mounted where it will actually be published, which is derived from SITE_URL.
  base: command === "serve" ? "/" : SITE_BASE,
  plugins: [react(), tokens()],
  build: {
    target: "es2022",
    // The page is one document with two screenshots: inlining anything would
    // only delay the first paint that matters (the text).
    assetsInlineLimit: 0,
  },
}));
