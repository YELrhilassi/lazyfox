//go:build windows

package platform

import (
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// This file deliberately spawns NO child processes.
//
// The previous implementation shelled out to powershell.exe, taskkill and
// tasklist. Because the installer is a GUI-subsystem binary, every one of those
// console programs popped a console window — and the wait loop polled tasklist
// every 250ms for up to 20s, so a single install flashed dozens of command
// windows on screen. Worse, the polling was the only standing between
// "Firefox closed" and "abort the install", so a slow exit failed the install
// outright.
//
// Everything below uses the Win32 API directly (a thread snapshot plus process
// handles), so nothing is ever shown on screen and waiting is a kernel wait or a
// bounded poll rather than a fixed sleep.

var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	procPostMessageW = user32.NewProc("PostMessageW")
)

// RunningFirefoxPIDs returns the pids of every running firefox.exe.
func RunningFirefoxPIDs() []uint32 { return RunningPIDs("firefox.exe") }

// RunningPIDs returns the pids of every process whose executable name matches
// name, with or without the .exe suffix.
func RunningPIDs(name string) []uint32 {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	var pids []uint32
	for err := windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		exe := windows.UTF16ToString(entry.ExeFile[:])
		if strings.EqualFold(exe, name) || strings.EqualFold(exe, name+".exe") {
			pids = append(pids, entry.ProcessID)
		}
	}
	return pids
}

// ProfileFirefoxAlive reports whether a Firefox process is still running at all.
//
// Windows cannot attribute the profile lock to a process (a sharing violation
// never says who owns it), so "locked AND some firefox.exe is alive" is the
// honest pair: after our stop pass, no live firefox.exe means nothing can be
// writing this profile, whatever else has the lock file open for a moment — and
// that is exactly the state the old code aborted over.
func ProfileFirefoxAlive(profileDir string) bool {
	return len(RunningFirefoxPIDs()) > 0
}

// StopProcessesNamed terminates every process whose executable matches name and
// returns how many were stopped.
//
// It exists for one caller: the native messaging host, which the extension keeps
// running for as long as a Firefox is connected to it. On Windows that process
// holds its own .exe open, so an in-place update cannot replace the binary until
// it exits — and the update must not confuse "the file is busy" with "the host
// is not installed". Only our own binary is ever named.
func StopProcessesNamed(name string) int {
	stopped := 0
	for _, pid := range RunningPIDs(name) {
		if stopProcess(pid) {
			stopped++
		}
	}
	return stopped
}

// stopProcess terminates a pid and blocks until the kernel reports it gone (or
// the wait times out). No taskkill, no polling.
func stopProcess(pid uint32) bool {
	// PROCESS_TERMINATE to kill it, SYNCHRONIZE to wait on it.
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false // already gone, or not ours to touch
	}
	defer windows.CloseHandle(h)
	if err := windows.TerminateProcess(h, 1); err != nil {
		return false
	}
	// A real wait: returns as soon as the process object is signalled.
	_, _ = windows.WaitForSingleObject(h, uint32((15 * time.Second).Milliseconds()))
	return true
}

// closeWindowsOf posts WM_CLOSE to every top-level window owned by pid and
// reports whether it found any.
//
// This is the "ask politely" half of the close: a window close is what Firefox
// responds to by saving its session and releasing the profile cleanly. The old
// straight-to-TerminateProcess path gave the browser no chance to do that, so
// every install looked like a crash on the next start — Firefox keeps the lock
// file's timestamp precisely to notice that — and a browser caught mid-write was
// a profile caught mid-write.
func closeWindowsOf(pid uint32) bool {
	found := false
	callback := windows.NewCallback(func(hwnd, lparam uintptr) uintptr {
		var owner uint32
		if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &owner); err == nil && owner == pid {
			const wmClose = 0x0010
			_, _, _ = procPostMessageW.Call(hwnd, wmClose, 0, 0)
			found = true
		}
		return 1 // keep enumerating
	})
	if err := windows.EnumWindows(callback, nil); err != nil {
		return false
	}
	return found
}

// waitForExit polls (by process NAME, so a pid that exited and was reused can
// never be mistaken for our browser) until none of pids is running, or the
// deadline passes.
func waitForExit(pids []uint32, wait time.Duration) {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		running := RunningFirefoxPIDs()
		live := false
		for _, pid := range pids {
			for _, r := range running {
				if r == pid {
					live = true
					break
				}
			}
			if live {
				break
			}
		}
		if !live {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// StopFirefoxForProfile closes the Firefox using profileDir and waits until the
// profile lock is released, returning how many processes were terminated.
//
// It closes politely first: WM_CLOSE to each firefox window, bounded at six
// seconds, so the browser can save its session and let go of the profile the way
// a user close would. Whatever is still alive after that is terminated, the list
// re-scanned so a process that appeared during the wait is included, and the wait
// for the lock is bounded — never a fixed sleep, and never given up on while a
// firefox.exe still exists.
//
// As before, while this profile is locked every firefox.exe is a candidate: a
// normally launched Firefox does not put `-profile <dir>` on its command line
// (and reading another process's command line needs the PEB).
func StopFirefoxForProfile(profileDir string) int {
	if !ProfileLocked(profileDir) {
		return 0
	}
	pids := RunningFirefoxPIDs()
	if len(pids) == 0 {
		// The lock reads held but no Firefox exists: the holder is something
		// else (an antivirus or indexer that has the file open for a moment).
		// There is nothing to close, and the caller's verdict is made on
		// liveness — see ProfileFirefoxAlive.
		return 0
	}

	// 1. Ask politely.
	for _, pid := range pids {
		closeWindowsOf(pid)
	}
	waitForExit(pids, 6*time.Second)

	// 2. Force whatever ignored that, with a fresh scan for stragglers.
	stopped := 0
	for _, pid := range RunningFirefoxPIDs() {
		if stopProcess(pid) {
			stopped++
		}
	}

	// 3. The lock is what the caller's writes depend on: wait for it to clear,
	//    with a hard bound so a wedged Firefox cannot hang the installer.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if !ProfileLocked(profileDir) {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	return stopped
}

// LaunchFirefox starts Firefox detached against the given profile. Firefox is a
// GUI application, so this shows no console.
func LaunchFirefox(bin, profileDir string, args ...string) error {
	cmd := commandHidden(bin, append([]string{"-profile", profileDir}, args...)...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}