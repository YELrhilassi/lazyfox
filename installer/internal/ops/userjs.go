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
	// The managed block is not only prefs: it carries the comments that explain
	// them. Those lines came from the payload, so they are dropped too — by exact
	// text, which means a comment the user wrote stays unless it is word-for-word
	// ours. Without this an uninstall left a growing pile of Lazyfox's own
	// commentary in a file it had otherwise emptied.
	oursComments := payloadCommentLines(ours)
	var left []string
	for _, line := range kept {
		if oursComments[strings.TrimSpace(line)] {
			continue
		}
		left = append(left, line)
	}
	content := strings.TrimRight(strings.Join(left, "\n"), "\n")
	// Nothing left means the file exists only because Lazyfox created it: an
	// empty user.js is indistinguishable from a stray file the user did not
	// write, and "uninstalled" should mean gone.
	if strings.TrimSpace(content) == "" {
		if err := os.Remove(userJs); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return os.WriteFile(userJs, []byte(content+"\n"), 0o644)
}

// payloadCommentLines returns the trimmed comment lines a managed-prefs payload
// declares, so an uninstall can take its own explanation back out.
func payloadCommentLines(source []byte) map[string]bool {
	out := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(string(source)))
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimRight(sc.Text(), "\r"))
		if line == "" || userPrefRe.MatchString(line) {
			continue
		}
		out[line] = true
	}
	return out
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
