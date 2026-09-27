// Command lazyfox-install is the Lazyfox installer: one self-contained Go
// binary that installs or removes the Lazyfox UI from a Firefox profile and the
// fx-autoconfig chrome loader from the Firefox installation.
//
// The code is organised in packages rather than one flat pile:
//
//	internal/platform  OS primitives — paths, processes, elevation, browser
//	internal/fx        the Firefox domain — installs, profiles, channels, choice
//	internal/payload   what we ship — the embed FSes and the artifact registry
//	internal/ops       the operations — install, uninstall, loader, verify
//	internal/config    parsed configuration shared by every front-end
//	internal/app       the graphical window's application layer (Wails bindings)
//	internal/tui       the terminal front-end
//
// This file, cli.go, auto.go and gui.go are only the entry point and CLI
// translation.
package main

import (
	"fmt"
	"os"

	"lazyfox/installer/internal/payload"
)

func main() {
	if err := realMain(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "lazyfox-installer:", err)
		os.Exit(1)
	}
}

// realMain locates the payload source, parses the arguments and either runs the
// requested non-interactive action or opens a front-end.
func realMain(args []string) error {
	// A GUI-subsystem Windows exe needs its console re-attached when invoked
	// with arguments from a terminal, so --mode output is not silently lost.
	attachCLIConsole()

	// Prefer a live repo dist/ when the binary runs from a checkout; otherwise
	// the embedded payloads are used.
	src := payload.Locate(executablePaths()...)

	cfg, handled, err := parseArgs(args)
	if err != nil {
		return err
	}
	if handled {
		return nil
	}
	return startInteractive(src, cfg)
}
