package app

import (
	"fmt"
	"regexp"
	"strings"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
)

// plan is a fully resolved, validated operation. The window never hands the
// operations layer a path: it hands a Request, this resolves it against the
// channel's view, and only a plan that validated is executed.
type plan struct {
	action  config.Action
	install *fx.Install
	profile *fx.Profile

	// newProfileName is the name a fresh Lazyfox-owned profile will get. It is
	// decided at preview time and reused at run time, so the folder the user was
	// shown is the folder that gets created.
	newProfileName string
	createsProfile bool
	// reason explains the profile decision in the progress log.
	reason string

	useExt    bool
	useLaunch bool
	// keepLoader leaves the chrome loader installed on an uninstall. Removing it
	// is the default (see ops.UninstallOptions), so this is opt-in.
	keepLoader bool
	// deleteProfile removes a Lazyfox-owned profile as part of an uninstall.
	deleteProfile bool
	// updateFrom is the version an update is replacing, filled in at resolve time
	// so the summary and the run cannot disagree about what is changing.
	updateFrom string
}

// profileNameRe is the shape a profile directory name may take. The name becomes
// a folder under the Firefox profile root, so anything that could escape that
// root (a separator, "..", an absolute path) is refused rather than sanitised.
var profileNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// resolve turns a request into a validated plan. It reads the machine and
// creates nothing — that is what makes Preview safe to call on every keystroke.
func (a *App) resolve(view fx.View, req Request) (plan, error) {
	p := plan{
		action:        parseAction(req.Action),
		useExt:        req.UseExtension,
		useLaunch:     req.UseLaunch,
		keepLoader:    req.KeepLoader,
		deleteProfile: req.DeleteProfile,
	}
	p.install = a.pickInstall(view, req)

	if p.action == config.LoaderOnly || p.action == config.LoaderRemove {
		if p.install == nil {
			return p, a.noInstallError()
		}
		return p, nil
	}

	// Install and uninstall both need a target Firefox. A path this channel
	// cannot see is refused with the reason, never silently redirected.
	if p.install == nil {
		return p, a.installError(view, req)
	}
	switch p.action {
	case config.Install:
		return a.resolveInstall(view, req, p)
	case config.Update:
		return a.resolveUpdate(view, req, p)
	}
	return a.resolveUninstall(view, req, p)
}

// resolveUpdate resolves an in-place update of an install that is already there.
//
// It never creates a profile and it refuses when the chosen profile has no
// Lazyfox in it, because "update" that silently becomes "install" would hide a
// wrong choice instead of showing it. The profile it picks on its own follows
// what an installer-managed install actually used: ours first, then whichever
// profile carries the add-on.
func (a *App) resolveUpdate(view fx.View, req Request, p plan) (plan, error) {
	if req.NewProfile {
		return p, fmt.Errorf("an update refreshes the profile Lazyfox is already in — choose a profile instead of creating one")
	}
	if dir := strings.TrimSpace(req.ProfileDir); dir != "" {
		p.profile = view.Profile(dir)
	} else if owned := view.OwnedProfile(); owned != nil {
		p.profile = owned
	} else {
		for _, pr := range view.Profiles {
			if pr.HasLazyfox {
				p.profile = pr
				break
			}
		}
	}
	if p.profile == nil {
		p.profile = a.pickProfile(view, req)
	}
	if p.profile == nil {
		return p, fmt.Errorf("no %s profile found to update", a.cfg.Channel.ShortName())
	}

	installDir := ""
	if p.install != nil {
		installDir = p.install.Dir
	}
	in := ops.Inspect(a.src, p.profile.Dir, installDir)
	if !in.IsInstalled() {
		return p, fmt.Errorf("Lazyfox is not installed in %s — Install puts it there", p.profile.Name)
	}
	p.updateFrom = in.AddonVersion
	// An update means "make this profile match this binary", so the add-on is
	// always refreshed; only the launch choice is left to the user.
	p.useExt = true
	p.reason = "updating " + p.profile.Name
	return p, nil
}

// resolveInstall resolves where an install goes.
//
// The dev channel always installs into its own disposable profile: there is no
// choice to make, and the user's own dev profile is never modified. The stable
// channel is where a choice exists — the profile Firefox uses, or a fresh
// Lazyfox-owned one — and asking is exactly what the window does.
func (a *App) resolveInstall(view fx.View, req Request, p plan) (plan, error) {
	// An explicit "new profile" wins over whatever the list had selected, on
	// both channels: the user asked for a profile of their own rather than a
	// modification of one they already have.
	if req.NewProfile {
		return a.planNewProfile(view, req, p)
	}

	if a.cfg.Channel.IsDev() {
		decision, err := fx.DecideInstall(p.install, view.Profiles, a.cfg.Channel)
		if err != nil {
			return p, err
		}
		// The window reviews a plan and then runs it, and the review names the
		// profile. When it echoes that name back, use exactly it: a plan that
		// showed one folder and created another would be worse than no preview.
		if decision.Created && strings.TrimSpace(req.NewProfileName) != "" {
			name, err := a.newProfileName(view, req.NewProfileName)
			if err != nil {
				return p, err
			}
			planned, err := fx.PlannedOwnedProfileNamed(p.install, view.Profiles, a.cfg.Channel, name)
			if err != nil {
				return p, err
			}
			decision.Profile = planned
			decision.Reason = "created dev profile " + name
		}
		p.profile = decision.Profile
		p.createsProfile = decision.Created
		if decision.Created && decision.Profile != nil {
			p.newProfileName = decision.Profile.Name
		}
		p.reason = decision.Reason
		return p, nil
	}

	p.profile = a.pickProfile(view, req)
	if p.profile == nil {
		if len(view.Profiles) == 0 {
			// Nothing to install into at all: the only sensible target is a
			// fresh profile, and saying so beats an empty list.
			return a.planNewProfile(view, req, p)
		}
		return p, fmt.Errorf("choose which Firefox profile to install into")
	}
	p.reason = "using your profile " + p.profile.Name
	return p, nil
}

// planNewProfile resolves a request for a fresh Lazyfox-owned profile. The name
// is decided here, at preview time, and reused at run time.
func (a *App) planNewProfile(view fx.View, req Request, p plan) (plan, error) {
	name, err := a.newProfileName(view, req.NewProfileName)
	if err != nil {
		return p, err
	}
	prof, err := fx.PlannedOwnedProfileNamed(p.install, view.Profiles, a.cfg.Channel, name)
	if err != nil {
		return p, err
	}
	p.profile = prof
	p.newProfileName = name
	p.createsProfile = true
	p.reason = "creating a new Lazyfox profile: " + name
	return p, nil
}

// resolveUninstall resolves an uninstall and, importantly, refuses to delete
// anything that is not provably Lazyfox's. A profile without the marker is the
// user's own, and the request is declined rather than quietly honoured.
func (a *App) resolveUninstall(view fx.View, req Request, p plan) (plan, error) {
	p.profile = a.pickProfile(view, req)
	if p.profile == nil {
		if len(view.Profiles) == 0 {
			return p, fmt.Errorf("no %s profile found to remove Lazyfox from", a.cfg.Channel.ShortName())
		}
		return p, fmt.Errorf("choose which Firefox profile to remove Lazyfox from")
	}
	if req.DeleteProfile && !fx.IsLazyfoxOwnedProfile(p.profile.Dir) {
		// Never silently, and never partially: the window shows this as a
		// refusal rather than a no-op that pretended to comply.
		return p, fmt.Errorf("refused to delete %s: Lazyfox did not create that profile", p.profile.Dir)
	}
	p.deleteProfile = req.DeleteProfile
	return p, nil
}

// newProfileName validates an explicit name, or invents one.
func (a *App) newProfileName(view fx.View, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return fx.NewOwnedProfileName(a.cfg.Channel)
	}
	if !profileNameRe.MatchString(requested) {
		return "", fmt.Errorf("%q is not a usable profile name; use letters, digits, dot, dash or underscore", requested)
	}
	// Never adopt a profile that is already there under a different name: a
	// colliding name would mean writing our ownership marker into the user's
	// own profile folder — the one mistake here that cannot be undone.
	for _, p := range view.Profiles {
		if p.Name == requested && !fx.IsLazyfoxOwnedProfile(p.Dir) {
			return "", fmt.Errorf("a profile called %q already exists and is not Lazyfox's; pick another name", requested)
		}
	}
	return requested, nil
}

// pickInstall resolves the chosen Firefox from this session's channel view: by
// explicit directory when the window supplied one, otherwise the channel's best.
// A path that is not this channel's Firefox resolves to nil.
func (a *App) pickInstall(view fx.View, req Request) *fx.Install {
	if strings.TrimSpace(req.InstallDir) != "" {
		return view.Install(req.InstallDir)
	}
	return view.Install("")
}

// pickProfile resolves the chosen profile from this session's channel view.
//
// With no profile named it falls back to the same heuristic an unattended
// install uses (SelectActiveProfile), so the window and --mode auto cannot
// disagree about which profile is "the one Firefox uses".
func (a *App) pickProfile(view fx.View, req Request) *fx.Profile {
	if dir := strings.TrimSpace(req.ProfileDir); dir != "" {
		return view.Profile(dir)
	}
	return fx.SelectActiveProfile(view.Profiles, view.Install(""))
}

// noInstallError is the "nothing to act on" message for the loader-only actions.
func (a *App) noInstallError() error {
	return fmt.Errorf("no %s installation found to write the loader into", a.cfg.Channel.ShortName())
}

// installError explains why an explicitly chosen Firefox was refused, in the
// terms of the window rather than of the CLI.
func (a *App) installError(view fx.View, req Request) error {
	if strings.TrimSpace(req.InstallDir) != "" && !view.Empty() {
		return fx.ErrForeignInstall(req.InstallDir, a.cfg.Channel)
	}
	return fx.ErrNoChannelInstall(a.cfg.Channel)
}
