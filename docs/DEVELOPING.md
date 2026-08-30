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
npm run build        # compile wasm + bundle the unsigned xpi into dist/
npm run dev-install  # build + install into a fresh Nightly/Dev profile
npm run ci           # the full local test run (run before you push)
```

That's it.

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

---

## One-line summary of every npm command

| Command | What it does for you |
|---------|----------------------|
| `build` | make the unsigned dev xpi |
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