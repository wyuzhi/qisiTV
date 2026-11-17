package runtimeinfo

import (
	"syscall"
	"time"
)

func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	// Signal(0) is unsupported on Windows. A terminated process can still have
	// an open handle, so FindProcess alone is not evidence that it is alive.
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	status, err := syscall.WaitForSingleObject(handle, 0)
	return err == nil && status == syscall.WAIT_TIMEOUT
}

const processQueryLimitedInformation = 0x1000

func processMatchesStart(pid int, startedAt time.Time) bool {
	if pid <= 0 {
		return false
	}
	access := uint32(syscall.SYNCHRONIZE | processQueryLimitedInformation)
	handle, err := syscall.OpenProcess(access, false, uint32(pid))
	if err != nil {
		if startedAt.IsZero() {
			return ProcessAlive(pid)
		}
		return false
	}
	defer syscall.CloseHandle(handle)
	status, err := syscall.WaitForSingleObject(handle, 0)
	if err != nil || status != syscall.WAIT_TIMEOUT {
		return false
	}
	if startedAt.IsZero() {
		return true
	}
	var creation, exit, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
		return true
	}
	createdAt := time.Unix(0, creation.Nanoseconds())
	return !createdAt.After(startedAt.Add(2 * time.Second))
}
