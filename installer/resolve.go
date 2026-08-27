package main

import "path/filepath"

// resolveReal resolves symlinks and normalizes to an absolute path. It returns
// the input unchanged when resolution fails (missing target, etc.).
func resolveReal(p string) string {
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
