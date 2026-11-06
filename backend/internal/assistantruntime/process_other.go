//go:build !windows

package assistantruntime

import "os/exec"

func ConfigureHostProcess(*exec.Cmd) {}
