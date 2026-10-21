package main

import (
	"fmt"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// runUpdate is `--mode update`: bring an ALREADY INSTALLED Lazyfox up to the
// version this binary carries, in place.
//
// WHY A SEPARATE MODE WHEN `install` ALREADY OVERWRITES. Because the two ask
// different questions. `install` is "make Lazyfox be here" — it may create a
// profile, import an add-on for the first time, and works on an empty profile.
// `update` is "replace what is there, and nothing else" — it refuses when there
// is nothing to update (that is a mistake, not an install), it never creates a
// profile, and when the profile is already current it does nothing at all
// rather than restarting Firefox for no reason.
//
// That is the whole point of the mode: the answer to "how do I get 0.5.11?" is
// `installer --mode update`, one command that does not require the user to know
// whether to uninstall first, where the profile is, or which version they have.
func runUpdate(src *payload.Source, rep ops.Reporter, cfg config.Config) error {
	view := fx.Scan(cfg.Channel)
	install, err := pickInstall(view, cfg)
	if err != nil {
		return err
	}
	prof, err := updateProfile(view, install, cfg, rep)
	if err != nil {
		return err
	}

	rep.Note("Channel: %s", cfg.Channel.Label())
	rep.Note("Firefox: %s", install.Label)
	rep.Note("Profile: %s", prof.Name)

	prev := ops.Inspect(src, prof.Dir, install.Dir)
	prevStatus := prev.Status()
	if prevStatus == ops.StatusNotInstalled {
		return fmt.Errorf("Lazyfox is not installed in %s — there is nothing to update.\n"+
			"Run the installer without --mode to install it, or --mode install.", prof.Name)
	}
	if prevStatus == ops.StatusNewer {
		rep.Warn("%s already has Lazyfox %s, which is newer than this build (%s).", prof.Name, prev.AddonVersion, prev.PayloadVersion)
		if !cfg.Force {
			return fmt.Errorf("refusing to downgrade %s from %s to %s; pass --force to replace it anyway",
				prof.Name, prev.AddonVersion, prev.PayloadVersion)
		}
	}
	if !prev.NeedsWork() && prevStatus != ops.StatusNewer && !cfg.Force {
		rep.Step("Lazyfox %s is already up to date in %s — nothing to do.", prev.PayloadVersion, prof.Name)
		if !prev.LoaderPresent {
			rep.Note("The chrome loader is not installed; --mode install (or --mode loader-only) adds it.")
		}
		return nil
	}
	// The from→to line is printed by ops.Run itself, so every front-end reports
	// the same thing and this one does not print it twice.
	if err := ops.Run(src, rep, ops.InstallOptions{
		Profile:      prof,
		Install:      install,
		UseExtension: !cfg.NoExt,
		UseLaunch:    !cfg.NoLaunch,
		ForceLoader:  cfg.Force,
		XpiPath:      cfg.XpiPath,
	}, passwordProvider(cfg)); err != nil {
		return err
	}

	failures, pending := ops.Verify(src, prof.Dir)
	for _, f := range failures {
		rep.Warn("verification: %s", f)
	}
	if len(failures) > 0 {
		return fmt.Errorf("the update did not verify in %s", prof.Name)
	}
	rep.Step("Updated and verified in %s", prof.Name)
	if pending {
		rep.Note("Restart Firefox to finish applying the update.")
	}
	return nil
}

// installedLabel words one profile's installed state for `--mode list`, or ""
// when the profile has no Lazyfox in it (saying so on every profile would bury
// the one line that matters).
func installedLabel(in ops.Installed) string {
	label := installedLabelBase(in)
	// A host that is on disk but not registered is invisible to the extension and
	// to every check that only looks at files, so the one report a user reads
	// before deciding to update names it.
	if label != "" && in.HostPresent && !in.HostReachable {
		label += "  [native host installed but not registered with Firefox — an update fixes it]"
	} else if label != "" && in.HostExpected && in.HostPresent && !in.HostCurrent {
		label += "  [native host is from an older build — an update refreshes it]"
	}
	return label
}

// installedLabelBase is the version/state half of installedLabel.
func installedLabelBase(in ops.Installed) string {
	switch in.Status() {
	case ops.StatusNotInstalled:
		return ""
	case ops.StatusCurrent:
		return "  [lazyfox " + in.AddonVersion + " — current]"
	case ops.StatusOutdated:
		return "  [lazyfox " + in.AddonVersion + " — update to " + in.PayloadVersion + " available]"
	case ops.StatusNewer:
		return "  [lazyfox " + in.AddonVersion + " — newer than this build's " + in.PayloadVersion + "]"
	case ops.StatusIncomplete:
		// Incomplete with a known version means the add-on is the same build as
		// this one but the chrome layer is not (a half-applied update, or a
		// profile written by an older installer); no version at all means the
		// add-on is gone while our chrome files are still there. The two read
		// differently to a user, so they are worded differently.
		if !in.AddonPresent {
			return "  [add-on missing — an update reinstalls it]"
		}
		version := in.AddonVersion
		if version == "" {
			version = "version unreadable"
		}
		if in.ChromePresent < in.ChromeTotal {
			return "  [lazyfox " + version + " — files are missing; an update repairs it]"
		}
		return "  [lazyfox " + version + " — files differ from this build; an update refreshes them]"
	}
	return ""
}

// updateProfile resolves which profile an update targets, without prompting and
// without ever inventing one: an explicit --profile wins, then the profile
// Lazyfox created for this channel, then the profile that actually has the
// add-on, then the channel's active profile.
//
// The order matters for the update case specifically: an installer-managed dev
// install lives in its own profile, and an existing install in the user's own
// stable profile is found by its add-on rather than by the "default" heuristic.
func updateProfile(view fx.View, install *fx.Install, cfg config.Config, rep ops.Reporter) (*fx.Profile, error) {
	if cfg.HasProfileArg {
		prof := view.Profile(cfg.Profile)
		if prof == nil {
			if platform.IsDir(cfg.Profile) {
				return nil, fx.ErrForeignProfile(cfg.Profile)
			}
			return nil, fx.ErrNoProfile
		}
		return prof, nil
	}
	if owned := view.OwnedProfile(); owned != nil {
		return owned, nil
	}
	for _, p := range view.Profiles {
		if p.HasLazyfox {
			return p, nil
		}
	}
	prof := fx.SelectActiveProfile(view.Profiles, install)
	if prof == nil {
		return nil, fx.ErrNoProfile
	}
	rep.Note("No Lazyfox install found in a Lazyfox profile; using %s.", prof.Name)
	return prof, nil
}
