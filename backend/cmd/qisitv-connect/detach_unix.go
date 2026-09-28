//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func detachService(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
