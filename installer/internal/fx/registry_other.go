//go:build !windows

package fx

// windowsRegistryFirefoxExes is Windows-only; nothing is registered on other
// platforms (installs come from the filesystem).
func windowsRegistryFirefoxExes() []string { return nil }
