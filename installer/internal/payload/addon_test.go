package payload

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// xpi builds an in-memory xpi carrying the given manifest.json, so the version
// reader can be tested without a staged payload on disk. The staged directory
// (internal/payload/data) is gitignored, so a checkout frequently has no xpi at
// all — a test that needed one would pass on a build machine and fail on the
// next clone, which is worse than no test.
func xpi(t *testing.T, manifest string, extra ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("manifest.json")
	if err != nil {
		t.Fatalf("create manifest: %v", err)
	}
	if _, err := w.Write([]byte(manifest)); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	for _, name := range extra {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		// A trailing slash is a directory entry, which carries no bytes.
		if strings.HasSuffix(name, "/") {
			continue
		}
		if _, err := w.Write([]byte("x")); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

func TestAddonVersionFromXpi(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{
			name: "plain manifest",
			data: xpi(t, `{"manifest_version":3,"version":"0.5.8","name":"Lazyfox"}`),
			want: "0.5.8",
		},
		{
			name: "version after other keys and nested objects",
			// The manifest is decoded as JSON, not scanned for a pattern: a
			// nested "version" (an add-on can have them) must not win.
			data: xpi(t, `{"browser_specific_settings":{"gecko":{"id":"x","version":"9.9.9"}},"version":"1.2.3"}`),
			want: "1.2.3",
		},
		{
			name: "whitespace is trimmed",
			data: xpi(t, `{"version":" 0.5.8 "}`),
			want: "0.5.8",
		},
		{
			name: "prerelease version is kept whole",
			data: xpi(t, `{"version":"0.5.9-beta.2"}`),
			want: "0.5.9-beta.2",
		},
		{
			name: "a manifest without a version is empty, not zero",
			data: xpi(t, `{"name":"Lazyfox"}`),
			want: "",
		},
		{
			name: "manifest.json elsewhere in the archive does not count",
			data: xpi(t, `{"version":"7.7.7"}`, "sub/manifest.json"),
			want: "7.7.7",
		},
		{
			name: "a manifest pushed aside by a directory entry still parses",
			data: xpi(t, `{"version":"3.3.3"}`, "chrome/"),
			want: "3.3.3",
		},
		{name: "empty bytes", data: nil, want: ""},
		{name: "not a zip", data: []byte("this is not an xpi"), want: ""},
		{name: "json that is not an object", data: xpi(t, `[1,2,3]`), want: ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := addonVersionFromXpi(c.data); got != c.want {
				t.Fatalf("addonVersionFromXpi = %q, want %q", got, c.want)
			}
		})
	}
}

// AddonVersion is a method on a Source, so it must answer the same thing every
// time it is asked (the window reads it on every refresh) and must never panic
// on a source with no payload — a checkout that has not staged one yet. What it
// may NOT do is invent a number: either the xpi is there and its own version is
// reported, or the answer is the empty string.
func TestAddonVersionIsStableAndHonest(t *testing.T) {
	src := &Source{}
	first := src.AddonVersion()
	if second := src.AddonVersion(); second != first {
		t.Fatalf("AddonVersion changed between calls: %q then %q", first, second)
	}
	if _, err := resolveEmbedded(AddonArtifact()); err != nil {
		// No staged payload in this checkout (internal/payload/data is
		// gitignored): the only correct answer is no version at all.
		if first != "" {
			t.Fatalf("AddonVersion = %q with no embedded xpi, want empty", first)
		}
		return
	}
	if first == "" {
		t.Fatal("an embedded xpi carries a version; AddonVersion returned empty")
	}
}
