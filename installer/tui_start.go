package main

import (
	tea "github.com/charmbracelet/bubbletea"
)

// action is the main operation the user chooses.
type action int

const (
	actInstall action = iota
	actUninstall
	actLoaderOnly
)

func (a action) String() string {
	switch a {
	case actInstall:
		return "Install"
	case actUninstall:
		return "Uninstall"
	case actLoaderOnly:
		return "Install chrome loader only"
	}
	return "?"
}

type screen int

const (
	scrAction screen = iota
	scrInstallPick
	scrProfilePick
	scrOptions
	scrConfirm
	scrRunning
	scrPassword
	scrManual
	scrResult
)

// tuiStart runs the interactive installer program.
func tuiStart(rc *repoContext, cfg config) error {
	installs := detectFirefoxInstalls()
	profiles := detectFirefoxProfiles()
	m := newModel(rc, cfg, installs, profiles)
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err := p.Run()
	return err
}
