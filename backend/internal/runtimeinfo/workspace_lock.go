package runtimeinfo

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// LockWorkspace protects opening, migrating and cleaning the same workspace.
// Legacy descriptors are used only to refuse an operation, never to discover
// an address. A live AppData shadow can therefore block an unsafe operation
// without redirecting the CLI to a different workspace.
func LockWorkspace(dataDir string) (*os.File, error) {
	lock, err := lockWorkspaceFile(dataDir)
	if err != nil {
		return nil, err
	}
	if legacyWorkspaceBusy(dataDir) {
		_ = lock.Close()
		return nil, errors.New("此数据目录正在被另一实例使用，请先关闭其他 BeefTV 窗口")
	}
	if path, pathErr := Path(dataDir); pathErr == nil {
		_ = os.Remove(path)
	}
	return lock, nil
}

func legacyWorkspaceBusy(dataDir string) bool {
	legacyPath := filepath.Join(dataDir, FileName)
	raw, err := os.ReadFile(legacyPath)
	if err != nil {
		return false
	}
	var legacy Info
	if json.Unmarshal(raw, &legacy) != nil || legacy.PID <= 0 || legacy.PID == os.Getpid() {
		return false
	}
	if path, pathErr := Path(dataDir); pathErr == nil && filepath.Clean(path) == filepath.Clean(legacyPath) && !legacy.StartedAt.IsZero() {
		return false
	}
	return processMatchesStart(legacy.PID, legacy.StartedAt)
}
