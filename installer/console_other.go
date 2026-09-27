//go:build !windows

package main

// attachCLIConsole is a Windows-only concern: on Unix the process always has a
// console to write to.
func attachCLIConsole() {}
