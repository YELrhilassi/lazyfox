# Releasing Lazyfox

> **Design note.** This repo's release flow is an instance of a reusable
> pattern — the “one-command, read-only-CI” release. If you want to *understand*
> why it is built this way and reapply it to another project, read
> **`docs/RELEASE-WORKFLOW-PATTERN.md`** (written agnostically). This page is the
> concrete, Lazyfox-specific playbook.

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

And, anytime you want to refresh the **dev channel** (no AMO, no master, no
review) — so Developer Edition / Nightly users get the newest build from the
setup page:

```
npm run build && npm run build:installers   # unsigned xpi + dev installers
npm run ship:nightly                        # (re)publish the `nightly` prerelease
```

`ship:nightly` updates the rolling GitHub prerelease tagged `nightly` in place
with the dev installers and the unsigned xpi. It is completely independent of
the signed release: it never touches `master`, never needs AMO, and is safe to
run as often as you like. The setup page points Developer Edition / Nightly at
this prerelease and stable Firefox at `releases/latest`.

### 1 · `npm run bump -- X.Y.Z`

Updates the version in every tracked place at once (`package.json`,
`package-lock.json`, `src/static/extension/manifest.json` — the manifest source
of truth — and the chrome helper's `CHROME_HELPER_VERSION`). Nothing else to
remember.

### 2 · `npm run submit`

Packs the fresh **unsigned** build, uploads it to addons.mozilla.org as a
**listed** version (which starts the review clock), and rebuilds the dev
installer binaries. Requires `AMO_API_KEY` / `AMO_API_SECRET`, from the
environment or from a gitignored `.env` **at the repo root** (copy
`.env.example`); an exported variable wins over the file. Refuses to re-submit
a version that already exists.

**AMO does not sign at upload.** A listed version is only signed after a
reviewer approves it. Wait for that before `ship`.

### 3 · `npm run ship`

The release. Run from any dev branch (on release day this is `dev-nightly`).
It does everything, in order, and stops with a clear message on the first
problem:

1. **Guards:** clean tree, you're on a non-master branch, AMO creds, `gh`
   available, the version is not already tagged, and — since the merge brings
   this branch's `.github/workflows/` files onto master — that the git credential
   may push them. GitHub rejects a push that adds or updates a workflow file when
   it is authenticated with an OAuth token lacking the `workflow` scope, with one
   documented exemption: content that already exists, byte for byte, on another
   branch of the same repository — which is what a merge from an already-pushed
   dev branch is. Ship checks both halves (scopes from the token's own header,
   exemption by comparing blobs against the remote's branches) and checks them
   HERE, before it touches anything, because the push is the last thing it does:
   new workflow content plus a scoped-out token stops the release, while exempt
   content is only a warning. Either way the remedy it prints is
   `gh auth refresh -h github.com -s workflow`; `LF_SKIP_PUSH_SCOPE_CHECK=1`
   skips the check for a credential git pushes with that `gh` does not report.
2. **Signed?** Read-only AMO API check that the version's signed xpi exists. If
   AMO is still reviewing, it stops here — you have not touched git yet.
3. **Push the branch being merged:** pushes your dev branch FIRST, before
   anything is merged or tagged. The commit master is about to gain is a merge,
   so it names both parents — a master referencing a commit that exists only on
   this machine is a history nobody else can resolve. A dry run asks the remote
   first, so a branch that has moved on since your checkout stops the release
   here, with nothing merged, built or tagged, and a fix that is a merge away.
4. **Merge:** fast-forwards master, then merges your dev branch into master with
   `-X theirs`. That resolves **every** conflict — source *and* generated
   `dist/`/installers — in your dev branch's favor. `scripts/ship-merge.ts` also
   settles the two shapes a merge strategy cannot resolve on its own (conflicting
   binary files, and modify/delete) by the same rule, so master becomes "latest
   dev source, exactly" with no manual conflict resolution ever.
5. **Build release:** syncs the AMO-**signed** xpi for that version, rebuilds the
   release-mode `dist/` bundles, and rebuilds the release installers
   (`installer/bin/lazyfox-install-{linux,darwin,windows.exe}`).
6. **Verify:** `check-dist`, installer tests, and confirms the committed xpi is
   signed and the right version.
7. **Commit + tag + push:** commits on master, tags `v<version>`, pushes master
   and the tag. The dev branch itself went up in step 3, so both parents of the
   merge commit are on the remote.
8. **GitHub Release:** creates the public release via `gh` with the three
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
| `dev-nightly.yml` | **manual** (`workflow_dispatch`) | The same pipeline `npm run ci` runs: committed artifacts up to date → unsigned dev build (`LF_SKIP_INSTALLERS=1`) → four typechecks → full test suite → artifacts still consistent. |
| `installers.yml` | **manual** (`workflow_dispatch`) | Builds every committed installer on its own OS (the macOS/Linux windows need CGO + the platform webview, so a Linux runner cannot produce them) and verifies the binaries it just built before uploading them as artifacts. It never writes to the repo. Builds locally with `npm run build`; this is the cross-platform proof. |
| `master.yml` | push to `master` | Compile release-mode sources (offline — reuses the committed signed xpi) + unit tests. |

A dev push therefore spends **no runner at all**: both dev-side workflows are
manual (`workflow_dispatch`), and the only push-triggered workflow is
`master.yml`, which runs once per release. Everything else in this file is a
local command, which is why `npm run ci` exists: it is the same sequence, on
your machine, before the push.

**What the runners cost: nothing.** This repository is public, and standard
GitHub-hosted runner minutes are free in a public repository — they are not
drawn from the account's included minutes, which apply to private repositories
(larger runners are the only paid kind, and no workflow here uses one). The
reason the dev pipelines are manual is turnaround time, not minutes.

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

| Binary | Channel | Embedded payload | Targets | Built & published by |
|--------|---------|------------------|---------|----------------------|
| `installer/bin/lazyfox-install-{linux,darwin,windows.exe}` | **stable** | **signed** xpi | stable / ESR | `npm run ship` → GitHub Release (`releases/latest`) |
| `installer/bin/lazyfox-install-dev-{linux,darwin,windows.exe}` | **nightly** | **unsigned** xpi | Developer Edition / Nightly | `npm run build:installers` + `npm run ship:nightly` → `nightly` prerelease |

The installer auto-detects the Firefox of its channel, the profile that Firefox
is actually using (no prompting), and falls back to a dedicated Lazyfox-owned
profile if the user's own cannot be used. See `docs/INSTALLER-ANALYSIS.md`.

## CLI reference

| Command | When to use | What it does for you |
|---------|-------------|----------------------|
| `npm run bump -- X.Y.Z` | Start a new version | Bump version everywhere at once. |
| `npm run build` | Daily dev | Unsigned dev build + xpi. |
| `npm run dev-install` / `dev-install:clean` | Daily dev | Build + install the unsigned build into a fresh Nightly/Dev profile. |
| `npm run submit` | Publish a version to AMO | Uploads the unsigned build as a listed version + rebuilds dev installers. |
| `npm run ship` | **Release** (after AMO signs) | Merge to master, sync signed xpi, rebuild release installers, tag, push, GitHub Release. |
| `npm run ship -- --rehearse` | **Before** `npm run ship` | Run every guard, the AMO signing check, the master merge and the release build in a scratch worktree; publishes nothing. |
| `npm run ship:release` | Recovery | Re-create the GitHub Release page for the current version, when master and the tag are already pushed. |
| `npm run ship:nightly` | **Dev channel refresh** (any time) | (Re)publish the rolling `nightly` prerelease with the dev installers + unsigned xpi. No AMO, no master. |
| `npm run ci` | Before pushing | Run the local CI (compile + unit suite). |
| `npm test` / `npm run verify` | Quick check | Unit suite / typecheck+suite. |
| `npm run clean` | Free-space/rebuild | Remove regenerable build products. |

## Rehearsing a release

`npm run ship` is deliberately all-or-nothing: it merges the dev branch into
master and rebuilds every artifact before it can discover that something is
wrong, and by then the expensive state exists. `npm run ship -- --rehearse` runs
the same release against a scratch `git worktree` and prints one table — every
guard, the AMO signature check, the master merge, the release build, the artifact
checks — then a verdict.

It never checks out master in your checkout, commits, tags, pushes or creates a
release; the merge commit and the rebuilt artifacts live only in the scratch
worktree, which is removed when the run ends (including on failure). It proves
that rather than promising it: HEAD and the working tree are compared before and
after, and a difference is reported as a bug in the rehearsal.

The checks live in `scripts/ship-checks.ts` and the merge in
`scripts/ship-merge.ts` — the same code the real release runs, because a
rehearsal with its own copy of a rule can disagree with the thing it rehearses.
That merge is worth knowing about: `-X theirs` resolves conflicting *hunks*, and
this repository also produces binary and modify/delete conflicts (master tracked
`build/native-host/lazyfox-host`, which the dev branch deleted), which the
strategy option cannot settle. `ship-merge.ts` applies the same policy to what is
left and completes the merge commit.

If the GitHub Release page fails after master and the tag are already pushed,
`npm run ship` cannot finish it (it would stop at "already tagged");
`npm run ship:release` creates just that page from the same asset list.