// The fix-list format: parsing, matching, and the templates.
//
// This file is where "somebody else's corpus works here" is either true or not.
// The format is Dark Reader's, so the tests are written the way that project's
// own README describes a block — hosts, then directives, then `====` — and the
// shipped corpus is parsed as part of the suite, because a shipped list that
// does not parse is a feature that does not exist.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  asIs,
  asList,
  corpusStats,
  expandTemplates,
  hostAndPath,
  hostMatches,
  matchRules,
  parseFixList,
} from "../../src/shared/dark-rules.ts";
import { SHIPPED_FIXES } from "../../src/shared/dark-fixes.ts";

const VARS = { foreground: "rgb(192, 202, 245)", background: "rgb(22, 22, 30)", accent: "rgb(122, 162, 247)" };

const SAMPLE = [
  "*",
  "INVERT",
  ".a",
  "CSS",
  ".x { background: ${white} !important; }",
  ".y { color: red; }",
  "IGNORE INLINE STYLE",
  ".b",
  "================================",
  "example.com",
  "INVERT",
  ".logo",
  "IGNORE CSS URL",
  "^https://fonts.googleapis.com/",
  "================================",
  "*.sub.example.org, example.net",
  "CSS",
  "body { background: ${black} }",
].join("\n");

describe("the fix-list parser", () => {
  const parsed = parseFixList(SAMPLE);

  test("every block becomes one rule, in file order", () => {
    assert.equal(parsed.rules.length, 3);
    assert.deepEqual(parsed.rules[0]!.hosts, ["*"]);
    assert.deepEqual(parsed.rules[1]!.hosts, ["example.com"]);
    assert.deepEqual(parsed.rules[2]!.hosts, ["*.sub.example.org", "example.net"]);
  });

  test("it reports no errors for a well-formed list", () => {
    assert.deepEqual(parsed.errors, []);
  });

  test("directives collect what belongs to them and nothing else", () => {
    assert.deepEqual(parsed.rules[0]!.invert, [".a"]);
    assert.deepEqual(parsed.rules[0]!.ignoreInline, [".b"]);
    assert.deepEqual(parsed.rules[0]!.removeBg, []);
    assert.deepEqual(parsed.rules[1]!.invert, [".logo"]);
    assert.deepEqual(parsed.rules[1]!.ignoreCssUrl, ["^https://fonts.googleapis.com/"]);
  });

  test("a CSS fragment keeps its lines, including blank ones", () => {
    // The two CSS lines are ONE fragment: `.y` is CSS, not a selector and not a
    // second directive. Getting this wrong turns every multi-line rule into a
    // one-line rule plus a rule that matches an element named `.y { color: red; }`.
    assert.match(parsed.rules[0]!.css, /^\.x \{ background: \$\{white\} !important; \}\n\.y \{ color: red; \}$/);
  });

  test("a block's line number is recorded, for error messages", () => {
    assert.equal(parsed.rules[0]!.line, 1);
    assert.ok(parsed.rules[1]!.line > 1);
  });

  test("a block with no host is reported and dropped", () => {
    const bad = parseFixList("INVERT\n.a\n====\nexample.com\nINVERT\n.b");
    assert.equal(bad.rules.length, 1, "only the block that named a host survives");
    assert.deepEqual(bad.rules[0]!.hosts, ["example.com"]);
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0]!, /no host pattern/);
  });

  test("an unknown directive is reported rather than read as a selector", () => {
    // The failure this prevents is silent: upstream's parser treats `INVERTT` as
    // a selector, so the rule matches nothing and the typo is invisible.
    const bad = parseFixList("example.com\nINVERTT\n.a");
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0]!, /unknown directive "INVERTT"/);
    assert.match(bad.errors[0]!, /line 2/);
  });

  test("hosts may be separated by commas, spaces or lines", () => {
    const r = parseFixList("a.com, b.com\nc.com  d.com\nCSS\n.x{}");
    assert.deepEqual(r.rules[0]!.hosts, ["a.com", "b.com", "c.com", "d.com"]);
  });

  test("an empty list is an empty list, not an error", () => {
    const r = parseFixList("\n\n   \n");
    assert.deepEqual(r.rules, []);
    assert.deepEqual(r.errors, []);
  });
});

describe("host matching", () => {
  const cases: Array<[string, string, boolean, string?]> = [
    ["*", "anything.example", true],
    ["example.com", "example.com", true],
    ["example.com", "www.example.com", true, "a bare pattern covers subdomains — upstream's own rule"],
    ["example.com", "notexample.com", false],
    ["example.com", "example.com.evil.net", false, "a suffix match must be label-aligned"],
    ["Example.COM", "example.com", true, "patterns are case-insensitive"],
    ["*.abc.net.au", "www.abc.net.au", true],
    ["*.abc.net.au", "abc.net.au", true],
    ["*.abc.net.au", "abc.net.au.evil.com", false],
    ["example.*", "example.com", true],
    ["example.*", "example.co.uk", true],
    ["example.*", "www.example.com", false, "a glob is anchored, so the www form needs its own block"],
    ["go*.example.com", "good.example.com", true],
    ["", "example.com", false],
  ];
  for (const [pattern, host, want, note] of cases) {
    test(`${pattern} vs ${host} → ${want}${note ? " (" + note + ")" : ""}`, () => {
      assert.equal(hostMatches(pattern, host), want);
    });
  }

  test("a pattern may carry a path prefix", () => {
    assert.equal(hostMatches("example.com/docs", "example.com", "/docs/a"), true);
    assert.equal(hostMatches("example.com/docs", "example.com", "/other"), false);
    assert.equal(hostMatches("example.com/docs", "example.com", ""), false);
    // No path supplied means the path part cannot be checked, and the host part
    // still decides — the alternative would be to silently drop the rule.
    assert.equal(hostMatches("example.com/docs", "example.com"), true);
  });

  test("hostAndPath reads a URL without a DOM", () => {
    assert.deepEqual(hostAndPath("https://www.Example.com/a/b?q=1"), { host: "www.example.com", path: "/a/b?q=1" });
    assert.deepEqual(hostAndPath("not a url"), { host: "", path: "" });
  });
});

describe("which rules apply, and in what order", () => {
  const { rules } = parseFixList(SAMPLE);

  test("the every-site block comes first, then the site's own", () => {
    // Order IS the cascade: a site block exists to override the generic one.
    const hit = matchRules(rules, "https://www.example.com/page");
    assert.equal(hit.length, 2);
    assert.deepEqual(hit[0]!.hosts, ["*"]);
    assert.deepEqual(hit[1]!.hosts, ["example.com"]);
  });

  test("a URL no site block names gets the every-site block, and only it", () => {
    // "Nothing matched" is not a reachable answer while the list contains a `*`
    // block — that block IS a rule for every site. What the caller gets is one
    // generic block and no site block, and the ORDER is the guarantee that a
    // site's own rules would have overridden it.
    const hit = matchRules(rules, "https://unrelated.test/");
    assert.deepEqual(hit.map((r) => r.hosts), [["*"]]);
    const noGeneric = parseFixList("example.com\nINVERT\n.logo").rules;
    assert.deepEqual(matchRules(noGeneric, "https://unrelated.test/"), [], "and without a `*` block there is nothing at all");
  });

  test("subdomains and paths are honoured through the URL form", () => {
    const sub = matchRules(rules, "https://deep.sub.example.org/x");
    assert.deepEqual(sub.map((r) => r.hosts), [["*"], ["*.sub.example.org", "example.net"]]);
    assert.equal(matchRules(rules, "https://example.net/x").length, 2, "the generic block plus the one that names this host");
    assert.equal(matchRules(rules, "https://nope.example.org/x").length, 1, "a near-miss host matches nothing but the generic block");
  });
});

describe("colour templates", () => {
  test("white and black mean the theme's poles, not the colours", () => {
    // Upstream's contract, and the opposite of how it reads: a rule written for a
    // light page has to keep meaning "the text colour" on a dark one.
    assert.equal(expandTemplates("${white}", VARS), VARS.foreground);
    assert.equal(expandTemplates("${black}", VARS), VARS.background);
    assert.equal(expandTemplates("${ accent }", VARS), VARS.accent);
  });

  test("every other template is a fixed colour", () => {
    assert.equal(expandTemplates("${#F5F5F5}", VARS), "#F5F5F5");
    assert.equal(expandTemplates("${rgb(245, 245, 245)}", VARS), "rgb(245, 245, 245)");
    assert.equal(expandTemplates("${lightblue}", VARS), "lightblue");
  });

  test("an upstream scheme gate is re-pointed at our attribute", () => {
    // Otherwise every `[data-darkreader-scheme="dark"]` rule in an imported file
    // is a rule that never matches, silently.
    assert.equal(
      expandTemplates('html[data-darkreader-scheme="dark"] .logo { filter: none; }', VARS),
      'html[data-lf-scheme="dark"] .logo { filter: none; }'
    );
  });

  test("text with no templates is untouched", () => {
    const css = ".a { background: var(--darkreader-neutral-background) !important; }";
    assert.equal(expandTemplates(css, VARS), css);
  });
});

describe("selector list helpers", () => {
  test("asIs wraps several selectors and leaves one alone", () => {
    assert.equal(asIs([".a"]), ".a");
    assert.equal(asIs([".a", " .b ", ""]), ":is(.a, .b)");
    assert.equal(asIs([]), "");
  });

  test("asList is a plain comma list and tolerates junk", () => {
    assert.equal(asList([".a", ".b"]), ".a, .b");
    assert.equal(asList(["", "  ", ".a"]), ".a");
  });

  test("corpusStats counts blocks, site blocks and selectors", () => {
    const { rules } = parseFixList(SAMPLE);
    const stats = corpusStats(rules);
    assert.equal(stats.blocks, 3);
    assert.equal(stats.sites, 2, "the `*` block is not a site");
    assert.equal(stats.selectors, 3, ".a and .b in the generic block, .logo in the site block");
  });
});

describe("the corpus that ships", () => {
  const parsed = parseFixList(SHIPPED_FIXES);

  test("it parses with no errors", () => {
    // A shipped list that does not parse is a feature that silently does not
    // exist, which is exactly what a free-text default is prone to.
    assert.deepEqual(parsed.errors, []);
    assert.ok(parsed.rules.length >= 8, `expected a handful of blocks, got ${parsed.rules.length}`);
  });

  test("it carries the upstream attribution and the pinned source", () => {
    // The attribution lives in the TEXT and not only in a comment above it: this
    // string is the default value of a settings textarea, and a user who copies
    // the corpus out of the UI should take the provenance with it. The parser
    // ignores `#` lines in host position, which is what makes that possible.
    const header = SHIPPED_FIXES.slice(0, 2000);
    assert.match(header, /darkreader\/darkreader/);
    assert.match(header, /MIT/);
    assert.match(header, /dynamic-theme-fixes\.config/);
    assert.ok(SHIPPED_FIXES.startsWith("#"), "the header comes first, before any block");
  });

  test("a commented-out block does not become a rule", () => {
    // The header above is the shipped case; this is the user's: commenting a
    // site block out is how a corpus is edited while keeping a record of what
    // was there, and it has to actually disable the block.
    const r = parseFixList("# example.com\n# INVERT\n# .logo\n\nreal.com\nINVERT\n.keep");
    assert.deepEqual(r.errors, []);
    assert.equal(r.rules.length, 1);
    assert.deepEqual(r.rules[0]!.hosts, ["real.com"]);
    assert.deepEqual(r.rules[0]!.invert, [".keep"]);
  });

  test("a `#id` selector after a directive is not read as a comment", () => {
    const r = parseFixList("example.com\nINVERT\n#player *\nCSS\n//not-a-comment{}");
    assert.deepEqual(r.rules[0]!.invert, ["#player *"]);
    assert.match(r.rules[0]!.css, /\/\/not-a-comment\{\}/);
  });

  test("the every-site block is there, and is the first", () => {
    assert.deepEqual(parsed.rules[0]!.hosts, ["*"]);
    assert.ok(parsed.rules[0]!.invert.length >= 4);
    assert.ok(parsed.rules[0]!.css.length > 200);
    assert.deepEqual(parsed.rules[0]!.ignoreCssUrl, ["^https://fonts.googleapis.com/"]);
  });

  test("the sites people visit are named", () => {
    const hosts = parsed.rules.flatMap((r) => r.hosts);
    for (const host of ["*.abc.net.au", "*.archlinux.org", "*.bitrix24.ru", "*.discogs.com", "*.docs.kubernetes.io"]) {
      assert.ok(hosts.includes(host), `${host} is missing from the shipped corpus`);
    }
  });

  test("the templates in it survive parsing un-expanded", () => {
    // They must reach the sheet as templates: expanding them at parse time would
    // bake one theme's colours into a list the user can edit. The corpus uses
    // upstream's fixed-colour form (`${#F5F5F5}`, "this exact colour, do not
    // transform it"); the two pole templates are covered by the tests above and
    // by composeSheet in dark-theme.test.ts.
    const all = parsed.rules.map((r) => r.css).join("\n");
    assert.match(all, /\$\{#F5F5F5\}/);
    assert.match(all, /\$\{#d2d2d2\}/);
    const count = (SHIPPED_FIXES.match(/\$\{[^}]+\}/g) || []).length;
    assert.ok(count >= 4, `expected the shipped templates to survive, found ${count}`);
  });

  test("the every-site selectors include the inline-colour fixes", () => {
    // These are the rules that catch what the engine cannot see: a colour written
    // into a style attribute, which no stylesheet walk will ever find.
    const css = parsed.rules[0]!.css;
    assert.match(css, /\*\[style\*="background:#fff"\]/);
    assert.match(css, /\*\[style\*="color:#000"\]/);
  });
});
