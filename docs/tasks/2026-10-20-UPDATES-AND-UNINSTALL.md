# Updates, and an uninstall that actually uninstalls

## What was wrong

1. **There was no update path.** `--mode install` rewrote everything whether or
   not it needed it, and nothing in the installer could say which version was
   installed: the payload knew its own version (`payload.AddonVersion`), the
   profile did not get asked. The only route to a new build was "run the
   installer again, or uninstall and reinstall" — and no front-end could tell the
   user which of those applied.
2. **The native messaging host was never removed.** `RunUninstall` removed the
   profile files, the add-on, and (with a flag) the loader. The host binary, its
   manifest and the Windows registry key stayed, allow-listing the add-on id of a
   product that was no longer installed.
3. **The loader stayed by default.** `config.js` switches Firefox's autoconfig
   on and names the chrome layer; leaving it after removing that layer is not a
   neutral leftover.
4. **Nothing checked a removal.** `ops.Verify` checked installs; uninstalls
   asserted their own success.
5. **The extension could not notice a half-applied update.** It showed the four
   component versions in a panel and left the comparison to the reader.

## What changed

### Installer (`installer/`)

- `payload/version.go` — `CompareVersions` (numeric, suffix-tolerant) and
  `VersionFromXpiFile`. The xpi's own manifest is the installed version, so
  profiles installed by older versions (which wrote no state file) are described
  correctly.
- `ops/installed.go` — `Inspect` measures one profile: add-on version, chrome
  files present/current, loader present/current, host present. `Status()` is one
  of `not-installed | current | outdated | newer | incomplete`; `NeedsWork()`
  is the repair/update predicate.
- `--mode update` (`installer/update.go`) — in-place refresh of an existing
  install. Refuses when nothing is installed, refuses to downgrade without
  `--force`, and does nothing when already current. `ops.Run` now logs the
  version move at the start, so every front-end (CLI, window, TUI) reports an
  update as an update.
- Uninstall now removes the native host (binary, manifest, Windows registry key)
  and the chrome loader **by default** (`--keep-loader` opts out; the old
  `--remove-loader` still parses and is a no-op). It ends with
  `ops.VerifyRemoved`, which returns everything still on disk — including a
  profile Firefox held open — and the run fails with those listed.
- Window: `ProfileInfo` carries the installed version and state, the action rail
  gains **Update Lazyfox** only when an install exists, the window OPENS on that
  action when there is one to do, the plan says whether the profile is
  stale/current/newer/partial, and the outcome distinguishes "updated" from
  "installed". `--mode list` prints each profile's installed version and whether
  an update is available.
- TUI: unchanged in shape; it inherits the update-on-install behaviour, the
  loader removal, and the removal verification.

### Extension

- `shared/versions.ts` — version arithmetic plus `componentVerdict`: compares the
  extension, the wasm core, the native host and the chrome helper, and reports
  which piece is older (or newer) than the add-on. No network.
- `shared/updates.ts` — a user-initiated check against the GitHub releases API,
  with a timeout and every failure reported as "could not check" rather than
  thrown.
- The settings page's Components panel now reports "same build / update needed /
  restart Firefox", explains which piece disagrees, and offers the installer.
  "Check for updates" is a button; nothing polls.

## Also found and fixed: the Windows installer build could not rebuild its UI

`scripts/npm.ts` fell back to `spawn("npm.cmd")` when `npm_execpath` was unset
(a script started with bare `node …`, which is how the rebuild is usually run).
Current Node refuses to spawn a `.cmd` without a shell — `EINVAL`, with no npm
output at all — so `build-dev-installers.ts` died the moment the window's
sources were newer than its bundle, which is exactly when an installer must be
rebuilt. It now looks for `npm-cli.js` beside the running Node and only falls
back to a shell on Windows. Without this the installers cannot be refreshed from
a plain `node scripts/...` invocation, so the stale-binary check could only pass
when nobody had edited the UI.

## Verified

- `go test ./...` in `installer/` — version ordering, installed-state
  classification (including "older and also missing a file" → *outdated*, not
  *incomplete*), `VerifyRemoved` across every component, keep-loader and
  disable-only cases, native host removal, and a full `RunUninstall` over a
  laid-down install asserting nothing of ours survives.
- `node --test scripts/test/versions.test.ts` — version ordering, skew verdicts,
  release-check success/current/failure paths.
- `npm run typecheck` (app, scripts, e2e, installer UI).
- `npm test` — unit, wire, seam, legacy, `check-dist`, installer payload check.
- `lazyfox-install --mode list` on this machine, over real profiles: it reports
  `0.5.9 — update to 0.5.10 available`, `0.5.10 — files differ from this build`
  and `0.5.8 — update to 0.5.10 available` per profile, read from each profile's
  own xpi rather than from any state file.
- The window, in its mock bridge: the action rail offers **Update Lazyfox** only
  on a machine that has one, lands on the profile that needs it, states
  "Installed: Lazyfox 0.5.9" and the footer reads `Update Lazyfox 0.5.9 →
  0.5.10 … (in place, nothing else changes)`; the removal review lists the
  native host, its manifest and the registry key, and shows **Keep the chrome
  loader** unchecked.

## Deliberately not done

- **No background update poll and no `update_url` in the manifest.** A listed AMO
  add-on gets its updates from AMO; a sideloaded xpi cannot be replaced by the
  add-on itself, and the chrome layer cannot either. The honest offer is "here is
  the installer, and it updates in place".
- **No automatic installer download/run.** That needs a signed updater, and the
  alternative — an unsigned binary fetched and executed by a browser extension —
  is worse than a button.
- **Stale files from an older build are not swept.** Uninstall and verify walk
  the current payload registry; a file that a future build stops shipping would
  not be known to it. No such file exists today.

## Follow-up: the launch check, and a host that was installed but invisible

### The bugs this round found

The native host was reported as missing on a machine where the installer had
just installed it. It was not one failure but three, each invisible from the
outside and each able to produce the same "native host: missing":

1. **The key was gone.** `lazyfox-host.exe` and `lazyfox.json` were both in
   `%LOCALAPPDATA%\Lazyfox`, byte for byte what the payload contained, but the
   `HKCU\Software\Mozilla\NativeMessagingHosts\lazyfox` key — the half of the
   install Firefox actually reads — had been deleted (see below for the cause).
2. **The host spoke the wrong protocol.** It read newline-delimited JSON, while
   native messaging is a 32-bit length followed by JSON with no newline. A real
   Firefox request therefore never produced a reply — `connectNative` hung until
   the port closed — so even a correctly installed and registered host could not
   answer. `native-host/main.go` now frames both directions (and still accepts a
   piped line, which is what the docs' smoke test does).
3. **A locked host binary aborted the manifest.** On Windows the running host
   process holds its own `.exe` open, so an in-place update failed to replace it
   and returned *before* writing the manifest and registering the key. Every
   later update hit the same file and the key stayed missing forever. The update
   now stops our host processes, retries the write, and treats a still-locked
   binary as a note rather than an abort — the manifest and key are the parts
   Firefox needs, and they are written regardless.

All three were reproduced on this machine and repaired by one `--mode update`
after the fixes.

The cause was in this work's own test suite. `TestRunUninstallLeavesNothingBehind`
drives a real `RunUninstall` over a throw-away profile in a temp directory, and
`RemoveNativeHost` called `platform.UnregisterNativeHostWindows`, which is not
scoped to a profile: it deleted the *developer's* machine-wide key while the test
passed. That is a test that damages the machine it runs on, and its damage was
exactly the state the product cannot see.

### What changed

- **The registry is behind a seam.** `ops.nativeHostRegistry` holds
  Register/Unregister/Registered; the tests replace it with an in-memory fake.
  No test touches a real key now, and `TestRunUninstallClearsTheHostRegistration`
  proves the uninstall still clears it.
- **The registration is measured, not assumed.** `platform.NativeHostRegisteredPath()`
  reads the key back; `ops.RegistrationProblem` words the two broken states
  (key missing, key pointing somewhere else) and `Verify` fails on them, because
  an install that verifies clean while the add-on cannot reach the host is a lie.
- **It counts as work.** `Installed.NeedsWork()` is true when a profile holds
  Lazyfox and its host is unreachable, so `--mode update`, the window's Update
  action and the window's default action all repair it — previously every file
  matched, so Status said "current" and the update refused to run.
- **It is visible.** `--mode list` marks the profile, `ProfileInfo.hostState`
  carries it to the window, and the settings panel's profile line says
  "native host not registered — an update fixes it".

### Update check at launch

`extension/services/updates.ts` asks GitHub once per browser session and shows at
most one notification, naming the new version and pointing at the installer
(which updates in place). The guard is `storage.session`, written *before* the
request, so a background restart mid-session cannot notify twice and a slow
request cannot either; an in-memory flag is the fallback when session storage is
unavailable. Nothing polls, and a check that cannot answer says nothing at
launch (the panel still reports "could not check" on demand). The notification
copy is `updateNotice` in `shared/updates.ts`, pinned by
`scripts/test/versions.test.ts`, so the two entry points cannot describe the same
update differently.

### The host is part of the update decision

The third bug exposed a fourth: `--mode update` compared the add-on version and
the chrome files, but not the host binary, which is versioned separately. A fix
to `lazyfox-host` could therefore never be delivered to a machine whose add-on
was already current — `--mode update` said "nothing to do". `Installed` now
carries `HostExpected` / `HostCurrent` (bytes compared against the payload), so a
stale host is `NeedsWork()` and the update rewrites just that binary. `Verify`
fails a run that left the old host behind, so the failure is loud rather than a
silent "updated and verified".

### Verified this round

- `go test ./...` in `installer/` — the new registry tests (unregistered host is
  work, a stale host binary is work, Verify fails each, uninstall clears the key,
  VerifyRemoved reports a leftover key, a locked binary still registers), plus
  the existing uninstall round-trip and every fixture updated to lay down the
  payload's real host bytes.
- `go test -C native-host ./...` — the framing regression: a framed request gets
  a framed reply, two consecutive frames are both answered in order, a piped line
  still gets a line, and an oversized frame is rejected. This module is now part
  of `npm test` (it was not built or tested by the root suite before).
- `node --test … scripts/test/versions.test.ts` — 15 pass, including the notice
  copy and its silence on current/unknown.
- On this machine, end to end: `--mode list` reported "native host installed but
  not registered with Firefox — an update fixes it"; `--mode update` registered
  the key and rewrote the binary (it had refused with "nothing to do" before the
  host-content comparison); a framed `host.info` request to the *installed*
  binary returned `{name: lazyfox-host, protocol: 2.0, version: 0.1.0}`; and
  `--mode list` then printed no host warning for any profile.
- `npm run typecheck` and `npm test` — green, including `check-dist` and the
  payload check (all six committed installers fresh).
- `npm run dev-install` — fresh dev profile created, extension xpi and chrome
  layer installed, and the fixed host installed and registered.
