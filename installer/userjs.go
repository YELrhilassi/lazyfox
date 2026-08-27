package main

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// user_pref("name", value) capture for identifying which prefs Lazyfox owns.
var userPrefRe = regexp.MustCompile(`^user_pref\("([^"]+)"`)

// distUserPrefs returns the set of pref names Lazyfox manages, read from
// dist/chrome/user.js.
func distUserPrefs(rc *repoContext) map[string]bool {
	managed := map[string]bool{}
	path := rc.chromeFile("user.js")
	f, err := os.Open(path)
	if err != nil {
		return managed
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m := userPrefRe.FindStringSubmatch(sc.Text()); m != nil {
			managed[m[1]] = true
		}
	}
	return managed
}

// mergeUserJS updates profile/user.js so Lazyfox's managed prefs are exactly
// ours, while any other pref the user has set is preserved. The previous file
// is backed up; the prefs section is appended after the preserved lines.
func mergeUserJS(rc *repoContext, profileDir string) error {
	managed := distUserPrefs(rc)
	userJs := filepath.Join(profileDir, "user.js")
	if err := backupFile(userJs, "install"); err != nil {
		return err
	}
	var kept []string
	if f, err := os.Open(userJs); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			if m := userPrefRe.FindStringSubmatch(line); m != nil {
				if managed[m[1]] {
					continue // ours: will be re-appended below
				}
			}
			kept = append(kept, line)
		}
		f.Close()
	}
	ours, err := os.ReadFile(rc.chromeFile("user.js"))
	if err != nil {
		return err
	}
	var body strings.Builder
	for _, l := range kept {
		body.WriteString(l)
		body.WriteString("\n")
	}
	body.Write(ours)
	if !strings.HasSuffix(body.String(), "\n") {
		body.WriteString("\n")
	}
	tmp := userJs + ".lazyfox.tmp"
	if err := os.WriteFile(tmp, []byte(body.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, userJs)
}

// dropManagedPrefs removes only Lazyfox-owned prefs from user.js (uninstall),
// preserving every other line.
func dropManagedPrefs(rc *repoContext, profileDir string) error {
	managed := distUserPrefs(rc)
	userJs := filepath.Join(profileDir, "user.js")
	if !exists(userJs) {
		return nil
	}
	if err := backupFile(userJs, "uninst"); err != nil {
		return err
	}
	var kept []string
	f, err := os.Open(userJs)
	if err != nil {
		return err
	}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if m := userPrefRe.FindStringSubmatch(line); m != nil {
			if managed[m[1]] {
				continue
			}
		}
		kept = append(kept, line)
	}
	f.Close()
	content := strings.Join(kept, "\n")
	if strings.TrimSpace(content) != "" {
		content += "\n"
	}
	return os.WriteFile(userJs, []byte(content), 0o644)
}
