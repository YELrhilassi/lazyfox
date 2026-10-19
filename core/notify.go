package core

import (
	"fmt"
	"strings"
)

// Download/notification manager data model and pure logic. The browser APIs
// (Downloads.sys.mjs in the chrome helper, browser.downloads in the extension
// background) hand the live state in; this package reconciles snapshots,
// decides which notifications belong on the status bar, and formats progress
// for display. Everything here is deterministic and side-effect free so it can
// be unit-tested and shared by every context through the wasm core.

// Download is one row of the download list / notification stream. ID is a
// stable key (the full target path in the chrome helper, the numeric id in the
// background) so a dismissed flag survives across polls. The json tags match
// the DownloadEntry shape the JS contexts exchange over the wasm bridge.
type Download struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	Path      string `json:"path"` // full file location
	URL       string `json:"url"`
	State     string `json:"state"` // in_progress | paused | complete | failed | canceled
	Received  int64  `json:"received"`  // bytes received so far
	Total     int64  `json:"total"`    // total bytes (0 = unknown)
	Speed     int64  `json:"speed"`    // bytes per second (0 = unknown)
	Dismissed bool   `json:"dismissed"` // notification dismissed from the status bar
	StartTime int64  `json:"startTime"`
	EndTime   int64  `json:"endTime"`
}

// InProgressState reports whether a download state string means the download
// is still moving (and therefore belongs on the status bar when not
// dismissed).
func InProgressState(state string) bool {
	return state == "in_progress" || state == "paused"
}

// MergeDownloads reconciles a fresh snapshot from the browser with the
// in-memory list. The fresh list is authoritative for every field except
// Dismissed, which is carried forward by ID so a notification the user
// dismissed stays dismissed across polls (but a brand-new download, with a new
// ID, always starts un-dismissed). Fresh order is preserved.
func MergeDownloads(prev, fresh []Download) []Download {
	dismissed := make(map[string]bool, len(prev))
	for _, p := range prev {
		if p.Dismissed {
			dismissed[p.ID] = true
		}
	}
	out := make([]Download, 0, len(fresh))
	for _, f := range fresh {
		if dismissed[f.ID] {
			f.Dismissed = true
		}
		out = append(out, f)
	}
	return out
}

// ActiveDownloads returns the downloads whose notification belongs on the
// status bar and have not been dismissed: in-progress/paused downloads show
// live progress, and done/failed downloads show a small terminal indicator
// (green / red). Canceled downloads leave the bar (the user cancelled them)
// but stay in the popup list.
func ActiveDownloads(downloads []Download) []Download {
	out := make([]Download, 0)
	for _, d := range downloads {
		if d.Dismissed {
			continue
		}
		if d.State == "complete" || d.State == "failed" || InProgressState(d.State) {
			out = append(out, d)
		}
	}
	return out
}

// Progress returns a whole percent 0..100 for a download, or -1 when the total
// is unknown (indeterminate).
func Progress(received, total int64) int {
	if total <= 0 {
		return -1
	}
	if received < 0 {
		received = 0
	}
	if received >= total {
		return 100
	}
	p := int(float64(received) / float64(total) * 100)
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// FormatBytes renders a byte count human-readably (123 B, 12.4 KB, 3.2 MB,
// ...). Negative input yields "" (unknown).
func FormatBytes(n int64) string {
	if n < 0 {
		return ""
	}
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	units := []string{"KB", "MB", "GB", "TB", "PB"}
	f := float64(n)
	i := -1
	for f >= 1024 && i+1 < len(units) {
		f /= 1024
		i++
	}
	return strings.TrimSuffix(fmt.Sprintf("%.1f", f), ".0") + " " + units[i]
}

// FormatSpeed renders a bytes/sec rate for the status bar (e.g. "2.4 MB/s"),
// or "" when unknown.
func FormatSpeed(bytesPerSec int64) string {
	if bytesPerSec <= 0 {
		return ""
	}
	return FormatBytes(bytesPerSec) + "/s"
}
