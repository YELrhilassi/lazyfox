# The Lazyfox product page

One page, in its own Vite + React project. Nothing here is imported by the
add-on, the installer or any script at the repository root, and nothing at the
root imports it: `npm test`, `npm run build` and `npm run ship` behave exactly as
they did before this directory existed.

```sh
cd site
npm install
npm run dev      # http://localhost:5199
npm run build    # dist/, ready to publish
```

## What the build does

`npm run build` is four steps, in this order, and the order is the point:

1. `tsc` for the app (`tsconfig.json`) and for the build-side files
   (`tsconfig.node.json`).
2. `vite build` — the client bundle into `dist/`.
3. `vite build --ssr src/entry-server.tsx` — the same components compiled for
   Node, into `.ssr/` (ignored by git).
4. `node scripts/prerender.mjs` — renders the page and writes it **into**
   `dist/index.html`, then generates `sitemap.xml` and `robots.txt`.

Step 4 is the SEO decision. The published document contains the whole page as
markup, with no JavaScript run: the `<h1>`, the copy, the key list, the install
steps and the alt text are in the HTML a crawler (or a reader with scripting
off) receives. React then hydrates that markup for the one interactive thing on
the page, the Copy buttons. `prerender.mjs` refuses to write an `index.html`
that lost its `<h1>` or still holds the placeholder comment, and the workflow
re-checks the same two facts before uploading.

The head carries a canonical URL, Open Graph and Twitter tags, and a
`SoftwareApplication` JSON-LD block. All of it is written in `index.html` from
placeholders (`%SITE_URL%`, `%SITE_TITLE%`, …) that `vite.config.ts` substitutes,
so the addresses live in `config.mjs` rather than scattered through markup.

## Where it is published

GitHub Pages, by `.github/workflows/pages.yml`, on a push to `master` or
`dev-nightly` that touches `site/`, or on demand from the Actions tab.
Expected address: <https://yelrhilassi.github.io/lazyfox/>.

**One-time setup:** in the repository, Settings → Pages → Build and deployment →
Source must be **GitHub Actions**. Without it the deploy job stops at
`actions/configure-pages` with "Get Pages site failed".

The workflow passes `SITE_URL=https://yelrhilassi.github.io/lazyfox` and nothing
else. That single value is both the canonical address and the source of the
bundle's base path: `config.mjs` derives `SITE_BASE` from its pathname
(`/lazyfox/`), and `vite.config.ts` uses the root only for `npm run dev`. Moving
to a custom domain means changing that one value, in `config.mjs` and in the
workflow. (It is deliberately not a second env var: a Windows shell rewrites a
value like `/lazyfox/` into a filesystem path before the build sees it.)

## Images

`public/lazyfox-mark.svg` and the two screenshots are copies of the documented
product shots under `docs/img/`; `public/img/og.png` is the command-center shot
used as the social card, and `public/img/apple-touch-icon.png` is the 512 px
extension icon. They are copied rather than linked because Vite's `public/`
tree is what a deployment uploads.

## Editing

The copy, the feature list, the key list and the install steps are data at the
top of `src/App.tsx`; the links and install one-liners are in `src/links.ts`;
the palette and the layout are `src/styles.css` (no CSS framework, one accent
colour). Keep the page short: it is a front page, not a manual — the README and
`docs/` are the manual.
