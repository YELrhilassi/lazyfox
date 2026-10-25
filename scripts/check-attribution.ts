#!/usr/bin/env node
// Attribution guard.
//
// A Co-Authored-By trailer is not in the diff, so no build or test can see it:
// it lives only in the commit object, and GitHub reads it when it draws the
// contributor graph. That is how an agent stayed listed as a contributor after
// every file it touched was rewritten. This script reads the commit objects
// themselves, so the only way to pass is to not write the trailer.
//
// The repository policy is owner-only. Every reachable commit must be authored
// by the owner and must not name a second author; Codebuff must not appear in
// an identity or a message at all.
//
// `prepare` installs this file as the commit-msg and pre-push hooks. CI runs it
// with full history (see .github/workflows/attribution.yml). The commit-msg mode
// checks only the pending message; the full mode checks identity and trailers.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const OWNER_EMAILS = new Set(["elrhilassiy@gmail.com"]);
// GitHub's web-flow identity is the committer when a file is edited in the
// browser. It is not an author and does not appear in the contributor graph.
const WEB_FLOW_EMAILS = new Set(["noreply@github.com"]);
const AGENT = /codebuff/i;
const CO_AUTHOR = /^\s*co-authored-by\s*:/im;

interface Problem {
  hash: string;
  detail: string;
}

interface Scan {
  count: number;
  problems: Problem[];
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function messageProblems(hash: string, message: string): Problem[] {
  const problems: Problem[] = [];
  if (AGENT.test(message)) problems.push({ hash, detail: "message mentions Codebuff" });
  if (CO_AUTHOR.test(message)) {
    problems.push({ hash, detail: "message carries a Co-Authored-By trailer" });
  }
  return problems;
}

function scanHistory(): Scan {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    console.error(
      "Attribution check needs full history, but this clone is shallow.\n" +
        "Run `git fetch --unshallow`, or check out with fetch-depth: 0, then retry.",
    );
    process.exit(2);
  }

  // \x1f separates fields and \x1e separates commits. Neither can occur in a
  // commit message in practice, and unlike a newline they survive a multi-line
  // body without ambiguity.
  const raw = git(["log", "--all", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e"]);
  const problems: Problem[] = [];
  let count = 0;

  for (const record of raw.split("\x1e")) {
    const text = record.replace(/^\r?\n/, "");
    if (!text.trim()) continue;
    const fields = text.split("\x1f");
    const hash = fields[0];
    if (!hash) continue;
    const authorName = fields[1] ?? "";
    const authorEmail = fields[2] ?? "";
    const committerName = fields[3] ?? "";
    const committerEmail = fields[4] ?? "";
    const message = fields.slice(5).join("\x1f");
    count++;

    if (AGENT.test(`${authorName} ${authorEmail}`)) {
      problems.push({ hash, detail: `author ${authorName} <${authorEmail}> is an agent` });
    } else if (!OWNER_EMAILS.has(authorEmail.toLowerCase())) {
      problems.push({ hash, detail: `author ${authorName} <${authorEmail}> is not the owner` });
    }

    if (AGENT.test(`${committerName} ${committerEmail}`)) {
      problems.push({ hash, detail: `committer ${committerName} <${committerEmail}> is an agent` });
    } else if (
      !OWNER_EMAILS.has(committerEmail.toLowerCase()) &&
      !WEB_FLOW_EMAILS.has(committerEmail.toLowerCase())
    ) {
      problems.push({ hash, detail: `committer ${committerName} <${committerEmail}> is not the owner` });
    }

    problems.push(...messageProblems(hash, message));
  }

  if (count === 0) {
    console.error("Attribution check found no commits. Run it from a git checkout.");
    process.exit(2);
  }
  return { count, problems };
}

function report(scan: Scan): void {
  if (scan.problems.length === 0) {
    console.log(
      `Attribution OK: ${scan.count} commit(s), all authored and committed by the repository owner.`,
    );
    return;
  }

  console.error(
    `Attribution guard failed: ${scan.problems.length} problem(s) in ${scan.count} commit(s).\n`,
  );
  for (const problem of scan.problems.slice(0, 30)) {
    console.error(`  ${problem.hash.slice(0, 12)}  ${problem.detail}`);
  }
  if (scan.problems.length > 30) {
    console.error(`  ... and ${scan.problems.length - 30} more`);
  }
  console.error(
    "\nA Co-Authored-By trailer is what makes GitHub list a second contributor.\n" +
      "Rewrite the offending commits, or delete the stale branch that still reaches\n" +
      "them, then re-run this check.",
  );
  process.exit(1);
}

const messageFileFlag = process.argv.indexOf("--message-file");
if (messageFileFlag !== -1) {
  const path = process.argv[messageFileFlag + 1];
  if (!path) {
    console.error("--message-file needs a path.");
    process.exit(2);
  }
  const problems = messageProblems("pending", readFileSync(path, "utf8"));
  if (problems.length === 0) {
    process.exit(0);
  }
  console.error("Refusing this commit message:");
  for (const problem of problems) console.error(`  ${problem.detail}`);
  console.error("Remove the agent credit and the Co-Authored-By trailer, then commit again.");
  process.exit(1);
}

report(scanHistory());
