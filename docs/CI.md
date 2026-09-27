# Testing CI locally (no need to push)

The GitHub workflows were historically failing on GitHub even when everything
worked on your machine. The reliable fix is to **run the exact same checks
locally before you push** — no Docker, no waiting on runners.

## One command

```bash
npm run ci
```

This runs, in order (mirroring `.github/workflows/dev-nightly.yml` → `unit`):

1. `actionlint` over every `.github/workflows/*.yml` (catches workflow syntax /
   expression errors statically)
2. `npm ci`
3. `npm run prepare` (toolchain check: node + go)
4. `npm run check` (**before** anything is built: are the committed artifacts
   consistent with the committed source?)
5. `npm run build` (compiles Go wasm core + bundles the unsigned dev xpi, and
   refreshes every committed installer binary)
6. `npm test` (Go core tests + installer tests + payload tests + dist
   completeness + the installer freshness check)
7. `node scripts/check-dist.ts` (dist is self-contained)
8. `npm run check` again (the build itself left nothing inconsistent)

If all of them pass, the `unit` job **will** be green on GitHub too.

### The step that runs *before* the build

Step 4 exists because of a specific, previously-invisible failure: `dist/` and
the installer binaries in `installer/bin/` are committed, so it is possible to
change a source file, commit, and push — with the artifacts still holding the
previous build. Every other step in the workflow would pass, because they either
rebuild first (repairing the tree in place, so the mistake never surfaces) or
never look at the artifacts at all. Whoever later downloaded `installer/bin/…`
would get old code.

`npm run check` compares two content hashes recorded by the last build:

- the **source fingerprint** (everything under `src/`, `core/`, `native-host/`,
  plus `build.ts` and the Go module files) — catches "source edited, nothing
  rebuilt", even when `dist/` was not touched;
- the **payload hash** (the staged chrome files, the loader files, the native
  host's source, and the embedded add-on) — catches "dist/ rebuilt, installers
  not", for every platform, including the ones this machine cannot run.

It is a hash comparison, not a build, so it is fast and it does not depend on
the toolchain. `npm run check:fix` rebuilds whatever it finds and re-checks, for
when you want the repair rather than the report.

End-to-end (optional, needs a real Firefox):

```bash
bash scripts/install-tools.sh geckodriver        # one-time
npm run ci:bidi                                   # adds the WebDriver BiDi suite
```

Set `BIDI_FIREFOX_BIN=/path/to/firefox` (and it auto-uses `.tools/geckodriver`)
when you want the browser-session tests included.

> **Why BiDi is local-only (not on GitHub Actions):** the full e2e suite boots
> a fresh Firefox and can take many minutes — more than GitHub's free-plan
> minutes allow. So the `dev-nightly` workflow now runs only the fast `unit`
> job (~50s) on push, and the browser suites are run locally (`npm run bidi`,
> `npm run probe:chrome`). Kill orphaned Firefox processes between runs
> (`pkill -9 geckodriver; pkill -9 firefox`) or a fresh run can stall waiting
> for a port CPU.

### Link hints (local only)

The link-hint suite runs **locally only**, against the local test pages:

```bash
npm run bidi:hints      # just the link-hint tests
npm run ci:hints        # the above with the full local CI prefix
```

It needs no network and no third-party markup: `scripts/bidi/pages.ts` serves
deliberately hostile local pages (occluding overlays, nested clickable wrappers,
shadow roots, virtual-DOM churn, a fixed header) and the suite asserts real
behaviour — which elements get keys, that keys stay stable across a re-render,
that Escape clears state, that nothing is anchored outside the viewport.

There used to be a scheduled workflow that downloaded real YouTube and GitHub
home pages and ran a "stress" test against the saved HTML. It is gone, and so is
the downloader: a snapshot of someone's home page is not a test fixture (its
markup changes under you, the external CSS/JS 404s so the page renders
unstyled, and the assertion it could make — "the collector completes and
anchors N hints" — is one the local pages already assert far more precisely).
Debugging a hint that will not appear is now a job for the in-page diagnostics
page (it reports the hint pipeline's found/hinted/rejected counters and probes
each candidate), not for a nightly scrape.

A full run is ~10+ minutes (the browser is real, and the suites wait on
network/timing). If your shell enforces a shorter cap, run the groups one at a
time — `--suite commandcenter`, `--suite content`, `--suite sessions`,
`--suite split`, `--suite options` — and `--only <text>` to iterate on a single
test.

### Testing the real chrome layer (the production bugs live here)

The BiDi harness installs the *full* Lazyfox layer into its throwaway profile —
the extension plus the chrome helper (`userChrome.css`, `userChrome.uc.js` via
the fx-autoconfig loader) — so the suites that need it exercise the real
chrome-document path: the native split view, the window-level status bar, the
leader/popup engine, per-tab cache enforcement and the relay. The chrome helper
is exactly where the tab-churn / double-status-bar bugs live, so a focused
probe of it is also available:

```bash
npm run probe:chrome
```

This boots a real Firefox profile with the full chrome layer and asks the
helper for its live state (`#lfc=state`). It reports, with a clear pass/fail
verdict, whether the helper booted, whether the status bar is mounted, how many
relay tabs exist (1 = healthy, more = relay churn), and the leader state. Run it
after any edit under `src/chrome/`.

## The tools (Void Linux)

Install once with:

```bash
bash scripts/install-tools.sh
```

This drops three binaries under `.tools/` (gitignored): **actionlint**
(workflow linter), **act** (optional GitHub-Actions emulator), and **geckodriver**
(WebDriver for the BiDi suite). It's idempotent and needs only `curl` + `tar`.

## Recommended pre-push loop on dev-nightly

```bash
npm run ci          # the whole unit job, locally
git log --oneline   # double-check your branch history before pushing
```

## Why the workflows used to fail

The classic root cause we fixed: the workflows pinned **Go 1.22** while the repo
modules (`go.mod`, `installer/go.mod`) require **Go 1.26**. `actions/setup-go`
installed exactly 1.22, so `go build` failed with:
`go.mod requires go >= 1.26`. All workflows now pin `go-version: "1.26"`.

If you edit a workflow, run `npm run ci` (step 1 runs actionlint) or directly:

```bash
.tools/actionlint .github/workflows/*.yml
```

## Running the workflow with `act` (advanced)

`act` emulates GitHub Actions in Docker. Use it only if you specifically want
to see the workflow run end-to-end inside the container:

```bash
GITHUB_TOKEN=$(gh auth token) ./.tools/act -W .github/workflows/dev-nightly.yml -j unit
```

Notes:
- Requires a running `docker` daemon (first run pulls a large image).
- Needs a working `GITHUB_TOKEN` (use `gh auth token`) to clone action repos.
- The container on some hosts is slow/flaky; `npm run ci` is the fast,
  deterministic path and covers the same logic. Prefer it.