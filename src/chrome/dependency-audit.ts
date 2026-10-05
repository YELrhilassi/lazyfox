// The check that keeps the env seam from rotting.
//
// WHY THIS EXISTS. `src/chrome/env.ts` exists so chrome logic is assertable in
// Node: a module takes a `ChromeEnv` and reads `env.document`, `env.window`,
// `env.services`. That property is invisible in the browser and completely
// silent when it decays — one `document.getElementById` slipped back into
// `popup.ts` and the module stopped being constructible in a test, with no
// error anywhere. TypeScript cannot catch it either: `document` is a DOM global
// the browser tree declares, so reading it typechecks perfectly.
//
// So it is checked here, statically, in the unit tier. A file that reads a
// browser global outside its `env` is a finding with a file and a line, and the
// audit fails. That is the whole point: the seam is only worth anything if
// nothing can quietly walk back through it.
//
// SCOPE, HONESTLY STATED. Not every chrome module is converted yet —
// `splitview.ts`, `channel.ts`, `tabguard.ts` and friends still read globals
// directly, and rewriting all of them is a much larger change than this. Rather
// than pretend the seam is universal, `SEAMED` below is the explicit list of
// modules that HAVE been converted. The audit enforces the rule for those, and
// reports the unconverted remainder as `unseamed` so the remaining work is
// visible rather than implied by silence.
//
// Two properties make this worth having even in that narrower form:
//   * a seamed module cannot regress (the audit fails the build), and
//   * the backlog cannot quietly grow (a NEW module is unseamed by default, so
//     adding one does not opt it into the ambient world by accident).

/** Browser globals a seamed chrome module may not read directly. */
export const BROWSER_GLOBALS = [
  "document",
  "window",
  "Services",
  "Ci",
  "Cc",
  "Cu",
  "ChromeUtils",
  "SessionStore",
  "WebExtensionPolicy",
  "ZoomManager",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
] as const;

/**
 * Modules converted to the `env` seam, with the reason each one earned it.
 *
 * The list is an assertion, not a suggestion: a file here that reads a global
 * fails the audit, and removing a file from the list without converting it is a
 * visible edit to this array (a reviewer sees it in the diff).
 */
export const SEAMED: Record<string, string> = {
  "alive.ts": "the announce handshake and the ProfD profile read",
  "commandcenterfocus.ts": "focus + key forwarding into the command-center page",
  "debug.ts": "the #lfc=state reply the whole e2e harness asserts against",
  "keystate.ts": "which surface owns the keys — the gate on every key decision",
  "keysdispatch.ts": "the ownership order (was already the house idiom)",
  "ops/primitives.ts": "tab identity, native URL loading, the native data sources",
  "ops/sessions.ts": "the session-relay refresh timer and the split-API probe",
  "ops/tabs.ts": "every action that addresses the window's tab strip",
  "ops/ui.ts": "zen mode and the find bar",
  "pagehints.ts": "chrome-owned-page link hints",
  "popup.ts": "popup mount/unmount and the window resize popup",
  "scrollkeys.ts": "vim scroll keys on chrome-owned pages",
  "statusbar.ts": "the bar's lifecycle: mount, fullscreen hide, selection read",
  // Extracted from main.ts in this pass, and written against the seam from the
  // start rather than converted afterwards: all three take the window (or the
  // whole env) as a parameter precisely so the composition root stays the only
  // place that knows where the chrome document comes from.
  "actorbridge.ts": "keys forwarded by the content-process actor",
  "winlisteners.ts": "the chrome document's keydown/keypress/keyup/blur/TabSelect listeners",
  "winsync.ts": "the 500ms relay poll, the #lfc= progress route, tab-select bookkeeping",
};

/** A single forbidden reference, with enough context to act on it. */
export interface DependencyFinding {
  file: string;
  line: number;
  global: string;
  text: string;
}

export interface DependencyAudit {
  /** Files whose globals must stay behind `env` — and did not. */
  findings: DependencyFinding[];
  /** Chrome modules not yet converted, with their global-reference counts. */
  unseamed: Array<{ file: string; globals: string[] }>;
  /** How many files the audit looked at. */
  files: number;
}

/**
 * Strip comments and string literals from a line.
 *
 * Without this the audit is trivially defeated by the word "document" in a
 * doc comment — and worse, it would fire on this very file. Only real code
 * counts as a reference to a global.
 *
 * `inBlockComment` carries block-comment state ACROSS lines. It has to: this
 * codebase's comment style puts ` * ` on every continuation line, so a scanner
 * that only looked at the current line would read every word inside a JSDoc
 * block as code — and would then "find" globals in prose. Passing the state in
 * is what makes a multi-line comment behave like the multi-line comment it is.
 */
export function code(line: string, inBlockComment = false): { code: string; inBlockComment: boolean } {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  let block = inBlockComment;
  while (i < line.length) {
    const c = line[i]!;
    if (block) {
      if (c === "*" && line[i + 1] === "/") {
        block = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") break;
    if (c === "/" && line[i + 1] === "*") {
      block = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, inBlockComment: block };
}

/**
 * Which browser globals a line of code reads, ignoring comments and strings.
 *
 * A reference only counts when the global stands ALONE — `env.document` is the
 * seam working, `document` is the seam bypassed. That one negative
 * lookbehind is what makes "read it through env" and "read it directly"
 * distinguishable at all, and it is why `env.window.gBrowser` does not count as
 * a `window` reference while `win.gBrowser` counts as nothing.
 */
export function globalsIn(line: string, inBlockComment = false): string[] {
  const c = code(line, inBlockComment).code;
  const found: string[] = [];
  for (const g of BROWSER_GLOBALS) {
    // A line that DECLARES the name shadows the global for every use on it —
    // `const document = env.document;` is the seam, not a bypass of it. This is
    // a line-level heuristic, not scope analysis: a declaration in a block
    // shadows only in that block, so a module that declares `document` in one
    // function and reads the real global in another would be under-reported.
    // That direction of error is deliberate — a missing finding costs less than
    // a false one that trains people to ignore the audit.
    const declared = new RegExp("\\b(?:const|let|var|function)\\s+" + g + "\\b").test(c);
    if (declared) continue;
    // Not preceded by a dot (env.document), a word char, or a quote.
    const re = new RegExp("(?<![.\\w$'\"])\\b" + g + "\\b");
    if (re.test(c)) found.push(g);
  }
  return found;
}

/** Is this a `declare const window: any` style ambient declaration? */
function isAmbientDeclaration(line: string): boolean {
  return /^\s*(declare\s+(const|var|let)\s|interface\s+(Window|GlobalThis)\b)/.test(line);
}

/**
 * Audit a set of file bodies.
 *
 * `files` is a map from the path used in findings (relative to `src/chrome/`)
 * to its source text, so the caller decides how to read the filesystem — this
 * stays a pure function over strings and is directly testable.
 */
export function auditDependencies(files: Record<string, string>): DependencyAudit {
  const findings: DependencyFinding[] = [];
  const unseamed: Array<{ file: string; globals: string[] }> = [];

  for (const [file, source] of Object.entries(files)) {
    const lines = source.split("\n");
    const seamed = Object.prototype.hasOwnProperty.call(SEAMED, file);
    const seen = new Set<string>();
    let inBlockComment = false;

    lines.forEach((raw, i) => {
      const hits = globalsIn(raw, inBlockComment);
      // The declaration form is typed, not read, and it is checked BEFORE the
      // comment state is advanced — a `declare` cannot live inside a comment.
      const skip = isAmbientDeclaration(raw);
      inBlockComment = code(raw, inBlockComment).inBlockComment;
      if (skip || !hits.length) return;
      for (const g of hits) seen.add(g);
      if (seamed) {
        for (const g of hits) {
          findings.push({ file, line: i + 1, global: g, text: raw.trim() });
        }
      }
    });

    if (!seamed && seen.size) {
      unseamed.push({ file, globals: [...seen].sort() });
    }
  }

  return { findings, unseamed, files: Object.keys(files).length };
}

/** One line per finding, for a test message that names the file and line. */
export function describeFindings(findings: DependencyFinding[]): string {
  return findings.map((f) => `${f.file}:${f.line} reads \`${f.global}\` directly — ${f.text}`).join("\n");
}
