package platform

import "path/filepath"

// ResolveReal resolves symlinks and normalizes to an absolute path. It returns
// the input unchanged when resolution fails (missing target, permission, etc.),
// so it is always safe to call on a path that may not exist yet.
func ResolveReal(p string) string {
	if p == "" {
		return p
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return abs
	}
	return real
}
