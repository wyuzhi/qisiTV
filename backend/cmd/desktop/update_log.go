package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// OpenUpdateLogDirectory accepts no caller path; it only opens this workspace.
func (a *DesktopApp) OpenUpdateLogDirectory() error {
	if _, err := a.dialogContext(); err != nil {
		return err
	}
	a.mu.RLock()
	dir := strings.TrimSpace(a.dataDir)
	runtimeHeld := a.runtime() != nil
	openDir := a.openDirectory
	a.mu.RUnlock()
	target := resolveExistingWorkspaceDirectory(dir, runtimeHeld)
	if target == "" {
		return errors.New("数据目录无法打开，请在存储设置中检查当前目录。")
	}
	if openDir != nil {
		return openDir(target)
	}
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("explorer.exe", target)
	case "darwin":
		command = exec.Command("open", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	if err := command.Start(); err != nil {
		return errors.New("无法打开日志文件夹，请在存储设置中查看当前目录。")
	}
	go func() { _ = command.Wait() }()
	return nil
}

func resolveExistingWorkspaceDirectory(dir string, allowCreate bool) string {
	if dir != "" {
		if allowCreate {
			_ = os.MkdirAll(dir, 0o755)
		}
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
		parent := filepath.Dir(filepath.Clean(dir))
		if parent != "" && parent != dir {
			if info, err := os.Stat(parent); err == nil && info.IsDir() {
				return parent
			}
		}
	}
	return ""
}
