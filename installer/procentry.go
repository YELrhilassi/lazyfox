package main

// processEntry is a lightweight handle on a running Firefox process. It is
// produced by the platform-specific process discoverers (windowsRunningFirefox
// on Windows; on Unix the loader walks /proc directly and returns simple pids).
type processEntry struct {
	pid     uint32
	cmdline string
	exePath string
}
