//go:build darwin

package platform

import "os/exec"

// OpenBrowser opens a URL with the standard `open` helper.
func OpenBrowser(url string) error {
	cmd := exec.Command("open", url)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
