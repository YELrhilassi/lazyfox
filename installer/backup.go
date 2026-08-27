package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// backup stamps and suffix helpers mirror the legacy shell installers:
//   - install backups:   <name>.lazyfox.bak-<timestamp>
//   - uninstall backups: <name>.lazyfox.uninst.bak-<timestamp>
const (
	backupSuffixInstall   = ".lazyfox.bak-"
	backupSuffixUninstall = ".lazyfox.uninst.bak-"
)

func stamp() string {
	return time.Now().Format("20060102-150405")
}

// backupFile copies src to a timestamped sibling backup. It is non-fatal on
// error (a failed backup should not stop the install).
func backupFile(src, kind string) error {
	if !exists(src) {
		return nil
	}
	suffix := backupSuffixInstall
	if kind == "uninst" {
		suffix = backupSuffixUninstall
	}
	bak := src + suffix + stamp()
	return copyFile(src, bak)
}

// copyFile copies a file (or directory) src -> dst preserving permissions.
func copyFile(src, dst string) error {
	st, err := os.Stat(src)
	if err != nil {
		return err
	}
	if st.IsDir() {
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyFile(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, st.Mode().Perm())
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	os.Chtimes(dst, st.ModTime(), st.ModTime())
	return nil
}

// removeStaleBackups deletes Lazyfox backup files older than 30 days in dir so
// re-installs don't pile up cruft. Backups newer than that are kept as the
// rollback safety net.
func removeStaleBackups(dir string) {
	if !isDir(dir) {
		return
	}
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !matchesBackupName(name) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
}

func matchesBackupName(name string) bool {
	return strings.Contains(name, backupSuffixInstall) || strings.Contains(name, backupSuffixUninstall)
}

// backupThenRemove copies a file to a .uninst backup then deletes it, exactly
// like the legacy uninstaller. Returns whether the file was handled.
func backupThenRemove(path string) (bool, error) {
	if !exists(path) {
		return false, nil
	}
	if err := backupFile(path, "uninst"); err != nil {
		return false, fmt.Errorf("backup of %s failed: %w", path, err)
	}
	if err := os.Remove(path); err != nil {
		return false, err
	}
	return true, nil
}
