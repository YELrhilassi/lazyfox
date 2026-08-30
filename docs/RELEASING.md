# Releasing Lazyfox

Two long-lived branches, with a strict rule:

- **`dev-nightly`** (and any feature branches) — the latest **unsigned** build.
  All source + generated dev artifacts live here. This is where you work.
- **`master`** — the **AMO-signed release**. Pushed only by `npm run ship`;
  CI never writes to it.

**The whole release is ONE command:** `npm run ship`, run from a dev branch.

---

## The complete release, end to end

There are only three commands in the whole flow:

```
npm run bump -- 0.5.7        # (1) start a version: bump everywhere at once
npm run submit               # (2) publish that version to AMO, rebuild dev installers
   …… wait for AMO review/signing ……
npm run ship                 # (3) the release: merge to master, sync signed xpi,
                             # rebuild release installers, tag, GitHub Release
```

### 1 · `npm run bump -- X.Y.Z`

Updates the version in every tracked place at once (`package.json`,
`package-lock.json`, `src/static/extension/manifest.json` — the manifest source
of truth — and the chrome helper's `CHROME_HELPER_VERSION`). Nothing else to
remember.

### 2 · `npm run submit`

Packs the fresh **unsigned** build, uploads it to addons.mozilla.org as a
**listed** version (which starts the review clock), and rebuilds the dev
installer binaries. Requires `AMO_API_KEY` / `AMO_API_SECRET` (a gitignored
`.env`). Refuses to re-submit a version that already exists.

**AMO does not sign at upload.** A listed version is only signed after a
reviewer approves it. Wait for that before `ship`.

### 3 · `npm run ship`

The release. Run from any dev branch (on release day this is `dev-nightly`).
It does everything, in order, and stops with a clear message on the first
problem:

1. **Guards:** clean tree, you're on a non-master branch, AMO creds, `gh`
   available, and the version is not already tagged.
2. **Signed?** Read-only AMO API check that the version's signed xpi exists. If
   AMO is still reviewing, it stops here — you have not touched git yet.
3. **Merge:** fast-forwards master, then merges your dev branch into master with
   `-X theirs`. That resolves **every** conflict — source *and* generated
   `dist/`/installers — in your dev branch's favor. Master becomes "latest dev
   source, exactly", with no manual conflict resolution ever.
4. **Build release:** syncs the AMO-**signed** xpi for that version, rebuilds the
   release-mode `dist/` bundles, and rebuilds the release installers
   (`installer/bin/lazyfox-install-{linux,darwin,windows.exe}`).
5. **Verify:** `check-dist`, installer tests, and confirms the committed xpi is
   signed and the right version.
6. **Commit + tag + push:** commits on master, tags `v<version>`, pushes master
   and the tag.
7. **GitHub Release:** creates the public release via `gh` with the three
   installers and the signed xpi as assets.

Nothing — not CI, not a workflow — writes back, tags, or publishes. Every write
is this one command, committing to master with the signed artifacts.

---

## How the branches stay consistent

Because `ship` merges `-X theirs`, master is always "the latest dev source +
whatever the release added". The *only* things that make master different from
dev are exactly what the release puts there:

- the **signed** xpi (`dist/lazyfox2-<ver>.xpi` + `-signed.xpi`), and
- the **release** installers (`installer/bin/lazyfox-install-*`, embedding the
  signed add-on).

Everything else — source, `dist/` bundles, `src/static/` — is copied from dev
verbatim. So merging forward is deterministic and never conflicts (verified in a
scratch clone).

## Workflows (all read-only)

| File | Trigger | Purpose |
|------|---------|---------|
| `dev-nightly.yml` | push / PR to `dev-nightly` | Compile the unsigned dev build + unit tests + dist check. |
| `master.yml` | push to `master` | Compile release-mode sources (offline — reuses the committed signed xpi) + unit tests. |

Neither workflow has AMO secrets, and neither pushes, tags, or creates a
release. Releases are created by `npm run ship`, exactly once.

## Why the old flow went away

The previous flow had CI build *and* commit-back the signed xpi, which:
- caused non-fast-forward master pushes and `github-actions[bot]` permission
  failures (the release step needed `contents: write` just to tag),
- required you to resolve generated-`dist/` merge conflicts by hand when any dev
  work had landed between releases, and
- split the release across several commands (`build`, `build:release`,
  `build:installers`, a manual `git push`, a `workflow_dispatch` …).

`npm run ship` collapses all of that: one command, deterministic merge, read-only
CI, no permission gymnastics.

## Version semantics

- The dev manifest (`src/static/extension/manifest.json`) is the **source of
  truth**; `npm run build` propagates it into `dist/extension/`.
- The branch the release is run from carries the version to be released.
  `ship` refuses to run for an already-tagged version.
- Both the extension and the chrome helper report their own versions (bumped
  together by `npm run bump`).

## Installer binaries — dev vs release

| Binary | Embedded payload | Built by |
|--------|------------------|----------|
| `installer/bin/lazyfox-install-{linux,darwin,windows.exe}` | **signed** xpi | `npm run ship` (release) |
| `installer/bin/lazyfox-install-dev-{linux,darwin,windows.exe}` | **unsigned** xpi | `npm run submit` (dev) |

## CLI reference

| Command | When to use | What it does for you |
|---------|-------------|----------------------|
| `npm run bump -- X.Y.Z` | Start a new version | Bump version everywhere at once. |
| `npm run build` | Daily dev | Unsigned dev build + xpi. |
| `npm run dev-install` / `dev-install:clean` | Daily dev | Build + install the unsigned build into a fresh Nightly/Dev profile. |
| `npm run submit` | Publish a version to AMO | Uploads the unsigned build as a listed version + rebuilds dev installers. |
| `npm run ship` | **Release** (after AMO signs) | Merge to master, sync signed xpi, rebuild release installers, tag, push, GitHub Release. |
| `npm run ci` | Before pushing | Run the local CI (compile + unit suite). |
| `npm test` / `npm run verify` | Quick check | Unit suite / typecheck+suite. |
| `npm run clean` | Free-space/rebuild | Remove regenerable build products. |