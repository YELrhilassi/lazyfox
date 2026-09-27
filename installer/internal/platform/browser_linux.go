//go:build linux

package platform

import "os/exec"

// OpenBrowser opens a URL with xdg-open. Arguments are passed as a vector, not
// through a shell, so the URL is never re-interpreted.
func OpenBrowser(url string) error {
	cmd := exec.Command("xdg-open", url)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
