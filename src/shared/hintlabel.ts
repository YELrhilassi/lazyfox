// One source of truth for what a hint label LOOKS like.
//
// Two hosts draw these labels and they are the same thing on screen — a key you
// press to take an element:
//
//   * the content script, which builds a stylesheet inside a closed shadow root
//     and hands each label a class (content/hints/selectors.ts), and
//   * the chrome helper, which draws 1-9 over the links of a page with no
//     content script (about:, error pages, PDFs) and can only reach that page's
//     own DOM, so it writes an inline style on each label (chrome/pagehints.ts).
//
// They drifted once: the content labels were a solid teal pill and the chrome
// ones a bordered dark chip with blue text, so `;f` looked like two different
// features depending on the page. The fix is not to describe the same values
// twice and hope — it is to put them here, where both hosts read them and a
// change to one cannot leave the other behind.
//
// KEEP THIS MODULE DOM-FREE AND DEPENDENCY-FREE. The chrome side typechecks under
// the seam audit, which reports any module that reaches for a browser global; a
// stylesheet constant has no business doing that, and importing one from here
// must never be the reason a chrome module stops being seamed.
//
// THE COLOURS ARE THE PRODUCT'S OWN. Every key cap in Lazyfox — the leader panel,
// the which-key overlay, the status bar hints — is drawn in `#7aa2f7`, and the
// label used to be a neon cyan (`#3ad4f0`) that appears nowhere else in the
// tree. A hint badge is the same kind of object as those key caps, so it is the
// same colour: one accent for "this is a key you press", everywhere. The
// AMBIGUOUS/WAITING state keeps a second colour (`#2ac3de`, also from the
// palette) so the two states are still told apart by fill as well as by the ⏎
// badge, which only ever appears while a waiting row exists — see enterFill.
//
// The design decisions behind these numbers (flat, no border, no shadow, fill
// contrast instead of chrome, why monospace, and what the earlier versions looked
// like) are settled by the measurements below.
//
// MEASURED, NOT GUESSED: with the values below a one-character label is
// 15.7 x 17 CSS px (the preview page reports it; a two-character label is
// 23.3 x 17) — near-square, which is what
// makes a dense batch read as a grid of keys rather than as slabs, and it is the
// size the collision sweep has to fit into the page. The enter badge is exactly
// as tall as a label so the pair reads as one row.

export const HINT_LABEL = {
  /** The fill. Solid, and the only thing carrying legibility on any ground.
   *  Tokenised (see shared/theme.ts): a hint badge is the product's accent, and
   *  the fallback is the Tokyo Night value for the one host that draws into a
   *  page with no tokens on it (chrome/pagehints.ts on a page with no content
   *  script). */
  fill: "var(--lf-accent,#7aa2f7)",
  /** Text on the fill: whatever the palette says reads on that accent. */
  text: "var(--lf-on-accent,#0b0d12)",
  /** The fill of the WAITING label — the typed prefix IS the whole key. */
  wait: "var(--lf-cyan,#2ac3de)",
  /** Ink on the waiting fill. A separate token because the accent's ink is not
   *  automatically readable on cyan: on the light preset the accent needs white
   *  while the cyan still needs black. */
  waitText: "var(--lf-on-cyan,#0b0d12)",
  /** Monospace: every key cap in the product uses it (see shared/theme.ts). */
  font:
    '700 13px/1 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace',
  /**
   * The air between a key's characters and its edges.
   *
   * Tight on purpose, and measured against the GLYPH: 13px monospace already
   * carries its own side bearings, so 6px per side left a one-character key
   * floating in the middle of a pill — the spaces around the letter read as
   * page, not as key. 2px x 4px frames the character instead, and the collision
   * sweep gets a smaller box to fit into a dense batch as a side effect.
   */
  padding: "2px 4px",
  radius: "2px",
  /** A hint key is one or two characters; monospace sets them too tight without it. */
  letterSpacing: ".04em",
  /**
   * The enter badge's box: as tall as a label so the pair lines up. A label is
   * one 13px line box plus 2px of padding twice, so 17 — enterH is that number
   * because the label's height is arithmetic, not taste: change the padding
   * above and this changes with it (the preview reports both).
   *
   * `overlay.placeEnter` places from these constants rather than from a layout
   * read — that read is the forced reflow that phase 2 of the placement exists to
   * avoid — so these ARE the stylesheet's `width`/`height` values, not an
   * approximation of them. overlay.ts reads them from here instead of keeping its
   * own copy, which is how the two were kept from drifting apart.
   */
  enterW: 24,
  enterH: 17,
  /**
   * The enter badge's icon: the return arrow a keyboard prints on its Enter key,
   * as a SOLID (one fill, no stroke) 24x24 path.
   *
   * The badge used to draw the Unicode "⏎" in the label's font, which made the
   * one icon in the hint UI the one thing whose shape belonged to the platform —
   * a different weight and different proportions on every stack, and an emoji on
   * some. A vector path is the same drawing everywhere, and a solid arrow still
   * reads at 13px where a glyph of that size turns into a smudge.
   *
   * It lives HERE, beside the badge's size and fill, so the preview page can draw
   * the running icon instead of a lookalike (see scripts/hints-preview.ts).
   */
  enterIcon: "M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z",
  /** The icon's box inside the badge, centred by the stylesheet — no font metric. */
  enterIconSize: 15,
  /**
   * The enter badge's fill.
   *
   * The badge appears in exactly one state: the typed prefix is the whole key of
   * a row while a longer key still shares it, so the only way to take that row is
   * Enter — the state the WAITING label is in. Drawing the badge in the idle fill
   * would paint it in a second colour beside a waiting label for no reason, so it
   * wears the waiting colour and the two read as one instruction. Its icon is
   * drawn in `text`, on top of this fill.
   */
  enterFill: "var(--lf-cyan,#2ac3de)",
} as const;

/**
 * The inline style for one label, for the host that draws into the page's own DOM.
 *
 * `extra` is appended last and is how the caller adds the label's POSITION —
 * deliberately the caller's business, because the chrome helper places labels
 * from the page's own rects and has no shared box model to inherit.
 */
export function hintLabelInlineStyle(
  extra = "",
  fill: string = HINT_LABEL.fill,
  ink: string = HINT_LABEL.text
): string {
  // The CONTENT script's labels live in a shadow root whose stylesheet is
  // prefixed with the tokens (see uiCss), so HINT_CSS can keep using `var()`.
  // A label the CHROME helper draws is a plain span on a page that has no
  // `--lf-*` properties, so that caller passes the palette's LITERAL accent and
  // ink — otherwise every chrome-mode label stays Tokyo blue on a light preset.
  return (
    "position:fixed;z-index:2147483647;" +
    "background:" + fill + ";color:" + ink + ";" +
    "font:" + HINT_LABEL.font + ";padding:" + HINT_LABEL.padding + ";" +
    "border-radius:" + HINT_LABEL.radius + ";letter-spacing:" + HINT_LABEL.letterSpacing + ";" +
    "text-align:center;pointer-events:none" +
    (extra ? ";" + extra : "")
  );
}
