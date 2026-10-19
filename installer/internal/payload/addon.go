package payload

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

// AddonVersion reports the version of the add-on this binary carries.
//
// WHY IT IS READ FROM THE XPI RATHER THAN FROM A CONSTANT. The installer's whole
// promise is "this is what I will write", and the honest answer to "which
// Lazyfox is that?" is a property of the artifact itself, not of a string
// somebody remembered to bump. The xpi is the only source that cannot drift: it
// is embedded in this binary at build time, it is what the install step writes
// into the profile (Source.Resolve, KindAddon, always the embedded copy), and
// its manifest.json has said which version it is since the extension existed.
//
// The window shows this, so a user running an installer downloaded last week can
// see that it is about to install last week's build. Before this, NOTHING in the
// installer knew the add-on's version: the payload was an opaque blob, the
// binaries carried only their channel, and the only way to tell 0.5.6 from 0.5.8
// was to install it and look.
//
// An unreadable payload answers with an empty string rather than an error: the
// version is a label on the window, and it must never be the reason an install
// cannot start. AddonAvailable is the question that decides whether there is an
// add-on at all.
func (s *Source) AddonVersion() string {
	s.addonVersionOnce.Do(func() {
		b, err := resolveEmbedded(AddonArtifact())
		if err != nil {
			return
		}
		s.addonVersion = addonVersionFromXpi(b)
	})
	return s.addonVersion
}

// addonVersionFromXpi reads "version" out of a WebExtension xpi's manifest.json.
//
// It takes BYTES rather than a path so it is testable without a payload on disk
// (the staged payload directory is gitignored, so a checkout often has none),
// and so the same function serves a future signed-xpi verification path.
//
// Every failure is an empty string: a zip we cannot open, a manifest we cannot
// find or parse, a manifest that is not JSON. None of those is a reason to stop
// an install, and none of them should be reported as "version 0.0.0".
func addonVersionFromXpi(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return ""
	}
	for _, f := range zr.File {
		// The manifest is at the archive root by specification; a merchant or a
		// stray directory entry cannot shadow it.
		if f.Name != "manifest.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return ""
		}
		var m struct {
			Version string `json:"version"`
		}
		// A bounded read: the manifest is a few hundred bytes, and a corrupt
		// archive should not be able to make this allocate without limit.
		err = json.NewDecoder(io.LimitReader(rc, 1<<20)).Decode(&m)
		_ = rc.Close()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(m.Version)
	}
	return ""
}

// The cache is per Source, and Source is built once per run (Locate), so this is
// one read of a few hundred kilobytes per process, not per window refresh.
