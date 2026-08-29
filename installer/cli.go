package main

import (
	"flag"
	"fmt"
	"os"
)

// config carries parsed command-line options plus the environment-derived
// defaults surfaced to the TUI.
type config struct {
	// Non-interactive operation (skip the TUI).
	action       string // "", "install", "uninstall", "loader-only", "loader-remove", "help", "list"
	profile      string
	firefoxDir   string
	noExt        bool
	noLaunch     bool
	removeLoader bool
	keepDisabled bool
	force        bool
	password     string // for sudo (non-interactive loader ops)
	xpiPath      string // install this unsigned xpi instead of the embedded signed build (dev)
	// TUI defaults.
	hasProfileArg bool
}

// parseArgs interprets the command line. On success handled=true means the
// process should return without opening the TUI (help printed, or a
// non-interactive action performed has not happened yet — the action itself is
// returned in cfg).
func parseArgs(rc *repoContext, args []string) (cfg config, handled bool, err error) {
	fs := flag.NewFlagSet("lazyfox", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	profile := fs.String("profile", "", "Firefox profile directory to use")
	ffdir := fs.String("firefox-dir", "", "Firefox installation directory")
	action := fs.String("mode", "", "install|uninstall|loader-only|loader-remove|list")
	var noExt, noLaunch, removeLoader, keepDisabled, force, help bool
	fs.BoolVar(&noExt, "no-extension", false, "skip the WebExtension build/install")
	fs.BoolVar(&noLaunch, "no-launch", false, "do not relaunch Firefox after install")
	fs.BoolVar(&removeLoader, "remove-loader", false, "also remove the chrome loader (uninstall)")
	fs.BoolVar(&keepDisabled, "keep-extension-disabled", false, "only disable the add-on, keep the xpi")
	fs.BoolVar(&force, "force", false, "force a chrome-loader (re)install/removal")
	fs.BoolVar(&help, "h", false, "show help")
	fs.BoolVar(&help, "help", false, "show help")
	fs.StringVar(&cfg.password, "sudo-pass", "", "sudo password for non-interactive loader ops")
	xpiPath := fs.String("xpi", "", "install this unsigned xpi instead of the embedded signed build (dev)")
	fs.Usage = func() { printUsage(fs) }

	// Also accept the legacy single-dash flags (-Profile, -NoExtension, …) for
	// drop-in compatibility by translating them before flag.Parse.
	translated := translateLegacyFlags(args)

	if err := fs.Parse(translated); err != nil {
		return cfg, true, nil // flag pkg already printed an error/usage
	}
	cfg.profile = *profile
	cfg.firefoxDir = *ffdir
	cfg.noExt = noExt
	cfg.noLaunch = noLaunch
	cfg.removeLoader = removeLoader
	cfg.keepDisabled = keepDisabled
	cfg.force = force
	cfg.hasProfileArg = *profile != ""
	cfg.action = *action
	cfg.xpiPath = *xpiPath

	// A bare positional argument is the profile (legacy CLI convention).
	if pos := fs.Args(); len(pos) > 0 {
		if cfg.profile == "" {
			cfg.profile = pos[0]
			cfg.hasProfileArg = true
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

	if cfg.action != "" {
		// Non-interactive action requested.
		if err := runNonInteractive(rc, cfg); err != nil {
			return cfg, true, err
		}
		return cfg, true, nil
	}
	return cfg, false, nil
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
	fmt.Fprintf(fs.Output(), `Lazyfox installer — a single cross-platform tool.

Without options the interactive TUI opens: it detects your platform, every
Firefox installation and every profile, then guides you through install or
uninstall.

Flags:
`)
	fs.PrintDefaults()
	fmt.Fprintf(fs.Output(), `
Examples:
  lazyfox-install                  open the interactive installer
  lazyfox-install --profile "…"    preset the profile for the TUI
  lazyfox-install --mode install --profile "…" --firefox-dir "…"
  lazyfox-install --mode install --profile "…" --xpi "…/lazyfox2-0.5.3.xpi" --no-launch
  lazyfox-install --mode loader-only --firefox-dir "…"
  lazyfox-install --mode uninstall --profile "…"
  lazyfox-install --mode list

Note: the legacy flags -Profile, -NoExtension, -NoLaunch, -ChromeLoaderOnly,
-FirefoxDir, -RemoveChromeLoader also work for drop-in compat.
`)
}

// runNonInteractive executes a requested action without the TUI, using the
// plain terminal printer.
func runNonInteractive(rc *repoContext, cfg config) error {
	rep := plainReporter{}

	switch cfg.action {
	case "list":
		installs := detectFirefoxInstalls()
		profiles := detectFirefoxProfiles()
		fmt.Println("Firefox installations:")
		for _, fi := range installs {
			fmt.Printf("  %s\n    exec: %s\n    dir : %s\n", fi.Label, fi.Exec, fi.Dir)
		}
		if len(installs) == 0 {
			fmt.Println("  (none detected)")
		}
		fmt.Println("\nFirefox profiles:")
		for _, p := range profiles {
			fmt.Printf("  %s  %s\n", p.label(), p.Dir)
		}
		if len(profiles) == 0 {
			fmt.Println("  (none detected)")
		}
		return nil

	case "loader-only":
		ff := pickFishFromDir(rc, cfg)
		if ff == nil {
			return fmt.Errorf("could not resolve a Firefox installation (use --firefox-dir)")
		}
		pw := func() (string, bool, error) { return cfg.password, cfg.password != "", nil }
		return InstallChromeLoader(rc, rep, ff, cfg.force, pw)

	case "loader-remove":
		ff := pickFishFromDir(rc, cfg)
		if ff == nil {
			return fmt.Errorf("could not resolve a Firefox installation (use --firefox-dir)")
		}
		pw := func() (string, bool, error) { return cfg.password, cfg.password != "", nil }
		return removeChromeLoader(rc, rep, UninstallOptions{Install: ff}, pw)

	case "install":
		prof := pickProfile(rc, cfg)
		if prof == nil {
			return fmt.Errorf("no profile: pass --profile or run the TUI to choose one")
		}
		ff := pickFish(rc, cfg, prof)
		pw := func() (string, bool, error) { return cfg.password, cfg.password != "", nil }
		return runInstall(rc, rep, InstallOptions{
			Profile:      prof,
			Install:      ff,
			UseExtension: !cfg.noExt,
			UseLaunch:    !cfg.noLaunch,
			ForceLoader:  cfg.force,
			XpiPath:      cfg.xpiPath,
		}, pw)

	case "uninstall":
		prof := pickProfile(rc, cfg)
		if prof == nil {
			return fmt.Errorf("no profile: pass --profile or run the TUI to choose one")
		}
		ff := pickFish(rc, cfg, prof)
		pw := func() (string, bool, error) { return cfg.password, cfg.password != "", nil }
		return runUninstall(rc, rep, UninstallOptions{
			Profile:                   prof,
			Install:                   ff,
			RemoveLoader:              cfg.removeLoader,
			KeepExtensionDisabledOnly: cfg.keepDisabled,
		}, pw)

	default:
		return fmt.Errorf("unknown mode: %s", cfg.action)
	}
}

// pickFish resolves a FirefoxInstall from CLI flags or auto-detection.
func pickFishFromDir(rc *repoContext, cfg config) *FirefoxInstall {
	installs := detectFirefoxInstalls()
	if cfg.firefoxDir != "" {
		for _, fi := range installs {
			if fi.Dir == cfg.firefoxDir || fi.Exec == cfg.firefoxDir {
				return fi
			}
		}
		// Accept a raw dir/exec even if not auto-detected.
		return &FirefoxInstall{Exec: cfg.firefoxDir, Dir: cfg.firefoxDir, Flavor: flavorStable}
	}
	if len(installs) > 0 {
		return installs[0]
	}
	return nil
}

// pickFish resolves the best Firefox install for a profile.
func pickFish(rc *repoContext, cfg config, prof *FirefoxProfile) *FirefoxInstall {
	installs := detectFirefoxInstalls()
	if cfg.firefoxDir != "" {
		for _, fi := range installs {
			if fi.Dir == cfg.firefoxDir || fi.Exec == cfg.firefoxDir {
				return fi
			}
		}
		return &FirefoxInstall{Exec: cfg.firefoxDir, Dir: cfg.firefoxDir, Flavor: flavorStable}
	}
	if len(installs) == 0 {
		return nil
	}
	// Prefer an install whose flavor matches the profile's flavor.
	for _, fi := range installs {
		if prof != nil && fi.Flavor == prof.Flavor {
			return fi
		}
	}
	return installs[0]
}

// pickProfile resolves a profile from CLI flags or auto-detection.
func pickProfile(rc *repoContext, cfg config) *FirefoxProfile {
	profiles := detectFirefoxProfiles()
	if cfg.profile != "" {
		for _, p := range profiles {
			if p.Dir == cfg.profile {
				return p
			}
		}
		real := resolveReal(cfg.profile)
		if isDir(real) {
			return &FirefoxProfile{Dir: real, Name: real, Flavor: flavorStable}
		}
		return nil
	}
	return pickDefaultProfile(profiles)
}
