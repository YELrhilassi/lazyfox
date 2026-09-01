package main

import (
	"fmt"
	"os"
)

func main() {
	if err := realMain(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "lazyfox-installer:", err)
		os.Exit(1)
	}
}

// realMain parses CLI args and runs the interactive front-end for this
// platform (Windows: GUI wizard; Unix: TUI) or a non-interactive operation.
func realMain(args []string) error {
	// A GUI-subsystem Windows exe needs its console re-attached when invoked
	// with arguments from a terminal, so --mode output is not silently lost.
	attachCLIConsole()

	// Locate the repo (dist/) for reading artifacts.
	var starts []string
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, exe)
	}
	rc := locateRepoRoot(starts...)

	cfg, handled, err := parseArgs(rc, args)
	if err != nil {
		return err
	}
	if handled {
		// e.g. --help printed; exit successfully.
		return nil
	}
	return startInteractive(rc, cfg)
}
