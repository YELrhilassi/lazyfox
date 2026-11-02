//go:build windows

package platform

import (
	"errors"

	"golang.org/x/sys/windows"
)

// lockHeld reports whether a live process holds the OS lock on this file.
//
// Firefox locks `parent.lock` with CreateFile(no sharing) while it runs and
// never deletes the file — "always create the profile lock and never delete it
// so we can use its modification timestamp to detect startup crashes" — so this
// re-opens it with no sharing at all: a sharing violation means somebody still
// has it open, which is the only honest signal available. A missing file, or one
// nobody holds, is not a lock.
func lockHeld(path string) bool {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		0, // no sharing: fails while Firefox holds the file
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return errors.Is(err, windows.ERROR_SHARING_VIOLATION)
	}
	windows.CloseHandle(h)
	return false
}

// lockHolder: the no-share re-open proves that *somebody* holds the file, but
// CreateFile never says who — there is no portable way to ask Windows which
// process owns a sharing violation. Windows therefore names no pid; callers use
// the firefox.exe process list there (see ProfileLockHolder).
func lockHolder(path string) int {
	return 0
}