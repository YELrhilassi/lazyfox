// The fix corpus that ships with the engine: Dark Reader's own site rules,
// quoted, in Dark Reader's own format.
//
// WHY A COPY OF SOMEBODY ELSE'S FILE IS THE RIGHT ANSWER. The engine can remap
// the colours it can see, and on a handful of sites that is not enough: a logo
// rendered as a CSS background, a captcha iframe, a diagram drawn in SVG. Those
// cases are unfixable in general and trivially fixable in particular, which is
// why that project's community maintains a plain-text list of them. Adopting the
// format (shared/dark-rules.ts) means their corpus — and any file a user has
// already written — drops straight into Lazyfox's settings; shipping a curated
// slice means the feature works on the sites people actually visit before
// anyone edits anything.
//
// PROVENANCE, and it matters because this is somebody else's work:
//
//   source  https://github.com/darkreader/darkreader
//   files   src/config/dynamic-theme-fixes.config
//           src/config/inversion-fixes.config
//   taken   main, 2026-10-15
//   licence MIT — Copyright (c) 2026 Dark Reader Ltd. The notice and the full
//           text live in docs/THIRD-PARTY.md, which is the file to read before
//           touching this one.
//
// WHAT WAS CHANGED: blocks were TRIMMED to the directives this engine
// implements — upstream's `--darkreader-bg--*` inline-analysis variables and its
// stylesheet-rewriting machinery have no counterpart here, so rules that depend
// on them are inert and were dropped rather than shipped as decoration. Nothing
// was retyped or "improved", and no selector was invented. A trimmed block is
// still an upstream block.
//
// NOT TESTED BY US. These are the community's claims about the community's
// sites; this project has no harness that visits them. Treat every entry as a
// starting point a user can edit — which is the point of shipping the text
// rather than a compiled table.
//
// NOTE ON THE ESCAPES: this file is a JavaScript template literal and the format
// uses `${…}` templates, so every one of them is written `\${…}`. That is the
// only reason that character appears with a backslash, and it is why the text
// cannot be moved into a plain .txt asset without also changing the loader.

// The header below is part of the shipped TEXT, not a comment about it, because
// this string is the default value of a settings textarea: a user who pastes
// their own list over it, or edits a site block they disagree with, should be
// able to read where the text came from without opening the repository. The
// parser skips `#` lines in host position, so the header is inert.
export const SHIPPED_FIXES = `# Lazyfox theme fixes — a curated subset of Dark Reader's own fix lists.
#
#   source   https://github.com/darkreader/darkreader
#   files    src/config/dynamic-theme-fixes.config
#            src/config/inversion-fixes.config
#   taken    main, 2026-10-15
#   licence  MIT — Copyright (c) 2026 Dark Reader Ltd. See docs/THIRD-PARTY.md.
#
# Format: the hosts a block applies to, then a directive, then one entry per
# line. Directives: INVERT, NO INVERT, REMOVE BG, CSS, IGNORE INLINE STYLE,
# IGNORE IMAGE ANALYSIS, IGNORE CSS URL. Blocks are separated by a line of ====.
# Lines starting with # are comments — a Lazyfox addition, not upstream's
# format, and recognised only before a directive (after INVERT, #player is a
# selector).
#
# Edit this freely: it is a starting point, not a constant. Deleting a block
# deletes the fix; adding one for a site you know is the intended use.
*
INVERT
c-wiz div > svg > circle
.jfk-bubble.gtx-bubble
.captcheck_answer_label > input + img
span#closed_text > img[src^="https://www.gstatic.com/images/branding/googlelogo"]
span[data-href^="https://www.hcaptcha.com/"] > #icon
img.Wirisformula
a[data-testid="headerMediumLogo"]>svg
CSS
::placeholder {
opacity: 0.5 !important;
}
*[style*="color: rgba(0,0,0,"]:not([style*="color: rgba(0,0,0,0)"]),
*[style*="color: rgba(0, 0, 0,"]:not([style*="color: rgba(0, 0, 0, 0)"]),
*[style*="color:#000"]:not(.cell-input > span),
*[style*="color:black"]:not(.cell-input > span),
*[style*="color:#282828"]:not(.cell-input > span),
*[style*="color:#444"]:not(.cell-input > span),
*[style*="color: #222222"]:not(.cell-input > span) {
color: var(--darkreader-neutral-text) !important;
}
*[style*="background:#fff"],
*[style*="background-color:#fff"],
*[style*="background: #fff"],
*[style*="background: rgb(255, 255, 255)"] {
background: var(--darkreader-neutral-background) !important;
}
*[bgcolor="#F5F5F5"],
*[style*="background-color: #F5F5F5"] {
background: \${#F5F5F5} !important;
}
*[style*="background: #e6e6e6"] {
background: \${#e6e6e6} !important;
}
*[style*="background:#f9f9f9"] {
background: \${#F9F9F9} !important;
}
IGNORE CSS URL
^https://fonts.googleapis.com/
================================
*.abc.net.au
INVERT
[data-component="ABCNewsLogo"] *
IGNORE INLINE STYLE
[data-component="ABCLogo"] *
================================
*.archlinux.org
INVERT
img[src*="icons/"]
img[src="/svg/calendar.svg"]
.cdx-search-input .cdx-text-input__icon.cdx-text-input__start-icon
.cdx-button--icon-only .vector-icon
CSS
.vector-sticky-pinned-container::after {
background: inherit;
}
body {
height: fit-content;
}
================================
*.arxiv.org
arxiv.org
INVERT
img.ds-funder-logo
CSS
img.ds-funder-logo {
background-color: white !important;
}
================================
*.bitrix24.ru
INVERT
#ws-canvas
================================
*.discogs.com
INVERT
[class*="logo"]
CSS
.swiper-pagination-bullet {
background: var(--swiper-pagination-bullet-inactive-color, #FFFFFF) !important;
}
.bg-\\[linear-gradient\\(to_right\\,transparent_var\\(--fill-stop\\)\\,\\#f2f2f2_var\\(--fill-stop\\)\\)\\] {
background-image: linear-gradient(to right,transparent var(--fill-stop),\${#d2d2d2} var(--fill-stop)) !important;
}
================================
*.docs.kubernetes.io
CSS
.highlight pre code > span[style*="text-decoration: underline"] {
text-decoration: none !important;
}
================================
*.dreamwidth.org
INVERT
#tagform input[type="image"]
CSS
body {
background-color: var(--darkreader-neutral-background) !important;
}
.tropo nav,
.tropo footer,
#intro-box-main {
background-image: none !important;
}
html[data-darkreader-scheme="dark"] .tropo #logo {
filter: invert(90%) hue-rotate(180deg) !important;
}
html[data-darkreader-scheme="dimmed"] .tropo #logo {
filter: brightness(85%) !important;
}
.ContextualPopup {
background: var(--darkreader-neutral-background) !important;
}
[class*='ui-widget'],
.gradient,
.taginfo {
background-image: none !important;
}
================================
*.gamer.com.tw
INVERT
.sidenav__icon
CSS
body {
background-color: transparent !important;
background-image: none !important;
}
.main-nav__logo {
background-color: currentColor !important;
}
IGNORE IMAGE ANALYSIS
.service__icon.icon-arrow
.MSG-mainpic
#BH-main_menu
#BH-master h4
.BH-slave_btns .BH-slave_btnA
#BH-slave h5
`;
