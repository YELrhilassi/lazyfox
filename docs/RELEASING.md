# Releasing Lazyfox

This repo has two long-lived branches that own different adds:

- **`dev-nightly`** — the latest **unsigned** build. `npm run build` produces
  an unsigned xpi that devs install straight into Firefox
  Nightly/Developer Edition (`npm run install` — a persistent install, no manual
  “Add” click).
- **`master`** — the **last AMO-signed** version. Regular users and GitHub
  Releases use master.

**The branch determines signed-vs-unsigned.** The version always lives in
`dist/extension/manifest.json`; nothing in the build tools hardcodes it.

---

## The release loop

1. **Develop on `dev-nightly`.** `npm run build` builds an unsigned xpi and
   `npm run install` (or `npm run install:clean` to wipe stale dev profiles
   first) installs it persistently into Nightly/Devedition.
2. When the next version is stable, **bump `dist/extension/manifest.json`** on
   `dev-nightly` (e.g. to `0.5.4`). Development now targets that “next” version.
3. **Publish from `dev-nightly`**: `node scripts/amo-sign.mjs` submits that
   version to AMO (requires `AMO_API_KEY` / `AMO_API_SECRET`).
4. **Wait for AMO review + signing.** AMO only auto-signs *listed* versions
   after approval.
5. **Sync the signed xpi down to `master`.** Once reviewing is complete, re-run
   the master workflow (a push to master, or `workflow_dispatch`). It derives the
   version from the manifest, downloads the AMO-signed xpi for that exact version
   via `scripts/sync-signed-xpi.mjs`, commits it back as
   `dist/lazyfox2-<ver>.xpi` + `-signed.xpi`, embeds it in the release installers,
   and (on a manual release run) tags + drafts a GitHub Release.

### Version semantics

- **Dev manifest** (`dev-nightly`) is the *next* unsigned version, e.g. `0.5.4`.
- **Master manifest** (`master`) matches the *last AMO-signed* version, e.g.
  `0.5.3`.

This is why the branches carry different versions: master always points at a
version that is already signed, so a fresh clone can rebuild the installer
offline (it reuses the committed signed xpi) without needing AMO credentials.

---

## Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| `.github/workflows/master.yml` | push to `master`; manual release via `workflow_dispatch` | Build + release: sync signed xpi from AMO, commit it back, verify dist + installer, tag + GitHub Release. |
| `.github/workflows/dev-nightly.yml` | push to `dev-nightly` | Auto-test the **unsigned** dev build on Firefox Nightly (BiDi). |
| `.github/workflows/nightly.yml` | push to `dev-nightly` | Another Nightly CI pass (unsigned dev build), including the installer tests. |

All three derive the version from `dist/extension/manifest.json`; there are no
hardcoded versions.

---

## Signing vs. syncing

- `scripts/amo-sign.mjs` — **submits a new version** to AMO and downloads the
  freshly signed xpi. Used by step 3 above.
- `scripts/sync-signed-xpi.mjs` — **downloads the signed xpi for an exact,
  already-submitted version** and writes both the plain and `-signed` artifacts.
  Used by the master workflow (`RELEASE=1`). It is deterministic: it reuses the
  committed signed xpi when already current, and otherwise fetches the exact
  version from AMO (refusing to guess or fabricate an unsigned one).

## Installer binaries — dev vs release

Two families of per-OS installer binaries live in `installer/bin/`, embedding
different extension payloads:

| Family | Binary names | Embedded payload | Built by |
|--------|--------------|------------------|----------|
| **Release** | `lazyfox-install-{linux,darwin,windows.exe}` | AMO-**signed** xpi | `npm run build:release` |
| **Dev** | `lazyfox-install-dev-{linux,darwin,windows.exe}` | **unsigned** xpi | `npm run build:installers` |

The dev binaries are committed (like the release ones), so a fresh clone has a
working dev installer with no Go toolchain. Dev scripts call
`ensureDevInstaller()` which resolves the committed per-OS dev binary for the
current platform, only building a host-form fallback on an uncovered host.

## CLI reference

| Script | Output |
|--------|--------|
| `npm run build` | **Dev** build (default): wasm + bundles + unsigned xpi; fast, no AMO. |
| `npm run build:release` | **Signed** release: syncs the AMO-signed xpi down (via `sync-signed-xpi.mjs`), rebuilds the 3 per-OS release installer binaries (`lazyfox-install-*`). Used by master CI. |
| `npm run build:installers` | Rebuild the 3 per-OS **dev** installer binaries (`lazyfox-install-dev-*`, unsigned embed). |
| `npm run install` | Build + install the fresh dev build into Nightly/Devedition (new profile, default-profile set). |
| `npm run install:clean` | Same as `install`, but first wipes stale dev profiles. |
| `npm run clean` | Remove regenerable build products (wasm, wasm embed, staged payloads) so the next build is a full rebuild. |
| `npm run verify` | `typecheck` + full `test` suite, in one shot. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Go core tests + installer tests + dist completeness. |

**Dev install flow:** `npm run install` (or `npm run install:clean`), which
builds the unsigned xpi and installs it, resolving the committed dev installer
binary for your platform.