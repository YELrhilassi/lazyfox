// Package config is the installer's parsed configuration, shared by the CLI
// parser in package main and every front-end (the graphical window and the
// terminal installer). It
// deliberately knows nothing about flag syntax so the parser stays a thin
// translation layer.
package config

import "lazyfox/installer/internal/fx"

// Action is what the user asked the installer to do.
type Action int

const (
	// Interactive opens the chosen front-end (the window, or the terminal
	// installer with --tui).
	Interactive Action = iota
	// Auto is the hands-off install the download runs: detect, install, verify.
	Auto
	Install
	Uninstall
	LoaderOnly
	LoaderRemove
	List
)

func (a Action) String() string {
	switch a {
	case Auto:
		return "Automatic install"
	case Install:
		return "Install"
	case Uninstall:
		return "Uninstall"
	case LoaderOnly:
		return "Install chrome loader only"
	case LoaderRemove:
		return "Remove chrome loader"
	case List:
		return "List detected Firefox"
	default:
		return "Interactive"
	}
}

// Config carries every option that can affect an operation.
type Config struct {
	Action       Action
	Profile      string
	FirefoxDir   string
	NoExt        bool
	NoLaunch     bool
	RemoveLoader bool
	KeepDisabled bool
	// DeleteProfile removes a Lazyfox-created profile on uninstall. Off by
	// default: uninstall suggests it instead, so a mistyped command cannot
	// destroy a profile.
	DeleteProfile bool
	Force         bool
	Password      string // sudo password for non-interactive loader ops
	XpiPath       string // install this unsigned xpi instead of the embedded build (dev)
	Channel       fx.Channel
	Dedicated     bool   // force a Lazyfox-owned dedicated profile
	StatusFile    string // elevated child reports its outcome here (Windows UAC)
	HasProfileArg bool   // the profile came from the command line, not detection
	TUI           bool   // force the terminal installer instead of the window
}
