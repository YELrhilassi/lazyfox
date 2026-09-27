package ops

import (
	"bytes"
	"os"
	"strings"

	"lazyfox/installer/internal/fx"
)

// extensions.json can grow very large (one object per installed add-on), and a
// full encoding/json round-trip is memory-hungry enough to matter on big
// profiles — and it rewrites the formatting. So, like the legacy PowerShell
// installer, we make surgical text edits: locate the object whose "id" equals
// our add-on id and either remove it (so Firefox re-imports the freshly written
// xpi) or flip its enabled fields. Memory stays flat no matter how many add-ons
// the user has.

// jsonObjectRange returns the byte range [start,end) of the outermost object
// whose "id" field equals wantID. It walks back over '{' candidates from the id
// match and validates each with a string-literal-aware brace matcher, picking
// the first whose span contains the id. Returns (-1,-1) when not found.
func jsonObjectRange(text, wantID string) (int, int) {
	idx := strings.Index(text, `"id":"`+wantID+`"`)
	if idx < 0 {
		idx = findIDAllowSpaces(text, wantID)
	}
	if idx < 0 {
		return -1, -1
	}
	idEnd := idx + len(`"id":"`+wantID+`"`) - 1
	searchFrom := idEnd
	for {
		open := strings.LastIndex(text[:searchFrom], "{")
		if open < 0 {
			return -1, -1
		}
		if closeIdx := matchBrace(text, open); closeIdx > idEnd {
			return open, closeIdx + 1
		}
		searchFrom = open - 1
	}
}

// findIDAllowSpaces matches "id" : "value" with flexible whitespace via a
// lightweight scan (avoids regexp on multi-MB files).
func findIDAllowSpaces(text, wantID string) int {
	probe := `"id"`
	start := 0
	for {
		i := strings.Index(text[start:], probe)
		if i < 0 {
			return -1
		}
		i += start
		j := i + len(probe)
		for j < len(text) && isJSONSpace(text[j]) {
			j++
		}
		if j < len(text) && text[j] == ':' {
			j++
			for j < len(text) && isJSONSpace(text[j]) {
				j++
			}
			if j < len(text) && text[j] == '"' {
				end := j + 1
				for end < len(text) && text[end] != '"' {
					end++
				}
				if end < len(text) && text[j+1:end] == wantID {
					return j
				}
			}
		}
		start = i + len(probe)
	}
}

func isJSONSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// matchBrace returns the index of the '}' closing the '{' at open, skipping
// braces inside string literals. Returns -1 on EOF.
func matchBrace(text string, open int) int {
	depth := 0
	inStr, esc := false, false
	for i := open; i < len(text); i++ {
		c := text[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// markAddonDisabled returns a copy with our add-on's enabled fields flipped off,
// plus whether the object was found.
func markAddonDisabled(text []byte) ([]byte, bool) {
	return mutateAddonStringFields(text, map[string]string{
		"userDisabled": "true",
		"active":       "false",
		"visible":      "false",
	})
}

// unmarkAddon returns a copy with our add-on's enabled fields set to active.
func unmarkAddon(text []byte) ([]byte, bool) {
	return mutateAddonStringFields(text, map[string]string{
		"userDisabled": "false",
		"active":       "true",
		"visible":      "true",
	})
}

// mutateAddonStringFields applies field rewrites to our add-on's object only.
func mutateAddonStringFields(text []byte, fields map[string]string) ([]byte, bool) {
	s := string(text)
	start, end := jsonObjectRange(s, fx.AddonID)
	if start < 0 {
		return text, false
	}
	slice := s[start:end]
	for field, want := range fields {
		slice = replaceField(slice, field, want)
	}
	return []byte(s[:start] + slice + s[end:]), true
}

// replaceField rewrites the value of a JSON field to want, handling whitespace.
func replaceField(slice, field, want string) string {
	probe := `"` + field + `"`
	for {
		i := strings.Index(slice, probe)
		if i < 0 {
			return slice
		}
		j := i + len(probe)
		for j < len(slice) && isJSONSpace(slice[j]) {
			j++
		}
		if j < len(slice) && slice[j] == ':' {
			j++
			for j < len(slice) && isJSONSpace(slice[j]) {
				j++
			}
			if j < len(slice) && slice[j] == '"' {
				end := j + 1
				for end < len(slice) && slice[end] != '"' {
					end++
				}
				return slice[:j] + want + slice[end+1:]
			}
			end := j
			for end < len(slice) && !isJSONSpace(slice[end]) && slice[end] != ',' && slice[end] != '}' {
				end++
			}
			return slice[:j] + want + slice[end:]
		}
		slice = slice[i+len(probe):]
	}
}

// removeAddonObject returns a copy with our add-on object removed from the
// "addons" array, repairing the surrounding comma so the JSON stays valid.
func removeAddonObject(text []byte) ([]byte, bool) {
	s := string(text)
	start, end := jsonObjectRange(s, fx.AddonID)
	if start < 0 {
		return text, false
	}
	// Prefer absorbing the trailing comma (middle element).
	cutEnd := end
	j := end
	for j < len(s) && isJSONSpace(s[j]) {
		j++
	}
	if j < len(s) && s[j] == ',' {
		cutEnd = j + 1
	} else {
		// Otherwise absorb the preceding comma.
		j := start - 1
		for j >= 0 && isJSONSpace(s[j]) {
			j--
		}
		if j >= 0 && s[j] == ',' {
			start = j
		}
	}
	return []byte(s[:start] + s[cutEnd:]), true
}

// editExtensionsJSON reads the file, applies a mutator, and writes the result
// back through temp+rename when it changed. backupIfChanged saves an .uninst
// backup first.
func editExtensionsJSON(path string, mutate func([]byte) ([]byte, bool), backupIfChanged bool) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	out, changed := mutate(data)
	if !changed || bytes.Equal(data, out) {
		return false, nil
	}
	if backupIfChanged {
		_ = backupFile(path, "uninst") // non-fatal; still write the edit
	}
	tmp := path + ".lazyfox.tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return false, err
	}
	return true, nil
}
