package app

import (
	"lazyfox/installer/internal/fx"
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
		DefaultInstall:          -1,
		DefaultProfile:          -1,
		DefaultUninstallProfile: -1,
	}

	for _, fi := range view.Installs {
		st.Installs = append(st.Installs, a.installInfo(fi))
	}
	recommended := fx.PickDefaultProfile(view.Profiles)
	for _, p := range view.Profiles {
		info := a.profileInfo(p)
		info.Recommended = recommended != nil && p == recommended
		st.Profiles = append(st.Profiles, info)
	}

	st.DefaultInstall = indexOfInstall(view, view.Install(""))
	st.DefaultProfile = indexOfProfile(view.Profiles, recommended)
	st.DefaultUninstallProfile = st.DefaultProfile
	// An installer-managed install used the profile Lazyfox created, so that is
	// the profile an uninstall starts from.
	if owned := view.OwnedProfile(); owned != nil {
		st.DefaultUninstallProfile = indexOfProfile(view.Profiles, owned)
	}

	st.Actions = []ActionInfo{
		{ID: "install", Label: "Install Lazyfox", Desc: "Add-on and chrome loader"},
		{ID: "uninstall", Label: "Remove Lazyfox", Desc: "Reverses an install, back to plain Firefox"},
		{ID: "loader-only", Label: "Install chrome loader only", Desc: "config.js in the Firefox folder · admin"},
		{ID: "loader-remove", Label: "Remove chrome loader only", Desc: "Deletes config.js · admin"},
	}
	return st
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

func (a *App) profileInfo(p *fx.Profile) ProfileInfo {
	return ProfileInfo{
		Name:       p.Name,
		Dir:        p.Dir,
		Label:      p.Label(),
		Edition:    p.EditionName(),
		Version:    p.FirefoxVersion,
		Flavor:     p.Flavor.String(),
		Locked:     p.Locked,
		HasLazyfox: p.HasLazyfox,
		IsDefault:  p.IsDefault,
		Owned:      fx.IsLazyfoxOwnedProfile(p.Dir),
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
