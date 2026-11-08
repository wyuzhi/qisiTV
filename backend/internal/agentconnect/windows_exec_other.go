//go:build !windows

package agentconnect

import (
	"context"
	"os/exec"
)

// scriptCommand is only reachable on Windows. The stub keeps the package
// buildable everywhere and makes unit tests for the command line possible.
func scriptCommand(ctx context.Context, comspec, line string) *exec.Cmd { return nil }
