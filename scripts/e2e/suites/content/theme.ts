// Theme suite: dark mode and reader mode, asserted on what the page actually
// RENDERS in a real Firefox.
//
// Both features are "paint" — a stylesheet built from computed colours, and an
// overlay that the scroll keys must move — so unit tests cannot prove them; this
// file is what verified `j`/`k` did not move the article (the scroller sits in a
// CLOSED shadow root) and that the reader host is top-layer-promoted.
//
// Assertions go through the product's own <html> mirrors (`data-lf-dark*`,
// `data-lf-scheme`, `data-lf-reader*`), which exist so shadow-internal state is
// legible from outside, plus getComputedStyle on the page's own elements.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  const FILE = "content/theme";
  const TAGS: string[] = ["theme", "newfeatures"];
  const t = (name: string, fn: () => Promise<void>, opts: { tags?: string[] } = {}) =>
    ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  // --- the mirrors -------------------------------------------------------

  // A MISSING ATTRIBUTE MUST BE READ AS "" and re-nulled on the harness side:
  // the wire serialises JS null as nothing at all, so an assertion written
  // against null can otherwise never pass.
  const attr = async (name: string): Promise<string | null> => {
    const v = await evalIn(
      ctx.tabA,
      `String(document.documentElement.getAttribute(${JSON.stringify(name)}))`
    ).catch(() => "null");
    const s = v === undefined || v === null ? "null" : String(v);
    return s === "null" ? null : s;
  };

  // Wait for an attribute to be ABSENT — the shape an overlay's teardown has, and
  // one `waitExpr(expr, "")` cannot express (it would compare against the empty
  // string and burn its whole timeout on a mirror that is correctly gone).
  const waitAttrGone = (name: string, ms = 6000) =>
    ctx.waitExpr(ctx.tabA, `!document.documentElement.hasAttribute(${JSON.stringify(name)})`, true, ms)
      .catch(() => null);

  // Wait for a mirror to hold a VALUE, not for a sleep to elapse. `want` omitted
  // matches any truthy value, which is what a mirror that may be "" needs.
  const waitAttr = (name: string, want?: string, ms = 10000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute(${JSON.stringify(name)})`, want, ms)
      .catch(() => null);

  const host = (): Promise<string> => evalIn(ctx.tabA, `location.hostname`).catch(() => "");

  // The per-site rules the product STORED. Read through the extension realm (the
  // probe tab), not from the page: storage is the record, and the point of these
  // assertions is that a key wrote one.
  const siteRules = async (): Promise<any[]> => {
    if (!ctx.probe) await ctx.bootstrap();
    const raw = await evalIn(
      ctx.probe,
      `browser.storage.local.get("config").then(r => JSON.stringify(((r.config || {}).dark || {}).sites || []))`
    ).catch(() => null);
    return raw ? JSON.parse(raw as string) : [];
  };

  // Wait for the rule for `match` to satisfy `ok`. The write crosses content →
  // background → storage, so "press and read" would race it.
  const waitRule = async (match: string, ok: (rule: any) => boolean, ms = 8000): Promise<any> => {
    return waitFor(async () => {
      const rules = await siteRules();
      const rule = rules.find((r) => r && r.match === match);
      return rule && ok(rule) ? rule : null;
    }, ms).catch(() => null);
  };

  // The colour the page's own body RENDERS. This is the assertion that the engine
  // did something to the page rather than merely recording an intention: the sheet
  // it injects sets `html,body{background-color:… !important}`.
  const bodyBg = (): Promise<string> =>
    evalIn(ctx.tabA, `getComputedStyle(document.body).backgroundColor`).catch(() => "");

  // --- dark mode ---------------------------------------------------------

  await t("a light page is darkened on load, and the page's colours go through the configured theme", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    const on = await waitAttr("data-lf-dark", "on");
    assert(
      on !== null,
      `the mirror says the page is dark: got ${JSON.stringify(await attr("data-lf-dark"))} (${await attr(
        "data-lf-dark-reason"
      )})`
    );
    assert((await attr("data-lf-scheme")) === "dark", "the scheme marker follows the decision");
    const sheet = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-dark")`);
    assert(sheet, "the engine installed its stylesheet");
    // The engine is a per-page MEASUREMENT (`chooseEngine`: dynamic for a page whose
    // colours are mostly one canvas, filter for a page it cannot read). Both are
    // correct answers; what would be wrong is the mirror naming neither, because the
    // rule corpus and the escape-hatch key are both keyed on it.
    const engine = await attr("data-lf-dark-engine");
    assert(
      engine === "dynamic" || engine === "filter",
      "the engine mirror names an engine, got " + JSON.stringify(engine)
    );
    // #16161e, the shipped `dark.background`.
    const bg = await bodyBg();
    assert(bg === "rgb(22, 22, 30)", "the page renders the configured background colour, got " + bg);
    console.log(`       (cold dark decision: engine=${engine}, reason=${await attr("data-lf-dark-reason")})`);
  });

  await t("a page that already ships a dark theme is left alone", async () => {
    // THE smart-dark case, and the one a blanket invert gets wrong. No key is
    // pressed: the verdict has to come from the rendered colours, because that is
    // the whole claim.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/dark`);
    const off = await waitAttr("data-lf-dark", "off");
    assert(off !== null, "the mirror says the page is NOT darkened, got " + JSON.stringify(await attr("data-lf-dark")));
    const reason = (await attr("data-lf-dark-reason")) || "";
    assert(/already dark/i.test(reason), "the reason names the verdict, got " + JSON.stringify(reason));
    const sheet = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-dark")`);
    assert(!sheet, "no stylesheet is installed on a page that is already dark");
    const scheme = await attr("data-lf-scheme");
    assert(!scheme, "no scheme marker is written either, got " + JSON.stringify(scheme));
    // And the page's own colour is untouched: #0f1115.
    const bg = await bodyBg();
    assert(bg === "rgb(15, 17, 21)", "the page keeps its own canvas, got " + bg);
  });

  // THE SITE'S OWN DARK THEME, which is a different question from "is it already
  // dark?". `/nativetheme-light` forces itself light with `color-scheme: light`
  // on the root while declaring both schemes in a meta tag, so it renders the
  // same on any machine; the engine must ASK it for dark (one `color-scheme`
  // write) and then stand down, leaving the site's own theme on screen.
  await t("a page that ships its own dark theme is asked for it, not recoloured", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/nativetheme-light`);
    // The ask may land before this line reads it; the evidence the ASK flipped
    // the page rather than our sheet is the colour that comes out: #0f1115 is
    // the fixture's own dark canvas, our shipped theme's background is #16161e,
    // and a remapped white canvas would come out as exactly that.
    const off = await waitAttr("data-lf-dark", "off");
    assert(
      off !== null,
      "the mirror says nothing of ours is painted, got " +
        JSON.stringify(await attr("data-lf-dark")) +
        " (" +
        (await attr("data-lf-dark-reason")) +
        ")"
    );
    const reason = (await attr("data-lf-dark-reason")) || "";
    assert(/dark theme/i.test(reason), "the reason names the site's theme, got " + JSON.stringify(reason));
    const engine = await attr("data-lf-dark-engine");
    assert(engine === "native", "the engine mirror says the theme is the site's, got " + JSON.stringify(engine));
    const sheet = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-dark")`);
    assert(!sheet, "no stylesheet of ours is installed");
    // And the page really IS dark now, in its own colours: #0f1115, not our
    // #16161e. That difference is the whole point — the site's theme, not ours.
    const after = await bodyBg();
    assert(after === "rgb(15, 17, 21)", "the page paints its OWN dark canvas, got " + after);
    const scheme = await evalIn(ctx.tabA, `getComputedStyle(document.documentElement).colorScheme`);
    assert(String(scheme).indexOf("dark") >= 0, "the page was asked for dark, got " + scheme);
  });

  // THE LATE DECLARATION. "Does this site have its own dark theme?" must be
  // asked after the head parses — at document_start the answer is always
  // "nothing declared". The fixture declares in its own DOMContentLoaded
  // handler, after the engine's.
  await t("a theme declared after the first paint is still found, and used", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/lateTheme`);
    const engine = await waitAttr("data-lf-dark-engine", "native", 12000);
    assert(
      engine !== null,
      "the site's own theme was never found: " +
        JSON.stringify(await attr("data-lf-dark-engine")) +
        " (" +
        (await attr("data-lf-dark-reason")) +
        ")"
    );
    const bg = await bodyBg();
    assert(bg === "rgb(15, 17, 21)", "the page renders its OWN dark canvas, got " + bg);
    const sheet = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-dark")`);
    assert(!sheet, "no stylesheet of ours is left on a native page");
  });

  // THE STATE SWITCH. An SPA throws its view away and renders a new one; for a
  // few frames there is no surface at all ("it breaks when I switch state and
  // shows blank dark overlay"). Both halves asserted: the theme survives the
  // teardown (no filter takeover of a blank document), and the colour that only
  // exists AFTER the switch is themed too.
  await t("a page that switches state keeps its theme, and the new view is themed too", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/spa`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the first view is darkened");
    const firstEngine = await attr("data-lf-dark-engine");
    // Wait for the fixture's own switch, then give the engine its gated pass.
    await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-fixture-switched") === "1"`, true, 8000);
    const lateThemed = await waitFor(async () => {
      const bg = await evalIn(
        ctx.tabA,
        `(() => { const el = document.getElementById("late"); return el ? getComputedStyle(el).backgroundColor : null; })()`
      ).catch(() => null);
      return bg && bg !== "rgb(221, 227, 236)" ? (bg as string) : null;
    }, 8000).catch(() => null);
    assert(
      lateThemed !== null,
      "the view rendered after the state switch was left light (the engine never re-measured)"
    );
    console.log(`       (state switch: first engine=${firstEngine}, #late now ${lateThemed})`);
    // The verdict itself must not have changed underneath the page: no takeover
    // by the filter engine, which is what an empty mid-switch measurement used to
    // produce (a page-wide inversion of a blank document).
    assert(
      (await attr("data-lf-dark")) === "on",
      "the theme survived the switch, got " + JSON.stringify(await attr("data-lf-dark")) + " (" + (await attr("data-lf-dark-reason")) + ")"
    );
    assert(
      (await attr("data-lf-dark-engine")) === firstEngine,
      "the engine did not flip to a different one mid-switch: " + firstEngine + " → " + (await attr("data-lf-dark-engine"))
    );
  });

  // THE ARTIFACTS, MEASURED. "Artifacts in rendering" is not a feeling: on a dark
  // page it is text that no longer reads against the surface it sits on, or a
  // surface that stayed paper-white while everything around it went dark. Both are
  // counted here on a page built out of the shapes real sites are made of (a dark
  // header with white text, a frosted sticky bar, a badge, a table, form controls,
  // an inline SVG and a photograph), and the themed page is held to the page's OWN
  // readability as the site ships it.
  const readability = (): Promise<{ total: number; unreadable: number; white: number }> =>
    evalIn(
      ctx.tabA,
      `(() => {
         const parse = (s) => {
           const m = /rgba?\\(([^)]+)\\)/.exec(s || "");
           if (!m) return null;
           const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
           return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
         };
         const lum = (c) => {
           const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
           return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
         };
         const ratio = (a, b) => {
           const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
           return (hi + 0.05) / (lo + 0.05);
         };
         const surfaceOf = (el) => {
           let n = el;
           while (n && n.nodeType === 1) {
             const c = parse(getComputedStyle(n).backgroundColor);
             if (c && c.a >= 0.5 && !/^(IMG|SVG|CANVAS|VIDEO)$/.test(n.tagName)) return c;
             n = n.parentElement;
           }
           return { r: 255, g: 255, b: 255, a: 1 };
         };
         let total = 0, unreadable = 0, white = 0;
         const isMedia = (el) => !!el.closest("svg,figure,picture") || /^(IMG|SVG|CANVAS|VIDEO)$/.test(el.tagName);
         for (const el of document.querySelectorAll("body *")) {
           const cs = getComputedStyle(el);
           if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.5) continue;
           const r = el.getBoundingClientRect();
           const bg = parse(cs.backgroundColor);
           // A large surface still paper-white on a dark page.
           if (bg && bg.a >= 0.5 && r.width * r.height > 40000 && lum(bg) > 0.85 && !isMedia(el)) white++;
           const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
           if (!own) continue;
           const fg = parse(cs.color);
           if (!fg || fg.a < 0.5) continue;
           total++;
           if (ratio(fg, surfaceOf(el)) < 2) unreadable++;
         }
         return JSON.stringify({ total, unreadable, white });
       })()`
    )
      .then((v) => JSON.parse(String(v)))
      .catch(() => ({ total: -1, unreadable: -1, white: -1 }));

  await t("a site-shaped page stays readable, and no surface is left paper-white", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/sitelike`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the site-shaped page is darkened");
    await new Promise((r) => setTimeout(r, 1200));

    // The page as the SITE ships it: turn the site off, measure, turn it back on.
    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    assert((await waitAttr("data-lf-dark", "off")) !== null, "the site is off for the baseline");
    const plain = await readability();
    assert(plain.total > 5, "the sweep found the page's text, got " + JSON.stringify(plain));
    // Sanity: the metric can see the light surfaces it is meant to count, or the
    // assertion below would pass on a page where nothing was measured at all.
    assert(plain.white > 0, "the page's own surfaces are light before theming: " + JSON.stringify(plain));

    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the site is darkened again");
    await new Promise((r) => setTimeout(r, 1200));
    const dark = await readability();
    console.log(`       (busy page: ${JSON.stringify(plain)} → ${JSON.stringify(dark)})`);
    assert(
      dark.total === plain.total,
      "the same text is on the page after the theme: " + JSON.stringify(dark)
    );
    assert(
      dark.unreadable <= plain.unreadable,
      `theming made ${dark.unreadable - plain.unreadable} more text/surface pair(s) unreadable (${JSON.stringify(plain)} → ${JSON.stringify(dark)})`
    );
    assert(
      dark.white === 0,
      "a large surface was left paper-white on a dark page: " + JSON.stringify(dark)
    );
    // Leave the host clean for the tests below, which assume the global default.
    await ctx.leaderSeq(ctx.tabA, ["Y", "x"]);
  });

  // THE COLOURS, MEASURED — assertions as properties of the mapping, not one
  // palette: a DARK surface on a light page must not come back pale (that is
  // inversion); gradient stops must be mapped (a pale hero stays a pale
  // rectangle otherwise); UA furniture goes dark only via color-scheme.
  await t("dark surfaces stay dark, gradients are mapped, and the UA scheme follows", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/sitelike`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page is darkened");
    // `color-scheme` is written on the pass after the native question is closed
    // (a page that declares nothing is answered at `load`), so wait for it.
    const scheme = await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `String(getComputedStyle(document.documentElement).colorScheme)`).catch(() => "");
      return /dark/.test(String(v)) ? String(v) : null;
    }, 8000).catch(() => null);
    assert(scheme !== null, "the root declares a dark scheme, got " + scheme);

    const probe = `(() => {
      const parse = (s) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(s || "");
        if (!m) return null;
        const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lum = (c) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
      };
      const head = document.querySelector("header");
      const grad = document.querySelector(".grad");
      const stops = (getComputedStyle(grad).backgroundImage.match(/rgba?\\([^)]*\\)/g) || []).map(parse);
      // A LAYER, and a light surface under a small image: the two shapes that
      // used to be invisible to the sampler (see pages.ts).
      const veil = document.querySelector(".veil");
      const veilLayer = getComputedStyle(veil, "::before");
      const sortth = document.querySelector("th.sortth");
      return JSON.stringify({
        veilBg: veilLayer.backgroundColor,
        veilBgLum: lum(parse(veilLayer.backgroundColor)),
        veilImage: veilLayer.backgroundImage,
        sortBg: getComputedStyle(sortth).backgroundColor,
        sortBgLum: lum(parse(getComputedStyle(sortth).backgroundColor)),
        sortRatio: ratio(parse(getComputedStyle(sortth).color), parse(getComputedStyle(sortth).backgroundColor)),
        headerBg: getComputedStyle(head).backgroundColor,
        headerFg: getComputedStyle(head).color,
        headerBgLum: lum(parse(getComputedStyle(head).backgroundColor)),
        headerRatio: ratio(parse(getComputedStyle(head).color), parse(getComputedStyle(head).backgroundColor)),
        gradImage: getComputedStyle(grad).backgroundImage,
        gradStops: stops.map((c) => (c ? Math.round(lum(c) * 100) / 100 : null)),
        body: getComputedStyle(document.body).backgroundColor,
      });
    })()`;
    const seen = JSON.parse(String(await evalIn(ctx.tabA, probe)));
    assert(seen.body === "rgb(22, 22, 30)", "the page still uses the theme canvas, got " + seen.body);
    assert(
      seen.headerBgLum < 0.25,
      `the navy header stayed a dark surface (${seen.headerBg}, luminance ${seen.headerBgLum}) instead of turning pale`
    );
    assert(
      seen.headerRatio >= 4.5,
      `the header's white text still reads on it (ratio ${seen.headerRatio}, ${seen.headerFg} on ${seen.headerBg})`
    );
    assert(seen.gradStops.length === 2, "the gradient kept both stops: " + seen.gradImage);
    for (const l of seen.gradStops) {
      assert(
        typeof l === "number" && l < 0.2,
        `a gradient stop was left light (${JSON.stringify(seen.gradStops)} in ${seen.gradImage})`
      );
    }
    // A `::before` VEIL IS A SURFACE TOO. Left alone it stays a white wash over a
    // mapped panel — the report "some gray overlay on some elements", measured.
    assert(
      seen.veilBgLum < 0.5,
      `the card's ::before veil stayed light (${seen.veilBg}) instead of becoming a dark wash`
    );
    assert(
      seen.veilBg !== seen.veilImage,
      "the layer is a colour, not an image: " + seen.veilImage
    );
    // AND SO IS THE COLOUR UNDER A BACKGROUND IMAGE. A sortable header's surface is
    // `#eef1f6 url(<arrow>)`; skipping the colour leaves light ink on a light cell.
    assert(
      seen.sortBgLum < 0.3,
      `the sortable header kept a light surface (${seen.sortBg}) under its icon`
    );
    assert(
      seen.sortRatio >= 4.5,
      `and its label still reads on it (ratio ${seen.sortRatio}, ${seen.sortBg})`
    );
    console.log(
      `       (dark header ${seen.headerBg}, text ratio ${seen.headerRatio.toFixed(1)}; gradient stops ${JSON.stringify(seen.gradStops)}; veil ${seen.veilBg}, sortable cell ${seen.sortBg})`
    );
  });

  // THE OVERLAY. A puzzle/canvas board paints itself, and a transparent,
  // absolutely-positioned layer above it takes the pointer events. That layer
  // paints NOTHING and must still paint nothing after theming — the engine
  // used to resolve its transparent colour against the canvas and paint it
  // back over the very board it was letting show through.
  await t("a transparent layer over a grid stays transparent, and the numbers stay readable", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/grid`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the grid page is darkened");
    await new Promise((r) => setTimeout(r, 800));
    const probe = `(() => {
      const parse = (s) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(s || "");
        if (!m) return null;
        const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lum = (c) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
      };
      const layer = document.getElementById("grid-layer");
      const cell = document.querySelector(".cell");
      const num = document.querySelector(".num");
      const given = document.querySelector(".num.given");
      const cellBg = parse(getComputedStyle(cell).backgroundColor);
      // A text element and the surface it is actually on, walked up the tree.
      const surfaceOf = (el) => {
        let n = el;
        while (n && n.nodeType === 1) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a >= 0.5) return c;
          n = n.parentElement;
        }
        return parse(getComputedStyle(document.body).backgroundColor);
      };
      return JSON.stringify({
        layerAlpha: parse(getComputedStyle(layer).backgroundColor).a,
        layerZ: getComputedStyle(layer).zIndex,
        cellBg: getComputedStyle(cell).backgroundColor,
        numContrast: ratio(parse(getComputedStyle(num).color), surfaceOf(num)),
        givenContrast: ratio(parse(getComputedStyle(given).color), surfaceOf(given)),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        cellLum: lum(cellBg),
      });
    })()`;
    const seen = JSON.parse(String(await evalIn(ctx.tabA, probe)));
    assert(seen.bodyBg === "rgb(22, 22, 30)", "the page is themed, got " + seen.bodyBg);
    assert(
      seen.layerAlpha === 0,
      `the interaction layer is still transparent (alpha ${seen.layerAlpha}, background ${seen.cellBg})`
    );
    assert(seen.cellLum < 0.2, "the grid's cells are dark, got " + seen.cellBg);
    assert(seen.numContrast >= 4.5, `the numbers read on their cell (ratio ${seen.numContrast})`);
    assert(seen.givenContrast >= 4.5, `the given numbers read too (ratio ${seen.givenContrast})`);
    console.log(
      `       (grid: layer alpha ${seen.layerAlpha}, cells ${seen.cellBg}, numbers ${seen.numContrast.toFixed(1)}:1 / ${seen.givenContrast.toFixed(1)}:1)`
    );
  });

  // THE SHARED-CLASS ARTIFACT. Real pages give many elements the same classes
  // and different colours, so a shared selector painting them all with one
  // element's colours is the artifact. Every emitted selector must reach exactly
  // the element measured — and one that cannot is not emitted at all.
  await t("every rule the engine emits paints exactly one element", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/sitelike`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page is darkened");
    await new Promise((r) => setTimeout(r, 800));
    const bad = await evalIn(
      ctx.tabA,
      `(() => {
         const sheet = document.getElementById("lazyfox-dark");
         if (!sheet) return ["no-sheet"];
         const out = [];
         const lines = String(sheet.textContent || "").split("\\n");
         for (const line of lines) {
           const m = /^(.+?)\\{([^}]*)\\}$/.exec(line.trim());
           if (!m) continue;
           const sel = m[1].trim();
           const decls = m[2];
           if (!/background-color:|(^|;|\\s)color:/.test(decls)) continue;
           // The engine's own boilerplate blocks are not per-element rules.
           if (sel.indexOf(",") >= 0 || sel.startsWith("html") || sel.startsWith(":root") || sel === "body" || sel.startsWith("a:link")) continue;
           // A LAYER RULE is checked on the ELEMENT that owns it: a
           // pseudo-element is not an element, and querySelectorAll with a ::before
           // suffix is 0 by definition rather than a selector that reaches nothing.
           // What has to hold is that the element the layer belongs to is reached
           // exactly once, which is the same property every other rule has.
           const base = sel.replace(/::(?:before|after)$/, "");
           let n = -1;
           try { n = document.querySelectorAll(base).length; } catch (e) { n = -2; }
           if (n !== 1) out.push(sel + " -> " + n);
         }
         return out.slice(0, 12);
       })()`
    ).catch(() => ["probe-failed"]);
    assert(Array.isArray(bad) && bad.length === 0, "selectors that do not reach exactly one element: " + JSON.stringify(bad));
  });

  // THE FLICKER. The engine's sheet write is itself a mutation in the subtree
  // it watches: every pass used to buy the next one, repainting a settled page
  // every ~400ms ("it flashes dark and light"). Counted by a mutation observer
  // on the engine's own <style>, the only place the write is visible.
  await t("a settled page stops being repainted (no self-triggered resample loop)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page is darkened first");
    // Give the opening burst time to finish before counting.
    await new Promise((r) => setTimeout(r, 1200));
    const armed = await evalIn(
      ctx.tabA,
      `(() => {
         const el = document.getElementById("lazyfox-dark");
         if (!el) return "no-sheet";
         window.__lfSheetWrites = 0;
         new MutationObserver((rs) => { window.__lfSheetWrites += rs.length; }).observe(el, {
           childList: true, characterData: true, subtree: true,
         });
         return "armed";
       })()`
    );
    assert(armed === "armed", "the engine's sheet is in the page, got " + armed);
    await new Promise((r) => setTimeout(r, 2000));
    const writes = await evalIn(ctx.tabA, `window.__lfSheetWrites`);
    assert(writes === 0, `the sheet was rewritten ${writes} time(s) on a quiet page`);
    // And the decision itself did not move either.
    assert((await attr("data-lf-dark")) === "on", "the page is still darkened");
  });

  // THE FLIP-FLOP. Each resample used to rebuild the palette from a page now
  // partly painted by us; the canvas reading drifted and the page moved between
  // two dark shades (or dark and light across the already-dark threshold). The
  // palette now builds from the measurement the LIVE theme was made from, so a
  // resample only adds entries — the canvas never moves.
  await t("a page that keeps changing keeps ONE theme", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page is darkened first");
    await new Promise((r) => setTimeout(r, 800));
    const settled = await bodyBg();
    assert(settled !== "", "the canvas is readable first");

    // A live page: new panels with new colours, every 120ms, for the whole test.
    const armed = await evalIn(
      ctx.tabA,
      `(() => {
         window.__lfNoise = setInterval(() => {
           const host = document.body;
           const d = document.createElement("div");
           d.className = "lf-noise";
           d.style.cssText = "width:300px;height:40px;background:#fdfdfd;color:#222;display:block";
           d.textContent = "noise " + Math.random();
           host.appendChild(d);
           if (host.querySelectorAll(".lf-noise").length > 8) host.querySelector(".lf-noise").remove();
         }, 120);
         return "armed";
       })()`
    );
    assert(armed === "armed", "the page can be made to mutate, got " + armed);

    const seen = new Set<string>();
    const mirrors = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      seen.add(await bodyBg());
      mirrors.add(String(await attr("data-lf-dark")));
    }
    await evalIn(ctx.tabA, `clearInterval(window.__lfNoise); window.__lfNoise = null`).catch(() => null);

    assert(
      seen.size === 1 && seen.has(settled),
      "the canvas never moved while the page churned, saw " + JSON.stringify([...seen])
    );
    assert(
      mirrors.size === 1 && mirrors.has("on"),
      "the verdict never flipped while the page churned, saw " + JSON.stringify([...mirrors])
    );
  });

  // THE ENDLESS WALK, and the mirror that can see it.
  //
  // The walk's slice arithmetic used to leave `pending()` reporting the whole
  // document as unwalked (see src/extension/content/dark/scan.ts), so a page that
  // had settled was measured again 60ms later for ever. MEASURED on this fixture,
  // in this harness: ~22 passes a second and ~22 status-bar verdict reports a
  // second, with the verdict never moving. Every OTHER mirror is blind to it —
  // they change only when the VERDICT does, so a hammering controller and a quiet
  // one look identical from outside, which is why this went unnoticed. Hence
  // `data-lf-dark-passes`, and hence this test: a page left alone must stop being
  // walked, and the bar must be told its verdict rather than told it again.
  await t("a themed page settles: the walk stops and the verdict is published once", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page is darkened first");

    const passes = async (): Promise<number | null> => {
      const v = await attr("data-lf-dark-passes");
      return v === null ? null : Number(v);
    };
    // "Settled" means three consecutive reads 200ms apart that agree. A loop does
    // not read as one big number — the count moves BETWEEN the reads — so the
    // check is the absence of movement, not a budget that has to be guessed.
    const settled = await waitFor(async () => {
      const a = await passes();
      if (a === null || !Number.isFinite(a)) return null;
      await new Promise((r) => setTimeout(r, 200));
      const b = await passes();
      await new Promise((r) => setTimeout(r, 200));
      const c = await passes();
      return b === a && c === b ? a : null;
    }, 8000).catch(() => null);
    assert(
      settled !== null,
      "the page stopped being walked, counts: " + JSON.stringify([await passes()])
    );
    assert(settled > 0, "the page was walked at least once, got " + settled);

    // And it STAYS settled. This is the property that was broken: a quiet page is
    // not allowed to earn another pass 1.5 seconds later.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await passes();
    assert(after === settled, `no pass for a settled page: ${settled} passes, then ${after} 1.5s later`);

    // THE BADGE ITSELF — the surface the user watches, fed by this page's
    // verdict. Asserted through the chrome helper's own render mirror. Polled,
    // because the read makes the probe tab transient and the bar may repaint
    // against a shifted strip while it is in flight (a repaint with no dark
    // entry for the selected index hides the segment until the next one).
    const badge = async (): Promise<{ field: string; mounted: boolean }> => {
      const s = await ctx.chromeState().catch(() => null);
      const m = String((s && s.statusAttr) || "").match(/\|dark:[^|]*/);
      return { field: m ? m[0] : "", mounted: !!(s && s.statusMounted) };
    };
    // A KEY FIRST, and it is the repair rather than a convenience: a key IS this
    // document's presence re-assert, and the verdict rides it (see
    // republishDarkVerdict in content/main.ts) — which is also what makes this
    // assertion deterministic. The read itself makes the probe tab transient,
    // and a bar repaint landing in that window resolves the segment against a
    // shifted strip, where this tab has no entry yet.
    await ctx.press(ctx.tabA, "j");
    const shown = await waitFor(async () => {
      const b = await badge();
      return b.field ? b : null;
    }, 10000).catch(() => null);
    assert(
      shown !== null,
      "the bar shows this page's dark verdict (chrome mounted: " + JSON.stringify((await badge()).mounted) + ")"
    );
    assert(
      shown.field === "|dark:on/dynamic",
      "the segment reads the verdict this page published, got " + JSON.stringify(shown.field)
    );
  });

  await t("a site with its own theme really goes light when the site is turned off", async () => {
    // The ask writes `color-scheme: dark` on the root and leaves it there, which is
    // what keeps the site's theme on screen. Turning the site off has to take that
    // write back — otherwise the key reports "off" while the page stays dark,
    // because the site keeps rendering the theme we asked it for.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/nativetheme-light`);
    assert((await waitAttr("data-lf-dark-engine", "native")) !== null, "the site's own theme is in use");
    const before = await bodyBg();
    assert(before === "rgb(15, 17, 21)", "the page starts in its own dark theme, got " + before);

    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    const light = await waitFor(async () => {
      const bg = await bodyBg();
      return bg === "rgb(255, 255, 255)" ? bg : null;
    }, 8000).catch(() => null);
    assert(light !== null, "the page went back to its light palette, got " + (await bodyBg()));
    assert((await attr("data-lf-dark")) === "off", "the mirror says off");
    const inline = await evalIn(
      ctx.tabA,
      `document.documentElement.style.getPropertyValue("color-scheme")`
    ).catch(() => "?");
    assert(!inline, "the ask was taken back off the root, got " + JSON.stringify(inline));

    // And pressing it again gives the site's theme back, rather than recolouring a
    // page that already has a dark palette of its own.
    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    const native = await waitAttr("data-lf-dark-engine", "native");
    assert(native !== null, "the site's theme is in use again, got " + JSON.stringify(await attr("data-lf-dark-engine")));
    const dark = await waitFor(async () => {
      const bg = await bodyBg();
      return bg === "rgb(15, 17, 21)" ? bg : null;
    }, 8000).catch(() => null);
    assert(dark !== null, "the page is dark in its OWN colours, got " + (await bodyBg()));
    // Leave the host clean for the tests below, which assume the global default.
    await ctx.leaderSeq(ctx.tabA, ["Y", "x"]);
  });

  await t(";Y d turns the theme off for this site and back on, and writes the per-site rule", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page starts darkened");
    const h = await host();

    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    assert((await waitAttr("data-lf-dark", "off")) !== null, "the key turned it off for this page");
    const off = await bodyBg();
    assert(off === "rgb(255, 255, 255)", "the page's own canvas came back, got " + off);
    const offRule = await waitRule(h, (r) => r.mode === "off");
    assert(offRule !== null, `the off decision was stored for ${h}, rules: ` + JSON.stringify(await siteRules()));

    // The same key again: the entry the first press created is REUSED (an entry
    // with no fields would be dropped, which is the documented reason the two
    // toggles write onto each other's rule).
    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the key turned it back on");
    const onRule = await waitRule(h, (r) => r.mode === "dark");
    assert(onRule !== null, `the on decision replaced it, rules: ` + JSON.stringify(await siteRules()));
    const rules = await siteRules();
    assert(
      rules.filter((r) => r.match === h).length === 1,
      "one rule per host, not one per press: " + JSON.stringify(rules)
    );
  });

  await t(";Y e switches to the filter engine on this site, and the root really carries the inversion", async () => {
    // The escape hatch, and the reason it is a key rather than a setting: the
    // dynamic engine cannot see a colour that reaches the screen through an image
    // or a canvas, and this is what a user does about it. `auto → dynamic → filter`
    // from the shipped default, so two presses land on filter by construction.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page starts darkened");
    const h = await host();

    await ctx.leaderSeq(ctx.tabA, ["Y", "e"]);
    await ctx.leaderSeq(ctx.tabA, ["Y", "e"]);
    assert((await waitAttr("data-lf-dark-engine", "filter")) !== null, "the mirror names the filter engine");
    const filter = await evalIn(ctx.tabA, `getComputedStyle(document.documentElement).filter`).catch(() => "");
    assert(
      typeof filter === "string" && /invert/.test(filter),
      "the root element really renders inverted in filter mode, got " + JSON.stringify(filter)
    );
    // THE ARTIFACT, seen from the page. `filter` applies to the filtered root's
    // own background too, so declaring the theme's canvas inside it rendered the
    // page LIGHT — the engine painted its own background upside down. The declared
    // value is the channel complement of #16161e, and the inversion lands exactly
    // on #16161e (hue-rotate is the identity on a neutral colour).
    const canvas = await bodyBg();
    assert(
      canvas === "rgb(233, 233, 225)",
      "the filtered canvas is declared as the pre-image of the theme background, got " + canvas
    );
    const rule = await waitRule(h, (r) => r.engine === "filter");
    assert(rule !== null, `the engine choice was stored for ${h}, rules: ` + JSON.stringify(await siteRules()));
  });

  await t(";Y x clears this site's rules and hands the page back to the global default", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/light`);
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the page starts darkened");
    const h = await host();
    await ctx.leaderSeq(ctx.tabA, ["Y", "d"]); // writes a rule for this host
    assert((await waitRule(h, (r) => !!r.mode)) !== null, "a rule exists to be cleared");

    await ctx.leaderSeq(ctx.tabA, ["Y", "x"]);
    // Wait for the stored list to STOP naming the host rather than for a toast:
    // the toast is emitted before the write crosses content → background →
    // storage, so a toast is not evidence that the record changed.
    const cleared = await waitFor(async () => {
      const rules = await siteRules();
      return rules.every((r) => r.match !== h) ? true : null;
    }, 8000).catch(() => null);
    assert(cleared !== null, "the rules for this host are gone, rules: " + JSON.stringify(await siteRules()));
    // Back on the global default, which darkens a light page — so the page is dark
    // again, but now for the other reason.
    assert((await waitAttr("data-lf-dark", "on")) !== null, "the global default took the page back over");
    assert(
      !/already dark/i.test((await attr("data-lf-dark-reason")) || ""),
      "and the reason no longer mentions a stored rule"
    );
  });

  // WHAT THE ENGINE DOES TO REAL SITES — opt-in, because it loads the public
  // internet from a test run.
  //
  // This is the half of the dark engine that no fixture can hold: the shapes a
  // real page is built from (a collapsed mobile menu with white text inside it,
  // a translucent modal overlay across a game board, a mid-grey backdrop under a
  // grid) are exactly the ones a fixture never has, and every defect in §11 of
  // the stability report was found here rather than reasoned out. It is off by
  // default so the suite stays hermetic and CI stays green:
  //
  //   LF_LIVE_SITES=1 npm run e2e -- --group content --only live:https
  const KNOWN = [
    "https://www.merriam-webster.com/",
    "https://www.nytimes.com/puzzles/sudoku/easy",
    "https://www.google.com/search?q=test",
  ];
  // The DIAGNOSTIC set: pages built from shapes the three above do not have — a
  // utility-framework app, a wiki with a skin, a component library, a plain HTML
  // forum — because "some gray overlay on some elements" is a report about the
  // shapes a few sites happen to have.
  const WIDE = [
    "https://en.wikipedia.org/wiki/Firefox",
    "https://github.com/",
    "https://tailwindcss.com/",
    "https://news.ycombinator.com/",
  ];
  // An ARBITRARY LIST, for the round that has to find a shape rather than
  // re-check a known one: `LF_LIVE_URLS=a,b,c`. The sets above stay as the
  // reproducible baseline.
  const LIVE = process.env.LF_LIVE_URLS
    ? process.env.LF_LIVE_URLS.split(",").map((s) => s.trim()).filter(Boolean)
    : process.env.LF_LIVE_SITES
      ? process.env.LF_LIVE_SITES === "wide"
        ? WIDE
        : KNOWN
      : [];
  const SWEEP = `(() => {
    const C = (s) => {
      const i = String(s).indexOf("("), j = String(s).lastIndexOf(")");
      if (i < 0 || j < 0) return null;
      const p = String(s).slice(i + 1, j).split(",").map((x) => parseFloat(x));
      if (p.length < 3 || p.some((n) => !isFinite(n))) return null;
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const L = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const x = L(a), y = L(b), hi = Math.max(x, y), lo = Math.min(x, y);
      return (hi + 0.05) / (lo + 0.05);
    };
    const surfaceOf = (el) => {
      let n = el;
      while (n && n.nodeType === 1) {
        const c = C(getComputedStyle(n).backgroundColor);
        if (c && c.a >= 0.5) return c;
        n = n.parentElement;
      }
      return C(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    };
    const desc = (n) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + String(n.className).split(/\\s+/).slice(0, 4).join(".") : "");
    const chain = (el) => {
      const out = [];
      let n = el;
      while (n && n.nodeType === 1 && out.length < 6) {
        const cs = getComputedStyle(n);
        const c = C(cs.backgroundColor);
        const r = n.getBoundingClientRect();
        out.push(desc(n) + " bg=" + (c ? "rgba(" + [c.r, c.g, c.b, c.a].join(",") + ")" : cs.backgroundColor) + " a=" + Math.round(r.width) + "x" + Math.round(r.height) + " img=" + (cs.backgroundImage === "none" ? "-" : cs.backgroundImage.slice(0, 24)));
        n = n.parentElement;
      }
      return out;
    };
    let total = 0, unreadable = 0, light = 0, invisible = 0, darkText = 0;
    // Grouped by the PAIR, not by the element: one shape repeated five hundred
    // times is one problem, and a list of the first three is not a diagnosis.
    const byPair = new Map();
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const bg = C(cs.backgroundColor);
      if (bg && bg.a >= 0.5 && L(bg) > 0.7 && r.width * r.height > 2000) light++;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const fg = C(cs.color);
      if (!fg || fg.a < 0.5) continue;
      // INVISIBLE TEXT IS NOT A REPORT. A collapsed dropdown (max-height:0) has
      // text with computed colours that will never be looked at; counting it
      // measures the page's markup rather than the page.
      if (r.width * r.height < 24) { invisible++; continue; }
      total++;
      const surf = surfaceOf(el);
      const rr = Math.round(ratio(fg, surf) * 100) / 100;
      if (rr < 2.5) {
        unreadable++;
        if (L(fg) > 0.5) darkText++;
        const key = cs.color + " on rgb(" + Math.round(surf.r) + "," + Math.round(surf.g) + "," + Math.round(surf.b) + ")";
        const hit = byPair.get(key);
        if (hit) { hit.n++; continue; }
        if (byPair.size < 6) byPair.set(key, { n: 1, k: rr, s: desc(el), chain: chain(el) });
      }
    }
    const worst = Array.from(byPair.entries()).map(([k, v]) => ({ pair: k, n: v.n, ratio: v.k, s: v.s, chain: v.chain }));
    // THE BIGGEST THINGS ON SCREEN, with their colours as rendered. A grid that
    // is hidden by an overlay, or a panel that stayed white, is one of these.
    const big = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < 20000) continue;
      const c = C(cs.backgroundColor);
      big.push({ a: Math.round(a), s: desc(el), bg: cs.backgroundColor, fg: cs.color, bd: cs.borderTopWidth !== "0px" ? cs.borderTopColor : "-", op: cs.opacity, pos: cs.position, z: cs.zIndex, im: cs.backgroundImage === "none" ? "-" : cs.backgroundImage.slice(0, 20) });
    }
    big.sort((x, y) => y.a - x.a);
    // THE FOUR QUESTIONS a report like "some gray overlay on some elements, and
    // issues with content" asks, each one a shape the engine cannot currently
    // see: a colour SYNTAX it does not parse, a PSEUDO-ELEMENT (never sampled),
    // a light surface still on screen (never painted), and a dark INLINE SVG fill
    // (an icon that vanishes on a dark page).
    // GROUND TRUTH for the colour parser: what Firefox hands back for each modern
    // syntax in a computed style, and what it RENDERS for it (a 1x1 canvas). The
    // two are different questions — the parser has to agree with the second one —
    // and a local script compares them against parseColor (see the task doc).
    const CASES = [
      "oklch(1 0 0)", "oklch(0 0 0)", "oklch(0.5 0.1 200)", "oklch(0.628 0.2577 29.234)",
      "oklab(1 0 0)", "oklab(0.5 0 0)", "oklab(1 0 5.96e-8 / 0.1)",
      "lab(100% 0 0)", "lab(0% 0 0)", "lab(50% 0 0)", "lab(50 0 0)",
      "lab(1.90334 0.278696 -5.48866)", "lab(27.1134 -0.956401 -12.3224)",
      "lch(50% 0 0)", "lch(29.2345% 44.2 27)",
      "hwb(120 20% 30%)", "color(srgb 1 0 0)", "color(srgb 0.5 0.5 0.5)",
      "color(display-p3 1 0 0)", "color-mix(in srgb, white 50%, black)",
      "color-mix(in srgb, #ffffff 25%, #000000)", "light-dark(white, black)",
    ];
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;width:8px;height:8px";
    document.body.appendChild(probe);
    let pcv = null;
    try { pcv = document.createElement("canvas").getContext("2d", { willReadFrequently: true }); } catch (e) { pcv = null; }
    if (pcv) { pcv.canvas.width = 1; pcv.canvas.height = 1; }
    const pixelOf = (css) => {
      if (!pcv) return "NO CANVAS";
      try {
        pcv.fillStyle = "#010203";
        pcv.fillStyle = css;
        pcv.fillRect(0, 0, 1, 1);
        const d = pcv.getImageData(0, 0, 1, 1).data;
        return "rgba(" + d[0] + ", " + d[1] + ", " + d[2] + ", " + Math.round((d[3] / 255) * 1000) / 1000 + ")";
      } catch (e) { return "ERR"; }
    };
    const probeRows = [];
    for (const css of CASES) {
      probe.style.backgroundColor = "";
      probe.style.backgroundColor = css;
      probeRows.push({ css, computed: getComputedStyle(probe).backgroundColor, pixel: pixelOf(css) });
    }
    probe.remove();
    const modern = new Map(), pseudo = new Map(), stillLight = new Map(), darkSvg = new Map();
    const bump = (m, key, where) => {
      const hit = m.get(key);
      if (hit) { hit.n++; return; }
      if (m.size < 6) m.set(key, { n: 1, where });
    };
    const list = (m) => Array.from(m.entries()).map(([k, v]) => ({ what: k, n: v.n, where: v.where }));
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      const raw = cs.backgroundColor;
      if (raw && !/^(rgba?\\(|hsla?\\(|transparent$|currentcolor$)/i.test(raw)) bump(modern, raw.slice(0, 48), desc(el) + " " + raw.slice(0, 48));
      if (a < 1000) continue;
      const c = C(raw);
      if (c && c.a >= 0.5 && L(c) > 0.6) {
        // WHY it survived matters as much as that it did: an element whose surface
        // is a url() with nothing inside it is the one shape the engine
        // deliberately leaves alone (see hasContent/bgCovers in detect.ts), so
        // the image, the child count and the size belong in the report.
        bump(
          stillLight,
          "rgb(" + Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b) + ") @" + Math.round(a),
          desc(el) + " " + Math.round(a) + "px2 img=" + (cs.backgroundImage === "none" ? "-" : "yes") + " kids=" + el.children.length + " size=" + cs.backgroundSize
        );
      }
      if (a >= 1500) {
        for (const which of ["::before", "::after"]) {
          const ps = getComputedStyle(el, which);
          if (!ps || ps.content === "none" || ps.content === "normal") continue;
          const pc = C(ps.backgroundColor);
          if (pc && pc.a >= 0.3 && L(pc) > 0.55) {
            bump(pseudo, which + " " + ps.backgroundColor + " pos=" + ps.position + " inset=" + [ps.top, ps.right, ps.bottom, ps.left].join("/"), desc(el) + " " + which + " " + ps.backgroundColor + " pos=" + ps.position);
          }
        }
      }
      if (a > 400 && /^(svg|path|circle|rect|polygon|ellipse|g|use)$/i.test(el.tagName)) {
        const f = C(cs.fill);
        if (f && f.a > 0.5 && L(f) < 0.2) bump(darkSvg, cs.fill + " @" + Math.round(a), desc(el) + " fill=" + cs.fill + " color=" + cs.color + " " + Math.round(a) + "px2");
      }
    }
    // THE FOUR THINGS THE SHEET CANNOT SAY.
    //
    // The engine emits exactly four declarations — background-color,
    // background-image (gradients), color, and the TOP border's colour. So
    // everything else the page paints is still the page's, on a dark canvas:
    // a light box-shadow (a ring, a hairline, an inset glow), a light outline, a
    // border on the other three sides, and a gradient that shares its value with
    // a url() (which makes the whole value a "photograph" and leaves the wash
    // in place). Each of those is a candidate for "some gray overlay on some
    // elements", and each is counted here rather than argued about.
    const shadow = new Map(), outlineC = new Map(), lightBorder = new Map(), mixed = new Map();
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < 2000) continue;
      const sh = cs.boxShadow;
      if (sh && sh !== "none") {
        const m = sh.match(/rgba?\\([^)]*\\)/g) || [];
        for (const one of m) {
          const c = C(one);
          if (c && c.a >= 0.2 && L(c) > 0.55) {
            bump(shadow, one + " @" + Math.round(a), desc(el) + " " + Math.round(a) + "px2 shadow=" + sh.slice(0, 42));
            break;
          }
        }
      }
      if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) {
        const c = C(cs.outlineColor);
        if (c && c.a >= 0.4 && L(c) > 0.6) bump(outlineC, cs.outlineColor + " @" + Math.round(a), desc(el) + " " + Math.round(a) + "px2 outline=" + cs.outlineWidth + " " + cs.outlineStyle);
      }
      if (a >= 10000) {
        for (const side of ["Right", "Bottom", "Left"]) {
          const w = parseFloat(cs["border" + side + "Width"]) || 0;
          if (w <= 0) continue;
          const c = C(cs["border" + side + "Color"]);
          if (c && c.a >= 0.5 && L(c) > 0.72) {
            bump(lightBorder, side.toLowerCase() + " " + cs["border" + side + "Color"] + " @" + Math.round(a), desc(el) + " " + side + " " + w + "px " + cs["border" + side + "Color"] + " " + Math.round(a) + "px2 top=" + cs.borderTopColor);
          }
        }
      }
      if (cs.backgroundImage.indexOf("url(") >= 0 && /gradient\\(/.test(cs.backgroundImage)) {
        bump(mixed, "url+gradient @" + Math.round(a), desc(el) + " " + Math.round(a) + "px2 bg=" + cs.backgroundColor + " kids=" + el.children.length);
      }
    }
    // The game board itself, when there is one: a grid is small elements with
    // borders, and this is the only way to see what we did to it.
    const board = [];
    const boardRoot = document.querySelector("#pz-game-root") || document.querySelector(".gameContainer");
    if (boardRoot) {
      for (const el of boardRoot.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a < 400) continue;
        board.push({ a: Math.round(a), s: desc(el), bg: cs.backgroundColor, fg: cs.color, ow: cs.borderTopWidth, bd: cs.borderTopColor, op: cs.opacity, sh: cs.boxShadow === "none" ? "-" : cs.boxShadow.slice(0, 18), im: cs.backgroundImage === "none" ? "-" : cs.backgroundImage.slice(0, 18) });
      }
      board.sort((x, y) => y.a - x.a);
    }
    const sheet = document.getElementById("lazyfox-dark");
    const text = sheet ? String(sheet.textContent || "") : "";
    const root = document.documentElement;
    return JSON.stringify({
      reason: root.getAttribute("data-lf-dark-reason"),
      engine: root.getAttribute("data-lf-dark-engine"),
      on: root.getAttribute("data-lf-dark"),
      els: document.querySelectorAll("*").length,
      bytes: text.length,
      rules: text.split("}").length - 1,
      total, unreadable, light, invisible, darkText,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
      filter: getComputedStyle(root).filter,
      worst,
      big: big.slice(0, 14),
      board: board.slice(0, 26),
      probe: probeRows,
      modern: Array.from(modern.entries()).length ? { kinds: modern.size, rows: list(modern) } : null,
      pseudo: Array.from(pseudo.entries()).length ? { kinds: pseudo.size, rows: list(pseudo) } : null,
      shadow: Array.from(shadow.entries()).length ? { kinds: shadow.size, rows: list(shadow) } : null,
      outline: Array.from(outlineC.entries()).length ? { kinds: outlineC.size, rows: list(outlineC) } : null,
      lightBorder: Array.from(lightBorder.entries()).length ? { kinds: lightBorder.size, rows: list(lightBorder) } : null,
      mixed: Array.from(mixed.entries()).length ? { kinds: mixed.size, rows: list(mixed) } : null,
      stillLight: Array.from(stillLight.entries()).length ? { kinds: stillLight.size, rows: list(stillLight) } : null,
      darkSvg: Array.from(darkSvg.entries()).length ? { kinds: darkSvg.size, rows: list(darkSvg) } : null,
    });
  })()`;
  for (const site of LIVE) {
    await t("live:" + site, async () => {
      await ctx.gotoPage(ctx.tabA, site);
      await new Promise((r) => setTimeout(r, 3000));
      // THE PREVIOUS TEST'S STATE IS NOT THIS TEST'S BASELINE.
      //
      // Dark mode is a toggle, and the tests above leave it where they left it —
      // so the first live run measured a "PLAIN" page that was already dark, and
      // the three columns came back shifted by one (the row labelled DARK was the
      // page with the theme turned OFF). Whatever the last test did is undone
      // here, explicitly, before anything is measured.
      // AND A BOT WALL IS NOT A PAGE. Measured: nytimes.com/puzzles served its
      // challenge page to this headless browser and the leader had nothing to arm
      // on, so the test failed on the site's judgement of the client rather than on
      // anything the engine did. A wall is reported as a skip, with the reason, so a
      // red run means the engine and never the network.
      const shape = JSON.parse(
        String(
          await evalIn(
            ctx.tabA,
            `(() => JSON.stringify({ els: document.querySelectorAll("*").length, title: String(document.title || "").slice(0, 48), wall: !!document.querySelector("#captcha-form,#challenge-form") }))()`
          ).catch(() => `{"els":0,"title":"","wall":true}`)
        )
      );
      // The captcha markers are the WALL's own, not an ad slot's: a `.g-recaptcha`
      // or a recaptcha iframe is embedded by ads and consent frames on pages that
      // are perfectly real (measured: nytimes.com carries both).
      if (shape.wall || Number(shape.els) < 120) {
        console.log(`       (${site} SKIPPED: bot wall or empty page — ${shape.els} elements, "${shape.title}")`);
        return;
      }
      // AND THE ANSWER ARRIVES LATE. `data-lf-dark` is written once the engine has
      // decided, which on a heavy page is a few seconds after load — a single read
      // here returned null and the normalization never fired, which is how the first
      // three reported runs came back with a PLAIN column that was already dark.
      const themeState = async (): Promise<string | null> => {
        for (let i = 0; i < 16; i++) {
          const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-dark")`).catch(() => null);
          if (v === "on" || v === "off") return v;
          await new Promise((r) => setTimeout(r, 500));
        }
        return null;
      };
      for (let i = 0; i < 3; i++) {
        const cur = await themeState();
        if (cur !== "on") break;
        // A PAGE THAT WILL NOT TAKE A KEY CANNOT BE MEASURED, and saying so is
        // not the same as passing: the harness could not drive this page (a
        // consent wall over the document, a challenge the browser never solves),
        // so its numbers would be about the interstitial.
        const armed = await ctx.leaderSeq(ctx.tabA, ["Y", "d"]).then(() => true, () => false);
        if (!armed) {
          console.log(`       (${site} SKIPPED: the leader never armed on this page — ${shape.els} elements, "${shape.title}")`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1800));
      }
      const plain = JSON.parse(String(await evalIn(ctx.tabA, SWEEP)));
      await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
      await new Promise((r) => setTimeout(r, 2500));
      const dark = JSON.parse(String(await evalIn(ctx.tabA, SWEEP)));
      await ctx.leaderSeq(ctx.tabA, ["Y", "d"]);
      await new Promise((r) => setTimeout(r, 1500));
      const back = JSON.parse(String(await evalIn(ctx.tabA, SWEEP)));
      console.log(`       (${site} PLAIN ${JSON.stringify(plain)})`);
      console.log(`       (${site} DARK  ${JSON.stringify(dark)})`);
      console.log(`       (${site} OFF   ${JSON.stringify(back)})`);
    }, { tags: ["theme", "live"] });
  }

  // --- reader mode -------------------------------------------------------

  await t(";R opens the article, and the article is what the scroll keys move", async () => {
    // The integration claim, measured: the overlay must become the target of the
    // SAME scroll controller the page uses, with no reader-specific key handling.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open");
    // THE PAGE STILL HAS THE KEYBOARD. The overlay hides `body`, which takes away
    // the element the caret was in, and a document that loses the focus loses the
    // keyboard with it: every key is then delivered to the browser window, so the
    // article cannot be scrolled, cannot be left with Escape and cannot be driven
    // by the leader — a live article behind a dead keyboard. This is the assertion
    // that caught exactly that, so it is kept as the guard (see render.ts).
    const hasFocus = await evalIn(ctx.tabA, `document.hasFocus()`).catch(() => null);
    assert(hasFocus === true, "the page still has the keyboard while the article is up, got " + hasFocus);

    const blocks = Number(await attr("data-lf-reader-blocks"));
    const words = Number(await attr("data-lf-reader-words"));
    assert(blocks >= 8, "the extractor collected the article's blocks, got " + blocks);
    assert(words >= 200, "and its words, got " + words);
    // The page is hidden, not merely covered: the reader decision documented in
    // reader/render.ts (a body-anchored overlay would hide itself).
    const bodyDisplay = await evalIn(ctx.tabA, `getComputedStyle(document.body).display`);
    assert(bodyDisplay === "none", "body is hidden while the reader is up, got " + bodyDisplay);
    const readerHost = await evalIn(ctx.tabA, `!!document.getElementById("lazyfox-reader")`);
    assert(readerHost, "the host is in the document");

    // The article must be taller than the viewport, or "the scroll keys move it"
    // proves nothing: a fixture that fits on one screen passes this test while
    // being unable to fail it.
    const box = await evalIn(
      ctx.tabA,
      `(() => { const h = document.getElementById("lazyfox-reader"); const r = h.getBoundingClientRect(); return JSON.stringify({ top: r.top, left: r.left, w: r.width, hgt: r.height, sh: h.scrollHeight, ch: h.clientHeight, vw: innerWidth, vh: innerHeight }); })()`
    );
    const b = JSON.parse(box);
    assert(b.sh > b.ch + 40, `the article overflows its pane (scrollHeight ${b.sh} vs ${b.ch})`);
    assert(Math.abs(b.vw - b.w) < 3 && Math.abs(b.vh - b.hgt) < 3, `the pane fills the viewport, got ${b.w}x${b.hgt}`);

    await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop = 0; true`);
    await ctx.press(ctx.tabA, "j");
    const jTop = await waitFor(
      async () =>
        (await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`).catch(() => 0)) > 0
          ? await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`)
          : null,
      6000
    ).catch(() => null);
    assert(jTop !== null, "j scrolled the article");
    const docY = await evalIn(ctx.tabA, `window.scrollY`).catch(() => -1);
    assert(docY === 0, "the document itself stayed put, got window.scrollY=" + docY);

    // A page turn is the same controller's other half: `d` moves by a viewport.
    await ctx.press(ctx.tabA, "d");
    const dTop = await waitFor(async () => {
      const top = await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`).catch(() => 0);
      return top > Number(jTop) + 100 ? top : null;
    }, 6000).catch(() => null);
    assert(dTop !== null, `d paged the article further than j left it (${jTop} → ${dTop})`);
    console.log(`       (article: ${blocks} blocks, ${words} words, ${b.sh}px in a ${b.ch}px pane)`);
  });

  await t("Escape leaves the article and gives the page back", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open");

    await ctx.press(ctx.tabA, "Escape");
    const mirrorsGone = await waitAttrGone("data-lf-reader");
    assert(
      mirrorsGone !== null,
      "every reader mirror is gone, got " + JSON.stringify(await attr("data-lf-reader"))
    );
    const hostGone = await waitFor(
      async () => ((await evalIn(ctx.tabA, `!document.getElementById("lazyfox-reader")`)) ? true : null),
      6000
    ).catch(() => null);
    assert(hostGone !== null, "the overlay left the document");
    const bodyDisplay = await evalIn(ctx.tabA, `getComputedStyle(document.body).display`);
    assert(bodyDisplay !== "none", "the page is visible again, body display is " + bodyDisplay);
  });

  await t("reader mode on a page that transforms the root still fills the viewport", async () => {
    // A transform on <html> — an off-canvas drawer, a scroll lock, a page
    // transition — makes the root the containing block for `position:fixed`, so a
    // host that is merely a child of <html> is measured against the DOCUMENT box.
    // Measured on the previous slice's fix for the same class of bug: a host
    // positioned that way sits a scroll offset away, which for a full-viewport
    // article means it is drawn mostly outside the screen. The reader host is
    // promoted to the top layer for this, and this is the test that says so.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await evalIn(ctx.tabA, `document.documentElement.style.transform = "translateZ(0)"; window.scrollTo(0, 900); true`);
    await ctx.waitExpr(ctx.tabA, `window.scrollY`, 900, 6000).catch(() => {});

    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open on the transformed page");
    const box = await evalIn(
      ctx.tabA,
      `(() => { const r = document.getElementById("lazyfox-reader").getBoundingClientRect(); return JSON.stringify({ top: r.top, left: r.left, w: r.width, hgt: r.height, vw: innerWidth, vh: innerHeight, y: scrollY }); })()`
    );
    const b = JSON.parse(box);
    assert(
      Math.abs(b.top) < 3 && Math.abs(b.left) < 3 && Math.abs(b.vw - b.w) < 3 && Math.abs(b.vh - b.hgt) < 3,
      `the article pane is the viewport even with the root transformed and scrolled ${b.y}px: ${JSON.stringify(b)}`
    );
    await ctx.press(ctx.tabA, "j");
    const moved = await waitFor(
      async () =>
        (await evalIn(ctx.tabA, `document.getElementById("lazyfox-reader").scrollTop`).catch(() => 0)) > 0
          ? true
          : null,
      6000
    ).catch(() => null);
    assert(moved !== null, "and the scroll keys still move it there");

    await ctx.press(ctx.tabA, "Escape");
    await evalIn(ctx.tabA, `document.documentElement.style.transform = ""; window.scrollTo(0, 0); true`);
  });

  await t("the article is real document text, so find works inside the reader", async () => {
    // The other half of "the keyboard is the integration": extraction renders
    // ordinary elements, not a canvas or an iframe, so the find widget's own
    // walker sees the article's sentences.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/article`);
    await ctx.leaderSeq(ctx.tabA, ["R"]);
    assert((await waitAttr("data-lf-reader", "1")) !== null, "the reader is open");

    await ctx.leaderSeq(ctx.tabA, ["/"]);
    await ctx.waitPopup(ctx.tabA, 8000);
    await ctx.typeIn(ctx.tabA, "extractor");
    const count = await waitFor(async () => {
      const v = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find")`).catch(() => null);
      const m = v && /^(\d+)\/(\d+)$/.exec(v);
      return m && Number(m[2]) >= 1 ? v : null;
    }, 8000).catch(() => null);
    assert(count !== null, "find counted the article's matches, saw " + (await attr("data-lf-find")));
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitPopupGone(ctx.tabA, 8000);
    await ctx.press(ctx.tabA, "Escape");
  });
}
