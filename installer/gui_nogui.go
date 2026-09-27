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
	if !platform.TerminalInteractive() {
		return fmt.Errorf("this build has no graphical window; run it from a terminal for the terminal installer")
	}
	fmt.Println("(this build has no graphical window — falling back to the terminal installer)")
	return tui.Run(src, cfg)
}
