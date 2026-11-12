//go:build windows

package agentconnect

import (
	"context"
	"os/exec"
	"syscall"
)

func scriptCommand(ctx context.Context, comspec, line string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, comspec)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: line}
	return cmd
}
