#!/usr/bin/env node
// Renders the which-key panel into a static page you can look at.
//
// Why this exists: the panel's layout is the part of the product that cannot be
// asserted. A test can prove the class names and the row order; it cannot see
// that a label's left edge is ragged, or that the header lost its background to
// a rule written for rows. Both of those shipped, and both were invisible to a
// green suite. So the redesign of the panel is judged here, against the real
// thing.
//
// Nothing here is a second implementation. The stylesheet comes from
// `src/shared/leader-css.ts`, every row comes from the markup builders in
// `src/shared/wk.ts`, and the keymap comes out of the REAL wasm core — the same
// code the browser runs. If the preview looks right and the panel renders
// differently, that means the builders are being called with different inputs,
// not that the preview is lying.
//
//   npm run wk:preview        -> build/wk-preview/index.html (gitignored)
//
// The page toggles between the states the panel can be in (each page of the
// keymap with its real cursor, and each category with its real sub-keys) and
// draws the panel at the size and position it ships with, over mock content so
// the shadow and the contrast are judged against something.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { core } from "../src/shared/core.ts";
import { WK_CSS, WK_HOST_HTML } from "../src/shared/leader-css.ts";
import { wkBodyHtml, wkCategoryHtml, wkExpectTitle, wkFootHtml, wkHeadHtml } from "../src/shared/wk.ts";
import type { WkPage } from "../src/shared/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "build", "wk-preview", "index.html");

// The preview serializes the host itself, so it has to agree with the host
// markup class-for-class. If WK_HOST_HTML grows a node, this check fails and the
// preview is fixed rather than quietly showing a different structure.
const hostClasses = [...WK_HOST_HTML.matchAll(/class='([^']+)'/g)].map((m) => m[1]!).join(" ");
if (hostClasses !== "wk wk-head wk-body wk-foot") {
  throw new Error("preview is out of step with WK_HOST_HTML: " + hostClasses);
}

interface View {
  id: string;
  label: string;
  note: string;
  head: string;
  body: string;
  foot: string;
}

const views: View[] = [];

// --- every page of the real keymap, with the real selection semantics --------
const pages = await core.wkPageCount();
for (let page = 0; page < pages; page++) {
  const slice: WkPage = await core.wkPageSlice(page);
  // The first DOOR on the page carries the cursor, so the selected-row design is
  // visible in the state that is hardest to get right (a door, not a binding).
  const door = slice.items.find((it) => it.cat);
  const sel = door ? door.lazyIndex : slice.items[0] ? slice.items[0].lazyIndex : -1;
  views.push({
    id: "page" + page,
    label: "All keys " + (page + 1) + "/" + pages,
    note: door
      ? "top level, cursor on the " + door.key + " door"
      : "top level, cursor on the first binding",
    head: wkHeadHtml("", ""),
    body: wkBodyHtml(slice, sel),
    foot: wkFootHtml(page, pages, false, !!(door && door.lazyIndex === sel)),
  });
}

// --- every category, from the keymap's own sub-key table ---------------------
interface KeymapHead {
  key: string;
  label: string;
  cat: string;
  catLabel?: string;
  catKeys?: Array<{ key: string; label: string }>;
}
for (const head of (await core.keymap()) as KeymapHead[]) {
  if (!head.cat) continue;
  const labels: Record<string, string> = {};
  const keys: string[] = [];
  for (const k of head.catKeys || []) {
    labels[k.key] = k.label;
    keys.push(k.key);
  }
  views.push({
    id: "cat-" + head.key,
    label: ";" + head.key + "  " + (head.catLabel || head.cat),
    note: "inside a door: " + keys.length + " keys, one column",
    head: wkHeadHtml(head.key, head.catLabel || head.cat || head.label),
    body: wkCategoryHtml(keys, labels),
    foot: wkFootHtml(0, 1, true),
  });
}

// --- a multi-key action IN FLIGHT -------------------------------------------
//
// The panel is a view of the leader's state, and this is the state that is not a
// list at all: a capture owns the keyboard, so the only true things on screen are
// which sequence is waiting and what it accepts. `;W m` waits for a tab position
// (`1-9`) and is the case that made the point — the keys it collects belong to the
// sequence, so the map must NOT be up while it is armed.
views.push({
  id: "pending",
  label: ";W m",
  note: "mid-sequence: waiting for a tab position",
  head: wkHeadHtml("W m", wkExpectTitle("1-9")),
  body: "",
  foot: wkFootHtml(0, 1, true),
});

const panels = views
  .map(
    (v, i) =>
      "<div id='panel-" +
      v.id +
      "' class='wk" +
      (i === 0 ? " on" : "") +
      "'><div class='wk-head'>" +
      v.head +
      "</div><div class='wk-body'>" +
      v.body +
      "</div><div class='wk-foot'>" +
      v.foot +
      "</div></div>",
  )
  .join("");

// The switcher is a PLAIN TEXT MENU, not a row of chips.
//
// It used to be bordered buttons with a coloured selected state, over cards with
// borders and rounded corners — a dashboard, drawn with the same vocabulary the
// panel is deliberately avoiding. The panel is judged here, so the page it is
// judged on has to be a document: one line per state, the current one in the
// accent colour, nothing boxed.
const buttons = views
  .map(
    (v, i) =>
      "<button data-view='" +
      v.id +
      "'" +
      (i === 0 ? " class='on'" : "") +
      "><b>" +
      v.label +
      "</b> " +
      v.note +
      "</button>",
  )
  .join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lazyfox which-key — design preview</title>
<style>
  /* The page the panel is drawn over: a plain document, so the panel's contrast
     is judged against content rather than against a flat backdrop. Nothing here
     is boxed — see the note on the switcher below. */
  :root { color-scheme: dark; }
  body { margin:0; background:#16161e; color:#a9b1d6;
         font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
         font-size:13px; line-height:1.6; }
  .page { max-width:660px; margin:0 auto; padding:26px 24px 150px; }
  h1 { font-size:13px; font-weight:600; color:#c0caf5; margin:0 0 2px; }
  p.note { color:#565f89; font-size:12px; margin:0 0 18px; }
  .switcher { margin:0 0 22px; display:flex; flex-direction:column; gap:1px; }
  .switcher button { display:block; text-align:left; cursor:pointer; background:none;
    border:0; padding:1px 0; margin:0; color:#565f89; font-family:inherit; font-size:12px; }
  .switcher button:hover { color:#9aa5ce; }
  .switcher button b { font-weight:500; color:#9aa5ce; }
  .switcher button.on, .switcher button.on b { color:#7aa2f7; }
  .mock { color:#3b4261; }
  .mock p { margin:0 0 10px; }
  .mock b { display:block; color:#565f89; font-weight:500; margin:22px 0 6px; }
${WK_CSS}
</style></head>
<body>
<div class="page">
  <h1>Which-key — design preview</h1>
  <p class="note">Real stylesheet, real markup builders, real keymap out of the core. The panel is
  position:fixed at right:24px bottom:30px, exactly where it ships.</p>
  <div class="switcher">${buttons}</div>
  <div class="mock">
    <b>A page behind the panel</b>
    <p>Text, at the size and weight a document actually uses, so the panel's
    contrast and its shadow are judged against content rather than against a flat
    backdrop. The panel is an overlay in the corner of a page the reader is
    reading, which is the only test that matters for how loud it should be.</p>
    <p>Nothing on this page is a card, a chip or a pill. Neither is the panel.</p>
    <b>And a second block, further down</b>
    <p>So that scrolling the list of states does not put the panel over the same
    pixels every time.</p>
  </div>
</div>
${panels}
<script>
  const buttons = [...document.querySelectorAll('.switcher button')];
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-view');
      for (const other of buttons) other.classList.toggle('on', other === b);
      for (const panel of document.querySelectorAll('.wk')) {
        panel.classList.toggle('on', panel.id === 'panel-' + id);
      }
    });
  }
</script>
</body></html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log("wrote " + out + " (" + html.length + " bytes, " + views.length + " views)");
