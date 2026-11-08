//go:build !windows

package agentconnect

import (
	"os"
	"testing"
)

func loosenTokenPermissions(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
}
