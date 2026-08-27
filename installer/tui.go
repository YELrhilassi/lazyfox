package main

// runTUI launches the interactive installer. Implemented in tui_model.go /
// tui_views.go.
func runTUI(rc *repoContext, cfg config) error {
	if !terminalInteractive() {
		// No TTY: run a sensible default non-interactive install.
		rep := plainReporter{}
		prof := pickProfile(rc, cfg)
		if prof == nil {
			return errNoProfile
		}
		ff := pickFish(rc, cfg, prof)
		return runInstall(rc, rep, InstallOptions{
			Profile:      prof,
			Install:      ff,
			UseExtension: !cfg.noExt,
			UseLaunch:    !cfg.noLaunch,
			ForceLoader:  cfg.force,
		}, func() (string, bool, error) {
			return cfg.password, cfg.password != "", nil
		})
	}
	return tuiStart(rc, cfg)
}
