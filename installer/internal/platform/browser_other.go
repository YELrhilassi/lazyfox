//go:build !windows && !linux && !darwin

package platform

import "fmt"

// OpenBrowser has no known browser launcher on this platform; the caller prints
// the URL instead.
func OpenBrowser(url string) error {
	return fmt.Errorf("cannot open a browser automatically on this platform; open %s", url)
}
