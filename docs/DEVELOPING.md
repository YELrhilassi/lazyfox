# Developing & releasing Lazyfox

This is the whole story in one page. There are two kinds of builds, and they
map 1:1 to the two main branches:

| Branch        | Build        | Who uses it                | Command               |
|---------------|--------------|---------------------------|-----------------------|
| `dev-nightly` | **unsigned** | you + Firefox Nightly/Dev | `npm run build`        |
| `master`      | **signed**   | everyone (AMO/stable)     | `npm run build:release`|

**The version lives only in `dist/extension/manifest.json`.** Nothing hardcodes
it. Bump it there and the whole pipeline follows.

---

## Daily dev loop (on `dev-nightly`)

```bash
npm install          # once; checks your toolchain (node + go)
npm run build        # compile wasm + bundle the unsigned xpi into dist/
npm run dev-install  # build + install it into a fresh Nightly/Dev profile
npm run ci           # the full local test run (run before you push)
```

That's it — `build` → `dev-install` → `ci`. Commands:

| Command | When |
|---------|------|
| `npm run build` | compile the latest changes into `dist/lazyfox2-<ver>.xpi` (unsigned) |
| `npm run dev-install` | build **and** install into a new Nightly/Dev profile (persistent) |
| `npm run dev-install:clean` | same, but wipe stale dev profiles first |
| `npm run ci` | run the whole CI check locally (actionlint + build + tests) |
| `npm test` / `npm run verify` | just the test / typecheck suites |

---

## Publishing a new version (`dev-nightly` → AMO)

1. **Bump the version** in `dist/extension/manifest.json` (e.g. `0.5.5`).
2. ```bash
   npm run submit
   ```
   This packs the fresh unsigned build, **uploads it to AMO as a listed
   (public) version**, and rebuilds the dev installers. It refuses to
   re-submit a version that already exists. Needs `AMO_API_KEY` +
   `AMO_API_SECRET` in `.env` (gitignored).
3. **Wait.** AMO reviews the submission; it only *signs* listed add-ons after a
   reviewer approves them. This is the only step with a human in the loop.

---

## Releasing the signed version (`master`)

Once AMO has approved that version, harvest the signed xpi:

```bash
git checkout master
npm run build:release     # downloads the AMO-signed xpi, rebuilds release installers
git commit -am "sync signed xpi for master"
git push
```

`npm run build:release` fails with a clear message (not a stack trace) if that
version isn't signed yet — in which case you still have to wait for review.

### The sign-vs-unsigned rule, stated plainly

- `npm run build` / `npm run submit` / `npm run build:installers` all make the
  **unsigned** build — only Firefox Nightly/Developer Edition will accept it.
- `npm run build:release` makes the **signed** build — what every stable
  Firefox user gets from AMO / the GitHub release.

That's why there are two installer families in `installer/bin/`:
`lazyfox-install-{linux,darwin,windows.exe}` (release, signed) and
`lazyfox-install-dev-*` (dev, unsigned).

---

## One-line summary of every npm command

| Command | What it does for you |
|---------|----------------------|
| `build` | make the unsigned dev xpi |
| `build:release` | make the signed release (master, after AMO review) |
| `submit` | push a new version to AMO + rebuild dev installers |
| `build:installers` | rebuild the portable dev installer binaries |
| `dev-install` / `dev-install:clean` | build + install into Nightly/Dev |
| `ci` / `ci:bidi` | run the local CI (universal pre-push check) |
| `bidi` | run the WebDriver end-to-end suite (extension only) |
| `probe:chrome` | probe the real chrome helper (status bar / relay / leader) |
| `clean` | wipe regenerable build products |
| `verify` / `test` / `typecheck` | run the test suites / typecheck |

## Running CI locally before pushing

```bash
npm run ci
```

Don't push to test whether CI passes — run this. See **docs/CI.md** for the
full story (and how to install the test tools on Void).