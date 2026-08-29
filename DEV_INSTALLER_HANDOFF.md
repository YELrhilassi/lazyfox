# Lazyfox Dev Installer + Branch Policy — Session Handoff

Repo: `/home/bliss/Projects/lazyfox` · Branch: `dev-nightly` · Remote: `mine` → `YELrhilassi/lazyfox.git`

> This document captures what was done, the branch policy decisions, what is committed/uncommitted, and the remaining work for the next session. Work left unimplemented is marked **[TODO]**.

---

## 1. Decision: branch determines signed-vs-unsigned

Agreed with the user (who said "ask me questions if confused"):

1. **Dev branches (`dev-nightly`)** carry the **latest unsigned** build. Devs install right away with the unsigned xpi (Fresh install into Nightly/Devedition, persists, no manual "Add" click).
2. **`master`** stays "in sync with the Firefox public repo" — it holds the **last AMO-signed** xpi. Regular users + GitHub releases use master.
3. **Release loop:** publish from dev → submit new version to AMO → wait for AMO review/sign → re-run master workflow to **sync the signed xpi down via AMO download → commit to master**.
4. **Different installers for dev vs release**: devs get a dev installer (unsigned embed) to test immediately; release installer (signed embed) for regular users.
5. **Version lives in manifest.json; the branch determines signed/unsigned.** No manual version forcing needed in scripts.

---

## 2. What is DONE and working (verified) — UNCOMMITTED

The following changes are in the working tree on `dev-nightly`, **NOT yet committed/pushed**:

### Go installer CLI: `--xpi` dev flag
- `installer/cli.go`: added `config.xpiPath` + `-xpi string` flag, wired into `InstallOptions` for `--mode install`; usage text updated.
- `installer/ops.go`: `installExtension()` branches — if `o.XpiPath` set it installs that **unsigned** xpi, else embedded signed build. Both go through the same persistent auto-enable mechanism (drop addon cache + fix extensions.json → no manual "Add" click).
- Verified: `./installer/bin/lazyfox-install-linux --help` shows `-xpi string     install this unsigned xpi instead of the embedded signed build (dev)`.
- `installer/installer_test.go`: relaxed the signed-requirement test (dev xpi may be unsigned). Ran `gofmt -w`.

### Dev .mjs scripts (new, untracked)
- `scripts/dev-helpers.mjs` — shared profile bookkeeping:
  - `profilesRoot()` (Linux/macOS/Windows).
  - `cleanDevProfiles(root)` — removes dev profile dirs matching `<random>.<name>` (`.lfxdev-*`, `.lfx-*`, `*.lazyfox-dev`) **and** strips their `[ProfileN]` sections + `Default=` from `profiles.ini`.
  - `createProfile` pattern: use Firefox `-CreateProfile "<name>"`, then `findProfileDirByName(root, name)` → the **actual registered** on-disk dir (prevents the bug where the installer wrote into a dir Firefox never registered, so the add-on appeared "not active").
  - `latestUnsignedXpi(distDir)` — picks `dist/lazyfox2-<ver>.xpi`, filtering out `-signed.` and stale versions.
  - `findFirefoxDir()` / `DEV_FIREFOX_DIRS` (`/opt/firefox-nightly`, `/opt/firefox-dev`).
  - **`setDefaultDevProfile(root, profileName, profilePath, ffDir)`** — makes the dev profile the default for Devedition so `firefox` opens it with **no `-P`**. Edits `[Install<hash>]` `Default=` in `profiles.ini` + `installs.ini`, sets `StartWithLastProfile=1`. Install hash detected by scanning profiles' `compatibility.ini` for `LastAppDir=/opt/firefox-dev`, then mapping profile → hash via `installs.ini`; **caches** the discovered hash to `.tools/dev-edition-hashes.json` (gitignored) so it stays robust across runs (the anchor profile's association is lost once we repoint the default).
  - Fixes applied during session: `[^\[]*?` instead of `[\s\S]*?` so regex never crosses `[Install...]` section boundaries (was capturing wrong hash); idempotent-ish.
- `scripts/clean-profile.mjs` — target of `npm run build:dev:clean`. Flow: clean old dev profiles → `npm run build:dev` (unsigned) → locate fresh xpi + Devedition → `-CreateProfile` + resolve real dir → `lazyfox-install --mode install --profile <dir> --firefox-dir <dev> --xpi <unsigned> --no-launch` → `setDefaultDevProfile` → prints `Launch: "/opt/firefox-dev/firefox"`. Respects `DEV_NO_DEFAULT=1` opt-out; warns (doesn't lie) when it can't set default.
- `scripts/dev-install.mjs` — same installer-CLI approach (build → create profile → install → set default).
- Removed `scripts/install-dev.sh` (deleted) and the orphaned `scripts/clean-profile.sh`.

### `build.mjs` — dev short-circuit
- `npm run build:dev` now: builds wasm + esbuild bundles + static, then **`zipStore(dist/extension → dist/lazyfox2-<ver>.xpi)`** (unsigned) and **exits** — **skipping** `amo-sign.mjs` (AMO rate-limit noise) and the cross-platform installer binary rebuild.
- Verified `npm run build:dev` prints cleanly: `[dev] packaging unsigned xpi -> dist/lazyfox2-0.5.3.xpi` then `Build complete. dist/ is ready to install (unsigned dev add-on).`
- Prod `npm run build` (master) unchanged: signs + stages + rebuilds the 3 installer binaries.

### package.json
- Added script `"build:dev:clean": "node scripts/clean-profile.mjs"`.

### End-to-end verified
`npm run build:dev:clean` on this machine now:
- cleans old dev profiles (dirs + profiles.ini),
- builds unsigned xpi (no AMO messages),
- creates 1 registered dev profile,
- installs chrome loader + unsigned extension persistently via the CLI,
- sets it as the **default** for Devedition (`318E` install), launch WITHOUT `-P`.
- Confirmed via a headless launch: log showed `[lazyfox-core ready, version=0.5.1]`, `[lazyfox-bindings loaded, count=64]` — the add-on is ACTIVE.

---

## 3. What is committed vs uncommitted

**Remote latest:** `1ec72ed feat: add dev-nightly workflow, native host, installer scripts and cleanup`.

**Uncommitted (working tree):**
```
 M build.mjs
 M dist/chrome/{corebootstrap,userChrome.uc}.js    (minified rebuilds)
 M dist/extension/{background,commandcenter,content,options}.js
 M installer/bin/lazyfox-install-{linux,darwin,windows.exe}  (rebuilt, have --xpi)
 M installer/cli.go
 M installer/installer_test.go
 M installer/ops.go
 M package.json
 D scripts/install-dev.sh
?? scripts/clean-profile.mjs
?? scripts/dev-helpers.mjs
?? scripts/dev-install.mjs
```
Note: `dist/lazyfox2-0.5.3.xpi` is **not** in the diff (restored to committed = **unsigned**, correct for dev). `dist/lazyfox2-0.5.3-signed.xpi` stays committed (referenced by workflows; dev filters it out). `.tools/` is gitignored (cache file not committed).

**Nothing has been committed for this session's work yet.** Next session: `git add` the above, commit, push to `mine dev-nightly`.

---

## 4. Remaining work / [TODO] for next session

### A. Host installer binary availability (GAP — important)
- `installer/bin/lazyfox-install` (host, no platform suffix) is **gitignored** (root `.gitignore` line 11), but `build:dev` now short-circuits **before** rebuilding it. The dev scripts (`clean-profile.mjs`, `dev-install.mjs`) invoke `installer/bin/lazyfox-install`.
- On this machine it exists (built earlier, 18MB, has `--xpi`), but a **fresh clone would lack it** → `build:dev:clean` would fail.
- **[TODO] Decide + implement:** make `build:dev` also build the host dev installer embedding the unsigned payload (device = staged unsigned xpi), OR make `clean-profile.mjs`/`dev-install.mjs` build the host binary if missing, OR have dev scripts auto-detect the per-OS committed binary (linux/darwin/windows.exe). Recommendation: build the host `installer/bin/lazyfox-install` in the dev build path (matches "different dev installer" decision), staging the unsigned xpi into `installer/payload/extension/` before `go build`.

### B. Separate dev vs release installer policy (PARTIALLY decided)
- User chose: "different installer for dev and release, devs test immediately with unsigned, regular users install signed easily."
- Currently a single `lazyfox-install-*` binary per OS exists; `--xpi` at runtime switches to unsigned. The committed binaries embed the signed payload (staged during earlier prod builds).
- **[TODO] Decide concrete naming/placement:** e.g. keep `installer/bin/lazyfox-install-*` as release (signed embed, master only) and add dev binaries (unsigned embed) OR rely on `--xpi` + committed dev build. Align with user before large refactor.

### C. Master workflow sync (current `master.yml` is sketchy)
- Goal: on master, obtain the signed xpi via AMO download → **commit it** to master as `dist/lazyfox2-<ver>.xpi` (+ `-signed.xpi`), then build release installer (signed embed), tag, and GitHub Release.
- Current `master.yml` tries to parse the file id out of `dist/lazyfox2-0.5.3-signed.xpi` via grep — fragile. Also uses hardcoded `0.5.3` (should derive from manifest).
- **[TODO]** Rework `master.yml` / or note the version should come from `dist/extension/manifest.json` (no hardcoded versions). Also `dev-nightly.yml` and `nightly.yml` have hardcoded `0.5.3` paths — make them derive version.
- Branch determination of signed/unsigned: the build reads the branch? **[TODO]** decide whether to pass an env flag (e.g. `RELEASE=1`) instead of sniffing branch name.

### D. Version/branch sync semantics
- Confirm the concrete bump flow: dev manifest is the "next" version (e.g. 0.5.4) that is unsigned; master manifest matches the last AMO-signed version (e.g. 0.5.3). When review completes, publish from dev, then re-run master workflow to sync the signed xpi down.
- **[TODO]** Document this in a short CONTRIBUTING/RELEASING note (or add to existing `install-clarify.md`).

### E. Cleanup / hardening of current changes
- `scripts/dev-helpers.mjs` `setDefaultDevProfile`: verify it's idempotent when re-run with profiles already pointing at a dev profile and cache present (partially done in testing). Consider removing the obsolete `findProfileDirByName` recency assumption.
- `installer_test.go` logs a WARNING (not fatal) for unsigned xpi — fine for dev but confirm prod/test-installer.mjs expecting signed still passes (it does: `npm test` green).
- Consider adding `zipStore` import cost note; `amo-lib.mjs` is already a dep of `build.mjs`.

---

## 5. Environment facts (this machine)

- Devedition: `/opt/firefox-dev/` (binary `/opt/firefox-dev/firefox`), **profiles live in the SAME `~/.config/mozilla/firefox/`** as release Firefox (Linux). Its install hash is `318E2192A215127D`; release Firefox is `4F96D1932A9F858E`.
- `compatibility.ini` stores `LastAppDir=/opt/firefox-dev/browser` — used to identify Dev Edition profiles.
- Current default dev profile (created by last `build:dev:clean`): `ngqxndzg.lfxdev-1787985656784`; `installs.ini` `[318E...]` → it; release `[4F96...]` → `664uc93t.default-default` (untouched, correct).
- Cache: `.tools/dev-edition-hashes.json` = `{ "/opt/firefox-dev": "318E2192A215127D" }`.
- Local geckodriver: `.tools/geckodriver` (Linux, no `.exe`). Dev scripts no longer need `GECKODRIVER`/`FIREFOX_BIN` pre-set.
- AMO signing currently hitting **rate-limit (429, ~60k s)** — dev build no longer touches AMO, so irrelevant for dev; prod/master will need to wait for the throttle or the committed fallback.
- `npm test` passes: `go test ./core/` + `node scripts/test-installer.mjs` + `node scripts/check-dist.mjs`.

---

## 6. Suggested next-session checklist (ordered)

1. `git add` + commit the current working tree (message style: e.g. `feat: dev installer via go-cli --xpi + unsigned dev build + default-profile`) and push to `mine dev-nightly`.
2. Implement A — make the dev build produce the host dev installer (unsigned embed) so fresh clones work.
3. Implement C/D — rework `master.yml` (derive version from manifest, AMO download → commit signed xpi to master, release installer + tag), remove hardcoded `0.5.3` in `dev-nightly.yml`/`nightly.yml`.
4. Confirm B — finalize dev-vs-release installer naming/embed policy with the user.
5. Add a short RELEASING note documenting the dev→review→master sync loop (decision D).
