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
4. `npm run build` (compiles Go wasm core + bundles the unsigned dev xpi)
5. `npm test` (Go core tests + installer tests + dist completeness)
6. `node scripts/check-dist.ts` (dist is self-contained)

If all six pass, the `unit` job **will** be green on GitHub too.

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

### Nightly: link hints against real pages (GitHub Actions)

The one browser suite that **does** run on GitHub is the scheduled
`.github/workflows/nightly-hints.yml`. Every night it builds the extension,
installs a pinned Firefox + geckodriver, downloads real UI-heavy page snapshots
(GitHub, YouTube) with `npm run bidi:fixtures`, and runs the link-hint tests —
including the stress test that exercises the hint engine against markup it did
not author.

It is built so a blocked network is never a false failure:

* the snapshot download is a `continue-on-error` step, so if it fails the run
  carries on and the stress test **skips** (the other hint tests use local
  fixtures and always run);
* `BIDI_REQUIRE_FIXTURES` is passed to the test only when the download actually
  succeeded, which turns a *missing* snapshot into a real failure — so a broken
  download cannot hide behind a skip.

Run the same thing locally:

```bash
npm run bidi:fixtures   # best-effort: pull the real-page snapshots
npm run bidi:hints      # just the link-hints tests (uses them when present)
npm run ci:hints        # the above with the full local CI prefix
```

The snapshots live in the gitignored `scripts/bidi/fixtures/`, so nothing
third-party is ever committed.

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