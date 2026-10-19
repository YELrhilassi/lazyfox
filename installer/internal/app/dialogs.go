package app

import (
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// BrowseFirefoxDir opens the OS folder picker for a Firefox installation, for
// the case where detection missed a portable or unusual build. The chosen path
// is only ever accepted if it is this channel's Firefox — the picker changes
// where the user is *looking*, not which channel this build touches.
func (a *App) BrowseFirefoxDir() (string, error) {
	return a.pickFolder("Select the Firefox installation folder")
}

// BrowseProfileDir opens the OS folder picker for a Firefox profile.
func (a *App) BrowseProfileDir() (string, error) {
	return a.pickFolder("Select the Firefox profile folder")
}

// pickFolder runs the native picker. A cancelled dialog is not an error: it
// comes back as an empty string, so the window can leave its state alone.
func (a *App) pickFolder(title string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("the installer window is not ready yet")
	}
	dir := ""
	if home, err := os.UserHomeDir(); err == nil {
		dir = home
	}
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                title,
		DefaultDirectory:     dir,
		CanCreateDirectories: false,
	})
}
