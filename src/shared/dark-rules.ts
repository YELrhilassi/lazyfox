// The per-site fix list: Dark Reader's file format, parsed here.
//
// WHY SOMEBODY ELSE'S FORMAT. A dark-mode engine can never cover every site by
// itself, and the community's answer to that is a plain-text rule corpus keyed
// by host. Dark Reader's is by far the largest such corpus and it is MIT
// licensed, so adopting its FORMAT (rather than inventing a JSON shape) means a
// file written for that project can be pasted into Lazyfox's settings and work.
// That is the whole reason this module exists, and it is why the directive names
// below are copied exactly — including `IGNORE INLINE STYLE`, spaces and all —
// rather than tidied into something prettier.
//
// THE GRAMMAR, in one place:
//
//     example.com, *.example.net      <- one or more host patterns, first
//     INVERT                          <- directive; following lines are selectors
//     .logo
//     img.badge
//     CSS                             <- directive; following lines are raw CSS
//     .card { background: ${white} !important; }
//     IGNORE INLINE STYLE             <- directive; following lines are selectors
//     .color-picker
//     ================================  <- block separator
//
// One deliberate difference from upstream's parser: a line that is ALL CAPS and
// is not a known directive is reported as an ERROR rather than silently treated
// as a selector. Upstream's silence is how a mistyped directive ships as a rule
// that matches an element named `INVERTT`, which is invisible until someone
// wonders why a fix does nothing.
//
// WHAT IS ACCEPTED BUT UNUSED: `IGNORE CSS URL`. It means "do not rewrite this
// stylesheet", and this engine never rewrites stylesheets at all, so the
// directive is parsed (the block must not fail to load) and ignored. That is a
// fact about the engine, not a promise about the directive.
//
// COMMENTS: a line starting with `#` or `//` in host position is skipped. Only
// in host position — see the note in the parser. This is a LAZYFOX addition, not
// part of upstream's format: Dark Reader's parser has no comment convention (its
// own guide documents none, and `#player` is a selector there), so a corpus that
// uses comments reads here and would have to lose them to travel back. The
// direction that matters is the other one — every file upstream ships parses
// here unmodified — and comments are what a user's own file will want.

export interface DarkRule {
  /** Host patterns, in file order. `*` is the every-site block. */
  hosts: string[];
  /** Selectors to counter-invert: media that disappears on a dark canvas. */
  invert: string[];
  /** Selectors that must NOT be counter-inverted even inside an INVERTed one. */
  noInvert: string[];
  /** Selectors whose background image is removed and replaced with the canvas. */
  removeBg: string[];
  /** Selectors the engine must not touch with its own colour mapping. */
  ignoreInline: string[];
  /** Selectors whose background-image must not be analysed (accepted; unused). */
  ignoreImage: string[];
  /** Stylesheet URL prefixes not to rewrite (accepted; unused). */
  ignoreCssUrl: string[];
  /** Raw CSS, templates unexpanded. */
  css: string;
  /** 1-based line the block started on, for error messages. */
  line: number;
}

export interface FixList {
  rules: DarkRule[];
  /** Human-readable problems, each naming its line. Never block loading. */
  errors: string[];
}

const DIRECTIVES = [
  "INVERT",
  "NO INVERT",
  "REMOVE BG",
  "CSS",
  "IGNORE INLINE STYLE",
  "IGNORE IMAGE ANALYSIS",
  "IGNORE CSS URL",
] as const;

type Directive = (typeof DIRECTIVES)[number];

const DIRECTIVE_SET: Record<string, Directive> = Object.fromEntries(
  DIRECTIVES.map((d) => [d, d])
);

/** A line that is all comment: `# …` or `// …`. */
const COMMENT = /^(#|\/\/)/;

/** A line of separator: `====`, `=====`, … (upstream uses 32 of them). */
const SEPARATOR = /^={4,}$/;

/** An all-caps word that is not a directive — almost certainly a typo. */
const LOOKS_LIKE_DIRECTIVE = /^[A-Z][A-Z ]{2,}$/;

function emptyRule(line: number): DarkRule {
  return {
    hosts: [],
    invert: [],
    noInvert: [],
    removeBg: [],
    ignoreInline: [],
    ignoreImage: [],
    ignoreCssUrl: [],
    css: "",
    line,
  };
}

function targets(rule: DarkRule, directive: Directive): string[] | null {
  switch (directive) {
    case "INVERT":
      return rule.invert;
    case "NO INVERT":
      return rule.noInvert;
    case "REMOVE BG":
      return rule.removeBg;
    case "IGNORE INLINE STYLE":
      return rule.ignoreInline;
    case "IGNORE IMAGE ANALYSIS":
      return rule.ignoreImage;
    case "IGNORE CSS URL":
      return rule.ignoreCssUrl;
    case "CSS":
      return null; // CSS accumulates as text, not as a selector list
  }
}

/**
 * Parse a fix list. Never throws: a malformed block is reported in `errors` and
 * the rest of the file still loads. That is deliberate — the corpus is
 * user-editable text, and a single typo dropping every other rule would be the
 * worst possible failure mode.
 */
export function parseFixList(text: string): FixList {
  const rules: DarkRule[] = [];
  const errors: string[] = [];
  let current = emptyRule(1);
  let started = false;
  let directive: Directive | null = null;

  const flush = () => {
    if (!started) return;
    if (current.hosts.length === 0) {
      errors.push(`line ${current.line}: a block with no host pattern was dropped`);
      current = emptyRule(current.line);
      started = false;
      directive = null;
      return;
    }
    current.css = current.css.replace(/\s+$/, "");
    rules.push(current);
    current = emptyRule(current.line);
    started = false;
    directive = null;
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").replace(/\r$/, "");
    const line = raw.trim();
    const lineNo = i + 1;
    if (SEPARATOR.test(line)) {
      flush();
      current.line = lineNo + 1;
      continue;
    }
    if (line === "") {
      // A blank line inside a CSS fragment is part of the CSS; anywhere else it
      // is noise. Keeping it inside CSS is what lets a pasted-in block be
      // formatted like the CSS it is.
      if (directive === "CSS" && started) current.css += "\n";
      continue;
    }
    if (directive === null && COMMENT.test(line)) {
      // Comments are only recognised in HOST POSITION, before a directive. That
      // is the one place a `#` cannot be a selector — after `INVERT` or `CSS` a
      // hash begins an id selector, and reading `#player` as a comment would
      // silently drop the fix it names. The shipped corpus opens with a header
      // for the same reason a user's file will, so this is not a nicety.
      continue;
    }
    if (!started) {
      current = emptyRule(lineNo);
      started = true;
    }
    const known = DIRECTIVE_SET[line];
    if (known) {
      directive = known;
      continue;
    }
    if (LOOKS_LIKE_DIRECTIVE.test(line)) {
      errors.push(`line ${lineNo}: unknown directive "${line}" (ignored)`);
      continue;
    }
    if (directive === null) {
      // Host patterns: whitespace- or comma-separated, any number per line.
      for (const host of line.split(/[\s,]+/)) {
        if (host) current.hosts.push(host);
      }
      continue;
    }
    if (directive === "CSS") {
      current.css += (current.css ? "\n" : "") + raw.replace(/\s+$/, "");
      continue;
    }
    const list = targets(current, directive);
    if (list) list.push(line);
  }
  flush();
  return { rules, errors };
}

/**
 * Whether one host pattern covers a host (and optional path).
 *
 * Three shapes, and the bare one is the interesting one:
 *
 *   `*`              every site
 *   `*.example.com`  example.com and any subdomain of it
 *   `example.com`    the host itself, or any SUBDOMAIN of it
 *   `example.*`      any TLD (a glob: `*` matches any run of characters)
 *   `example.com/x`  the host, and only URLs whose path starts with `/x`
 *
 * The subdomain rule for a bare pattern is upstream's behaviour and the reason
 * its contribution guide tells authors to omit `www`: a pattern spelling `www.`
 * would then only match that one form. Getting this wrong in the other direction
 * (a rule that silently stops applying on `m.example.com`) is a fix that looks
 * broken, which is why it is stated here and pinned by a test.
 */
export function hostMatches(pattern: string, host: string, path?: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const slash = trimmed.indexOf("/");
  const patHost = slash < 0 ? trimmed : trimmed.slice(0, slash);
  if (slash >= 0 && path !== undefined) {
    const patPath = trimmed.slice(slash);
    if (!path.startsWith(patPath)) return false;
  }
  if (patHost === "*") return true;
  const lower = host.toLowerCase();
  const pat = patHost.toLowerCase();
  if (pat.startsWith("*.")) {
    const rest = pat.slice(2);
    return lower === rest || lower.endsWith("." + rest);
  }
  if (pat.indexOf("*") < 0) {
    return lower === pat || lower.endsWith("." + pat);
  }
  // A glob somewhere else (`example.*`, `go*.example.com`).
  const re = new RegExp(
    "^" + pat.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return re.test(lower);
}

/** A host + path parsed out of a URL, without touching a DOM. */
export function hostAndPath(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, path: u.pathname + u.search };
  } catch {
    return { host: "", path: "" };
  }
}

/**
 * The rules that apply to a URL: the every-site blocks first, then the matching
 * host blocks in file order.
 *
 * Order is the cascade. A site's own rule exists to override the generic one
 * (that is what `INVERT` on a specific logo is *for*), so generic-first is not a
 * detail — reversed, the corpus would fight itself and the site-specific fixes
 * would lose.
 */
export function matchRules(rules: DarkRule[], url: string): DarkRule[] {
  const { host, path } = hostAndPath(url);
  const generic: DarkRule[] = [];
  const specific: DarkRule[] = [];
  for (const rule of rules) {
    let hit = false;
    for (const pattern of rule.hosts) {
      if (hostMatches(pattern, host, path)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    if (rule.hosts.length === 1 && rule.hosts[0] === "*") generic.push(rule);
    else specific.push(rule);
  }
  return generic.concat(specific);
}

/** Values a `${…}` template resolves to. */
export interface TemplateVars {
  /** `${white}` — the theme's foreground pole (upstream's meaning). */
  foreground: string;
  /** `${black}` — the theme's background pole. */
  background: string;
  /** `${accent}` — the link colour (a Lazyfox addition; see the docs). */
  accent: string;
}

/**
 * Expand upstream's `${…}` colour templates and re-point its scheme attribute.
 *
 * The template rule is upstream's and is worth stating precisely, because it is
 * the opposite of what it looks like: `${white}` and `${black}` mean "the text
 * colour" and "the background colour" (so a rule written for a light page keeps
 * meaning the same thing on a dark one), while every OTHER template — `${#F5F5F5}`,
 * `${rgb(245, 245, 245)}`, `${lightblue}` — means "this exact colour, do not
 * transform it". Passing those through verbatim is therefore correct, not lazy.
 *
 * The attribute rewrite is ours: upstream rules are gated on
 * `[data-darkreader-scheme="dark"]`, and rather than define a variable nobody
 * reads, the engine sets `data-lf-scheme` and this function points the selector
 * at it — so an imported block that gates on the scheme keeps working.
 */
export function expandTemplates(css: string, vars: TemplateVars): string {
  const out = css.replace(/\$\{([^}]*)\}/g, (_m, inner: string) => {
    const name = inner.trim();
    if (name === "white") return vars.foreground;
    if (name === "black") return vars.background;
    if (name === "accent") return vars.accent;
    const named = name.toLowerCase();
    if (named === "bg" || named === "background") return vars.background;
    if (named === "fg" || named === "foreground" || named === "text") return vars.foreground;
    // Fixed colour: upstream's contract is "leave this one alone".
    return name;
  });
  return out.replace(/\[data-darkreader-scheme=/g, "[data-lf-scheme=");
}

/** A selector list as one `:is(...)` argument, or "" when empty. */
export function asIs(selectors: string[]): string {
  const clean = selectors.map((s) => s.trim()).filter(Boolean);
  if (!clean.length) return "";
  if (clean.length === 1) return clean[0]!;
  return ":is(" + clean.join(", ") + ")";
}

/** A selector list joined for a plain rule (`,`-separated), or "" when empty. */
export function asList(selectors: string[]): string {
  return selectors.map((s) => s.trim()).filter(Boolean).join(", ");
}

/** How many blocks a list holds, split by whether they are site-specific. */
export function corpusStats(rules: DarkRule[]): { blocks: number; sites: number; selectors: number } {
  let sites = 0;
  let selectors = 0;
  for (const rule of rules) {
    if (!(rule.hosts.length === 1 && rule.hosts[0] === "*")) sites++;
    selectors +=
      rule.invert.length +
      rule.noInvert.length +
      rule.removeBg.length +
      rule.ignoreInline.length +
      rule.ignoreImage.length;
  }
  return { blocks: rules.length, sites, selectors };
}
