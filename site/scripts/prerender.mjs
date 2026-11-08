// Runs after the client and SSR builds. It puts the rendered markup into the
// served document (so the page a crawler or a reader gets already says
// everything, with no JavaScript run) and emits the two files only a real
// deployment origin can write: sitemap.xml and robots.txt.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { SITE_URL } from "../config.mjs";

const root = resolve(import.meta.dirname, "..");
const htmlPath = resolve(root, "dist/index.html");

const { render } = await import(pathToFileURL(resolve(root, ".ssr/entry-server.js")).href);

const html = await readFile(htmlPath, "utf8");
const marker = '<div id="root"><!--app--></div>';
if (!html.includes(marker)) {
  throw new Error(`prerender: ${htmlPath} has no ${marker} to fill — did index.html change?`);
}

const body = render();
if (!body.includes("<h1")) {
  throw new Error("prerender: the page rendered without its <h1>; refusing to publish an empty shell");
}

await writeFile(htmlPath, html.replace(marker, `<div id="root">${body}</div>`), "utf8");

const today = new Date().toISOString().slice(0, 10);
await writeFile(
  resolve(root, "dist/sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`,
  "utf8",
);

await writeFile(
  resolve(root, "dist/robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
  "utf8",
);

console.log(`prerender: wrote ${(body.length / 1024).toFixed(1)} KiB of markup into index.html`);
console.log(`prerender: sitemap + robots for ${SITE_URL}/`);
