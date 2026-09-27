package app

import (
	"errors"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
)

// errUnknownAction can only happen when a front-end sends an action name that
// was never offered, so it is a guard rather than a user-facing case.
var errUnknownAction = errors.New("unsupported action")

// execute carries out a validated plan, streaming progress to the window.
//
// Every branch ends in a Result rather than an error, because at this point the
// interesting thing is not "it failed" but what state the machine is left in —
// and for an install, that is decided by reading the files back off disk
// (ops.Verify) rather than by trusting the step that wrote them.
func (a *App) execute(p plan) Result {
	rep := &eventReporter{ctx: a.ctx}
	// The window elevates through the system's own prompt (UAC, polkit,
	// osascript); it has no terminal and no password field, so declining here is
	// correct rather than a limitation.
	var pw ops.PasswordProvider = ops.Declined

	switch p.action {
	case config.Install:
		profile, err := a.materializeProfile(p)
		if err != nil {
			return failure(err)
		}
		if p.reason != "" {
			rep.Note("%s", p.reason)
		}
		if err := ops.Run(a.src, rep, ops.InstallOptions{
			Profile:      profile,
			Install:      p.install,
			UseExtension: p.useExt,
			UseLaunch:    p.useLaunch,
		}, pw); err != nil {
			return failure(err)
		}
		failures, pending := ops.Verify(a.src, profile.Dir)
		if len(failures) > 0 {
			return Result{
				OK:       false,
				State:    "failed",
				Text:     "Lazyfox was installed, but the install did not verify.",
				Failures: failures,
			}
		}
		return Result{OK: true, State: "installed", Text: "Lazyfox is installed.", PendingEnable: pending}

	case config.Uninstall:
		if err := ops.RunUninstall(a.src, rep, ops.UninstallOptions{
			Profile:         p.profile,
			Install:         p.install,
			RemoveLoader:    p.removeLoader,
			RemoveDedicated: p.deleteProfile,
		}, pw); err != nil {
			return failure(err)
		}
		a.refreshView()
		return Result{OK: true, State: "removed", Text: "Lazyfox is removed. Firefox is back to normal."}

	case config.LoaderOnly:
		if err := ops.InstallChromeLoader(a.src, rep, p.install, false, pw); err != nil {
			return failure(err)
		}
		return Result{OK: true, State: "installed", Text: "The chrome loader is installed."}

	case config.LoaderRemove:
		if err := ops.RemoveChromeLoader(a.src, rep, p.install, pw); err != nil {
			return failure(err)
		}
		return Result{OK: true, State: "removed", Text: "The chrome loader is removed."}
	}
	return failure(errUnknownAction)
}

// materializeProfile creates the profile a plan promised, under exactly the name
// the preview showed. Nothing is created for an existing profile.
func (a *App) materializeProfile(p plan) (*fx.Profile, error) {
	if !p.createsProfile || p.profile == nil {
		return p.profile, nil
	}
	profile, err := fx.EnsureOwnedProfile(p.install, a.snapshot().Profiles, a.cfg.Channel, p.newProfileName)
	if err != nil {
		return nil, err
	}
	// The machine changed: re-scan so the next State() call lists the new
	// profile instead of the machine as it was when the window opened.
	a.refreshView()
	return profile, nil
}

// failure wraps an execution error as a Result, so the window can show the
// message next to the log that produced it.
func failure(err error) Result {
	return Result{OK: false, State: "failed", Text: err.Error()}
}
