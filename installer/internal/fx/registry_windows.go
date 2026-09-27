//go:build windows

package fx

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// windowsRegistryFirefoxExes looks up Firefox executables registered in the
// Windows registry (HKCU and HKLM).
//
// `Software\Mozilla` holds one key per Firefox family, named by flavor
// (`Mozilla Firefox`, `Firefox Developer Edition`, `Firefox Nightly`,
// `Firefox ESR`). Each family has version subkeys (e.g. `157.0 (x64 en-CA)`)
// whose `Main\PathToExe` is the binary. The names differ per channel, so we
// enumerate instead of hardcoding them.
func windowsRegistryFirefoxExes() []string {
	var exes []string
	roots := []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE}
	parents := []string{
		`Software\Mozilla`,
		`Software\WOW6432Node\Mozilla`,
	}
	seen := map[string]bool{}
	for _, root := range roots {
		for _, parent := range parents {
			pk, err := registry.OpenKey(root, parent, registry.ENUMERATE_SUB_KEYS)
			if err != nil {
				continue
			}
			families, _ := pk.ReadSubKeyNames(0)
			pk.Close()
			for _, family := range families {
				if !strings.Contains(strings.ToLower(family), "firefox") {
					continue
				}
				key := parent + `\` + family
				fk, err := registry.OpenKey(root, key, registry.ENUMERATE_SUB_KEYS)
				if err != nil {
					continue
				}
				versions, _ := fk.ReadSubKeyNames(0)
				fk.Close()
				for _, v := range versions {
					vk, err := registry.OpenKey(root, key+`\`+v+`\Main`, registry.QUERY_VALUE)
					if err != nil {
						continue
					}
					path, _, err := vk.GetStringValue("PathToExe")
					vk.Close()
					if err == nil && path != "" && !seen[strings.ToLower(path)] {
						seen[strings.ToLower(path)] = true
						exes = append(exes, path)
					}
				}
			}
		}
	}
	return exes
}
