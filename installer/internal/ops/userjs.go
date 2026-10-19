package ops

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// userPrefRe captures user_pref("name", ...) so we can tell which prefs Lazyfox
// owns, without parsing the values.
var userPrefRe = regexp.MustCompile(`^user_pref\("([^"]+)"`)

// UserPrefs returns the set of pref names a managed-prefs payload declares.
func UserPrefs(source []byte) map[string]bool {
	managed := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(string(source)))
	for sc.Scan() {
		if m := userPrefRe.FindStringSubmatch(sc.Text()); m != nil {
			managed[m[1]] = true
		}
	}
	return managed
}

// mergeUserJS updates profile/user.js so Lazyfox's managed prefs are exactly
// ours, preserving every other pref the user set. The previous file is backed
// up; the managed block is appended after the preserved lines.
func mergeUserJS(src *payload.Source, profileDir string) error {
	ours, err := src.Resolve(payload.UserJSArtifact())
	if err != nil {
		return err
	}
	managed := UserPrefs(ours)
	userJs := filepath.Join(profileDir, payload.UserJSName)
	if err := backupFile(userJs, "install"); err != nil {
		return err
	}
	kept := nonManagedLines(userJs, managed)
	var body strings.Builder
	for _, l := range kept {
		body.WriteString(l)
		body.WriteString("\n")
	}
	body.Write(ours)
	if !strings.HasSuffix(body.String(), "\n") {
		body.WriteString("\n")
	}
	return writeAtomic(userJs, body.String())
}

// dropManagedPrefs removes only Lazyfox-owned prefs from user.js (uninstall),
// preserving every other line.
func dropManagedPrefs(src *payload.Source, profileDir string) error {
	ours, err := src.Resolve(payload.UserJSArtifact())
	if err != nil {
		return err
	}
	userJs := filepath.Join(profileDir, payload.UserJSName)
	if !platform.Exists(userJs) {
		return nil
	}
	if err := backupFile(userJs, "uninst"); err != nil {
		return err
	}
	kept := nonManagedLines(userJs, UserPrefs(ours))
	content := strings.Join(kept, "\n")
	if strings.TrimSpace(content) != "" {
		content += "\n"
	}
	return os.WriteFile(userJs, []byte(content), 0o644)
}

// nonManagedLines returns the file's lines with managed prefs removed.
func nonManagedLines(path string, managed map[string]bool) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var kept []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if m := userPrefRe.FindStringSubmatch(line); m != nil && managed[m[1]] {
			continue
		}
		kept = append(kept, line)
	}
	return kept
}

// writeAtomic writes through a temp file + rename so a crash never leaves a
// half-written user.js.
func writeAtomic(path, content string) error {
	tmp := path + ".lazyfox.tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
