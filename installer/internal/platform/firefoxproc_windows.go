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
// windows on screen. Worse, the polling was the only thing standing between
// "Firefox closed" and "abort the install", so a slow exit failed the install
// outright.
//
// Everything below uses the Win32 API directly (a thread snapshot plus process
// handles), so nothing is ever shown on screen and waiting is a kernel wait
// rather than a poll.

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

// StopFirefoxForProfile terminates the Firefox processes holding profileDir and
// waits until the profile lock is actually released, returning how many were
// stopped.
//
// A normally launched Firefox does not put `-profile <dir>` on its command line
// (and reading another process's command line needs the PEB), so while this
// profile is locked every firefox.exe is a candidate — the same rule the old
// implementation used. Nothing is killed when the profile is not locked.
func StopFirefoxForProfile(profileDir string) int {
	if !ProfileLocked(profileDir) {
		return 0
	}
	stopped := 0
	for _, pid := range RunningFirefoxPIDs() {
		if stopProcess(pid) {
			stopped++
		}
	}
	if stopped == 0 {
		return 0
	}
	// The thing we actually care about is the lock file, not the process list:
	// Firefox unlinks it on clean shutdown. Wait for that, with a hard bound so
	// a wedged Firefox cannot hang the installer forever.
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
