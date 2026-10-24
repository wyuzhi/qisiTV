//go:build !windows

package runtimeinfo

import (
	"qisitv/backend/internal/desktopstorage"
	"os"
)

func lockWorkspaceFile(dataDir string) (*os.File, error) { return desktopstorage.Lock(dataDir) }
