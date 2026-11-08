//go:build !windows

package securefile

import (
	"fmt"
	"os"
)

// Protect is a no-op on Unix: callers create the file with mode 0600.
func Protect(string) error { return nil }

// Verify reports an error unless only the owner can read and write the file.
func Verify(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm() != 0o600 {
		return fmt.Errorf("连接凭据权限为 %o，应为 0600", info.Mode().Perm())
	}
	return nil
}
