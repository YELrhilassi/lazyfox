package main

import (
	"fmt"
	"path/filepath"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
	"lazyfox/installer/internal/payload"
)

// runAuto is the hands-off install: it detects the Firefox of this installer's
// channel, resolves the profile that channel's policy wants, installs and
// verifies.
//
// It is the path a one-click download uses, so it never prompts. Everything it
// can see comes from one channel-scoped fx.View, which is what makes "the dev
// installer cannot touch stable Firefox" true by construction rather than by
// care.
func runAuto(src *payload.Source, cfg config.Config) error {
	rep := ops.Plain{}
	pw := passwordProvider(cfg)
	view := fx.Scan(cfg.Channel)

	rep.Note("Channel: %s", cfg.Channel.Label())

	install, err := pickInstall(view, cfg)
	if err != nil {
		return err
	}
	rep.Note("Firefox: %s", install.Label)

	prof, err := autoProfile(rep, view, install, cfg)
	if err != nil {
		return err
	}

	if err := installAndVerify(src, rep, install, prof, cfg, pw); err == nil {
		return nil
	} else {
		rep.Warn("Install into %s failed: %v", prof.Name, err)
	}

	// A dedicated profile is the guaranteed-to-work target. If we were not
	// already there, move to one rather than leaving a half-install behind.
	if fx.IsLazyfoxOwnedProfile(prof.Dir) {
		return fmt.Errorf("could not install into the Lazyfox profile — see above")
	}
	rep.Warn("Falling back to a Lazyfox-owned profile.")
	fallback, err := fx.EnsureDedicatedProfile(install, view.Profiles, cfg.Channel)
	if err != nil {
		return err
	}
	if sameProfile(fallback, prof) {
		return fmt.Errorf("the install did not complete — see above")
	}
	rep.Step("Using profile: %s", fallback.Dir)
	if err := ops.Run(src, rep, ops.InstallOptions{
		Profile:      fallback,
		Install:      install,
		UseExtension: !cfg.NoExt,
		UseLaunch:    !cfg.NoLaunch,
		ForceLoader:  cfg.Force,
		XpiPath:      cfg.XpiPath,
	}, pw); err != nil {
		return err
	}
	if err := verify(src, rep, fallback); err != nil {
		return fmt.Errorf("the install did not verify in the fallback profile — see above")
	}
	rep.Note("Lazyfox-owned profile. Uninstall can delete it.")
	return nil
}

func sameProfile(a, b *fx.Profile) bool {
	if a == nil || b == nil {
		return a == b
	}
	return filepath.Clean(a.Dir) == filepath.Clean(b.Dir)
}

// autoProfile resolves the install target with no prompting, honouring an
// explicit --profile and otherwise taking the channel's policy (PlanInstall).
func autoProfile(rep ops.Reporter, view fx.View, install *fx.Install, cfg config.Config) (*fx.Profile, error) {
	if cfg.HasProfileArg {
		prof := view.Profile(cfg.Profile)
		if prof == nil {
			return nil, fx.ErrForeignProfile(cfg.Profile)
		}
		rep.Note("Profile (from --profile): %s", prof.Name)
		return prof, nil
	}

	plan, err := fx.PlanInstall(install, view.Profiles, cfg.Channel)
	if err != nil {
		return nil, err
	}
	if plan.Profile == nil {
		return nil, fx.ErrNoProfile
	}

	switch {
	case plan.Created:
		rep.Step("Created profile: %s", plan.Profile.Name)
		rep.Note("Lazyfox-owned. Uninstall can delete it.")
	case fx.IsLazyfoxOwnedProfile(plan.Profile.Dir):
		rep.Note("Profile: %s (Lazyfox-managed)", plan.Profile.Name)
	default:
		rep.Note("Profile: %s", plan.Profile.Name)
	}
	if plan.Reason != "" {
		rep.Note("%s", plan.Reason)
	}
	return plan.Profile, nil
}

// installAndVerify runs the install and then checks the result on disk. It
// returns an error when the install failed OR verification found problems — the
// two failures that matter, because either way "the installer said it worked"
// cannot be the last word.
func installAndVerify(
	src *payload.Source,
	rep ops.Reporter,
	fi *fx.Install,
	prof *fx.Profile,
	cfg config.Config,
	pw ops.PasswordProvider,
) error {
	if err := ops.Run(src, rep, ops.InstallOptions{
		Profile:      prof,
		Install:      fi,
		UseExtension: !cfg.NoExt,
		UseLaunch:    !cfg.NoLaunch,
		ForceLoader:  cfg.Force,
		XpiPath:      cfg.XpiPath,
	}, pw); err != nil {
		return err
	}
	return verify(src, rep, prof)
}

// verify checks the install on disk and reports the one thing the user may still
// have to do (restart Firefox), so "it worked but nothing happened" cannot occur
// silently.
func verify(src *payload.Source, rep ops.Reporter, prof *fx.Profile) error {
	failures, pending := ops.Verify(src, prof.Dir)
	if len(failures) > 0 {
		for _, f := range failures {
			rep.Warn("verification: %s", f)
		}
		return fmt.Errorf("verification failed in %s", prof.Name)
	}
	rep.Step("Verified in %s", prof.Name)
	if pending {
		rep.Note("Restart Firefox to activate Lazyfox.")
	}
	return nil
}
