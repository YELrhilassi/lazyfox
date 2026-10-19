#!/usr/bin/env node
// Renders the hint labels into a static page you can look at.
//
// Why this exists: the label's APPEARANCE is the part of the product that cannot
// be asserted. A test can prove the class names, the placement geometry and that
// every key on screen is typeable; it cannot see that the badge is too loud on a
// dark page, or that a wall of them reads as noise over a card grid. So the look
// is judged here, against the real thing.
//
// Nothing here is a second implementation of the RUNNING overlay. The stylesheet
// is `HINT_CSS` imported from the module the extension ships, and every state
// drawn (a plain label, the WAITING label, the enter badge) uses the real class
// names. What IS simplified — and stated on the page — is placement: labels sit
// at their element's top-left corner, which is the anchor the overlay tries
// first, instead of running the collision sweep that needs a layout engine.
//
//   npm run hints:preview   -> build/hints-preview/index.html (gitignored)
//
// The point of the page is comparison: each stylesheet is rendered over the same
// three grounds (a dark card grid like a video site, a light page, and a dense
// cluster where the labels compete), so a change can be judged on the surfaces it
// has to survive rather than in isolation. The two stylesheets on it are the one
// that ships and the one it replaced.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HINT_CSS } from "../src/extension/content/hints/selectors.ts";
// The caption's numbers come from the same module the stylesheet does, so the
// page cannot describe a look other than the one it renders (see `note` below).
import { HINT_LABEL } from "../src/shared/hintlabel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "build", "hints-preview", "index.html");

interface Variant {
  id: string;
  label: string;
  note: string;
  /** The stylesheet. The shipped one is HINT_CSS verbatim — never a copy. */
  css: string;
  /** Where a label sits on its element: "corner" (shipped) or an inset in px. */
  inset: number;
}

// --- the two stylesheets ----------------------------------------------------
//
// The shipped one is HINT_CSS ITSELF, imported from the module the extension
// bundles, so this page cannot show a look the product no longer has. The
// previous one is a literal copy, which is the only honest way to show the thing
// that was replaced: it is no longer anywhere in the tree.
const PREVIOUS_CSS =
  ".hint{position:fixed;z-index:2147483646;background:#2ac3de;color:#16161e;" +
  "font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;padding:2px 5px;border-radius:4px;" +
  "pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.4),0 0 0 1px rgba(22,22,30,.55)}" +
  ".hint-enter{position:fixed;left:0;top:0;display:none;z-index:2147483647;background:#2ac3de;color:#16161e;" +
  "font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;padding:2px 5px;border-radius:4px;" +
  "pointer-events:none;white-space:pre;box-shadow:0 2px 6px rgba(0,0,0,.4),0 0 0 1px rgba(22,22,30,.55)}" +
  ".hint.hint-wait{background:#7aa2f7;box-shadow:0 0 0 2px #c0caf5,0 2px 6px rgba(0,0,0,.45)}" +
  ".hint[style*='display:none'],.hint-off{display:none}";

const variants: Variant[] = [
  {
    id: "shipped",
    label: "Shipped now",
    // INTERPOLATED, not typed out. This caption used to name the fill by hand and
    // kept saying `#3ad4f0` for a whole pass after the stylesheet moved to the
    // product's blue — a preview whose caption lies about the thing it renders is
    // worse than no caption. Every value below is read off the same constants the
    // stylesheet is built from, so the only way to make it wrong is to change the
    // look without regenerating this page.
    note:
      HINT_LABEL.padding.split(" ")[0] +
      "px vertical padding, solid " +
      HINT_LABEL.fill +
      " with near-black text (" +
      HINT_LABEL.text +
      "), " +
      HINT_LABEL.radius +
      " radius, no border and no shadow. Fill contrast is what makes it legible on a dark page and " +
      "on white; the waiting label is " +
      HINT_LABEL.wait +
      ", the same colour the enter badge wears. That badge draws a solid arrow (a " +
      HINT_LABEL.enterIconSize +
      "px vector path, not the platform's ⏎ glyph), so the arrow is the same " +
      "drawing here as it is in the running overlay.",
    css: HINT_CSS,
    inset: 0,
  },
  {
    id: "previous",
    label: "What it replaced",
    note:
      "12px/600, 1px dark ring + drop shadow per label, 4px radius. Kept here only so the change " +
      "can be judged against the old look instead of described.",
    css: PREVIOUS_CSS,
    inset: 0,
  },
];

// Two identical stylesheets would render the same look twice and make the
// comparison a lie, so that is a hard error rather than something to notice in a
// screenshot. The shipped one must also still carry every state.
if (variants[0]!.css === variants[1]!.css) {
  throw new Error("preview would show the shipped stylesheet twice");
}
for (const v of variants) {
  for (const rule of [".hint{", ".hint-enter{", ".hint-wait"]) {
    if (!v.css.includes(rule)) throw new Error("preview variant " + v.id + " lost " + rule);
  }
}
// The icon rule is required of the SHIPPED stylesheet only: the previous look
// drew no icon (it had no badge-worth of markup at all), so demanding the rule
// of it would mean editing the record of what was replaced. It is required here
// because the page draws the real solid arrow, and a sheet that lost this rule
// would leave the SVG at its default size — a look no user has.
if (!variants[0]!.css.includes(".hint-enter svg{")) {
  throw new Error("shipped stylesheet lost .hint-enter svg{");
}

const CARD_IMG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='176' height='99'%3E%3Crect width='176' height='99' fill='%23303846'/%3E%3Ccircle cx='88' cy='49' r='18' fill='%23e8e8ee' opacity='.9'/%3E%3Cpath d='M83 40 L99 49 L83 58 Z' fill='%23303846'/%3E%3C/svg%3E";

/** One label, positioned the way the overlay places it (see the header). */
function hint(text: string, cls: string, inset: number, extra = ""): string {
  const pos = inset ? `left:${inset}px;top:${inset}px` : "left:0;top:0";
  return `<span class="hint${cls ? " " + cls : ""}" style="position:absolute;display:block;${pos};${extra}">${text}</span>`;
}

/**
 * The enter badge, built the way the overlay builds it: the real fixed box (from
 * HINT_LABEL) around the real solid icon. The previous page drew a "⏎" text
 * character here, so it kept showing the old look for as long as the running
 * overlay did not — a preview that lies about the thing it renders is worse than
 * no preview.
 */
function enterBadge(extra: string): string {
  return (
    `<span class="hint-enter" style="position:absolute;display:block;${extra}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HINT_LABEL.enterIcon}"/></svg></span>`
  );
}

/** A dark card grid — the surface the labels are hardest to read on. */
function darkGround(inset: number): string {
  const cards = [
    { dur: "30:56", key: "a" },
    { dur: "12:04", key: "s" },
    { dur: "1:57:33", key: "d" },
  ];
  return (
    `<div class="ground dark">` +
    cards
      .map(
        (c) =>
          `<div class="card">` +
          `<span class="thumb">${hint(c.key, "", inset)}<img src="${CARD_IMG}" width="176" height="99" alt=""></span>` +
          `<span class="badge">${c.dur}</span>` +
          `<div class="title">A video title that runs across two lines</div>` +
          `</div>`,
      )
      .join("") +
    `</div>`
  );
}

/** A light page: the labels must not look like paint spilled on the content. */
function lightGround(inset: number): string {
  return (
    `<div class="ground light">` +
    `<div class="row"><span class="rel" style="width:280px">` +
    `<input value="" placeholder="Search the docs">${hint("f", "", inset)}</span>` +
    `<span class="rel" style="width:120px">` +
    `<button>Save changes</button>${hint("j", "", inset)}</span></div>` +
    `<p class="prose">A paragraph of body copy, with a <span class="rel">` +
    `<a href="#">documentation link</a>${hint("k", "", inset)}</span> in the middle of ` +
    `it and a <span class="rel"><a href="#">second one</a>${hint("l", "", inset)}</span> ` +
    `further along the line.</p>` +
    `</div>`
  );
}

/** The dense state: many labels competing, plus the waiting badge. */
function denseGround(inset: number): string {
  let grid = "";
  for (let i = 0; i < 12; i++) {
    const key = i < 9 ? String(i + 1) : "a" + (i - 8);
    grid += `<span class="rel tiny"><button>${i}</button>${hint(key, "", inset)}</span>`;
  }
  return (
    `<div class="ground dense">` +
    `<div class="rel" style="width:220px"><button>An ambiguous row</button>` +
    hint("aa", "hint-wait", inset) +
    enterBadge("left:232px;top:2px") +
    `</div>` +
    `<div class="tinygrid">${grid}</div>` +
    `</div>`
  );
}

/**
 * Prefix every selector in a variant's stylesheet with its section id.
 *
 * The candidates all draw the same class names, so without this the LAST
 * stylesheet on the page would be the one every section rendered with — i.e. a
 * "comparison" of three copies of the third option. The transform is textual and
 * mechanical (split on `}`, prefix the selector list) so the rules themselves
 * are still the real ones, unedited.
 */
function scope(css: string, id: string): string {
  return css
    .split("}")
    .map((part) => {
      const brace = part.indexOf("{");
      if (brace < 0) return part;
      const sel = part.slice(0, brace).trim();
      if (!sel) return part;
      const prefixed = sel
        .split(",")
        .map((s) => "#" + id + " " + s.trim())
        .join(",");
      return prefixed + part.slice(brace);
    })
    .join("}");
}

const sections = variants
  .map(
    (v) => `
<section id="${v.id}">
  <style>${scope(v.css, v.id)}</style>
  <header>
    <h2>${v.label}</h2>
    <p>${v.note}</p>
  </header>
  <div class="grounds">
    ${darkGround(v.inset)}
    ${lightGround(v.inset)}
    ${denseGround(v.inset)}
  </div>
</section>`,
  )
  .join("");

const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Hint label look</title>
<style>
  /* Page chrome only. Every .hint rule below comes from the candidate's own
     stylesheet, which is the shipped HINT_CSS or a documented edit of it. */
  body { margin:0; background:#14141a; color:#c8c8d4; font:14px/1.6 system-ui,sans-serif; }
  h1 { font-size:18px; margin:24px 24px 4px; color:#fff; }
  .lede { margin:0 24px 8px; max-width:760px; color:#9a9aab; }
  section { margin:28px 24px 40px; }
  section header h2 { font-size:15px; margin:0 0 2px; color:#fff; }
  section header p { margin:0 0 12px; max-width:820px; color:#9a9aab; }
  .grounds { display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; }
  .ground { border-radius:10px; padding:16px; flex:0 0 auto; }
  .ground.dark { background:#0f0f13; }
  .ground.light { background:#fff; color:#111; }
  .ground.dense { background:#1b1b22; }
  .light .prose { margin:0; max-width:420px; }
  .card { width:176px; display:inline-block; vertical-align:top; margin-right:16px; position:relative; }
  .thumb { position:relative; display:block; width:176px; height:99px; }
  .thumb img { display:block; border-radius:6px; }
  .badge { position:absolute; right:6px; bottom:38px; background:rgba(0,0,0,.75); color:#fff;
           font:600 11px/1 system-ui,sans-serif; padding:3px 4px; border-radius:3px; }
  .title { font:13px/1.35 system-ui,sans-serif; color:#e8e8ee; margin-top:8px; }
  .rel { position:relative; display:inline-block; }
  .row { display:flex; gap:14px; align-items:center; margin-bottom:14px; }
  .row input { width:100%; padding:6px 8px; border:1px solid #c3c8d4; border-radius:5px; font:13px system-ui,sans-serif; }
  .row button { padding:6px 10px; border:1px solid #c3c8d4; border-radius:5px; background:#f2f3f7; font:13px system-ui,sans-serif; }
  .tinygrid { display:grid; grid-template-columns:repeat(6,64px); gap:10px; margin-top:18px; }
  .tiny button { width:64px; padding:6px 0; }
  .dense button { padding:6px 8px; border:1px solid #3a3a46; border-radius:5px; background:#25252e; color:#dcdce6; font:13px system-ui,sans-serif; }
  .dense .rel button { margin-right:0; }
  .note { margin:24px; color:#7e7e91; font-size:12px; max-width:820px; }
</style></head>
<body>
<h1>Hint labels: shipped, and what it replaced</h1>
<p class="lede">The first section is the stylesheet the extension ships TODAY, imported from
<code>content/hints/selectors.ts</code> — not a copy, so this page cannot show a look the
product no longer has. The second is the one it replaced, kept so the change can be judged
against the old look. Both are drawn over the three surfaces the labels live on. Placement
is simplified: each badge sits at its element's first anchor, the top-left corner, instead
of running the overlay's collision sweep, which needs a layout engine. Everything else is
the real rules: <code>.hint</code>, <code>.hint-wait</code> and <code>.hint-enter</code>.</p>
${sections}
${variants
  .map((v) => `<section><header><h2>${v.label}: stylesheet</h2></header><pre class="note">${v.css
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</pre></section>`)
  .join("")}
</body></html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log("[hints-preview] wrote " + out);
console.log("[hints-preview] variants: " + variants.map((v) => v.id).join(", "));
