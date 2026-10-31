//go:build linux

package platform

import (
	"fmt"
	"os"
	"os/exec"
)

// terminalsToTry is the launch shape of each common desktop terminal emulator:
// every one runs a command, but they disagree on the flag that introduces it —
// `-e` (xterm lineage), `--` (gnome-terminal/mate-terminal), plain argv (kitty,
// foot). The first emulator found in PATH wins; the command is always the
// installer's own executable path as a single argument vector element, never a
// shell string, so a path with spaces needs no quoting.
var terminalsToTry = []struct {
	bin  string
	args []string
}{
	{"x-terminal-emulator", []string{"-e"}}, // Debian alternatives system
	{"gnome-terminal", []string{"--"}},
	{"konsole", []string{"-e"}},
	{"xfce4-terminal", []string{"-x"}},
	{"mate-terminal", []string{"--"}},
	{"tilix", []string{"-e"}},
	{"terminator", []string{"-e"}},
	{"qterminal", []string{"-e"}},
	{"xterm", []string{"-e"}},
	{"alacritty", []string{"-e"}},
	{"kitty", nil},
	{"foot", []string{}},
}

// OpenInTerminal re-runs this installer inside a visible terminal window, so a
// binary the user double-clicked in a file manager — which gives the process no
// stdin terminal — still reaches the installer instead of exiting with an
// error printed to a console nobody is watching.
//
// The child inherits the new terminal's stdin, so its own
// TerminalInteractive() check passes and the terminal installer runs there; the
// parent process exits immediately, leaving the launched window to carry the
// installer — the same shape as the Windows double-click, which opens the
// window and lets it run.
func OpenInTerminal() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve own executable: %w", err)
	}
	for _, t := range terminalsToTry {
		if _, err := FindPath(t.bin); err != nil {
			continue
		}
		cmd := exec.Command(t.bin, append(t.args, exe)...)
		if err := cmd.Start(); err == nil {
			go cmd.Wait()
			return nil
		}
	}
	return fmt.Errorf("no known terminal emulator found; run the installer from a terminal")
}
