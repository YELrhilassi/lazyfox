package app

import (
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// state builds the machine picture the window renders. It only reads: nothing
// here writes to Firefox, so the window can be closed at any point.
func (a *App) state(view fx.View) State {
	st := State{
		Channel:                 a.cfg.Channel.String(),
		ChannelShort:            a.cfg.Channel.ShortName(),
		ChannelLabel:            a.cfg.Channel.Label(),
		ProfilePolicy:           a.cfg.Channel.ProfilePolicy(),
		DevChannel:              a.cfg.Channel.IsDev(),
		Platform:                string(platform.HostOS()),
		PayloadOrigin:           a.src.Origin(),
		HasDist:                 a.src.HasDist(),
		AddonAvailable:          a.src.AddonAvailable(),
		AddonVersion:            a.src.AddonVersion(),
		DefaultInstall:          -1,
		DefaultProfile:          -1,
		DefaultUninstallProfile: -1,
		DefaultUpdateProfile:    -1,
	}

	installDir := ""
	if fi := view.Install(""); fi != nil {
		installDir = fi.Dir
	}

	for _, fi := range view.Installs {
		st.Installs = append(st.Installs, a.installInfo(fi))
	}
	recommended := fx.PickDefaultProfile(view.Profiles)
	for _, p := range view.Profiles {
		info := a.profileInfo(p, installDir)
		info.Recommended = recommended != nil && p == recommended
		st.Profiles = append(st.Profiles, info)
		st.UpdateAvailable = st.UpdateAvailable || needsUpdate(info.LazyfoxState) ||
			info.HostState == hostUnregistered || info.HostState == hostStale
	}

	st.DefaultInstall = indexOfInstall(view, view.Install(""))
	st.DefaultProfile = indexOfProfile(view.Profiles, recommended)
	st.DefaultUninstallProfile = st.DefaultProfile
	// An installer-managed install used the profile Lazyfox created, so that is
	// the profile an uninstall starts from.
	if owned := view.OwnedProfile(); owned != nil {
		st.DefaultUninstallProfile = indexOfProfile(view.Profiles, owned)
	}

	// An update starts from the install that needs it, then from ours, then from
	// whatever the channel would use by default — so opening the window on an
	// out-of-date machine lands on the update that fixes it.
	st.DefaultUpdateProfile = st.DefaultProfile
	for i, p := range st.Profiles {
		if needsUpdate(p.LazyfoxState) {
			st.DefaultUpdateProfile = i
			break
		}
	}

	anyInstalled := false
	for _, p := range st.Profiles {
		if p.LazyfoxState != string(ops.StatusNotInstalled) {
			anyInstalled = true
			break
		}
	}
	st.Actions = []ActionInfo{
		{ID: "install", Label: "Install Lazyfox", Desc: "Add-on and chrome loader"},
	}
	if anyInstalled {
		st.Actions = append(st.Actions, ActionInfo{ID: "update", Label: "Update Lazyfox", Desc: a.updateDesc(st)})
	}
	st.Actions = append(st.Actions,
		ActionInfo{ID: "uninstall", Label: "Remove Lazyfox", Desc: "Reverses an install, back to plain Firefox"},
		ActionInfo{ID: "loader-only", Label: "Install chrome loader only", Desc: "config.js in the Firefox folder · admin"},
		ActionInfo{ID: "loader-remove", Label: "Remove chrome loader only", Desc: "Deletes config.js · admin"},
	)
	return st
}

// updateDesc words the update action from what is actually installed: offering
// "Update" next to a version that is already current would be the kind of
// button-lying this window avoids.
func (a *App) updateDesc(st State) string {
	if st.UpdateAvailable {
		target := st.AddonVersion
		if target == "" {
			target = "this build"
		}
		return "Refreshes the existing install in place to " + target
	}
	for _, p := range st.Profiles {
		if p.LazyfoxState == string(ops.StatusNewer) {
			return "This build is older than the installed " + p.LazyfoxVersion
		}
	}
	return "Already up to date"
}

func needsUpdate(state string) bool {
	return state == string(ops.StatusOutdated) || state == string(ops.StatusIncomplete)
}

func (a *App) installInfo(fi *fx.Install) InstallInfo {
	return InstallInfo{
		Label:  fi.Label,
		Exec:   fi.Exec,
		Dir:    fi.Dir,
		Flavor: fi.Flavor.String(),
		Loader: loaderState(a.src, fi),
	}
}

// profileInfo describes one profile, including what Lazyfox is doing in it.
// installDir may be empty; the loader state is then simply not measured.
func (a *App) profileInfo(p *fx.Profile, installDir string) ProfileInfo {
	in := ops.Inspect(a.src, p.Dir, installDir)
	return ProfileInfo{
		Name:           p.Name,
		Dir:            p.Dir,
		Label:          p.Label(),
		Edition:        p.EditionName(),
		Version:        p.FirefoxVersion,
		Flavor:         p.Flavor.String(),
		Locked:         p.Locked,
		HasLazyfox:     p.HasLazyfox,
		IsDefault:      p.IsDefault,
		Owned:          fx.IsLazyfoxOwnedProfile(p.Dir),
		LazyfoxVersion: in.AddonVersion,
		LazyfoxState:   string(in.Status()),
		HostState:      hostState(in),
	}
}

// The three host states the window distinguishes. "missing" is not a warning:
// the host is optional, and a store install never has one.
const (
	hostMissing      = "missing"
	hostOK           = "ok"
	hostUnregistered = "unregistered"
	hostStale        = "stale"
)

func hostState(in ops.Installed) string {
	switch {
	// The host is machine-wide, so a profile without Lazyfox has nothing to say
	// about it — reporting it there would put the same warning on every row.
	case !in.IsInstalled() || !in.HostPresent:
		return hostMissing
	case !in.HostReachable:
		// Unreachable is the louder problem: a stale binary that Firefox cannot
		// find at all is reported as the missing key, which is the thing to fix.
		return hostUnregistered
	case in.HostExpected && !in.HostCurrent:
		return hostStale
	default:
		return hostOK
	}
}

// loaderState reports whether the loader files in an install dir are current.
func loaderState(src *payload.Source, fi *fx.Install) string {
	current, present := 0, 0
	for _, art := range payload.LoaderArtifacts() {
		dst := payload.Dest(fi.Dir, art)
		if !platform.Exists(dst) {
			continue
		}
		present++
		if src.UpToDate(art, dst) {
			current++
		}
	}
	switch {
	case present == 0:
		return "missing"
	case current == len(payload.LoaderArtifacts()):
		return "current"
	default:
		return "outdated"
	}
}

func indexOfInstall(view fx.View, want *fx.Install) int {
	if want == nil {
		return -1
	}
	for i, fi := range view.Installs {
		if fi == want {
			return i
		}
	}
	return -1
}

func indexOfProfile(profiles []*fx.Profile, want *fx.Profile) int {
	if want == nil {
		return -1
	}
	for i, p := range profiles {
		if p == want {
			return i
		}
	}
	return -1
}
