package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
	"lazyfox/installer/internal/tui"
)

// parseArgs turns the command line into a config.Config. handled=true means the
// process should exit without opening a front-end (help was printed, or a
// non-interactive action already ran).
func parseArgs(args []string) (cfg config.Config, handled bool, err error) {
	fs := flag.NewFlagSet("lazyfox", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	profile := fs.String("profile", "", "Firefox profile directory to use")
	ffdir := fs.String("firefox-dir", "", "Firefox installation directory")
	mode := fs.String("mode", "", "auto|install|uninstall|loader-only|loader-remove|list")
	xpiPath := fs.String("xpi", "", "install this unsigned xpi instead of the embedded build (dev)")
	chFlag := fs.String("channel", "", "stable|nightly — which Firefox channel to target (default: this build's channel)")

	var noExt, noLaunch, removeLoader, keepDisabled, deleteProfile, force, help, tui bool
	fs.BoolVar(&noExt, "no-extension", false, "skip the WebExtension install")
	fs.BoolVar(&noLaunch, "no-launch", false, "do not relaunch Firefox after install")
	fs.BoolVar(&removeLoader, "remove-loader", false, "also remove the chrome loader (uninstall)")
	fs.BoolVar(&keepDisabled, "keep-extension-disabled", false, "only disable the add-on, keep the xpi")
	fs.BoolVar(&deleteProfile, "delete-profile", false, "on uninstall, also delete the profile Lazyfox created")
	fs.BoolVar(&force, "force", false, "force a chrome-loader (re)install/removal")
	fs.BoolVar(&tui, "tui", false, "use the terminal installer instead of the window")
	fs.BoolVar(&help, "h", false, "show help")
	fs.BoolVar(&help, "help", false, "show help")
	fs.StringVar(&cfg.Password, "sudo-pass", "", "sudo password for non-interactive loader ops")
	fs.StringVar(&cfg.StatusFile, "status", "", "write the operation outcome to this file (elevated child reporting)")
	fs.BoolVar(&cfg.Dedicated, "dedicated", false, "create/use a dedicated Lazyfox profile instead of your own")
	fs.Usage = func() { printUsage(fs) }

	// The legacy single-dash flags (-Profile, -NoExtension, …) are translated
	// before parsing so drop-in callers keep working.
	if err := fs.Parse(translateLegacyFlags(args)); err != nil {
		return cfg, true, nil // flag already printed an error/usage
	}

	cfg.Profile = *profile
	cfg.FirefoxDir = *ffdir
	cfg.NoExt = noExt
	cfg.NoLaunch = noLaunch
	cfg.RemoveLoader = removeLoader
	cfg.KeepDisabled = keepDisabled
	cfg.DeleteProfile = deleteProfile
	cfg.Force = force
	cfg.HasProfileArg = *profile != ""
	cfg.XpiPath = *xpiPath
	cfg.TUI = tui
	cfg.Channel = fx.ParseChannel(fx.EmbeddedChannel)
	if strings.TrimSpace(*chFlag) != "" {
		cfg.Channel = fx.ParseChannel(*chFlag)
	}

	// A bare positional argument is the profile (legacy CLI convention).
	if pos := fs.Args(); len(pos) > 0 {
		if cfg.Profile == "" {
			cfg.Profile = pos[0]
			cfg.HasProfileArg = true
			pos = pos[1:]
		}
		if len(pos) > 0 {
			return cfg, true, fmt.Errorf("unexpected argument: %s", pos[0])
		}
	}

	if help {
		fs.Usage()
		return cfg, true, nil
	}

	cfg.Action = parseMode(*mode)
	if cfg.Action != config.Interactive {
		src := payload.Locate(executablePaths()...)
		if err := runNonInteractive(src, cfg); err != nil {
			return cfg, true, err
		}
		return cfg, true, nil
	}
	return cfg, false, nil
}

func parseMode(mode string) config.Action {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "auto":
		return config.Auto
	case "install":
		return config.Install
	case "uninstall":
		return config.Uninstall
	case "loader-only":
		return config.LoaderOnly
	case "loader-remove":
		return config.LoaderRemove
	case "list":
		return config.List
	default:
		return config.Interactive
	}
}

// translateLegacyFlags converts the old shell-style flags to their modern
// equivalents so `install -NoExtension -FirefoxDir X` keeps working.
func translateLegacyFlags(args []string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		switch a {
		case "-NoExtension", "--NoExtension":
			out = append(out, "--no-extension")
		case "-NoLaunch", "--NoLaunch":
			out = append(out, "--no-launch")
		case "-ChromeLoaderOnly", "--ChromeLoaderOnly":
			out = append(out, "--mode", "loader-only")
		case "-RemoveChromeLoader", "--RemoveChromeLoader":
			out = append(out, "--remove-loader")
		case "-KeepExtensionDisabledOnly", "--KeepExtensionDisabledOnly":
			out = append(out, "--keep-extension-disabled")
		case "-FirefoxDir", "--FirefoxDir":
			out = append(out, "--firefox-dir")
		case "-Profile", "--Profile":
			out = append(out, "--profile")
		case "-h", "-help", "--help":
			out = append(out, "--help")
		default:
			out = append(out, a)
		}
	}
	return out
}

func printUsage(fs *flag.FlagSet) {
	fmt.Fprintf(fs.Output(), `Lazyfox installer.

This build handles one Firefox channel only: a dev build (Developer Edition /
Nightly) or a stable build. It never touches the other one.

No options: opens the installer window (same on Windows, Linux and macOS).
--tui uses the terminal installer instead.

Flags:
`)
	fs.PrintDefaults()
	fmt.Fprintf(fs.Output(), `
Examples:
  lazyfox-install                             open the installer window
  lazyfox-install --tui                       terminal installer instead
  lazyfox-install --mode auto                 no prompts: detect, install, verify
  lazyfox-install --mode list                 show what this build targets
  lazyfox-install --mode uninstall --delete-profile
  lazyfox-install --mode loader-only --firefox-dir "…"

The legacy flags -Profile, -NoExtension, -NoLaunch, -ChromeLoaderOnly,
-FirefoxDir and -RemoveChromeLoader still work.
`)
}

// startInteractive opens the chosen front-end. The window is the default on
// every platform because it needs no terminal at all — a GUI-subsystem Windows
// exe double-clicked, a desktop launch and a terminal session all reach it. The
// terminal installer is opt-in with --tui and requires a terminal, since drawing
// it without one produces escape-code garbage instead of an installer.
func startInteractive(src *payload.Source, cfg config.Config) error {
	if cfg.TUI {
		if !platform.TerminalInteractive() {
			return fmt.Errorf("--tui needs a terminal; run without it to get the installer window")
		}
		return tui.Run(src, cfg)
	}
	return runGUI(src, cfg)
}

// runNonInteractive executes a requested action without any UI.
//
// Every action resolves its targets through fx.Scan, so it can only ever see
// this installer's own channel.
func runNonInteractive(src *payload.Source, cfg config.Config) error {
	rep := ops.Plain{}

	switch cfg.Action {
	case config.List:
		return listTargets(src, cfg)

	case config.Auto:
		return runAuto(src, cfg)

	case config.LoaderOnly, config.LoaderRemove:
		view := fx.Scan(cfg.Channel)
		ff, err := pickInstall(view, cfg)
		if err != nil {
			return err
		}
		var opErr error
		if cfg.Action == config.LoaderOnly {
			opErr = ops.InstallChromeLoader(src, rep, ff, cfg.Force, passwordProvider(cfg))
		} else {
			opErr = ops.RemoveChromeLoader(src, rep, ff, passwordProvider(cfg))
		}
		platform.WriteElevatedStatus(cfg.StatusFile, opErr) // the UAC parent watches this
		return opErr

	case config.Install:
		view := fx.Scan(cfg.Channel)
		install, err := pickInstall(view, cfg)
		if err != nil {
			return err
		}
		prof, err := planProfile(rep, view, install, cfg)
		if err != nil {
			return err
		}
		rep.Note("Channel: %s", cfg.Channel.Label())
		return ops.Run(src, rep, ops.InstallOptions{
			Profile:      prof,
			Install:      install,
			UseExtension: !cfg.NoExt,
			UseLaunch:    !cfg.NoLaunch,
			ForceLoader:  cfg.Force,
			XpiPath:      cfg.XpiPath,
		}, passwordProvider(cfg))

	case config.Uninstall:
		view := fx.Scan(cfg.Channel)
		return runUninstall(src, rep, view, cfg)

	default:
		return fmt.Errorf("unknown mode")
	}
}

// pickInstall resolves the Firefox install for the requested action, keeping the
// channel boundary: an explicit path for the other channel's Firefox is refused
// rather than honoured.
func pickInstall(view fx.View, cfg config.Config) (*fx.Install, error) {
	ff := view.Install(cfg.FirefoxDir)
	if ff != nil {
		return ff, nil
	}
	if cfg.FirefoxDir != "" && !view.Empty() {
		return nil, fx.ErrForeignInstall(cfg.FirefoxDir, cfg.Channel)
	}
	return nil, fx.ErrNoChannelInstall(cfg.Channel)
}

// planProfile is the install's profile policy, expressed once (PlanInstall) and
// then reported: a dev install always gets its own disposable profile; a stable
// install uses the profile Firefox actually uses and only creates one when there
// is none.
func planProfile(rep ops.Reporter, view fx.View, install *fx.Install, cfg config.Config) (*fx.Profile, error) {
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
	plan, err := fx.PlanInstall(install, view.Profiles, cfg.Channel)
	if err != nil {
		return nil, err
	}
	rep.Note("%s", plan.Reason)
	return plan.Profile, nil
}

// runUninstall removes the install and then *suggests* deleting the profile
// Lazyfox created, rather than deleting it — a profile is the one thing here
// that cannot be backed up, so a mistyped command must not destroy it.
func runUninstall(src *payload.Source, rep ops.Reporter, view fx.View, cfg config.Config) error {
	var prof *fx.Profile
	if cfg.HasProfileArg {
		prof = view.Profile(cfg.Profile)
	} else if owned := view.OwnedProfile(); owned != nil {
		// No explicit profile: prefer the one Lazyfox created, since that is
		// what an installer-managed install used. Never a user profile.
		prof = owned
	} else {
		prof = view.Profile("")
	}
	if prof == nil {
		return fx.ErrNoProfile
	}

	install := view.Install(cfg.FirefoxDir)
	owned := fx.IsLazyfoxOwnedProfile(prof.Dir)

	if owned && !cfg.DeleteProfile {
		rep.Note("%s is Lazyfox-owned. Kept for now.", prof.Name)
	}
	if err := ops.RunUninstall(src, rep, ops.UninstallOptions{
		Profile:                   prof,
		Install:                   install,
		RemoveLoader:              cfg.RemoveLoader,
		KeepExtensionDisabledOnly: cfg.KeepDisabled,
		RemoveDedicated:           cfg.DeleteProfile && owned,
	}, passwordProvider(cfg)); err != nil {
		return err
	}

	// Offer the follow-up only when there is something to offer: a dev profile
	// exists purely for Lazyfox and is otherwise dead weight, so removing it is
	// the natural end of the story.
	if owned && !cfg.DeleteProfile {
		rep.Note("To delete it: lazyfox-install --mode uninstall --delete-profile")
	}
	return nil
}

// listTargets prints what this build targets, and explicitly what it ignores —
// the channel boundary made visible.
//
// It also reports where this binary's install payload comes from and whether it
// is usable. That makes `lazyfox-install --mode list` a one-command health check
// for a built installer — the exact question "did the compiler embed the current
// payload?" — instead of discovering it only when a launch or an install fails.
func listTargets(src *payload.Source, cfg config.Config) error {
	view := fx.Scan(cfg.Channel)

	fmt.Printf("Installer channel: %s — %s\n", cfg.Channel.String(), cfg.Channel.Label())
	fmt.Printf("Payload: %s\n", src.Origin())
	payloadErr := src.Usable()
	if payloadErr == nil {
		if src.AddonAvailable() {
			fmt.Println("  add-on payload : present (the installer can add the extension)")
		} else {
			fmt.Println("  add-on payload : MISSING — only the chrome loader could be installed")
		}
	} else {
		fmt.Println("  payload check  : FAILED")
	}
	fmt.Println("\nFirefox for this channel:")
	for _, fi := range view.Installs {
		fmt.Printf("  %s\n    exec: %s\n    dir : %s\n", fi.Label, fi.Exec, fi.Dir)
	}
	if len(view.Installs) == 0 {
		fmt.Println("  (none — nothing for this installer to do here)")
	}
	var others []*fx.Install
	for _, fi := range fx.Installs() {
		if !cfg.Channel.Matches(fi.Flavor) {
			others = append(others, fi)
		}
	}
	if len(others) > 0 {
		fmt.Println("\nIgnored (other channel — never touched):")
		for _, fi := range others {
			fmt.Printf("  %s\n", fi.Label)
		}
	}

	fmt.Println("\nFirefox profiles for this channel:")
	for _, p := range view.Profiles {
		owned := ""
		if fx.IsLazyfoxOwnedProfile(p.Dir) {
			owned = "  [Lazyfox-owned: " + fx.OwnedProfileChannel(p.Dir).String() + "]"
		}
		fmt.Printf("  %s  %s%s\n", p.Label(), p.Dir, owned)
	}
	if len(view.Profiles) == 0 {
		fmt.Println("  (none — the installer would create its own)")
	}
	// Return the payload failure LAST so the report above still prints, but a
	// broken binary exits non-zero: a health check that cannot fail is useless.
	return payloadErr
}

// passwordProvider supplies the non-interactive sudo password, if given.
func passwordProvider(cfg config.Config) ops.PasswordProvider {
	return func() (string, bool, error) { return cfg.Password, cfg.Password != "", nil }
}

func executablePaths() []string {
	var out []string
	if exe, err := os.Executable(); err == nil {
		out = append(out, exe)
	}
	return out
}
