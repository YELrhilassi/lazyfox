package main

import (
	"fmt"
)

// runAuto is the hands-off install: it detects the Firefox of this installer's
// channel, picks the profile that Firefox actually uses (no prompting), installs,
// verifies, and — if the user's own profile could not be made to work (locked,
// not writable, or the install did not land) — falls back to a dedicated Lazyfox
// profile that it owns and cleans up on uninstall.
//
// This is the path the one-click flow (and the setup page's installer) uses.
func runAuto(rc *repoContext, cfg config) error {
	rep := plainReporter{}
	ch := cfg.channel

	profiles := detectFirefoxProfiles()

	// An explicit --firefox-dir always wins (advanced/testing use).
	var fi *FirefoxInstall
	if cfg.firefoxDir != "" {
		fi = pickFishFromDir(rc, cfg)
	}
	if fi == nil {
		installs := detectFirefoxInstalls()
		if len(installs) == 0 {
			return fmt.Errorf("no Firefox installation found — install Firefox first, then run this again")
		}
		fi = selectInstallForChannel(installs, profiles, ch)
	}
	if fi == nil {
		return fmt.Errorf("no usable Firefox installation detected")
	}
	rep.Note("Channel: %s", ch.label())
	rep.Note("Firefox: %s", fi.Label)

	pw := func() (string, bool, error) { return cfg.password, cfg.password != "", nil }

	// A profile explicitly requested on the command line always wins.
	explicit := pickProfile(rc, cfg)

	if explicit != nil {
		rep.Note("Profile (from --profile): %s", explicit.Name)
		ok, pending, err := installAndVerify(rc, rep, fi, explicit, ch, cfg, pw)
		if err != nil || !ok {
			if err != nil {
				rep.Warn("Install into %s did not complete: %v", explicit.Name, err)
			} else {
				rep.Warn("Verification found problems in %s — falling back to a dedicated Lazyfox profile.", explicit.Name)
			}
			return installDedicated(rc, rep, fi, profiles, ch, cfg, pw)
		}
		reportVerified(rep, explicit, pending, ch)
		return nil
	}

	if cfg.dedicated {
		return installDedicated(rc, rep, fi, profiles, ch, cfg, pw)
	}

	// Auto: the profile this Firefox actually uses.
	prof := selectActiveProfile(profiles, fi)
	if prof == nil {
		rep.Note("No profile is registered for this Firefox yet — creating a dedicated Lazyfox profile.")
		return installDedicated(rc, rep, fi, profiles, ch, cfg, pw)
	}
	if isLazyfoxOwnedProfile(prof.Dir) {
		// We already own a dedicated profile for this channel; reuse it directly.
		rep.Note("Profile: %s (Lazyfox-managed)", prof.Name)
		ok2, pending2, err2 := installAndVerify(rc, rep, fi, prof, ch, cfg, pw)
		if err2 != nil || !ok2 {
			if err2 != nil {
				rep.Warn("Re-install into the Lazyfox profile did not complete: %v", err2)
			} else {
				rep.Warn("Verification found problems in the Lazyfox profile.")
			}
			return fmt.Errorf("could not repair the Lazyfox profile — see the messages above")
		}
		reportVerified(rep, prof, pending2, ch)
		return nil
	}

	rep.Note("Profile (auto-detected as the one in use): %s", prof.Name)
	ok, pending, err := installAndVerify(rc, rep, fi, prof, ch, cfg, pw)
	if err == nil && ok {
		reportVerified(rep, prof, pending, ch)
		return nil
	}
	if err != nil {
		rep.Warn("Install into %s did not complete: %v", prof.Name, err)
	} else {
		rep.Warn("Verification found problems in %s.", prof.Name)
	}
	rep.Warn("Falling back to a dedicated Lazyfox profile so the install is guaranteed to work.")
	return installDedicated(rc, rep, fi, profiles, ch, cfg, pw)
}

// installAndVerify runs the install and then checks the result on disk. It
// returns ok (no verification failures) and pending (the add-on could not be
// confirmed enabled yet because Firefox is running — it enables on next start).
func installAndVerify(
	rc *repoContext,
	rep StepReporter,
	fi *FirefoxInstall,
	prof *FirefoxProfile,
	ch channel,
	cfg config,
	pw PasswordProvider,
) (ok bool, pending bool, err error) {
	err = runInstall(rc, rep, InstallOptions{
		Profile:      prof,
		Install:      fi,
		UseExtension: !cfg.noExt,
		UseLaunch:    !cfg.noLaunch,
		ForceLoader:  cfg.force,
		XpiPath:      cfg.xpiPath,
	}, pw)
	if err != nil {
		return false, false, err
	}
	failures, pending := verifyInstall(rc, prof.Dir, ch)
	if len(failures) > 0 {
		for _, f := range failures {
			rep.Warn("verification: %s", f)
		}
		return false, pending, nil
	}
	return true, pending, nil
}

// installDedicated creates/reuses the Lazyfox-owned profile and installs there.
func installDedicated(
	rc *repoContext,
	rep StepReporter,
	fi *FirefoxInstall,
	profiles []*FirefoxProfile,
	ch channel,
	cfg config,
	pw PasswordProvider,
) error {
	prof, err := ensureDedicatedProfile(fi, profiles, ch)
	if err != nil {
		return err
	}
	rep.Step("Using a dedicated Lazyfox profile: %s", prof.Dir)
	ok, pending, err := installAndVerify(rc, rep, fi, prof, ch, cfg, pw)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("the install did not verify in the dedicated profile — see the messages above")
	}
	rep.Note("This profile is created and owned by Lazyfox; `--mode uninstall` removes it.")
	reportVerified(rep, prof, pending, ch)
	return nil
}

// reportVerified prints the outcome and the one thing the user may still have to
// do (restart Firefox) so "it worked but nothing happened" cannot occur silently.
func reportVerified(rep StepReporter, prof *FirefoxProfile, pending bool, ch channel) {
	rep.Step("Verified: Lazyfox is installed in %s (channel %s).", prof.Name, ch.String())
	if pending {
		rep.Note("Start (or restart) Firefox to activate Lazyfox — the add-on is imported on the next launch.")
	}
}
