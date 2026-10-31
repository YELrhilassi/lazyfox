#!/usr/bin/env node
// Diagnostic: print one line per payloadHash input — its POSIX relative label
// and sha256 — so a payload disagreement between two machines (e.g. the CI
// runners vs a local checkout, see the Go pin note in
// .github/workflows/installers.yml) can be narrowed to the file that actually
// differs. payloadHash itself collapses everything into one digest, which can
// only ever answer "different"; this answers "which one".
//
// Not part of any gate. CI runs it right after `npm run build` (see
// installers.yml) and prints to the job log; diff two jobs' output to bisect.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOADER_FILES,
  ROOT,
  STAGED_CHROME_FILES,
  latestUnsignedXpi,
  nativeHostSources,
} from "./payload.ts";

function sha256(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const chrome = STAGED_CHROME_FILES.map((f) => `dist/chrome/${f}`);
const loader = LOADER_FILES.map((f) => `dist/chrome/loader/${f}`);
const host = nativeHostSources(ROOT);
const xpi = latestUnsignedXpi(ROOT);

const rows: Array<{ path: string; sha: string; bytes: number }> = [];
const add = (rel: string): void => {
  const abs = join(ROOT, rel);
  try {
    rows.push({ path: rel, sha: sha256(abs), bytes: readFileSync(abs).length });
  } catch {
    rows.push({ path: rel, sha: "MISSING", bytes: 0 });
  }
};

for (const rel of [...chrome, ...loader, ...host]) add(rel);
if (xpi) add(xpi);

rows.sort((a, b) => a.path.localeCompare(b.path));
for (const r of rows) console.log(`${r.sha}  ${r.bytes}\t${r.path}`);
const total = createHash("sha256");
for (const r of rows) total.update(`${r.sha}  ${r.bytes}\t${r.path}\n`);
console.log(`# ${rows.length} inputs; manifest sha256 ${total.digest("hex").slice(0, 16)}`);
