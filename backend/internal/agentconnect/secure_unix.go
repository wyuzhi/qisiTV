//go:build !windows

package agentconnect

import (
	"fmt"
	"os"
)

func secureTokenFile(string) error { return nil }

func verifyTokenPermissions(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm() != 0o600 {
		return fmt.Errorf("连接凭据权限为 %o，应为 0600", info.Mode().Perm())
	}
	return nil
}
