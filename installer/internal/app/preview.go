package app

import (
	"path/filepath"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// Preview resolves a request and describes exactly what it will do — creating
// nothing, deleting nothing, and writing nothing.
//
// This is the front-end's review screen, and for an uninstall it is the answer
// the user is owed before anything disappears: the complete list of files that
// go, and the complete list of things that stay. Both lists come from the same
// payload registry the uninstall walks, so a file cannot be listed here and
// missed there, or the other way round.
func (a *App) Preview(req Request) (Preview, error) {
	p, err := a.resolve(a.snapshot(), req)
	if err != nil {
		return Preview{}, err
	}
	return a.preview(p), nil
}

func (a *App) preview(p plan) Preview {
	pv := Preview{
		Action:   actionID(p.action),
		Summary:  a.summary(p),
		Warnings: a.warnings(p),
	}
	if p.install != nil {
		pv.Install = a.installInfo(p.install)
	}
	if p.profile != nil {
		pv.Profile = a.profileInfo(p.profile)
		// A profile that is about to be created has no marker on disk yet, so
		// ownership is stated from the decision rather than from the file.
		pv.Profile.Owned = pv.Profile.Owned || p.createsProfile
	}
	pv.CreatesProfile = p.createsProfile
	pv.DeletesProfile = p.deleteProfile

	switch p.action {
	case config.Install:
		pv.Changes = a.installChanges(p)
	case config.Uninstall:
		pv.Removals, pv.Unchanged = a.uninstallInventory(p)
	case config.LoaderOnly:
		pv.Changes = a.loaderChanges(p, false)
	case config.LoaderRemove:
		pv.Removals = a.loaderRemovals(p)
	}

	for _, c := range pv.Changes {
		pv.NeedsAdmin = pv.NeedsAdmin || c.Elevated
	}
	for _, r := range pv.Removals {
		pv.NeedsAdmin = pv.NeedsAdmin || r.Kind == "loader"
	}
	return pv
}

// installChanges is what an install writes, in the order it writes it.
func (a *App) installChanges(p plan) []ChangeInfo {
	if p.profile == nil {
		return nil
	}
	dir := p.profile.Dir
	var out []ChangeInfo

	if p.createsProfile {
		out = append(out, ChangeInfo{
			Path:   dir,
			Kind:   "profile",
			Detail: "a new profile Lazyfox owns — your own profile is not touched",
		})
		out = append(out, ChangeInfo{
			Path:   filepath.Join(p.profile.Root, "profiles.ini"),
			Kind:   "json",
			Detail: "the new profile registered and made the default for this Firefox",
		})
	}

	for _, art := range payload.ChromeArtifacts() {
		out = append(out, ChangeInfo{
			Path:        payload.Dest(dir, art),
			Kind:        "file",
			Detail:      "Lazyfox UI file",
			ProfileSide: true,
		})
	}

	out = append(out, ChangeInfo{
		Path:        payload.Dest(dir, payload.UserJSArtifact()),
		Kind:        "prefs",
		Detail:      "Lazyfox's preferences merged in — every other pref you set is kept",
		ProfileSide: true,
	})

	if p.useExt {
		out = append(out, ChangeInfo{
			Path:        payload.Dest(dir, payload.AddonArtifact()),
			Kind:        "file",
			Detail:      "the Lazyfox add-on (" + a.addonLabel() + ")",
			ProfileSide: true,
		})
		out = append(out, ChangeInfo{
			Path:        filepath.Join(dir, fx.ExtensionsJSONName),
			Kind:        "json",
			Detail:      "Lazyfox registered as enabled",
			ProfileSide: true,
		})
	}

	out = append(out, a.loaderChanges(p, true)...)
	out = append(out, a.hostChanges(p, true)...)
	return out
}

// loaderChanges describes the chrome-loader files in the Firefox installation
// folder — the one step that needs administrator rights.
func (a *App) loaderChanges(p plan, markElevated bool) []ChangeInfo {
	if p.install == nil || p.install.Dir == "" {
		return nil
	}
	var out []ChangeInfo
	for _, art := range payload.LoaderArtifacts() {
		out = append(out, ChangeInfo{
			Path:     payload.Dest(p.install.Dir, art),
			Kind:     "loader",
			Detail:   "keyboard loader, so the leader key works on internal pages",
			Elevated: markElevated && !ops.IsWritable(p.install.Dir),
		})
	}
	return out
}

// hostChanges describes the optional native messaging host. It is listed as
// optional because an install without it is a complete install.
func (a *App) hostChanges(p plan, optional bool) []ChangeInfo {
	if p.profile == nil {
		return nil
	}
	t := ops.NativeHostTargets(p.profile.Dir)
	if t.HostDir == "" {
		return nil
	}
	out := []ChangeInfo{
		{Path: t.HostPath, Kind: "file", Detail: "native messaging host (optional; the add-on works without it)", Optional: optional},
		{Path: t.ManifestPath, Kind: "file", Detail: "the manifest Firefox reads to find the host", Optional: optional},
	}
	if t.Registry {
		out = append(out, ChangeInfo{
			Path:     `HKCU\Software\Mozilla\NativeMessagingHosts\lazyfox`,
			Kind:     "registry",
			Detail:   "registry entry Firefox looks the host up by name in",
			Optional: optional,
		})
	}
	return out
}

// loaderRemovals is what removing the loader deletes.
func (a *App) loaderRemovals(p plan) []RemovalInfo {
	if p.install == nil || p.install.Dir == "" {
		return nil
	}
	out := []RemovalInfo{}
	for _, art := range payload.LoaderArtifacts() {
		path := payload.Dest(p.install.Dir, art)
		if !platform.Exists(path) {
			continue
		}
		out = append(out, RemovalInfo{
			Path:   path,
			Kind:   "loader",
			Detail: "keyboard loader (needs admin)",
			Exists: true,
		})
	}
	return out
}

// uninstallInventory is the uninstall review: everything that will be deleted,
// and everything that will deliberately be left alone.
func (a *App) uninstallInventory(p plan) (removals, unchanged []RemovalInfo) {
	if p.profile == nil {
		return nil, nil
	}
	dir := p.profile.Dir
	owned := fx.IsLazyfoxOwnedProfile(dir)

	for _, art := range payload.ChromeArtifacts() {
		removals = addRemoval(removals, RemovalInfo{
			Path:       payload.Dest(dir, art),
			Kind:       "file",
			Detail:     "Lazyfox UI file",
			Restorable: true,
		})
	}

	removals = addRemoval(removals, RemovalInfo{
		Path:       filepath.Join(dir, payload.UserJSName),
		Kind:       "prefs",
		Detail:     "Lazyfox's preferences taken back out — every other pref you set stays",
		Restorable: true,
	})
	removals = addRemoval(removals, RemovalInfo{
		Path:       payload.Dest(dir, payload.AddonArtifact()),
		Kind:       "file",
		Detail:     "the Lazyfox add-on",
		Restorable: true,
	})
	removals = addRemoval(removals, RemovalInfo{
		Path:       filepath.Join(dir, fx.AddonStartupName),
		Kind:       "file",
		Detail:     "Firefox's add-on import cache (rebuilt on the next start)",
		Restorable: true,
	})
	removals = addRemoval(removals, RemovalInfo{
		Path:       filepath.Join(dir, fx.ExtensionsJSONName),
		Kind:       "json",
		Detail:     "Lazyfox's entry removed; your other add-ons stay",
		Restorable: true,
	})

	if p.removeLoader {
		removals = append(removals, a.loaderRemovals(p)...)
	} else if p.install != nil && p.install.Dir != "" {
		unchanged = append(unchanged, RemovalInfo{
			Path:   p.install.Dir,
			Kind:   "loader",
			Detail: "chrome loader left in place (removing it needs admin)",
			Exists: true,
		})
	}

	// The native host is deliberately not part of an uninstall today, so it is
	// reported as staying rather than quietly promised away.
	if t := ops.NativeHostTargets(dir); t.HostPath != "" {
		unchanged = append(unchanged, RemovalInfo{
			Path:   t.HostPath,
			Kind:   "file",
			Detail: "native messaging host left in place",
			Exists: platform.Exists(t.HostPath),
		})
	}

	if p.deleteProfile {
		// Only reachable for a profile carrying the Lazyfox marker: the plan
		// refuses the request otherwise.
		removals = append(removals, RemovalInfo{
			Path:   dir,
			Kind:   "profile",
			Detail: "the whole profile — Lazyfox created it, so removing it is safe",
			Exists: true,
			Owned:  true,
		})
		unchanged = append(unchanged, RemovalInfo{
			Path:   filepath.Join(p.profile.Root, "profiles.ini"),
			Kind:   "json",
			Detail: "cleaned up: the profile entry goes, and a surviving profile gets the Default flag back",
			Exists: true,
		})
	} else if owned {
		unchanged = append(unchanged, RemovalInfo{
			Path:   dir,
			Kind:   "profile",
			Detail: "the Lazyfox profile Lazyfox created (you can ask for it to be deleted)",
			Exists: true,
			Owned:  true,
		})
	} else {
		unchanged = append(unchanged, RemovalInfo{
			Path:   dir,
			Kind:   "profile",
			Detail: "your own profile — bookmarks, history, passwords, cookies and your other add-ons",
			Exists: true,
		})
	}
	return removals, unchanged
}

// addRemoval appends a removal only when the file is actually there, so the
// review shows what exists rather than what might have existed.
func addRemoval(list []RemovalInfo, r RemovalInfo) []RemovalInfo {
	r.Exists = platform.Exists(r.Path)
	if !r.Exists {
		return list
	}
	return append(list, r)
}

// summary words the operation in one line.
func (a *App) summary(p plan) string {
	ff := a.cfg.Channel.ShortName()
	if p.install != nil && p.install.Label != "" {
		ff = p.install.Label
	}
	switch p.action {
	case config.Install:
		where := "your own profile"
		if p.profile != nil {
			where = p.profile.Name
		}
		if p.createsProfile {
			where = "a new Lazyfox profile (" + p.newProfileName + ")"
		}
		return "Install Lazyfox into " + where + " in " + ff
	case config.Uninstall:
		where := "the selected profile"
		if p.profile != nil {
			where = p.profile.Name
		}
		return "Remove Lazyfox from " + where
	case config.LoaderOnly:
		return "Install the chrome loader into " + ff
	case config.LoaderRemove:
		return "Remove the chrome loader from " + ff
	}
	return ""
}

// warnings are the things worth saying before a run.
func (a *App) warnings(p plan) []string {
	var out []string
	if p.profile != nil && p.profile.Locked {
		out = append(out, "Firefox is using this profile right now; the installer closes it first and can reopen it afterwards.")
	}
	switch p.action {
	case config.Install:
		if p.profile != nil && !p.createsProfile && p.profile.HasLazyfox {
			out = append(out, "Lazyfox is already in this profile — the install refreshes it in place.")
		}
		if !a.src.HasDist() {
			out = append(out, "No repo dist/ folder found: the payload embedded in this binary is used.")
		}
		if !a.src.AddonAvailable() {
			out = append(out, "This build carries no add-on payload, so only the chrome loader can be installed.")
		}
		if p.install != nil && p.install.Dir != "" && !ops.IsWritable(p.install.Dir) {
			out = append(out, "The loader step needs administrator rights; your system will ask once.")
		}
	case config.Uninstall:
		if p.profile != nil && !p.createsProfile && !fx.IsLazyfoxOwnedProfile(p.profile.Dir) {
			out = append(out, "This is your own profile. Only Lazyfox's own files go — your bookmarks, history, saved logins and other add-ons stay.")
		}
		if p.profile != nil && !p.profile.HasLazyfox && !platform.Exists(filepath.Join(p.profile.Dir, "chrome", "userChrome.uc.js")) {
			out = append(out, "Lazyfox does not look installed in this profile; there may be nothing to remove.")
		}
	}
	return out
}

// addonLabel names the add-on build this installer carries.
func (a *App) addonLabel() string {
	if a.cfg.Channel.IsDev() {
		return "unsigned dev build"
	}
	return "signed store build"
}

// actionID is the wire name of an action.
func actionID(a config.Action) string {
	switch a {
	case config.Install:
		return "install"
	case config.Uninstall:
		return "uninstall"
	case config.LoaderOnly:
		return "loader-only"
	case config.LoaderRemove:
		return "loader-remove"
	}
	return ""
}

// parseAction reads an action name leniently, defaulting to a full install.
func parseAction(s string) config.Action {
	switch s {
	case "uninstall":
		return config.Uninstall
	case "loader-only":
		return config.LoaderOnly
	case "loader-remove":
		return config.LoaderRemove
	case "install":
		return config.Install
	}
	return config.Install
}
