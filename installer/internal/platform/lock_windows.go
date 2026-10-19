//go:build windows

package platform

import (
	"errors"

	"golang.org/x/sys/windows"
)

// lockHeld reports whether a live process holds the OS lock on this file.
//
// Firefox locks `parent.lock` with LockFileEx while it runs and leaves the file
// itself behind, so this re-opens it with no sharing at all: a sharing violation
// means someone still has it open, which is the only honest signal that Firefox
// is running. A missing file, or one nobody holds, is not a lock.
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
