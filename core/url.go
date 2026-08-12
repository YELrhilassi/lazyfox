package core

import "strings"

// URL detection helpers. These intentionally avoid regexp: the WebAssembly
// build would otherwise drag in the regexp runtime, which roughly doubles the
// binary. All matches are ASCII scans / lowercase prefix or contains checks.

func isSchemeStart(r byte) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

func isSchemeByte(r byte) bool {
	return isSchemeStart(r) || r == '+' || r == '.' || r == '-' || (r >= '0' && r <= '9')
}

// hasSchemePrefix reports whether t starts with `[a-z][a-z0-9+.-]*:` (a scheme).
func hasSchemePrefix(t string) bool {
	if len(t) < 2 || !isSchemeStart(t[0]) {
		return false
	}
	for i := 1; i < len(t); i++ {
		c := t[i]
		if c == ':' {
			return true
		}
		if !isSchemeByte(c) {
			return false
		}
	}
	return false
}

// hasDomainDot reports whether t contains a '.' followed by at least two
// ASCII word characters (the old regexp `\.\w{2,}`).
func hasDomainDot(t string) bool {
	for i := 0; i+2 < len(t); i++ {
		if t[i] != '.' {
			continue
		}
		if isWordByte(t[i+1]) && isWordByte(t[i+2]) {
			return true
		}
	}
	return false
}

func isWordByte(r byte) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_'
}

var localhostPrefixes = []string{
	"localhost",
	"127.0.0.1",
	"[::1",
	"[::1]",
	"::1",
	"::1]",
}

func hasLocalhostPrefix(t string) bool {
	lt := strings.ToLower(t)
	for _, p := range localhostPrefixes {
		if strings.HasPrefix(lt, p) {
			return true
		}
	}
	return false
}

// NormalizeUrl turns user text into a loadable URL: passes through URLs that
// already carry a scheme (including about:/file:/moz-extension:), otherwise
// assumes https. The single `scheme:` test covers every case the old
// scheme:// / about: / file: / scheme: regexps matched together.
func NormalizeUrl(text string) string {
	t := strings.TrimSpace(text)
	if t == "" {
		return ""
	}
	if hasSchemePrefix(t) {
		return t
	}
	return "https://" + t
}

// IsLikelyUrl reports whether a query looks like a bare URL the user meant to
// open rather than a web search.
func IsLikelyUrl(text string) bool {
	t := strings.TrimSpace(text)
	if t == "" {
		return false
	}
	if strings.ContainsAny(t, "\t\n ") {
		return false
	}
	if hasSchemePrefix(t) {
		return true
	}
	if hasDomainDot(t) {
		return true
	}
	if hasLocalhostPrefix(t) {
		return true
	}
	return false
}
