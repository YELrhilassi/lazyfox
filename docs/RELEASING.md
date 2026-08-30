# Releasing Lazyfox

This repo has two long-lived branches that own different adds:

- **`dev-nightly`** — the latest **unsigned** build. `npm run build` produces
  an unsigned xpi that devs install straight into Firefox
  Nightly/Developer Edition (`npm run dev-install` — a persistent install, no manual
  “Add” click).
- **`master`** — the **last AMO-signed** version. Regular users and GitHub
  Releases use master.

**The branch determines signed-vs-unsigned.** The version always lives in
`dist/extension/manifest.json`; nothing in the build tools hardcodes it.

---

## The release loop

1. **Develop on `dev-nightly`.** `npm run build` builds an unsigned xpi and
   `npm run dev-install` (or `npm run dev-install:clean` to wipe stale dev
   profiles first) installs it persistently into Nightly/Devedition.
2. When the next version is stable, **bump `dist/extension/manifest.json`** on
   `dev-nightly` (e.g. to `0.5.4`). Development now targets that “next” version.
3. **Submit from `dev-nightly`**: `npm run submit` packs the fresh unsigned xpi,
   uploads it to AMO as a **listed** (public) version, and rebuilds the dev
   installer binaries. Requires `AMO_API_KEY` / `AMO_API_SECRET` (in a
   gitignored `.env`). It refuses to re-submit a version that already exists.
4. **Wait for AMO review + signing.** AMO only *signs* listed versions after a
   reviewer approves them — submission does not sign the xpi immediately.
5. **Sync the signed xpi down to `master`.** Once reviewing is complete, run
   `npm run build:release` (or the master workflow via `workflow_dispatch`). It
   derives the version from the manifest, downloads the AMO-signed xpi for that
   exact version via `scripts/sync-signed-xpi.mjs`, commits it back as
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
| `.github/workflows/dev-nightly.yml` | push / PR to `dev-nightly` | Auto-test the **unsigned** dev build: unit tests + installer tests + BiDi e2e on Firefox Nightly. |

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

| Script | When to use | Output |
|--------|-------------|--------|
| `npm run build` | **Daily dev on dev-nightly.** | **Unsigned** dev build: wasm + bundles + `dist/lazyfox2-<ver>.xpi`, fast, no AMO. |
| `npm run submit` | **Publish a new version to AMO** (from dev-nightly). | Packs the fresh build, uploads it to AMO as a listed version (starts the review clock), rebuilds the dev installers. Needs `AMO_API_KEY`/`SECRET`. |
| `npm run build:release` | **Master release only** — after AMO has signed the version. | Syncs the AMO-signed xpi down (via `sync-signed-xpi.mjs`), rebuilds the release installers (`lazyfox-install-*`). Fails with a clear message (no stack trace) if that version isn't signed yet. |
| `npm run build:installers` | After a dev build, to refresh the portable dev installers. | Rebuilds `installer/bin/lazyfox-install-dev-*` (unsigned embed). |
| `npm run dev-install` | Try the latest dev build in Nightly/Devedition. | Build + install the fresh unsigned build into a new profile (default-profile set). |
| `npm run dev-install:clean` | Same as `dev-install` but wipe stale dev profiles first. | |
| `npm run clean` | Before a full rebuild. | Removes regenerable build products (wasm, wasm embed, staged payloads). |
| `npm run verify` | One-shot check. | `typecheck` + full `test` suite together. |
| `npm run typecheck` | Quick TS check. | `tsc --noEmit`. |
| `npm run test` | Full unit suite. | Go core tests + installer tests + dist completeness. |

**Dev install flow:** `npm run dev-install` (or `npm run dev-install:clean`),
which builds the unsigned xpi and installs it, resolving the committed dev installer
binary for your platform.

**If `npm run build:release` fails with “the AMO-signed xpi … is not available
yet”**: that is expected on dev-nightly — that command is only for the master
release path, after `npm run submit` + AMO review. You almost certainly want
`npm run build` (unsigned dev build) or `npm run submit` (to publish a new
version) instead.