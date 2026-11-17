//go:build !windows

package runtimeinfo

import (
	"errors"
	"os"
	"syscall"
	"time"
)

func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	defer process.Release()
	err = process.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

func processMatchesStart(pid int, _ time.Time) bool {
	return ProcessAlive(pid)
}
