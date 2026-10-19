// The version link: one version, every carrier, compared.
//
// WHAT THIS EXISTS FOR. The version of Lazyfox is written down in eight places —
// the npm package, the extension manifest (source and built), the chrome helper
// constant, the Go core, the installer window's own package, and the payload
// record of every committed installer binary. Nothing compared them, so they
// drifted: at the time this file was written `installer/frontend/package.json`
// said 0.5.7 while the extension it installed, the manifest it shipped and the
// signed payload it embedded all said 0.5.8 — and `npm run check` was green,
// because a version is not a payload byte.
//
// A version is how a user answers "what did I just install?", and for an
// installer it is also the honest answer to "what is in this binary?" — the
// window now shows it (read from the embedded xpi) and the CLI prints it. So a
// carrier that disagrees is not a cosmetic problem: it is the installer telling
// two different stories.
//
// The source extension manifest is the declared source of truth (scripts/
// bump-version.ts discovers the current version from it), so everything else is
// compared against that rather than against a number written here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readState } from "../payload.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function readJson(rel: string): Record<string, unknown> | null {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The version every other carrier is measured against. */
function truthVersion(): string {
  const m = readJson("src/static/extension/manifest.json");
  const v = m?.version;
  assert.equal(typeof v, "string", "src/static/extension/manifest.json must carry a version");
  return v as string;
}

/** One carrier: where the version is written, and what it says there. */
type Carrier = { what: string; version: string | null };

function carriers(): Carrier[] {
  const out: Carrier[] = [];
  const truth = truthVersion();

  const pkg = readJson("package.json");
  out.push({ what: "package.json", version: (pkg?.version as string) ?? null });

  const lock = readJson("package-lock.json");
  out.push({ what: "package-lock.json", version: (lock?.version as string) ?? null });
  const lockRoot = (lock?.packages as Record<string, { version?: string }> | undefined)?.[""];
  out.push({ what: "package-lock.json packages[\"\"]", version: lockRoot?.version ?? null });

  out.push({ what: "src/static/extension/manifest.json", version: truth });

  // dist/ is a build product and may legitimately be absent (a Go-only
  // checkout); when it exists it must agree, which is the check that catches
  // "bumped the source manifest, forgot to rebuild".
  const distManifest = readJson("dist/extension/manifest.json");
  if (distManifest) out.push({ what: "dist/extension/manifest.json", version: (distManifest.version as string) ?? null });

  // The installer window's own package. This is the carrier that drifted.
  const ui = readJson("installer/frontend/package.json");
  out.push({ what: "installer/frontend/package.json", version: (ui?.version as string) ?? null });
  const uiLock = readJson("installer/frontend/package-lock.json");
  if (uiLock) {
    out.push({ what: "installer/frontend/package-lock.json", version: (uiLock.version as string) ?? null });
    const uiLockRoot = (uiLock.packages as Record<string, { version?: string }> | undefined)?.[""];
    out.push({ what: "installer/frontend/package-lock.json packages[\"\"]", version: uiLockRoot?.version ?? null });
  }

  // Two carriers live in source code rather than in JSON.
  const alive = readFileSync(join(ROOT, "src/chrome/alive.ts"), "utf8");
  const helper = /CHROME_HELPER_VERSION\s*=\s*"([^"]+)"/.exec(alive);
  out.push({ what: "src/chrome/alive.ts CHROME_HELPER_VERSION", version: helper?.[1] ?? null });

  const corePath = join(ROOT, "core/js/main.go");
  if (existsSync(corePath)) {
    const core = /const version\s*=\s*"([^"]+)"/.exec(readFileSync(corePath, "utf8"));
    out.push({ what: "core/js/main.go const version", version: core?.[1] ?? null });
  }

  return out;
}

describe("the version link", () => {
  test("every carrier in the repo agrees", () => {
    const truth = truthVersion();
    const wrong = carriers().filter((c) => c.version !== truth);
    assert.deepEqual(
      wrong.map((c) => `${c.what} says ${JSON.stringify(c.version)}`),
      [],
      `every version carrier must say ${truth} — run \`npm run bump -- ${truth}\` after bumping dist/, or fix the carrier by hand`,
    );
  });

  test("every carrier is actually present", () => {
    // A carrier that silently stopped being written (a renamed field, a manifest
    // rewritten by hand) would pass the comparison above by being absent.
    for (const c of carriers()) {
      assert.notEqual(c.version, null, `${c.what} must carry a version`);
    }
  });

  test("every committed installer records the version it embeds", () => {
    const truth = truthVersion();
    const binaries = readState(ROOT).binaries;
    const dev = Object.values(binaries).filter((b) => b.out.includes("-dev-"));
    assert.ok(dev.length > 0, "the dev installers must be recorded in installer/bin/payload-state.json");

    for (const b of dev) {
      assert.equal(
        b.xpiVersion,
        truth,
        `${b.out} embeds ${b.xpi} (add-on ${b.xpiVersion}) while the tree is ${truth} — rebuild the installers`,
      );
      assert.ok(b.source, `${b.out} must record the source fingerprint it was built from`);
    }
  });

  test("the window never hardcodes a version", () => {
    // The installer's window shows the version it will install, read from the
    // embedded xpi (payload.AddonVersion). A literal here would be a second
    // answer that nobody bumps, which is how the drift above started — so this
    // refuses one, in every file the window is built from.
    //
    // lib/mock.ts is exempt and named deliberately: it is the fixed machine the
    // window is designed against in a browser tab, it is dropped from production
    // builds by `import.meta.env.DEV`, and its whole job is to be inert.
    const dir = join(ROOT, "installer", "frontend", "src");
    const offenders: string[] = [];
    const walk = (d: string, prefix: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const rel = `${prefix}/${e.name}`;
        if (e.isDirectory()) {
          walk(join(d, e.name), rel);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(e.name) || rel === "src/lib/mock.ts") continue;
        const text = readFileSync(join(d, e.name), "utf8");
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          if (/\d+\.\d+\.\d+/.test(line)) offenders.push(`${rel}:${i + 1}`);
        }
      }
    };
    if (existsSync(dir)) walk(dir, "src");
    assert.deepEqual(offenders, [], "a version in the window's source is a second source of truth — read it from State");
  });
});
