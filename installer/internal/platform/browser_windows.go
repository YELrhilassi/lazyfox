//go:build windows

package platform

// OpenBrowser opens a URL in the user's default browser. rundll32's
// FileProtocolHandler is the standard no-shell way to hand a URL to the default
// browser, and it is launched hidden so no console window appears.
func OpenBrowser(url string) error {
	cmd := commandHidden("rundll32", "url.dll,FileProtocolHandler", url)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
