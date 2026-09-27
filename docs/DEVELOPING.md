# Developing & releasing Lazyfox

Two branches, one rule:

| Branch        | Build        | Who uses it                | How it gets updated   |
|---------------|--------------|---------------------------|-----------------------|
| `dev-nightly` | **unsigned** | you + Firefox Nightly/Dev | you work here        |
| `master`      | **signed**   | everyone (AMO/stable)     | `npm run ship`       |

You work on `dev-nightly` (or a feature branch). `master` is only ever written
by one command. CI is read-only on both.

---

## Daily dev loop (on `dev-nightly`)

```bash
npm install          # once; checks toolchain (node + go)
npm run sync         # build everything, refresh every installer, verify, print the table
npm run dev-install  # install that build into a fresh Nightly/Dev profile
npm run ci           # the full local test run (run before you push)
```

That's it. `npm run sync` is the command that ends the "did I remember to rebuild
the executables?" question: after it finishes, every committed installer binary
is built from the current source, and it prints the proof.

### The build cannot leave a stale executable behind

`dist/` is committed, and so are the installer binaries in `installer/bin/`
(users install from a downloaded binary, and a fresh clone must work without a
Go toolchain). That makes "rebuild the payload but not the binaries" a real and
invisible failure: the tree looks built, and the installer quietly installs the
previous build. Three rules remove the possibility:

- **A build rebuilds every executable.** `npm run build` refreshes all the dev
  installers (all platforms — the non-host ones are cross-compiled terminal
  installers) and the release installers whenever a signed add-on exists. The
  only exceptions are opt-in: `LF_INSTALLER_TARGETS=host` for a fast iteration
  build, and `--no-installers` when nothing consumes `installer/bin/`.
- **Freshness is decided by content, not by timestamps.** Every build records
  what it embedded in `installer/bin/payload-state.json` (the payload content
  hash, the add-on, the binary's own hash). `npm run check` recomputes the hash
  and compares, for every platform — which a clone, a `git checkout` or a
  teammate's build cannot fool, unlike mtimes.
- **`npm run check` fails the build, and can fix itself.** It also verifies the
  payload staged for `//go:embed` is byte-identical to `dist/`, and runs this
  machine's binary from a temp dir to confirm it really embeds a usable
  add-on. `npm run check:fix` rebuilds whatever is stale and re-checks.

The payload file list itself is declared once, in
`installer/internal/payload/artifacts.json`, which the Go payload package
`//go:embed`s and every build script reads. There is no second copy to forget
to update.

## Releasing (the whole flow is two commands)

There are exactly **two** release commands — `submit`, then `ship`. Nothing else.

```bash
npm run bump -- 0.5.7    # (optional) start a version: bump everywhere at once
npm run submit           # publish that version to AMO  → wait for review/signing
npm run ship             # after AMO signs → the release (merge→signed→tag→GitHub Release)
```

**`npm run submit`** builds the unsigned xpi, uploads it to addons.mozilla.org as
a listed version, and rebuilds the dev installers. Needs `AMO_API_KEY` +
`AMO_API_SECRET` (gitignored `.env`).

**`npm run ship`** — run from your dev branch once AMO has signed the version —
does the entire release, automatically and deterministically:

1. Guards + a read-only AMO check that the version is signed.
2. Merges your dev branch into master with `-X theirs` (never conflicts, even
   on generated `dist/`/installers).
3. Syncs the AMO-signed xpi, rebuilds release-mode dist + the release
   installers.
4. Verifies, then commits master, tags `v<version>`, pushes, and creates the
   GitHub Release.

### The signed-vs-unsigned rule, stated plainly

- `npm run build` / `npm run submit` make the **unsigned** build — only Firefox
  Nightly/Developer Edition accepts it.
- `npm run ship` makes the **signed** build — what every stable Firefox user
  gets from AMO / the GitHub release.

That's why there are two installer families:
`installer/bin/lazyfox-install-*` (release, signed embed) and
`installer/bin/lazyfox-install-dev-*` (dev, unsigned embed).

### The dev channel is fully self-service (no AMO, no waiting)

Development never waits on Firefox review. To put the newest unsigned build in
front of Developer Edition / Nightly users — and to exercise the installer from
the setup page exactly as those users do:

```bash
npm run sync                              # unsigned xpi + every dev installer (channel=nightly)
npm run ship:nightly                        # (re)publish the rolling `nightly` prerelease
```

`ship:nightly` never touches `master` and needs no AMO credentials. The `;I`
setup page detects the running Firefox (`a1` → Nightly, `b` → Developer
Edition) and links Nightly/Dev users at this prerelease, stable users at
`releases/latest`. So both audiences always get the build that matches their
browser — see `docs/INSTALLER-ANALYSIS.md`.

The `--mode auto` installer (what that page's download runs) needs no decisions:
it picks the channel-matched Firefox, the profile Firefox is actually using,
and falls back to a dedicated Lazyfox-owned profile if necessary — then verifies
what it wrote. The installer build also stamps the channel into the binary, so
a dev installer refuses to masquerade as a signed one.

---

## One-line summary of every npm command

| Command | What it does for you |
|---------|----------------------|
| `sync` | **the dev loop**: build, refresh every installer, verify, print the freshness table |
| `sync:verify` | just the gate (typecheck + tests + freshness), no rebuild |
| `check` / `check:fix` | is any committed installer stale? (fix = rebuild what is) |
| `build` | make the unsigned dev xpi **and refresh every installer binary** |
| `installer` | build, then open the installer window (add `-- --release`, `-- --no-build`) |
| `build:installers` | rebuild every per-OS dev installer binary (what `build` already does) |
| `build:release-installers` | rebuild the release installer binaries (needs a signed xpi) |
| `dev-install` / `dev-install:clean` | build + install into Nightly/Dev |
| `bump -- X.Y.Z` | bump the version everywhere at once |
| `submit` | publish a version to AMO + rebuild dev installers |
| **`ship`** | **the release**: merge→signed→tag→push→GitHub Release |
| `ci` / `ci:bidi` | run the local CI (universal pre-push check) |
| `bidi` | run the WebDriver end-to-end suite (extension only) |
| `probe:chrome` | probe the real chrome helper (status bar / relay / leader) |
| `clean` | wipe regenerable build products |
| `verify` / `test` / `typecheck` | run the test suites / typecheck |

## Running CI locally before pushing

```bash
npm run ci
```

Don't push to test whether CI passes — run this. The GitHub workflows
(`dev-nightly.yml`, `master.yml`) run the exact same read-only checks. See
**docs/CI.md** for details (and how to install the test tools on Void).

---

## When the dev loop misbehaves (checklist)

Most “it broke after I pulled” cases are one of these four. Work down the list.

### 1. Reinstall dependencies after every pull

`package.json` changes between branches, and a stale `node_modules` is the
usual cause of a wall of type errors that make no sense:

```bash
npm install
```

A missing `@types/node` (or any “Cannot find type definition file” error) is
almost always a stale install, not a real type error.

### 2. esbuild's binary: npm 11 blocks install scripts by default

npm 11 refuses to run package install scripts unless they are approved, so
**esbuild's `postinstall` (which installs its platform binary) is skipped** and
`npm run build` fails with a missing/`ENOENT` esbuild binary. Approve it once:

```bash
npm approve-scripts esbuild      # or: npm approve-scripts --allow-scripts-pending
npm install
```

You only need to do this on a machine where the binary is not already present;
CI and existing checkouts are unaffected.

### 3. Ditch stale generated artifacts before building

`dist/`, `build/`, the wasm, and any generated Go files are **build output**.
When you switch branches, output from the old branch can linger untracked and
break a build in a way that looks impossible (we have hit a stale generated
`core/js/version_gen.go` shadowing the real `version` const, which failed
`go build ./core/js`). When in doubt:

```bash
npm run clean && npm run build
```

`npm run clean` only removes regenerable products; it never touches source.
For a from-scratch rebuild that also drops the *committed* artifacts (the dist/
bundles, `installer/bin/*` and their payload records — the signed add-on xpis
are never touched, they cannot be regenerated without AMO credentials):

```bash
npm run clean:all && npm run sync
```

### 4. The version is one number, everywhere — bump it with the tool

Never hand-edit a version. `npm run bump -- X.Y.Z` updates **all** of it
(`package.json`, `package-lock.json`, the source manifest, the chrome helper's
`CHROME_HELPER_VERSION`, and the Go core's `const version`). `npm test`
fails loudly if any of those drift — which is how we caught the core still
reporting `0.5.1` long after the extension shipped `0.5.7`.

---

## Which half am I running?

The add-on and the window chrome are separate halves with different capabilities
(the status bar in particular exists in both, by two different mechanisms). If
you are unsure what a given checkout is actually doing, read
**`docs/INSTALLER-ANALYSIS.md`** — it has the full capability matrix and how to
probe the live state (`npm run probe:chrome`).