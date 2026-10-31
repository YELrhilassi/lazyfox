//go:build nogui

package main

import (
	"fmt"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
	"lazyfox/installer/internal/tui"
)

// runGUI is the graphical front-end, compiled out of this build with `-tags
// nogui`.
//
// The tag exists for one reason: the window's GUI backends need CGO on macOS
// and Linux (they talk to the system webview), so a single host can no longer
// cross-compile every installer. Building with `-tags nogui` produces the
// pure-Go CLI/terminal build instead, which is what the freeze-cross-compile
// check and the scripted installs use. Shipping installers are built per
// platform without the tag.
func runGUI(src *payload.Source, cfg config.Config) error {
	if platform.TerminalInteractive() {
		fmt.Println("(this build has no graphical window — falling back to the terminal installer)")
		return tui.Run(src, cfg)
	}
	// No terminal on stdin — the shape a double-click produces (Finder, a Linux
	// file manager). The old behavior returned the "run it from a terminal"
	// error, which main printed to stderr of a process nobody was watching, and
	// then died: the installer silently vanished — the reported "the linux and
	// mac installers don't work". The repair is to put the installer in a
	// terminal the user can see and let it run there, which is also what the
	// Windows binary does with its window: double-click, a UI appears.
	if err := platform.OpenInTerminal(); err == nil {
		return nil
	}
	return fmt.Errorf("this build has no graphical window; run it from a terminal for the terminal installer")
}
