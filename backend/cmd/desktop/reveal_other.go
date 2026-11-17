//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func platformDownloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	if runtime.GOOS == "linux" {
		if xdgDir := resolveLinuxXDGDownloadsDir(home); xdgDir != "" {
			return xdgDir
		}
	}
	candidate := filepath.Join(home, "Downloads")
	if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
		return candidate
	}
	return ""
}

func resolveLinuxXDGDownloadsDir(home string) string {
	if envDir := strings.TrimSpace(os.Getenv("XDG_DOWNLOAD_DIR")); envDir != "" && filepath.IsAbs(envDir) {
		if info, err := os.Stat(envDir); err == nil && info.IsDir() {
			return filepath.Clean(envDir)
		}
	}
	configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME"))
	if configHome == "" || !filepath.IsAbs(configHome) {
		configHome = filepath.Join(home, ".config")
	}
	raw, err := os.ReadFile(filepath.Join(configHome, "user-dirs.dirs"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "XDG_DOWNLOAD_DIR=") {
			continue
		}
		val := strings.Trim(strings.TrimPrefix(trimmed, "XDG_DOWNLOAD_DIR="), `"`)
		val = strings.ReplaceAll(val, "$HOME", home)
		if filepath.IsAbs(val) {
			if info, statErr := os.Stat(val); statErr == nil && info.IsDir() {
				return filepath.Clean(val)
			}
		}
	}
	return ""
}

func revealFileInFileManager(targetPath string) error {
	clean := filepath.Clean(strings.TrimSpace(targetPath))
	if clean == "" || !filepath.IsAbs(clean) || strings.ContainsAny(clean, "\r\n\x00") {
		return errors.New("诊断包文件路径无效")
	}
	info, err := os.Stat(clean)
	if err != nil || info.IsDir() {
		return errors.New("未找到已导出的诊断包文件")
	}
	var command *exec.Cmd
	if runtime.GOOS == "darwin" {
		command = exec.Command("open", "-R", clean)
	} else {
		command = exec.Command("xdg-open", filepath.Dir(clean))
	}
	if err := command.Start(); err != nil {
		return errors.New("无法在文件夹中显示诊断包文件")
	}
	go func() { _ = command.Wait() }()
	return nil
}
