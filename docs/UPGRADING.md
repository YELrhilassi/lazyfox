# Updating and uninstalling

This is about the installed product: getting a new Lazyfox build without
uninstalling anything, and removing every piece when the user asks. (For what a
new *Firefox* release does to the chrome layer, see [UPDATES.md](UPDATES.md).)

Lazyfox is four independently versioned pieces — the add-on, the Go wasm core,
the native messaging host and the chrome helper — and nothing makes them move
together. That is the whole shape of this problem: an update is not "download a
new file", it is "make every piece in this profile match one build, without
losing anything". Both the installer and the extension are built around that.

Nothing here requires an uninstall first.

## Updating

### The installer

```sh
lazyfox-install --mode update
```

- Finds the Firefox of this installer's channel, then the profile that holds
  Lazyfox: the one the installer created (`dev-<id>` / `lazyfox-<id>`), else the
  profile that actually carries the add-on, else the channel's active profile.
  `--profile` names one explicitly.
- Measures the install against the binary it is running from: the installed
  xpi's own `manifest.json` is the installed version, the payload's embedded xpi
  is the new one.
- **Refuses** when there is nothing to update (that is an install, not an
  update), and **refuses to downgrade** a profile that already holds a newer
  build unless `--force` is passed.
- **Does nothing** when the profile is already current, rather than restarting
  Firefox to rewrite identical bytes. `--force` re-applies anyway.
- Otherwise rewrites the chrome files, merges the managed prefs, refreshes the
  chrome loader and the add-on, drops Firefox's add-on cache so the fresh xpi is
  imported, and verifies the result on disk.

`--mode install` remains the "make Lazyfox be here" path: it may create a
profile and works on an empty one. It is also idempotent, so running it over an
existing install updates it — the update mode exists to make the *intent*
explicit and to refuse the cases where "install" would be the wrong answer.

The window has the same thing as an action. It appears only when some profile
holds Lazyfox, names the version move (`Update Lazyfox 0.5.9 → 0.5.10`), shows
the same file list an install does, and reports "updated" separately from
"installed".

Opening the window on a machine that already has an older or partial install
lands on **Update**, not on **Install**: the download's job on that machine is
to make it current, and "install over what you have" reads like a reinstall of
the very thing that is being replaced. Select Install explicitly to force a full
write instead.

### The extension

The settings page's **Components** panel answers the local half of the question
with no network at all: are the pieces installed here from the same build? A
chrome helper older than the add-on means the add-on moved ahead of the layer
that implements the keys — the state that looks like a bug and is really a
half-applied update. The panel says so in words ("run the installer to update it
in place") and offers the installer download.

The other half — "is there a newer release?" — is asked once at the start of a
browser session, and can also be asked on demand from the panel. It compares the
newest release with `runtime.getManifest().version` and offers the release page
when one is newer.

**Once per launch, and one notification.** The launch check is not a poll: no
timer, no re-check on focus or navigation, and the once-per-session guard is
`storage.session`, which Firefox clears when the browser closes. A background
page restarting mid-session (event pages do that constantly) therefore cannot
notify twice; tomorrow's launch can. The notification names the version and says
the installer updates in place — it is the only thing that can replace the
chrome layer and the native host, because the add-on is not allowed to.

A failure (offline, rate limit, odd response) is silent at launch — an update
check that cannot answer is not news — and is reported as "could not check" in
the panel, never as an exception.

## The native host is installed AND registered

The host is optional, but "installed" is two things on Windows: the binary and
manifest under `%LOCALAPPDATA%\Lazyfox`, *and* the
`HKCU\Software\Mozilla\NativeMessagingHosts\lazyfox` key that points Firefox at
the manifest. Without the key the files are all present, every file check
passes, and `connectNative` still fails — which the extension can only report as
"native host: missing".

So the installer now measures the registration rather than assuming it: `Verify`
fails an install whose host is present but unregistered, `--mode list` says so
per profile, the window marks the profile, and `--mode update` treats it as work
to do even when every version and file is current. `--mode uninstall` removes the
key, and `VerifyRemoved` reports one left behind.

The host binary itself is compared byte-for-byte with the payload, like the
chrome files. That is what lets a fix to the host reach an existing install:
without it, `--mode update` sees a current add-on and answers "nothing to do",
and the binary is versioned separately from the add-on for exactly this reason.
An update stops running host processes before replacing the file (a live host
holds its own `.exe` open on Windows) and still writes the manifest and key when
the binary cannot be replaced yet, because those are what Firefox looks up.

## Uninstalling

`--mode uninstall` (or Remove in the window) removes **every** component the
install wrote:

| Component | Where |
|-----------|-------|
| chrome UI files | `<profile>/chrome/*` (the directory too, when empty) |
| managed prefs | merged out of `<profile>/user.js`; every other pref stays, and the file goes when nothing but ours was in it |
| add-on xpi | `<profile>/extensions/lazyfox@lazyfox.dev.xpi` |
| Firefox's add-on cache | `<profile>/addonStartup.json.lz4` |
| registry entry | Lazyfox's object in `<profile>/extensions.json`; other add-ons stay |
| native messaging host | `~/.local/bin/lazyfox-host` / `%LOCALAPPDATA%\Lazyfox\`, its manifest, and the Windows registry key |
| chrome loader | `config.js` + `defaults/pref/config-prefs.js` in the Firefox folder (needs admin; `--keep-loader` opts out) |
| profile | only a Lazyfox-created one, only with `--delete-profile`, and only with its `.lazyfox-profile` marker |

Two of those used to be missing, and neither was visible from the outside: the
native host was never removed at all (an uninstalled Lazyfox left a privileged
helper and a manifest that allow-lists its id), and the loader was kept unless
the user remembered `--remove-loader` (autoconfig left switched on, pointing at a
chrome layer that no longer existed). The default is now removal; keeping it is
the opt-in, for the one real case where another product shares those files.

### Removal is measured

`ops.RunUninstall` ends with `ops.VerifyRemoved`: it reads the files back off
disk and returns everything of ours that is still there — with the reason when
there is one ("Firefox is running; quit it and re-run"). The CLI exits non-zero
and lists them; the window shows them under the outcome. A removal that is not
checked is a removal that can silently half-succeed, which is the same mistake
`ops.Verify` was written to prevent for installs.

Backups are unchanged: every file removed is copied to a timestamped
`.lazyfox.uninst.bak-*` sibling first, so an uninstall is still reversible by
hand. Those backups are not Lazyfox state and are never treated as leftovers.
