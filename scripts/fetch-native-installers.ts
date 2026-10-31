#!/usr/bin/env node
// Download the native-builds workflow artifacts and overlay them into
// installer/bin/ by hand, outside of a release:
//
//   npm run native:fetch -- --release        latest release-mode run (dispatches one)
//   npm run native:fetch -- --dev            latest dev-mode run (dispatches one)
//   npm run native:fetch -- --release --run <id>   a specific finished run
//
// `npm run ship` does all three steps itself (dispatch, wait, overlay); this is
// the way to pull native binaries in without shipping — e.g. to refresh the
// committed installers after fixing the pipeline on CI, or to get a working
// Linux AppImage into the tree before the next release.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  dispatchNativeBuilds,
  downloadNativeArtifacts,
  overlayNativeInstallers,
  rmStaging,
  waitNativeRun,
} from "./native-installers.ts";
import { ROOT } from "./payload.ts";

const argv = process.argv.slice(2);
const release = argv.includes("--release");
const dev = argv.includes("--dev");
const runIdx = argv.indexOf("--run");
const runId = runIdx !== -1 ? Number(argv[runIdx + 1]) : null;
// The ref the workflow is dispatched against ("HEAD" by default reads oddly to
// the API — it wants a real ref name — so this points the dispatch at master,
// the only branch the release build is meant to run on).
const refIdx = argv.indexOf("--ref");
const ref = refIdx !== -1 ? argv[refIdx + 1] : "HEAD";

const self = fileURLToPath(import.meta.url);
if (process.argv[1] !== self && !process.argv[1]?.endsWith("fetch-native-installers.ts")) {
  // Imported as a module (tests): do nothing.
  process.exit(0);
}

if (release === dev) {
  console.error("pick exactly one of --release / --dev");
  process.exit(2);
}

try {
  let id: number;
  if (runId && Number.isFinite(runId)) {
    id = runId;
    console.log(`[native] using the requested run ${id}`);
  } else {
    dispatchNativeBuilds(ROOT, { release, ref });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    console.log(`[native] dispatched the native builds (${sha.slice(0, 12)}) — waiting…`);
    id = (await waitNativeRun(ROOT, sha)).databaseId;
  }
  downloadNativeArtifacts(ROOT, id);
  const { plugins, state } = overlayNativeInstallers(ROOT);
  rmStaging(ROOT);
  console.log(`\n[native] overlaid ${plugins.length} installer file(s):\n  ${plugins.join("\n  ")}`);
  console.log(`[native] state entries rewritten: ${state.length}`);
  console.log("[native] next: npm run check (proves every committed binary against the tree)");
} catch (e) {
  console.error(`\n[native] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
