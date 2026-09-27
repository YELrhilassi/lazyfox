// Package tui is the terminal front-end: the installer for a terminal session,
// reachable with --tui on every platform, and what a `-tags nogui` build falls
// back to. The graphical window is the default front-end; both drive exactly the
// same operations.
package tui

import (
	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
	"lazyfox/installer/internal/payload"
)

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

// Run starts the interactive installer.
//
// It works from the channel-scoped view, so the terminal UI can only ever offer
// this installer's own Firefox and profiles — the channel rule is not a UI
// convention here, it is the only data the UI has.
func Run(src *payload.Source, cfg config.Config) error {
	view := fx.Scan(cfg.Channel)
	m := newModel(src, cfg, view.Installs, view.Profiles)
	return runProgram(m)
}

// CheckRequirements is the shared guard every front-end applies before doing
// anything: without payloads there is nothing to install.
func CheckRequirements(src *payload.Source) error {
	return src.Usable()
}

var _ ops.Reporter = (*chanReporter)(nil)
