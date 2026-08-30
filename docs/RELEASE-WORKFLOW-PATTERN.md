# The "one-command, read-only-CI" release pattern

> This document describes the release flow this repo uses, written **agnostically**
> so it can be lifted into another project — it does not assume Lazyfox, AMO,
> Firefox, Go, or GitHub except where they are named as concrete examples. The
> *principles* are what matter; swap the tools for yours.

## The problem every release flow has

Software that ships in any kind of signed / reviewed / store-bound form (a
signed add-on, a notarized app, an App Store build, a tagged npm release…) needs
a moment where **developmental state** ("here's the newest thing I built") and
**releasable state** ("here's the last thing I signed and shipped") come together.
Naively automating this produces a very common set of injuries:

- **CI writes back to the branch it runs on** — a workflow commits, pushes a tag,
  or "fixes up" master. The moment the expected permissions or the branch state
  change, the push fails (403), branches stop fast-forwarding, and a simple
  release becomes an incident.
- **Generated artifacts turn merges into conflicts.** If both branches carry
  build output (`dist/`, binaries, bundles) and they build differently per
  branch, a routine "bring development into master" merge explodes with
  conflicts that a human has to unpick every single time.
- **The release is split across many hand-typed commands.** "build, then
  release, then push, then tag, then publish" forces trust in a checklist, not
  in a tool. A missed step or an out-of-order command silently produces a
  half-done release.
- **CI is relied on to *create* the release.** Kitchen-sink workflows that
  build, sign, and publish are slow, need every secret, and are the hardest kind
  of thing to reproduce locally or debug.

The pattern below removes each of those. It has two parts: a **branch model**
that makes "development" vs "released" explicit and cheap, and a **single
release command** that does the merge + build + tag + publish in one runnable,
deterministic step — with CI reduced to read-only verification.

---

## Part 1 — The branch model

Use (at least) two long-lived branches with a strict rule:

- **`dev`** (or `main`/the branch you actually work on) — always the newest.
  All source, and any generated artifacts that development mode produces.
- **`release`** (or `master`) — the last *published* state. **Only the release
  command ever writes to it.** Human commits to `release` are forbidden.

The invariant you want is:

> **`release` = `dev`'s source + exactly the artifacts the release step adds.**

This is the key idea. If `release` is *only ever* that — never "`dev` source
plus manually tweaked bits" — then updating it is deterministic and conflict-free
no matter how many releases you do.

Two corollaries that make this hold:

1. **All real work — including release tooling — is authored on `dev` first.**
   The workflows, scripts, and docs are the same files on both branches. When
   you change the release tooling, it changes on `dev` and flows to `release`
   through the same release step as everything else. There is never a
   "let me patch the workflow on `release` only" moment.

2. **Generated artifacts on `release` are rebuilt from `dev`'s source every
   time** — never hand-edited. Whatever the release build regenerates (dist
   bundles, binaries, installers) is discarded-and-redone as part of the release,
   so the only persistent difference `release` carries is the thing the
   *publishing* step adds (a signed package, a tag pointing at the signed
   artifact, release installers…).

### Why this kills merge conflicts for good

When `dev` has moved forward and `release` still points at the previous release,
bringing `dev` into `release` is a normal three-way merge — *except* that the
build outputs in `dist/` type paths differ between the two branches. That is a
conflict sitting there every single time.

The fix has two layers:

- **Prefer the incoming side for the whole merge:** merge with `-X theirs`
  (git's "resolve every conflict in favor of the branch being merged in"). Run
  from `release`, merging `dev` in, `-X theirs` takes `dev`'s version of
  everything — source *and* generated output. That is correct because `release`
  has no original source of its own; it is meant to become `dev`'s source.
  This resolves content conflicts, binary conflicts, *and* modify/delete cases
  without a human in the loop.
- **Rebuild the generated output on `release` immediately after the merge.**
  Even though the merge copied `dev`'s `dist/` over, the release step then
  rebuilds `dist/` in *release mode*. So the committed `dist/` on `release` is
  the release-mode output, and the next merge just copies `dev`'s (dev-mode)
  output over it and rebuilds again. Deterministic, repeatable.

> `-X theirs` is safe here *because of the invariant above.* If `release`
> ever grew its own hand-committed changes that `dev` lacked, `-X theirs` would
> silently discard them. The rule "only the release command writes to `release`,
> and it rebuilds everything generated" is what makes that safe. Enforce it.

### Mentally: where does each artifact live?

| Category | On `release` | Source of truth |
|----------|--------------|-----------------|
| Source (`src/`, config, docs, workflows) | copied from `dev` | `dev` |
| Generated dev-mode output (`dist/`, bundles) | copied from `dev`, then rebuilt in release mode | `dev` source + release build |
| The signed / published artifact (signed xpi, notarized app, build tarball) | **added by the release step only** | the release command |
| A release tag (`vX.Y.Z`) | created by the release step | the release command |

---

## Part 2 — The single release command

Expose **one** developer-facing command (e.g. `npm run ship`) that performs the
whole release from start to finish, in order, stopping with a clear message on
the first problem. Split it into two clearly-named files/steps if the "publish
new version" half and the "release after review" half can't happen in one sitting
(the Lazyfox case is: `submit` uploads for review, later `ship` does the
release). The point is that each half is *one command*, not a checklist.

A well-designed release command should:

1. **Guard up front.** Refuse to run unless:
   - the working tree is clean,
   - you are on the `dev` branch (never `release`),
   - any required credentials are present,
   - any required CLI tools are installed,
   - and the version to release is not **already** tagged/released (so you
     can't accidentally republish).
   Fail *before* touching git state.

2. **Check the publish target is actually ready — read-only.** For a
   signed/reviewed release, query the publishing service read-only to confirm
   the version you're about to release is signed/approved. If it isn't, stop
   here: nothing about git has changed yet, so re-running later is cheap and
   safe. This removes the "run it too early and half-break everything" failure.

3. **Fetch, switch to `release`, fast-forward to the shared base.** Bring
   `release` up to the published state so the merge below starts from a known
   point.

4. **Merge `dev` into `release` with `-X theirs`.** No human conflict
   resolution, ever. `release` becomes `dev`'s source exactly.

5. **Run the release build.** Rebuild `dist/` in release mode, fetch/sync the
   signed artifact for the exact version, rebuild the packaging (release
   installers, binaries). Every generated file is produced fresh here.

6. **Verify before committing.** Run the completeness and, if applicable,
   signature checks: confirm the to-be-shipped artifact is present, correct
   version, correctly signed. If any verification fails, stop — don't publish a
   known-bad build.

7. **Commit, tag, push.** Commit the release artifacts on `release`, create the
   annotated tag `vX.Y.Z`, push `release` and the tag.

8. **Create the public release.** Push the release to the distribution channel
   (GitHub Release, store, registry…) with the packaged artifacts attached.

9. **Return the repo to the `dev` branch.** Leave the developer where they
   started, since the whole point of one command is that they don't have to
   babysit branch switching.

### Where writing happens — and why that's the design

Every mutation — the merge commit, the release-artifact commit, the tag, the
push, the published release — happens **inside this one command, while the
developer is at the keyboard, with the right credentials**. CI is never given
the authority or the secret to do any of it. That is a deliberate trade:

- **Reproducibility:** you can run `ship` locally, watch exactly what it does,
  and step in if something looks wrong. CI builds you can only observe after the
  fact.
- **Permissions:** the machine that publishes needs real credentials; CI needs
  none beyond read-only checkout. You stop maintaining "a token that can push to
  release branch" in a workflow.
- **No feedback loop:** CI watching a push to `release` *verifies*; it never has
  to build-and-push-back, so there is no branch that a workflow competes with.

---

## Part 3 — CI as read-only verification

With the release command owning all writes, the workflows collapse into plain,
fast, permissionless checks. Run these on **every** branch's push:

1. **Install dependencies.**
2. **Compile** the sources for the branch's mode (dev branch → dev build;
   release branch → release build, which reuses the committed signed artifact and
   needs no secrets). This proves the pushed state compiles.
3. **Run the unit/test suite.**
4. **Verify the committed artifacts are present and well-formed** (e.g.,
   `dist/` complete, the shipped package exists).

Rules to keep CI honest:

- **Read-only, always.** No `git commit`, `git push`, no tag creation, no
  publish step in any workflow. If a workflow *needs* write access to do its
  job, that's a design smell — move that job into the release command.
- **No secrets, by default.** If CI only verifies, it doesn't need
  `AMO_API_KEY`, an app-store credential, or a deploy token. Everything that
  needs a secret belongs in the release command.
- **No `permissions:` blocks granting write.** Your workflow file should not
  declare `contents: write`; you don't want the token to have write even as a
  latent capability. (If the platform injects one anyway, the guard is that the
  workflow simply has no step that uses it.)

---

## The full workflow, annotated

```
[ developer ]  npm run bump -- X.Y.Z        # (dev) one source-bump everywhere
[ developer ]  npm run submit               # (dev) build + upload for review; rebuild dev packaging
        │            … wait for review / signing …
[ developer ]  npm run ship                 # THE RELEASE — from a dev branch
        │       1. guards (clean tree, on dev, creds, not already tagged)
        │       2. read-only signed?/approved? check against the service
        │       3. fetch + checkout release + ff to the shared base
        │       4. git merge -X theirs <dev>   → release == dev's source
        │       5. release build (sync signed artifact, rebuild dist, packaging)
        │       6. verify (complete? correct version? signed?)
        │       7. commit release artifacts, tag vX.Y.Z, push release + tag
        │       8. create the public GitHub Release / store publish
        └──────  9. back on dev
        │
        ▼  pushes to dev and release
[ CI ]  workflows run read-only compile + tests + artifact checks
        (no commits, no tags, no secrets, no publish)
```

---

## Checklist to reapply in another project

1. **Pick the two branches.** `dev` (where you work) and `release`/`master`
   (what's published). Decide that source lives on `dev`; `release` is written
   only by the release command.
2. **Separate generated output from source in your head.** List the directories
   that are pure build output (`dist/`, `node_modules` if committed, binaries,
   bundles). Commit them if it helps your users install without a toolchain, but
   always rebuild them on `release` from source.
3. **Make `release = dev source + release-added artifacts` the invariant.** Never
   hand-commit to `release`. Author changes — including to the release tooling
   itself — on `dev` first.
4. **Write the one release command** with the nine steps above, using `-X
   theirs` for the merge and a read-only "is the target publishable?" check
   before any git mutation. Add guards that fail early and clearly.
5. **Add a single source-of-truth version bump** (`npm run bump`-style) so
   "what version am I?" is answered in one place — a version scattered across
   package.json, a manifest, and a const in source is how releases drift.
6. **Strip CI down to read-only verification.** Remove every write, tag, publish,
   and secret from workflows. Move any job that needs write access into the
   release command.
7. **Prefer `-X theirs` only because the invariant holds.**

## Trade-offs and when *not* to use this

- **Works best** when there is a real "dev > release" gap with a human/`-X`
  gate in the middle: signed builds, store review, notarization, tagged releases.
- **Not a fit** for pure continuous-delivery where every merge to the trunk is
  immediately shipped with no human in the loop — there the "release command"
  is just the pipeline, and this ceremony adds nothing.
- **`-X theirs` demands discipline.** If people start committing original work
  directly to `release`, `-X theirs` will throw it away on the next merge.
  Enforce "only the release command writes to `release`" with a branch rule /
  a CI guard that refuses pushes from anything but the release command's bot if
  you need to protect against it.